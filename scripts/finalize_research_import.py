"""Apply confirmed import scope and price review to an independent candidate."""
from __future__ import annotations

import argparse
import csv
import json
import shutil
import sqlite3
from collections import Counter, defaultdict
from copy import deepcopy
from decimal import Decimal
from pathlib import Path

from api.research_formulas import calculate
from reconcile_research_import import digest, formula_digest, packed, price_codes, write_csv


def finalize(prior: Path, master: Path, output: Path):
    # ponytail: Bound to the approved v40 batch; rebind source evidence for a new batch.
    assert not output.exists(), '使用新的输出目录，保留历史核验结果'
    decisions = json.loads(master.read_text(encoding='utf-8'))
    prior_decisions = json.loads((prior / master.name).read_text(encoding='utf-8'))
    assert {k: v for k, v in decisions.items() if k not in {'product_import_exclusions', 'product_code_corrections'}} == prior_decisions
    before = deepcopy(decisions)
    old = sqlite3.connect((prior / '研发数据分析.db').as_uri() + '?mode=ro', uri=True)
    old.row_factory = sqlite3.Row
    rows = {r['product']: dict(r) for r in old.execute('SELECT * FROM resolved_formulas')}
    formulas = {c: json.loads(r['formula_json']) for c, r in rows.items()}
    assert len(formulas) == 2380 and len(decisions['yield_selections']) == 233
    sources = {r['kind']: dict(r) for r in old.execute('SELECT * FROM sources')}
    for source in sources.values():
        assert digest(prior / '来源原件' / source['filename']) == source['sha256']
    raw_prices = {str(json.loads(r['values_json'])[8]): (r['source_row'], json.loads(r['values_json']))
                  for r in old.execute("SELECT * FROM raw_rows WHERE kind='erp_prices'")}
    stock = [(r['source_row'], json.loads(r['values_json'])) for r in old.execute("SELECT * FROM raw_rows WHERE kind='erp_stock'")]
    original = json.loads((prior / '成本试算输入.json').read_text(encoding='utf-8'))
    payload = deepcopy(original)
    package, prices = payload['package'], payload['prices']
    excluded = set(decisions['product_import_exclusions']['products'])
    assert len(excluded) == 9 and excluded <= formulas.keys()
    renames = decisions['product_code_corrections']
    assert set(renames) == {'K112-LAJ\n112-L'}
    old_ids = {c: formulas[c]['id'] for c in excluded | renames.keys()}
    for source_code, choice in renames.items():
        target = choice['canonical_code']
        assert target not in formulas and choice['bom_sha256'] == sources['bom']['sha256']
        f = formulas.pop(source_code)
        assert f['source_row'] == choice['bom_header_row']
        f.update(id='recipe:' + target, name=target, source_product_code=source_code)
        formulas[target] = f
        rows[target] = rows.pop(source_code)
        for recipe in package['recipes']:
            if recipe['id'] == old_ids[source_code]:
                recipe.update(id=f['id'], name=target, source_product_code=source_code)
            for line in recipe['lines']:
                if line['ref'] == old_ids[source_code]:
                    assert line['kind'] == 'recipe'
                    line.update(ref=f['id'], code=target, source_product_code=source_code)
    excluded_ids = {old_ids[c] for c in excluded}
    package['recipes'] = [f for f in package['recipes'] if f['id'] not in excluded_ids]
    active = {c: f for c, f in formulas.items() if c not in excluded}
    assert len(active) == 2371
    assert not any(l['ref'] in excluded_ids or l['code'] in excluded or l.get('price_ref') in excluded
                   or set(l.get('price_refs', [])) & excluded for f in package['recipes'] for l in f['lines'])

    # Bind the approved existing recipe by its snapshot fingerprint and ERP row.
    rg = next(f for f in package['recipes'] if f['name'] == 'RG-1A')
    rg_parent = next(f for f in package['recipes'] if f['name'] == 'RG-2A')
    line = next(l for l in rg_parent['lines'] if l['source_row'] == 3166)
    assert line == next(l for l in formulas['RG-2A']['lines'] if l['source_row'] == 3166)
    assert line['code'] == line['ref'] == 'RG-1A' and line['kind'] == 'material' and Decimal(line['quantity']) == 400
    assert rg['owner'] == '卢彬' and rg['source_row'] == 24
    reference_choice = {'confirmed_on': '2026-10-09', 'source': 'user_plan_approval', 'product': 'RG-2A',
                        'source_row': 3166, 'input_code': 'RG-1A', 'reference_recipe_id': rg['id'],
                        'reference_recipe_sha256': formula_digest(rg), 'snapshot_sha256': digest(prior / '现有系统只读基线-20261007.json'),
                        'rule': '引用现役配方动态成本，保留ERP原投料，不视为ERP库存原价'}
    line.update(kind='recipe', ref=rg['id'], reference_confirmation=reference_choice)
    formulas['RG-2A'] = rg_parent
    active['RG-2A'] = rg_parent
    decisions['recipe_input_selections'] = [reference_choice]

    pn, pr = raw_prices['1031010022']
    matches = [(n, r) for n, r in stock if r[5] == 'CF026K']
    assert pn == 256 and pr[9] == 'CF026K' and Decimal(str(pr[12])) == Decimal('8.0689')
    assert len(matches) == 1 and str(matches[0][1][4]) == str(pr[8]) and matches[0][1][7] == 'kg'
    sn, sr = matches[0]
    prices['CF026K']['inventory_price'] = str(pr[12])
    price_match = {'confirmed_on': '2026-10-09', 'source': 'same_erp_item_match', 'code': 'CF026K', 'item': str(pr[8]),
                   'price_source_row': pn, 'stock_source_rows': [sn], 'unit_price': str(pr[12]),
                   'price_source_sha256': sources['erp_prices']['sha256'], 'stock_source_sha256': sources['erp_stock']['sha256']}
    decisions['existing_recipe_price_reconciliation'] = [price_match]

    cp, cr = raw_prices['1020110002']
    assert cp == 29 and cr[9] == 'CF003' and Decimal(str(cr[12])) == Decimal('718.6')
    assert Decimal(str(cr[11])) / Decimal(str(cr[10])) == Decimal(str(cr[12]))
    assert prices['CF003'] == {'latest_price': '9', 'inventory_price': '718.6'}
    prices['CF003']['inventory_price_pending_review'] = True
    review = {'confirmed_on': '2026-10-09', 'source': 'user_plan_approval', 'status': 'pending_ERP_price_verification',
              'item': str(cr[8]), 'price_source_row': cp, 'source_sha256': sources['erp_prices']['sha256'],
              'ERP_unit_price': str(cr[12]), 'price_quantity': str(cr[10]), 'price_amount': str(cr[11]),
              'latest_purchase_price': '9', 'rule': '保留原ERP价；待确认库存成本不能由零价、手动成本或库存兜底掩盖'}
    decisions['inventory_price_reviews'] = {'CF003': review}

    previous_issues = [dict(r) for r in old.execute('SELECT * FROM review_issues')]
    mes_codes = {r['product'] for r in previous_issues if r['category'] == 'MES无对应BOM'}
    owner_codes = {r['product'] for r in previous_issues if r['category'] == '负责人无对应BOM'}
    uses = defaultdict(set)
    for f in package['recipes']:
        for l in f['lines']:
            if Decimal(l['quantity']) != 0:
                uses[l['code']].add(f['name'])
                if l['kind'] == 'material':
                    for ref in price_codes(l):
                        uses[ref].add(f['name'])
    priced = {r[9] for _, r in raw_prices.values()}
    orphan_groups = {'MES有价投料保留': sorted(c for c in mes_codes if uses[c] and c in priced),
                     'MES未引用暂存': sorted(c for c in mes_codes if not uses[c]),
                     'MES被引用缺价待补': sorted(c for c in mes_codes if uses[c] and c not in priced),
                     '负责人无BOM暂存': sorted(owner_codes)}
    assert [len(orphan_groups[k]) for k in orphan_groups] == [20, 15, 3, 3]
    assert all(not uses[c] for c in owner_codes)
    decisions['unmatched_record_confirmation'] = {'confirmed_on': '2026-10-09', 'source': 'user_plan_approval',
                                                 'groups': orphan_groups, 'rule': '不新增无BOM产品台账；原始记录保留，不按后缀拼接或停用现役产品'}
    assert {k: v for k, v in decisions.items() if k not in {'recipe_input_selections', 'existing_recipe_price_reconciliation', 'inventory_price_reviews', 'unmatched_record_confirmation'}} == before

    policy_prices = {'latest': prices, 'inventory': {c: dict(v, latest_price='0' if c == '纯水' else None) for c, v in prices.items()}}
    results = {p: calculate(package, values, price_policy=p) for p, values in policy_prices.items()}
    costs = {(c, p): results[p][f['id']] for c, f in active.items() for p in results}
    assert len(costs) == 4742
    assert abs(Decimal(costs['RG-2A', 'latest']['cost']) - Decimal('17.33921536177491035770498724')) < Decimal('1e-20')
    assert costs['RG-2A', 'inventory']['missing_materials'] == ['CF001M']
    held = sorted(c for c, f in active.items() if results['inventory'][f['id']].get('price_review_pending'))
    assert held and all(costs[c, 'inventory']['cost'] is None and costs[c, 'inventory']['price_review_pending'] == ['CF003'] for c in held)
    assert all(not r.get('price_review_pending') for r in results['latest'].values())
    assert not any(l['basis'] == 'erp_inventory_fallback' and l.get('price_review_pending') for r in results['inventory'].values() for l in r['lines'])
    prior_costs = {(r['product'], r['policy']): json.loads(r['result_json']) for r in old.execute('SELECT * FROM trial_costs')}
    changes = [(c, p, prior_costs[c, p], r) for (c, p), r in costs.items() if c != 'K112-LAJ' and prior_costs[c, p] != r]
    assert [c for c, p, _, _ in changes if p == 'latest'] == ['RG-2A']
    missing_direct = {ref for f in active.values() for l in f['lines'] if l['kind'] == 'material' and Decimal(l['quantity']) != 0 for ref in price_codes(l)
                      if ref not in before['unpriced_zero_cost_inputs'] and prices.get(ref, {}).get('latest_price') is None and prices.get(ref, {}).get('inventory_price') is None}
    assert len(missing_direct) == 200
    next_issues = [dict(r) for r in previous_issues if r['category'] not in {'无MES的替代收率异常', '产品编码格式', '直接投料仍无可用价格'}]
    group_by_code = {c: k for k, group in orphan_groups.items() for c in group}
    for r in next_issues:
        if r['product'] in group_by_code:
            r.update(status='已确认暂存' if '暂存' in group_by_code[r['product']] else '已确认作为有价投料' if r['product'] in orphan_groups['MES有价投料保留'] else '待补资料', decision=group_by_code[r['product']])
        if r['category'] == '库存品号缺ERP单价':
            c = r['product']
            if c in active and costs[c, 'inventory']['cost'] is not None:
                r.update(status='已确认BOM核算', decision='ERP原价保持空，按BOM成本核算')
    for c in sorted(missing_direct):
        next_issues.append({'category': '直接投料仍无可用价格', 'product': c, 'evidence_json': packed({'直接引用产品': sorted(uses[c]), '说明': '未提供有效价格，缺价不填0'}), 'status': '待补资料', 'decision': ''})
    next_issues.append({'category': 'ERP库存单价待确认', 'product': 'CF003', 'evidence_json': packed(dict(review, affected_products=held)), 'status': '待确认', 'decision': '暂挂相关库存成本'})
    extras = ['CF001M', 'CF004C', 'CF018', 'CF1138', 'CF236']
    assert all(prices[c]['latest_price'] is not None and prices[c]['inventory_price'] is None for c in extras)
    for c in extras:
        next_issues.append({'category': '仅缺ERP库存单价', 'product': c, 'evidence_json': packed(prices[c]), 'status': '待补资料', 'decision': '最新价可用，库存价不得混用'})

    output.mkdir()
    evidence = output / '核验记录'
    evidence.mkdir()
    shutil.copytree(prior / '来源原件', output / '来源原件')
    for name in ['现有系统只读基线-20261007.json', '已确认现役配方采用清单.csv', '已确认参考取价清单.csv', '参考均价组成.csv']:
        shutil.copy2(prior / name, output / name)
    shutil.copy2(master, evidence / '业务确认-本轮处理前备份.json')
    db = sqlite3.connect(output / '研发数据分析.db')
    old.backup(db)
    db.execute('DELETE FROM resolved_formulas')
    for c, f in formulas.items():
        if c in excluded:
            f = dict(f, import_status='confirmed_inactive_excluded')
        db.execute('INSERT INTO resolved_formulas VALUES(?,?,?,?)', (c, packed(f), rows[c]['source_blocks_json'], rows[c]['selection_basis']))
    db.execute('DELETE FROM trial_costs')
    def status(result):
        return '价格待确认' if result.get('price_review_pending') else '缺价' if result['cost'] is None else '试算可计算'
    for (c, p), r in costs.items():
        db.execute('INSERT INTO trial_costs VALUES(?,?,?,?,?,?)', (c, p, r['cost'], packed(r['missing_materials']), status(r), packed(r)))
    db.execute('DELETE FROM review_issues')
    for r in next_issues:
        db.execute('INSERT INTO review_issues(category,product,evidence_json,status,decision) VALUES(?,?,?,?,?)', tuple(r[k] for k in ['category', 'product', 'evidence_json', 'status', 'decision']))
    db.execute('UPDATE business_decisions SET payload_json=?', (packed(decisions),))
    rules = json.loads(old.execute('SELECT payload_json FROM confirmed_rules').fetchone()[0])
    rules.update({k: decisions[k] for k in ['product_import_exclusions', 'product_code_corrections', 'recipe_input_selections', 'existing_recipe_price_reconciliation', 'inventory_price_reviews', 'unmatched_record_confirmation']})
    db.execute('UPDATE confirmed_rules SET payload_json=?', (packed(rules),))
    inventory_evidence = {'库存行': [sn], '价格记录': [{'行号': pn, '品号': pr[8], '创建日期': pr[13], '单位成本': pr[12]}], '来源': 'ERP 库存', '库存数量截止日期': '2026-10-07', '取价核对': price_match}
    db.execute('INSERT OR REPLACE INTO material_candidates VALUES(?,?,?,?,?,?)', ('CF026K', sr[7], str(sr[9]), str(pr[12]), prices['CF026K']['latest_price'], packed(inventory_evidence)))
    db.execute('INSERT OR REPLACE INTO inventory_rows VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', (sn, sr[5], str(sr[4]), sr[1], sr[3], sr[8], str(sr[9]), sr[7], str(pr[12]), pn, pr[3], pr[5], 0))
    for c in ['RG-2A', 'K112-LAJ']:
        old_code = 'K112-LAJ\n112-L' if c == 'K112-LAJ' else c
        row = old.execute('SELECT evidence_json FROM system_differences WHERE product=?', (old_code,)).fetchone()
        if row:
            value = json.loads(row[0])
            value['候选配方'] = active[c]
            value['本轮独立确认'] = reference_choice if c == 'RG-2A' else renames[old_code]
            db.execute('UPDATE system_differences SET evidence_json=?,product=? WHERE product=?', (packed(value), c, old_code))
    db.commit()
    assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    for table, order in {'sources': 'kind', 'raw_rows': 'kind,source_row', 'bom_blocks': 'block_id', 'bom_lines': 'block_id,source_row', 'product_owners': 'source_row', 'mes_yields': 'source_row'}.items():
        assert list(db.execute(f'SELECT * FROM {table} ORDER BY {order}')) == list(map(tuple, old.execute(f'SELECT * FROM {table} ORDER BY {order}'))), table
    assert db.execute('SELECT count(*) FROM raw_rows').fetchone()[0] == 37248
    assert len(decisions['system_formula_replacement_confirmation']['products']) == 37

    def save(name, value):
        (output / name).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    save(master.name, decisions)
    save('已确认规则.json', rules)
    save('成本试算输入.json', payload)
    save('拟导入范围.json', {'analysis_candidate': output.name, 'ERP_product_codes': sorted(active), 'excluded': decisions['product_import_exclusions'], 'product_code_corrections': renames, 'formal_write_authorized': False})
    write_csv(output / '产品双成本试算.csv', ['产品', '部门', '负责人', '最新成本', '最新状态', '库存成本', '库存状态', '最新缺价', '库存缺价'],
              [[c, f['department'], f['owner'], costs[c, 'latest']['cost'], status(costs[c, 'latest']), costs[c, 'inventory']['cost'], status(costs[c, 'inventory']), packed(costs[c, 'latest']['missing_materials']), packed(costs[c, 'inventory']['missing_materials'])] for c, f in sorted(active.items())])
    write_csv(output / '本轮成本变化.csv', ['产品', '口径', '原成本', '候选成本', '当前状态', '缺价编码'], [[c, p, left['cost'], right['cost'], status(right), packed(right['missing_materials'])] for c, p, left, right in changes])
    write_csv(output / 'CF003库存价格待确认影响.csv', ['产品', '部门', '负责人', '处理', '原库存试算成本'], [[c, active[c]['department'], active[c]['owner'], '库存成本暂挂；原ERP价保留', prior_costs[c, 'inventory']['cost']] for c in held])
    write_csv(output / '已确认无BOM记录处理.csv', ['编码', '处理组', '被引用产品', '原始证据'], [[c, group_by_code[c], packed(sorted(uses[c])), next(r['evidence_json'] for r in previous_issues if r['product'] == c and r['category'] in {'MES无对应BOM', '负责人无对应BOM'})] for c in sorted(group_by_code)])
    write_csv(output / '已确认停用排除清单.csv', ['产品', '部门', '负责人', '处理'], [[c, formulas[c]['department'], formulas[c]['owner'], '本批拟导入排除，来源保留'] for c in sorted(excluded)])
    write_csv(output / '已确认编码更正清单.csv', ['原编码', '正式内编', 'BOM标题行', '负责人行'], [[c, v['canonical_code'], v['bom_header_row'], v['owner_source_row']] for c, v in renames.items()])
    write_csv(output / '待决策总清单.csv', ['类别', '编码', '状态', '处理口径', '证据'], [[r[k] for k in ['category', 'product', 'status', 'decision', 'evidence_json']] for r in next_issues])
    relationship_rows = list(csv.DictReader((prior / '取价待处理清单.csv').open(encoding='utf-8-sig')))
    def impact(c):
        affected = {code for (code, _), r in costs.items() if c in r['missing_materials']}
        return [c, packed(sorted(uses[c])), packed(sorted(affected)), packed(sorted({active[x]['department'] for x in uses[c] if x in active})), packed(sorted({active[x]['owner'] for x in uses[c] if x in active and active[x]['owner']}))]
    common_headers = ['编码', '直接引用产品', '缺价影响产品', '部门', '负责人']
    manual = [r for r in relationship_rows if r['待处理原因'] == '选择手动核算价，未填写单价']
    other = [r for r in relationship_rows if r not in manual]
    assert len(manual) == 26 and len(other) == 19
    write_csv(output / '下一批-手动价格26项.csv', common_headers + ['原确认表行', '待补核算价元每kg'], [impact(r['原料编码']) + [r['原表行号'], ''] for r in manual])
    write_csv(output / '下一批-取价关系19项.csv', common_headers + ['状态', '原待处理说明'], [impact(r['原料编码']) + ['已确认引用现役配方；库存仍待CF001M' if r['原料编码'] == 'RG-1A' else '仍需确认', r['待处理原因']] for r in other])
    special = sorted(c for c in missing_direct if c.startswith(('HG', 'HJ', '加工')))
    assert sum(c.startswith(('HG', 'HJ')) for c in special) == 51 and sum(c.startswith('加工') for c in special) == 10
    write_csv(output / '下一批-HG-HJ与加工类61项.csv', common_headers + ['建议'], [impact(c) + ['由对应部门集中补价格或确认可参考编码；不默认零价'] for c in special])
    write_csv(output / '优先处理-缺BOM与价格3项.csv', common_headers + ['建议'], [impact(c) + ['补正确BOM或有效核算价，不能按相似后缀替代'] for c in orphan_groups['MES被引用缺价待补']])
    write_csv(output / '仅缺ERP库存价5项.csv', ['编码', '现役最新价', '库存状态'], [[c, prices[c]['latest_price'], '缺ERP库存价，不混用最新采购价'] for c in extras])
    write_csv(output / '缺ERP库存原价8项.csv', ['编码', '品号', 'ERP库存单价', 'BOM库存成本', '处理'], [[r['product'], json.loads(r['evidence_json'])['品号'], '', costs.get((r['product'], 'inventory'), {}).get('cost'), r['decision'] or '仍需补资料'] for r in next_issues if r['category'] == '库存品号缺ERP单价'])
    write_csv(output / '缺价投料影响200项.csv', common_headers, [impact(c) for c in sorted(missing_direct)])
    counts = {p: dict(Counter(status(costs[c, p]) for c in active)) for p in results}
    receipt = {'candidate': output.name, 'read_only_production_snapshot': '2026-10-07', 'source_hashes_verified': len(sources), 'raw_rows_preserved': 37248,
               'ERP_product_count': len(active), 'excluded_products': sorted(excluded), 'confirmed_yield_choices_preserved': 233,
               'ERP_adoption_approvals_preserved': 37, 'dual_cost_records_replayed': len(costs), 'cost_status_counts': counts,
               'CF003_inventory_pending_products': len(held), 'changed_result_records': len(changes), 'direct_unpriced_codes': len(missing_direct),
               'orphan_groups': orphan_groups, 'CF026K_matched': price_match, 'formal_database_written': False}
    save('分析摘要.json', receipt)
    save('核验记录/四类处理复算核验.json', receipt)
    (output / '阅读说明.txt').write_text('当前独立候选：' + output.name + '\n只使用拟导入范围中的2371个ERP产品；9个停用产品保留来源并排除，13个现役产品和1个复配方案继续保留。\nCF003原ERP价718.6保留，相关库存成本为价格待确认，不能当作有效成本；最新价仍按既有口径。\n原始BOM、MES和负责人行不改写。下一批取价关系19项中RG-1A关系已解决，其余18项仍需确认；26项手动价格仍需提供。\n本轮未写正式库或发布，仍使用2026-10-07只读基线；最终导入前重新预检并完成验收。\n', encoding='utf-8')
    for source in sources.values():
        assert digest(output / '来源原件' / source['filename']) == source['sha256']
    db.close()
    old.close()
    assert json.loads(master.read_text(encoding='utf-8')) == before
    pending = master.with_suffix('.pending.json')
    assert not pending.exists()
    pending.write_text(json.dumps(decisions, ensure_ascii=False, indent=2), encoding='utf-8')
    assert json.loads(pending.read_text(encoding='utf-8')) == decisions
    pending.replace(master)
    return receipt


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--prior', type=Path, required=True)
    parser.add_argument('--decisions', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(finalize(args.prior, args.decisions, args.output), ensure_ascii=False))
