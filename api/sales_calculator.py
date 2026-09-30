"""Private what-if quotation calculations; never creates an adopted quote."""
from __future__ import annotations

import json
from decimal import Decimal, ROUND_FLOOR, localcontext
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field

from api.postgres import transaction
from api.research import now, packed
from api.sales import ALLOCATION_TIERS, MODES, SalesStore, decimal, money


class Shape(BaseModel):
    model_config = ConfigDict(extra='forbid')


class Tier(Shape):
    upper: str | None = Field(default=None, max_length=150)
    amount: str = Field(max_length=150)


class Step(Shape):
    id: str = Field(min_length=1, max_length=80)
    label: str = Field(min_length=1, max_length=40)
    operation: Literal['+', '-', '*', '/']
    value: str | None = Field(default=None, max_length=150)
    automatic_allocation: bool = False
    fee: bool = False
    allocation_step: bool = False
    tiers: list[Tier] | None = Field(default=None, max_length=20)


class Panel(Shape):
    id: str = Field(min_length=1, max_length=80)
    name: str = Field(min_length=1, max_length=60)
    mode: Literal['domestic_direct', 'domestic_intermediary', 'export_direct', 'export_intermediary']
    direction: Literal['forward', 'reverse'] = 'forward'
    target_price: str = Field(default='', max_length=150)
    steps: list[Step] = Field(max_length=24)


class Source(Shape):
    kind: Literal['manual', 'product', 'snapshot']
    product_id: str | None = Field(default=None, max_length=200)
    basis: Literal['latest', 'inventory'] = 'latest'
    cost: str | None = Field(default=None, max_length=150)
    special_allocation: bool = False
    product_code: str = Field(default='', max_length=200)
    source_version: str = Field(default='', max_length=100)


class Evaluation(Shape):
    source: Source
    panels: list[Panel] = Field(min_length=1, max_length=12)


class Template(Shape):
    mode: Literal['domestic_direct', 'domestic_intermediary', 'export_direct', 'export_intermediary']
    steps: list[Step] = Field(max_length=24)


class SavedInput(Shape):
    kind: Literal['template', 'workspace']
    name: str | None = Field(default=None, max_length=120)
    payload: dict
    revision: int | None = Field(default=None, ge=1)


def _bands(tiers: list[Tier] | None):
    rows = tiers if tiers is not None else [Tier(upper=upper, amount=amount) for upper, amount in ALLOCATION_TIERS]
    if not rows:
        raise ValueError('至少保留一档公摊')
    low = Decimal(0)
    bands = []
    for index, row in enumerate(rows):
        high = decimal(row.upper, '分档上限') if row.upper is not None else None
        if index == len(rows) - 1:
            if high is not None:
                raise ValueError('最后一档须设为无上限')
        elif high is None or high <= low:
            raise ValueError('分档上限须逐档递增')
        amount = decimal(row.amount, '公摊金额')
        bands.append((low, high, amount))
        if high is not None:
            low = high
    return bands


def _tier_amount(cost: Decimal, tiers: list[Tier] | None):
    return next(amount for low, high, amount in _bands(tiers) if high is None or cost < high)


def _steps(steps: list[Step], cost: Decimal, *, special: bool, tier: Decimal | None = None):
    value = cost
    trail = []
    fees = Decimal(0)
    with localcontext() as context:
        context.prec = 100
        for step in steps:
            if step.automatic_allocation:
                if step.operation != '+' or not step.fee or step.value not in (None, '') or special:
                    raise ValueError('自动公摊只能作为普通产品的费用加项')
                amount = tier if tier is not None else _tier_amount(cost, step.tiers)
            else:
                amount = decimal(step.value, step.label)
                if special and (step.allocation_step or '公摊' in step.label) and not Decimal('.3') <= amount <= 1:
                    raise ValueError('特殊公摊须在0.3至1元之间')
            if step.fee and step.operation not in ('+', '-'):
                raise ValueError('费用只能使用加法或减法')
            if step.operation == '+':
                value += amount
                if step.fee:
                    fees += amount
            elif step.operation == '-':
                value -= amount
                if step.fee:
                    fees -= amount
            elif step.operation == '*':
                value *= amount
            else:
                if amount == 0:
                    raise ValueError(f'{step.label}的除数不能为零')
                value /= amount
            trail.append({'id': step.id, 'value': money(value)})
    return value, fees, trail


def calculate_panel(panel: Panel, cost: str | None, *, special: bool = False):
    ids = [step.id for step in panel.steps]
    if len(ids) != len(set(ids)):
        raise ValueError('公式步骤编号不能重复')
    if sum(step.automatic_allocation for step in panel.steps) > 1:
        raise ValueError('自动公摊只能出现一次')
    for step in panel.steps:
        if step.tiers is not None:
            _bands(step.tiers)
    current = decimal(cost, '产品成本', source=True) if cost not in (None, '') else None
    if panel.direction == 'forward':
        if current is None:
            raise ValueError('请先选择有成本的产品或输入手工成本')
        price, fees, trail = _steps(panel.steps, current, special=special)
        if price < 0:
            raise ValueError('公式结果小于零，请检查减项')
        return {'price': money(price), 'target_cost': None, 'cost_total': money(current + fees), 'cost_gap': None, 'trail': trail}

    if panel.target_price in (None, ''):
        raise ValueError('请先输入意向报价')
    target = decimal(panel.target_price, '意向报价')
    auto_step = next((step for step in panel.steps if step.automatic_allocation), None)
    bands = _bands(auto_step.tiers) if auto_step else [(Decimal(0), None, None)]
    candidates = []
    with localcontext() as context:
        context.prec = 100
        for low, high, tier in bands:
            zero, _, _ = _steps(panel.steps, Decimal(0), special=special, tier=tier)
            one, _, _ = _steps(panel.steps, Decimal(1), special=special, tier=tier)
            slope = one - zero
            if slope <= 0:
                raise ValueError('公式结果未随产品成本递增，无法反推成本上限')
            # Displayed quote prices round to cents, so a cost remains feasible
            # until its unrounded result reaches the next half cent.
            candidate = ((target + Decimal('.005') - Decimal('1e-30') - zero) / slope).quantize(
                Decimal('.01'), rounding=ROUND_FLOOR)
            candidate = min(candidate, Decimal('1000000000'))
            if high is not None:
                candidate = min(candidate, (high - Decimal('1e-18')).quantize(Decimal('.01'), rounding=ROUND_FLOOR))
            if candidate < low:
                continue
            price, fees, trail = _steps(panel.steps, candidate, special=special)
            if price >= 0 and Decimal(money(price)) <= target:
                candidates.append((candidate, fees, trail))
    if not candidates:
        raise ValueError('该意向报价下没有非负的可用产品成本')
    found, fees, trail = max(candidates, key=lambda row: row[0])
    return {'price': money(target), 'target_cost': money(found), 'cost_total': money(found + fees),
            'cost_gap': money(found - current) if current is not None else None, 'trail': trail}


class CalculatorStore:
    def __init__(self, sales: SalesStore):
        self.sales = sales
        self.url = sales.url

    def resolve_source(self, source: Source, actor):
        self.sales._authorize(actor)
        if source.kind == 'product':
            product = next((row for row in self.sales.products(actor)['products'] if row['id'] == source.product_id), None)
            if product is None:
                raise ValueError('所选产品不存在')
            return Source(kind='product', product_id=product['id'], basis=source.basis,
                          cost=product['latest_cost'] if source.basis == 'latest' else product['inventory_cost'],
                          special_allocation=product['special_allocation'], product_code=product['code'],
                          source_version=product['source_version'] or '')
        if source.kind == 'manual':
            return Source(kind='manual', cost=source.cost)
        if not source.product_id:
            raise ValueError('成本快照缺少产品')
        return Source(kind='snapshot', product_id=source.product_id, basis=source.basis,
                      cost=source.cost, special_allocation=source.special_allocation,
                      product_code=source.product_code, source_version=source.source_version)

    def evaluate(self, body: Evaluation, actor):
        source = self.resolve_source(body.source, actor)
        results = []
        for panel in body.panels:
            try:
                result = calculate_panel(panel, source.cost, special=source.special_allocation)
                auto_step = next((step for step in panel.steps if step.automatic_allocation), None)
                if auto_step is not None:
                    basis = result['target_cost'] if panel.direction == 'reverse' else source.cost
                    result['allocation_amount'] = money(_tier_amount(decimal(basis, source=True), auto_step.tiers))
                results.append({'id': panel.id, 'result': result, 'error': None})
            except (ValueError, ArithmeticError) as error:
                results.append({'id': panel.id, 'result': None, 'error': str(error)})
        return {'source': source.model_dump(), 'results': results,
                'default_allocation_tiers': [{'upper': upper, 'amount': amount} for upper, amount in ALLOCATION_TIERS]}

    def list_saved(self, actor):
        self.sales._authorize(actor)
        with transaction(self.url) as db:
            rows = db.execute('SELECT id,kind,name,revision,payload,created_at,updated_at FROM sales_calculator_saved '
                              'WHERE owner_id=%s ORDER BY updated_at DESC', (actor['id'],)).fetchall()
        return {'saved': [dict(id=row[0], kind=row[1], name=row[2], revision=row[3], payload=json.loads(row[4]),
                               created_at=row[5], updated_at=row[6]) for row in rows]}

    def save(self, body: SavedInput, actor, key: str | None = None):
        self.sales._authorize(actor, 3)
        if body.kind == 'template':
            name = (body.name or '').strip()
            if not name:
                raise ValueError('请输入公式模板名称')
            payload = Template.model_validate(body.payload).model_dump()
        else:
            workspace = Evaluation.model_validate(body.payload)
            source = self.resolve_source(workspace.source, actor)
            if source.kind == 'product':
                source.kind = 'snapshot'
            payload = Evaluation(source=source, panels=workspace.panels).model_dump()
            label = source.product_code or '手工成本'
            basis = (' · 库存优先' if source.basis == 'inventory' else ' · 最新优先') if source.kind != 'manual' else ''
            name = (body.name or '').strip() or f'{label}{basis} · {len(workspace.panels)} 个面板'
        stamp = now()
        with transaction(self.url, write=True) as db:
            if key is None:
                key = str(uuid4())
                db.execute('INSERT INTO sales_calculator_saved(id,owner_id,kind,name,revision,payload,created_at,updated_at) '
                           'VALUES(%s,%s,%s,%s,1,%s,%s,%s)', (key, actor['id'], body.kind, name, packed(payload), stamp, stamp))
            else:
                row = db.execute('SELECT kind,revision FROM sales_calculator_saved WHERE id=%s AND owner_id=%s',
                                 (key, actor['id'])).fetchone()
                if row is None:
                    raise KeyError(key)
                if row[0] != body.kind or row[1] != body.revision:
                    raise RuntimeError('方案已更新，请重新打开后再保存')
                db.execute('UPDATE sales_calculator_saved SET name=%s,revision=revision+1,payload=%s,updated_at=%s '
                           'WHERE id=%s AND owner_id=%s', (name, packed(payload), stamp, key, actor['id']))
        return next(row for row in self.list_saved(actor)['saved'] if row['id'] == key)

    def delete(self, key: str, actor):
        self.sales._authorize(actor, 3)
        with transaction(self.url, write=True) as db:
            row = db.execute('DELETE FROM sales_calculator_saved WHERE id=%s AND owner_id=%s RETURNING id',
                             (key, actor['id'])).fetchone()
            if row is None:
                raise KeyError(key)
        return {'deleted': key}
