"""Manager quotation batches with immutable calculations and adopted price versions."""
from __future__ import annotations

import json
from copy import deepcopy
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP, localcontext
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from api.postgres import transaction
from api.research import digest, now, packed
from api.research_formulas import DEFAULT_COMPOSITE

MODES = ('domestic_direct', 'domestic_intermediary', 'export_direct', 'export_intermediary')
REASONS = ('客户现用价格', '产品功能溢价', '高浓／开稀价格对照', '其他客户常规售价', '客户议价', '其他')
PARAMETERS = ('allocation', 'freight', 'barrel', 'tax', 'profit', 'reverse', 'export_addition_1', 'export_addition_2', 'export_multiplier')
ALLOCATION_TIERS = (("5", ".5"), ("10", ".8"), ("15", "1.2"), ("20", "1.5"),
                    ("25", "1.8"), ("30", "2.2"), (None, "2.5"))


def decimal(value, label='金额', *, source=False):
    if isinstance(value, bool) or len(str(value)) > 150:
        raise ValueError(f'{label}数字长度无效')
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise ValueError(f'{label}必须是数字') from None
    if not result.is_finite() or result < 0 or result > Decimal('1000000000') or (not source and result.as_tuple().exponent < -18):
        raise ValueError(f'{label}须为非负有限数字，最多18位小数且不超过十亿')
    return result


def money(value):
    with localcontext() as context:
        context.prec = 80
        return str(value.quantize(Decimal('.01'), rounding=ROUND_HALF_UP))


def allocation(cost):
    return next(fee for threshold, fee in ALLOCATION_TIERS if threshold is None or cost < Decimal(threshold))


def defaults(mode, cost=None, special=False):
    return dict(allocation=None if special or cost is None else allocation(decimal(cost, source=True)), freight='0.3', barrel='0.5',
                tax='1.11' if mode == 'domestic_direct' else '1.09', profit='1.1',
                reverse='1.07' if mode == 'domestic_direct' else '1.04',
                export_addition_1='0.75', export_addition_2='1.65', export_multiplier='1.15')


def calculate(mode, cost, parameters, special=False):
    cost = decimal(cost, '成本', source=True)
    required = ('export_addition_1', 'export_addition_2', 'export_multiplier') if mode.startswith('export') else ('allocation', 'freight', 'barrel', 'tax', 'profit', 'reverse')
    values = {key: decimal(parameters.get(key), key) for key in required}
    if special and not mode.startswith('export') and not Decimal('.3') <= values['allocation'] <= 1:
        raise ValueError('特殊公摊须在0.3至1元之间')
    with localcontext() as context:
        context.prec = 100
        if mode.startswith('export'):
            normal = (cost + values['export_addition_1'] + values['export_addition_2']) * values['export_multiplier']
            return {'normal_price': money(normal), 'break_even_price': None}
        base = (cost + values['allocation'] + values['freight'] + values['barrel']) * values['tax'] * values['reverse']
        return {'normal_price': money(base * values['profit']), 'break_even_price': money(base)}


class Body(BaseModel):
    model_config = ConfigDict(extra='forbid')


class NewBatch(Body):
    name: str = Field(default='新报价批次', min_length=1, max_length=120)
    mode: Literal['domestic_direct', 'domestic_intermediary', 'export_direct', 'export_intermediary'] = 'domestic_direct'
    copy_from: str | None = None


class ItemBody(BaseModel):
    # Ignore derived display fields returned by the API; they never establish trust.
    model_config = ConfigDict(extra='ignore')
    product_id: str = Field(min_length=1, max_length=200)
    external_name: str = Field(default='', max_length=200)
    cost_basis: Literal['latest', 'inventory'] = 'latest'
    parameters: dict[str, str | None] = Field(default_factory=dict)
    final_price: str | None = None
    pricing_reasons: list[str] = Field(default_factory=list, max_length=6)
    pricing_note: str = Field(default='', max_length=1000)
    reference_prices: dict[str, str] = Field(default_factory=dict, max_length=12)


class DraftBody(Body):
    revision: int = Field(ge=1)
    name: str = Field(min_length=1, max_length=120)
    mode: Literal['domestic_direct', 'domestic_intermediary', 'export_direct', 'export_intermediary']
    customer_name: str = Field(default='', max_length=200)
    customer_code: str = Field(default='', max_length=80)
    uncoded: bool = False
    salesperson: str = Field(default='', max_length=100)
    items: list[ItemBody] = Field(max_length=500)


class Selection(Body):
    revision: int = Field(ge=1)
    product_ids: list[str] = Field(min_length=1, max_length=500)


class CalculateBody(Selection):
    refresh_costs: bool = False
    confirm_manual_prices: bool = False


class AdoptBody(Selection):
    keep_stale_cost: bool = False
    confirm_below_break_even: bool = False


class ReasonBody(Selection):
    reason: str = Field(min_length=1, max_length=1000)


class CodeBody(Body):
    revision: int = Field(ge=1)
    customer_code: str = Field(min_length=1, max_length=80)


class SalesStore:
    def __init__(self, url):
        self.url = url

    @staticmethod
    def _authorize(actor, level=2):
        if not actor.get('is_system_admin') and actor.get('scope_levels', {}).get('sales', 0) < level:
            raise PermissionError('没有此项销售操作权限')

    def _catalog(self, db):
        pending = db.execute("SELECT status FROM research_events WHERE status!='done' ORDER BY _order LIMIT 1").fetchone()
        products = []
        for formula_raw in db.execute("SELECT formula FROM research_formulas WHERE lifecycle='active' ORDER BY position"):
            formula = json.loads(formula_raw[0])
            composite = formula['kind'] != 'recipe'
            if composite and formula['id'] != DEFAULT_COMPOSITE:
                continue
            record = db.execute('''SELECT r.sequence,r.payload,r.event_id,e.recorded_at
                FROM research_cost_records r LEFT JOIN research_events e ON e.id=r.event_id
                WHERE r.product_id=%s ORDER BY r.sequence DESC LIMIT 1''', (formula['id'],)).fetchone()
            payload = json.loads(record[1]) if record else {}
            code = 'CF401B' if composite else formula['name']
            products.append(dict(id='research:' + formula['id'], code=code, name=code, source='research', department='研发五部',
                                 latest_cost=payload.get('latest_cost'), inventory_cost=payload.get('inventory_cost'),
                                 status=('failed' if pending[0] == 'failed' else 'updating') if pending else payload.get('status', 'missing'),
                                 special_allocation=code.startswith(('CF', 'HM')), source_version=str(record[0]) if record else None,
                                 source_label='研发成本记录', source_date=payload.get('recorded_at') or payload.get('effective_date') or (record[3] if record else None)))
        batch = db.execute('SELECT id FROM procurement_price_batches ORDER BY version DESC LIMIT 1').fetchone()
        for ident, code, name, unit, latest, inventory, version, published_at, price_date in db.execute('''SELECT m.id,m.code,m.name,m.unit,b.latest_price,i.price,
                pb.version,pb.published_at,pb.price_date FROM procurement_materials m
                LEFT JOIN procurement_price_batch_items b ON b.material_id=m.id AND b.batch_id=%s
                LEFT JOIN procurement_price_batches pb ON pb.id=b.batch_id
                LEFT JOIN procurement_inventory i ON i.material_id=m.id WHERE m.archived_at IS NULL ORDER BY m.code''', (batch[0] if batch else None,)):
            if code == 'CF401B' or unit.lower().strip() not in ('kg', '公斤', '千克'):
                continue
            products.append(dict(id='procurement:' + ident, code=code, name=name, source='procurement', department='采购',
                                 latest_cost=latest, inventory_cost=inventory, status='ready' if latest is not None or inventory is not None else 'missing',
                                 special_allocation=code.startswith(('CF', 'HM')), source_version=f'采购价 v{version}' if version is not None else digest([latest, inventory]),
                                 source_label='采购原料价格', source_date=price_date or published_at))
        return {p['id']: p for p in products}, bool(pending)

    def products(self, actor):
        self._authorize(actor)
        with transaction(self.url) as db:
            products, pending = self._catalog(db)
            return {'products': list(products.values()), 'pending': pending, 'defaults': {mode: defaults(mode) for mode in MODES},
                    'unmapped_oil_notice': '原油清单尚待明确关联产品；未关联产品不参与报价。'}

    def _get(self, db, key, actor, revision=None):
        self._authorize(actor)
        row = db.execute('SELECT owner_id,revision,payload FROM sales_batches WHERE id=%s', (key,)).fetchone()
        if not row:
            raise KeyError('报价批次不存在')
        if row[0] != actor['id'] and not actor.get('is_system_admin'):
            raise PermissionError('只能操作自己的报价批次')
        if revision is not None and row[1] != revision:
            raise RuntimeError('报价批次已被其他操作更新，请刷新后重试')
        return json.loads(row[2])

    def _event(self, db, batch, actor, kind, payload):
        db.execute('INSERT INTO sales_events(id,batch_id,actor_id,created_at,kind,payload) VALUES(%s,%s,%s,%s,%s,%s)',
                   (str(uuid4()), batch['id'], actor['id'], now(), kind, packed(payload)))

    def _write(self, db, batch, actor, kind, details=None):
        batch['revision'] += 1
        batch['updated_at'] = now()
        db.execute('UPDATE sales_batches SET revision=%s,payload=%s,updated_at=%s WHERE id=%s',
                   (batch['revision'], packed(batch), batch['updated_at'], batch['id']))
        self._event(db, batch, actor, kind, details or {})
        return {'batch': batch}

    def batches(self, actor):
        self._authorize(actor)
        with transaction(self.url) as db:
            return {'batches': [json.loads(r[0]) for r in db.execute('SELECT payload FROM sales_batches WHERE owner_id=%s OR %s ORDER BY updated_at DESC', (actor['id'], bool(actor.get('is_system_admin'))))]}

    def detail(self, key, actor):
        with transaction(self.url) as db:
            batch = self._get(db, key, actor)
            events = [dict(id=r[0], actor_id=r[1], created_at=r[2], kind=r[3], actor_name=r[5], **json.loads(r[4])) for r in db.execute('SELECT e.id,e.actor_id,e.created_at,e.kind,e.payload,u.display_name FROM sales_events e JOIN identity_users u ON u.id=e.actor_id WHERE e.batch_id=%s ORDER BY e.created_at', (key,))]
            return {'batch': batch, 'events': events}

    @staticmethod
    def _cost(product, basis):
        if product['status'] not in ('ready', 'missing'):
            return None, None
        primary = product.get(basis + '_cost')
        if primary is not None and (product['source'] == 'research' or basis == 'latest' or decimal(primary, source=True) > 0):
            return primary, basis
        alternate = 'inventory' if basis == 'latest' else 'latest'
        fallback = product.get(alternate + '_cost')
        return (fallback, alternate) if fallback is not None and (product['source'] == 'research' or alternate == 'latest' or decimal(fallback, source=True) > 0) else (None, None)

    def _new_item(self, product, mode, basis='latest'):
        cost, actual = self._cost(product, basis)
        return dict(product_id=product['id'], product=deepcopy(product), cost_basis=basis, cost=cost, actual_basis=actual,
                    external_name='', parameters=defaults(mode, cost, product['special_allocation']), final_price=None,
                    pricing_reasons=[], pricing_note='', reference_prices={}, result=None, trial_id=None,
                    manual_price_confirmed=False, manual_price=False, adopted=False, adjustment_reason=None)

    @staticmethod
    def _follow_defaults(parameters, before, after):
        for key in PARAMETERS:
            current = parameters.get(key)
            if current == before[key] or (current is not None and before[key] is not None and decimal(current) == decimal(before[key])):
                parameters[key] = after[key]

    def create(self, body, actor):
        self._authorize(actor, 3)
        with transaction(self.url, write=True) as db:
            stamp = now()
            batch = dict(id=str(uuid4()), owner_id=actor['id'], revision=1, name=body['name'].strip(), mode=body['mode'],
                         customer_name='', customer_code='', uncoded=False, salesperson='', items=[], created_at=stamp, updated_at=stamp, adjusted=False)
            if not batch['name']:
                raise ValueError('批次名称不能为空')
            if body.get('copy_from'):
                old = self._get(db, body['copy_from'], actor)
                catalog, _ = self._catalog(db)
                batch['mode'] = old['mode']
                for item in old['items']:
                    if item['product_id'] not in catalog:
                        raise ValueError('原批次含已停用产品，请新建批次重新选择')
                    fresh = self._new_item(catalog[item['product_id']], batch['mode'], item['cost_basis'])
                    for key in ('parameters', 'external_name', 'pricing_reasons', 'pricing_note', 'reference_prices'):
                        fresh[key] = deepcopy(item[key])
                    self._follow_defaults(fresh['parameters'], defaults(old['mode'], item['cost'], item['product']['special_allocation']),
                                          defaults(batch['mode'], fresh['cost'], fresh['product']['special_allocation']))
                    batch['items'].append(fresh)
                batch['copied_from'] = old['id']
            db.execute('INSERT INTO sales_batches(id,owner_id,revision,payload,created_at,updated_at) VALUES(%s,%s,1,%s,%s,%s)', (batch['id'], actor['id'], packed(batch), stamp, stamp))
            self._event(db, batch, actor, 'create', {'copied_from': body.get('copy_from')})
            return {'batch': batch}

    @staticmethod
    def _input(item):
        return {key: deepcopy(item.get(key)) for key in ('product_id', 'external_name', 'cost_basis', 'parameters', 'final_price', 'pricing_reasons', 'pricing_note', 'reference_prices')}

    def save(self, key, body, actor):
        self._authorize(actor, 3)
        with transaction(self.url, write=True) as db:
            batch = self._get(db, key, actor, body['revision'])
            old = {item['product_id']: item for item in batch['items']}
            identifiers = [item['product_id'] for item in body['items']]
            if len(set(identifiers)) != len(identifiers):
                raise ValueError('同一批次不能重复添加产品')
            has_record = db.execute('SELECT 1 FROM sales_records WHERE batch_id=%s LIMIT 1', (key,)).fetchone()
            if has_record and any(body[field].strip() != batch[field] for field in ('customer_name', 'salesperson')):
                raise ValueError('已采用批次不能更换客户或业务员，请新建批次')
            if has_record and (body['customer_code'].strip() != batch['customer_code'] or body['uncoded'] != batch['uncoded']):
                raise ValueError('已采用批次请使用客户编码补录操作')
            if has_record and body['mode'] != batch['mode']:
                raise ValueError('已采用批次不能更换报价类型，请新建批次')
            if any(item['adopted'] and ident not in identifiers for ident, item in old.items()):
                raise ValueError('已采用产品不能删除，请使用作废')
            catalog, _ = self._catalog(db)
            items = []
            for incoming in body['items']:
                ident = incoming['product_id']
                previous = old.get(ident)
                if previous is None:
                    if ident not in catalog:
                        raise ValueError('产品不存在或已停用')
                    item = self._new_item(catalog[ident], body['mode'], incoming['cost_basis'])
                else:
                    item = deepcopy(previous)
                if set(incoming['parameters']) - set(PARAMETERS):
                    raise ValueError('未知报价参数')
                for param, value in incoming['parameters'].items():
                    if value is not None:
                        decimal(value, param)
                if any(reason not in REASONS for reason in incoming['pricing_reasons']):
                    raise ValueError('未知定价依据')
                if len(set(incoming['pricing_reasons'])) != len(incoming['pricing_reasons']):
                    raise ValueError('定价依据不能重复')
                if any(len(k) > 100 or len(v) > 500 for k, v in incoming['reference_prices'].items()):
                    raise ValueError('参考价格说明过长')
                if incoming['final_price'] is not None:
                    incoming['final_price'] = money(decimal(incoming['final_price'], '最终报价'))
                merged = self._input(item)
                merged.update(incoming)
                merged['parameters'] = {**item['parameters'], **incoming['parameters']}
                changed = merged != self._input(item) or batch['mode'] != body['mode']
                if previous and previous['adopted'] and changed and not previous.get('adjustment_reason'):
                    raise ValueError('已采用产品须先选择调整原因')
                if changed:
                    prior_price = item['final_price']
                    prior_defaults = defaults(batch['mode'], item['cost'], item['product']['special_allocation'])
                    item.update(merged)
                    item['cost'], item['actual_basis'] = self._cost(item['product'], item['cost_basis'])
                    if batch['mode'] != body['mode'] or (previous and previous['cost_basis'] != item['cost_basis']):
                        self._follow_defaults(item['parameters'], prior_defaults, defaults(body['mode'], item['cost'], item['product']['special_allocation']))
                    if item['final_price'] != prior_price:
                        item['manual_price'] = item['final_price'] is not None
                    item.update(result=None, trial_id=None, manual_price_confirmed=False)
                items.append(item)
            for field in ('name', 'customer_name', 'customer_code', 'salesperson'):
                batch[field] = body[field].strip()
            if not batch['name']:
                raise ValueError('批次名称不能为空')
            batch.update(mode=body['mode'], uncoded=body['uncoded'], items=items)
            if batch['uncoded'] and batch['customer_code']:
                raise ValueError('暂未编码与客户编码不能同时填写')
            return self._write(db, batch, actor, 'save_draft')

    @staticmethod
    def _selected(batch, identifiers):
        if len(identifiers) != len(set(identifiers)):
            raise ValueError('选择的产品不能重复')
        items = [item for item in batch['items'] if item['product_id'] in identifiers]
        if not items or len(items) != len(identifiers):
            raise ValueError('请选择当前批次中的产品')
        return items

    def trial(self, key, body, actor):
        self._authorize(actor, 3)
        with transaction(self.url, write=True) as db:
            batch = self._get(db, key, actor, body['revision'])
            selected = self._selected(batch, body['product_ids'])
            catalog, _ = self._catalog(db)
            trial_id, stamp = str(uuid4()), now()
            for item in selected:
                if item['adopted'] and not item.get('adjustment_reason'):
                    raise ValueError('已采用产品须先选择调整原因')
                if body.get('refresh_costs'):
                    product = catalog.get(item['product_id'])
                    if product is None:
                        raise ValueError('产品已停用，不能刷新成本')
                    prior_default = defaults(batch['mode'], item['cost'], item['product']['special_allocation'])['allocation']
                    item['product'] = deepcopy(product)
                    item['cost'], item['actual_basis'] = self._cost(product, item['cost_basis'])
                    if item['parameters']['allocation'] == prior_default:
                        item['parameters']['allocation'] = defaults(batch['mode'], item['cost'], product['special_allocation'])['allocation']
                if item['cost'] is None:
                    raise ValueError(f"{item['product']['code']}缺少可用正式成本，不能测算")
                item['result'] = calculate(batch['mode'], item['cost'], item['parameters'], item['product']['special_allocation'])
                if not item.get('manual_price'):
                    item['final_price'] = item['result']['normal_price']
                    item['manual_price_confirmed'] = True
                else:
                    item['manual_price_confirmed'] = bool(body.get('confirm_manual_prices'))
                item['trial_id'] = trial_id
            payload = dict(id=trial_id, batch_id=key, batch_name=batch['name'], mode=batch['mode'],
                           customer_name=batch['customer_name'], customer_code=batch['customer_code'], uncoded=batch['uncoded'], salesperson=batch['salesperson'],
                           actor_id=actor['id'], created_at=stamp, items=deepcopy(selected))
            db.execute('INSERT INTO sales_trials(id,batch_id,actor_id,created_at,payload) VALUES(%s,%s,%s,%s,%s)', (trial_id, key, actor['id'], stamp, packed(payload)))
            return self._write(db, batch, actor, 'calculate', {'trial_id': trial_id})

    @staticmethod
    def _reason_required(batch, item):
        standard = defaults(batch['mode'], item['cost'], item['product']['special_allocation'])
        keys = ('export_addition_1', 'export_addition_2', 'export_multiplier') if batch['mode'].startswith('export') else ('allocation', 'freight', 'barrel', 'tax', 'profit', 'reverse')
        changed = any(standard[k] is not None and decimal(item['parameters'][k]) != decimal(standard[k]) for k in keys)
        manual = item['final_price'] != item['result']['normal_price']
        if (changed or manual) and not item['pricing_reasons']:
            raise ValueError('调整参数或最终报价后，请选择定价依据')
        if '其他' in item['pricing_reasons'] and not item['pricing_note'].strip():
            raise ValueError('定价依据选择其他时，请填写简短说明')

    def adopt(self, key, body, actor):
        self._authorize(actor, 4)
        with transaction(self.url, write=True) as db:
            batch = self._get(db, key, actor, body['revision'])
            if not batch['customer_name'] or not batch['salesperson'] or not (batch['customer_code'] or batch['uncoded']):
                raise ValueError('采用前须填写客户名称、客户编码或暂未编码、业务员')
            catalog, _ = self._catalog(db)
            selected = self._selected(batch, body['product_ids'])
            for item in selected:
                if item['adopted'] and not item.get('adjustment_reason'):
                    raise RuntimeError('该产品已经采用，不能重复采用')
                if not item['result'] or not item['trial_id']:
                    raise ValueError('参数已变化或尚未测算，请先重新测算')
                if not item['manual_price_confirmed']:
                    raise ValueError('重新测算后须确认保留手动报价，或使用新的测算结果')
                expected = calculate(batch['mode'], item['cost'], item['parameters'], item['product']['special_allocation'])
                if expected != item['result']:
                    raise ValueError('测算结果已失效，请重新测算')
                self._reason_required(batch, item)
                live = catalog.get(item['product_id'])
                stale = live != item['product']
                if stale and not body.get('keep_stale_cost'):
                    raise RuntimeError('产品成本或状态已更新，请刷新成本重新测算，或明确保留原成本依据')
                below = expected['break_even_price'] is not None and decimal(item['final_price']) < decimal(expected['break_even_price'])
                if below and (not body.get('confirm_below_break_even') or not item['pricing_reasons']):
                    raise ValueError('低于盈亏平衡参考价，请选择定价依据并确认采用')
                version = db.execute('SELECT COALESCE(MAX(version),0)+1 FROM sales_records WHERE batch_id=%s AND product_id=%s', (key, item['product_id'])).fetchone()[0]
                db.execute("UPDATE sales_records SET status='superseded' WHERE batch_id=%s AND product_id=%s AND status='active'", (key, item['product_id']))
                ident, stamp = str(uuid4()), now()
                payload = dict(id=ident, batch_id=key, batch_name=batch['name'], product_id=item['product_id'], version=version, status='active',
                               actor_id=actor['id'], owner_id=batch['owner_id'], created_at=stamp, mode=batch['mode'],
                               customer_name=batch['customer_name'], customer_code=batch['customer_code'], uncoded=batch['uncoded'], salesperson=batch['salesperson'],
                               item=deepcopy(item), kept_stale_cost=stale, below_break_even=below)
                db.execute('INSERT INTO sales_records(id,batch_id,product_id,version,status,actor_id,created_at,payload) VALUES(%s,%s,%s,%s,\'active\',%s,%s,%s)', (ident, key, item['product_id'], version, actor['id'], stamp, packed(payload)))
                if item.get('adjustment_reason'):
                    batch['adjusted'] = True
                item.update(adopted=True, adjustment_reason=None, record_id=ident, record_version=version, voided=False)
            return self._write(db, batch, actor, 'adopt', {'product_ids': body['product_ids']})

    def revise(self, key, body, actor):
        self._authorize(actor, 4)
        if not body['reason'].strip():
            raise ValueError('请填写调整原因')
        with transaction(self.url, write=True) as db:
            batch = self._get(db, key, actor, body['revision'])
            for item in self._selected(batch, body['product_ids']):
                if not item['adopted']:
                    raise ValueError('尚未采用的产品可直接编辑草稿')
                item['adjustment_reason'] = body['reason'].strip()
                item.update(result=None, trial_id=None, manual_price_confirmed=False)
            return self._write(db, batch, actor, 'revise', {'product_ids': body['product_ids'], 'reason': body['reason']})

    def customer_code(self, key, body, actor):
        self._authorize(actor, 3)
        if not body['customer_code'].strip():
            raise ValueError('客户编码不能为空')
        with transaction(self.url, write=True) as db:
            batch = self._get(db, key, actor, body['revision'])
            previous = batch['customer_code']
            batch.update(customer_code=body['customer_code'].strip(), uncoded=False)
            return self._write(db, batch, actor, 'customer_code', {'previous': previous, 'customer_code': batch['customer_code']})

    def void(self, key, body, actor):
        self._authorize(actor, 4)
        if not body['reason'].strip():
            raise ValueError('请填写作废原因')
        with transaction(self.url, write=True) as db:
            batch = self._get(db, key, actor, body['revision'])
            for item in self._selected(batch, body['product_ids']):
                result = db.execute("UPDATE sales_records SET status='void' WHERE batch_id=%s AND product_id=%s AND status='active' RETURNING id", (key, item['product_id'])).fetchone()
                if not result:
                    raise ValueError('产品没有可作废的有效报价')
                item.update(voided=True, adopted=True, adjustment_reason=None, result=None, trial_id=None)
            return self._write(db, batch, actor, 'void', {'product_ids': body['product_ids'], 'reason': body['reason']})

    def history(self, actor, records=False):
        self._authorize(actor)
        with transaction(self.url) as db:
            if records:
                values = []
                for raw, status, batch_raw, actor_name in db.execute('SELECT r.payload,r.status,b.payload,u.display_name FROM sales_records r JOIN sales_batches b ON b.id=r.batch_id JOIN identity_users u ON u.id=r.actor_id WHERE b.owner_id=%s OR %s ORDER BY r.created_at DESC', (actor['id'], bool(actor.get('is_system_admin')))):
                    item, batch = json.loads(raw), json.loads(batch_raw)
                    item.update(status=status, actor_name=actor_name, current_customer_code=batch['customer_code'], current_uncoded=batch['uncoded'])
                    values.append(item)
                return {'records': values}
            return {'trials': [dict(json.loads(r[0]), actor_name=r[1]) for r in db.execute('SELECT t.payload,u.display_name FROM sales_trials t JOIN sales_batches b ON b.id=t.batch_id JOIN identity_users u ON u.id=t.actor_id WHERE b.owner_id=%s OR %s ORDER BY t.created_at DESC', (actor['id'], bool(actor.get('is_system_admin'))))]}


def create_sales_router(store, settings):
    from api.sales_calculator import CalculatorStore, Evaluation, SavedInput
    calculator = CalculatorStore(store)
    router = APIRouter(prefix='/api/workbenches/sales', tags=['sales'])

    def actor(request, level=2):
        if settings.workbench_modes['sales'] != 'active':
            raise HTTPException(404, '销售工作台未启用')
        if getattr(request.app.state, 'sales_error', None):
            raise HTTPException(503, '销售工作台暂时不可用')
        user = getattr(request.state, 'current_user', None)
        if not user:
            raise HTTPException(401, '请登录')
        try:
            store._authorize(user, level)
        except PermissionError as error:
            raise HTTPException(403, str(error)) from error
        return user

    def run(fn, *args):
        try:
            return fn(*args)
        except PermissionError as error:
            raise HTTPException(403, str(error)) from error
        except KeyError as error:
            raise HTTPException(404, str(error)) from error
        except RuntimeError as error:
            raise HTTPException(409, str(error)) from error
        except (ValueError, ArithmeticError) as error:
            raise HTTPException(422, str(error)) from error

    @router.get('/products')
    def products(request: Request):
        return run(store.products, actor(request))

    @router.get('/batches')
    def batches(request: Request):
        return run(store.batches, actor(request))

    @router.post('/batches')
    def create(body: NewBatch, request: Request):
        return run(store.create, body.model_dump(), actor(request, 3))

    @router.get('/batches/{key}')
    def detail(key: str, request: Request):
        return run(store.detail, key, actor(request))

    @router.put('/batches/{key}/draft')
    def save(key: str, body: DraftBody, request: Request):
        return run(store.save, key, body.model_dump(), actor(request, 3))

    @router.post('/batches/{key}/calculate')
    def trial(key: str, body: CalculateBody, request: Request):
        return run(store.trial, key, body.model_dump(), actor(request, 3))

    @router.post('/batches/{key}/adopt')
    def adopt(key: str, body: AdoptBody, request: Request):
        return run(store.adopt, key, body.model_dump(), actor(request, 4))

    @router.post('/batches/{key}/revise')
    def revise(key: str, body: ReasonBody, request: Request):
        return run(store.revise, key, body.model_dump(), actor(request, 4))

    @router.post('/batches/{key}/customer-code')
    def customer_code(key: str, body: CodeBody, request: Request):
        return run(store.customer_code, key, body.model_dump(), actor(request, 3))

    @router.post('/batches/{key}/void')
    def void(key: str, body: ReasonBody, request: Request):
        return run(store.void, key, body.model_dump(), actor(request, 4))

    @router.get('/history')
    def history(request: Request):
        return run(store.history, actor(request))

    @router.get('/records')
    def records(request: Request):
        return run(store.history, actor(request), True)

    @router.post('/calculator/evaluate')
    def calculator_evaluate(body: dict, request: Request):
        user = actor(request)
        return run(calculator.evaluate, run(Evaluation.model_validate, body), user)

    @router.get('/calculator/saved')
    def calculator_saved(request: Request):
        return run(calculator.list_saved, actor(request))

    @router.post('/calculator/saved')
    def calculator_create(body: dict, request: Request):
        user = actor(request, 3)
        return run(calculator.save, run(SavedInput.model_validate, body), user)

    @router.put('/calculator/saved/{key}')
    def calculator_update(key: str, body: dict, request: Request):
        user = actor(request, 3)
        return run(calculator.save, run(SavedInput.model_validate, body), user, key)

    @router.delete('/calculator/saved/{key}')
    def calculator_delete(key: str, request: Request):
        return run(calculator.delete, key, actor(request, 3))

    return router
