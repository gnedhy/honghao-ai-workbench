"""Report upload must stage stock and activate it with the price period."""
from io import BytesIO
from datetime import UTC, datetime, timedelta

from openpyxl import Workbook, load_workbook
import pytest

from api.procurement_excel import selected_prices
from api.postgres import transaction
from tests.procurement_helpers import procurement_post
from tests.test_procurement_isolation import publish, confirm_risks
from tests.test_procurement_rd5 import data, trial_data
from tests.test_research_workbench import ready, K, records

PREFIX = '/api/workbenches/procurement'


def report(rows):
    book = Workbook()
    sheet = book.active
    sheet.title = '原料行情总表'
    sheet.append(['采购员', '品名', '库存数量', '2026-11-02', '库存价格'])
    for row in rows:
        sheet.append(['测试采购员', *row])
    stream = BytesIO()
    book.save(stream)
    book.close()
    return stream.getvalue()


def test_report_extracts_stock_even_without_market_price():
    result = selected_prices(report([('A', 12, 11, 8), ('B', 0, None, 9)]),
                             '原料行情总表', '2026-11-02',
                             {code: {'name': code, 'unit': 'kg'} for code in ['A', 'B']})
    assert result['valid'] == 2
    assert '库存数量' in result['content']
    assert result['rows'][0]['purchaser'] == '测试采购员'
    assert result['rows'][0]['inventory_quantity'] == '12'
    assert result['rows'][0]['inventory_price'] == '8'
    assert result['rows'][1]['inventory_quantity'] == '0'


def upload(client, rows):
    response = client.post(PREFIX + '/excel-preview', files={'file': ('report.xlsx', report(rows))},
                           data={'sheet': '原料行情总表', 'price_date': '2026-11-02'})
    assert response.status_code == 200, response.text
    selection = response.json()['selection']
    assert selection['blocked'] == 0
    response = procurement_post(client, PREFIX + '/imports', json={
        'source_name': '隔离库存行情报表', 'effective_date': '2026-11-02', 'content': selection['content']})
    assert response.status_code == 201, response.text
    return response.json()


def stock(url):
    with transaction(url) as db:
        return db.execute("SELECT i.quantity,i.price FROM procurement_inventory i JOIN procurement_materials m ON m.id=i.material_id WHERE m.code='A'").fetchone()


def test_upload_activation_freezes_inventory_and_updates_cost_version(ready):
    settings, client, _, store = ready
    before_stock = stock(settings.database_url)
    before_records = records(settings.database_url)
    before_cost = store.detail(K)['product']
    receipt = upload(client, [('A', 17, 33, 21)])
    material = next(m for m in client.get(PREFIX + '/overview?compact=true').json()['materials'] if m['code']=='A')
    assert material['price_modifier'] == {'kind':'source','name':'测试采购员','id':None}
    assert stock(settings.database_url) == before_stock
    store.process_events()
    assert records(settings.database_url) == before_records
    current = client.get(PREFIX + '/updates/current').json()['current']
    confirm_risks(client, current)
    activated = publish(client, current)
    assert activated.status_code == 200, activated.text
    assert stock(settings.database_url) == ('17', '21')
    for suffix in ['', '?compact=true', '?read_mode=ledger']:
        material = next(m for m in client.get(PREFIX + '/overview' + suffix).json()['materials'] if m['code']=='A')
        assert material['price_modifier']['name'] == '测试采购员'
    with transaction(settings.database_url) as db:
        actor,purchaser = db.execute('SELECT actor_name,source_purchaser FROM procurement_saved_changes WHERE update_id=%s', (receipt['update_id'],)).fetchone()
        assert actor != purchaser and purchaser == '测试采购员'
    history = client.get(PREFIX + '/materials/' + material['id'] + '?compact=true').json()['official_history']
    assert history[-1]['modifier']['name'] == '测试采购员'
    batch = client.get(PREFIX + '/batches/' + activated.json()['id']).json()
    item = next(row for row in batch['items'] if row['code'] == 'A')
    assert (item['latest_price'], item['inventory_price']) == ('33', '21')
    assert item['inventory_quantity'] == '17'
    store.process_events()
    after_records = records(settings.database_url)
    assert after_records[:len(before_records)] == before_records
    assert len(after_records) > len(before_records)
    after_cost = store.detail(K)['product']
    assert after_cost['latest_cost'] != before_cost['latest_cost']
    assert after_cost['inventory_cost'] != before_cost['inventory_cost']
    with transaction(settings.database_url) as db:
        assert db.execute("SELECT count(*) FROM procurement_price_batches WHERE update_id=%s", (receipt['update_id'],)).fetchone()[0] == 1
        assert db.execute("SELECT inventory_snapshot FROM procurement_price_batches WHERE id=%s", (batch['id'],)).fetchone()[0] != '[]'
    assert publish(client, current).status_code == 409


def test_stock_only_cancel_and_archived_import_do_not_leak(ready):
    settings, client, _, store = ready
    original = stock(settings.database_url)
    receipt = upload(client, [('A', 0, None, 19)])
    assert procurement_post(client, PREFIX + f"/imports/{receipt['id']}/archive").status_code == 409
    current = client.get(PREFIX + '/updates/current').json()['current']
    assert procurement_post(client, PREFIX + f"/updates/{current['id']}/cancel", json={'reason': '隔离测试取消本轮'}).status_code == 200
    assert procurement_post(client, PREFIX + f"/imports/{receipt['id']}/archive").status_code == 200
    assert stock(settings.database_url) == original
    upload(client, [('A', 0, None, 19)])
    current = client.get(PREFIX + '/updates/current').json()['current']
    assert procurement_post(client, PREFIX + f"/updates/{current['id']}/cancel", json={'reason': '隔离测试取消本轮'}).status_code == 200
    assert stock(settings.database_url) == original
    upload(client, [('A', 0, None, 19)])
    current = client.get(PREFIX + '/updates/current').json()['current']
    assert publish(client, current).status_code == 200
    assert stock(settings.database_url) == ('0', '19')
    store.process_events()


@pytest.mark.parametrize('quantity,price', [(-1, 8), ('bad', 8), (None, 8), (12, '8-9'), (12, -1)])
def test_invalid_stock_blocks_whole_report(quantity, price):
    result = selected_prices(report([('A', quantity, 11, price)]), '原料行情总表', '2026-11-02', {'A': {'name': 'A', 'unit': 'kg'}})
    assert result['blocked'] == 1
    assert result['valid'] == 0


def test_scheduled_copy_preserves_stock_and_activation_is_atomic(ready, monkeypatch):
    from api.procurement import ProcurementStore
    import api.research as research
    settings, client, admin, _ = ready
    original = stock(settings.database_url)
    upload(client, [('A', 18, None, 22)])
    current = client.get(PREFIX + '/updates/current').json()['current']
    assert publish(client, current, mode='scheduled', activate_at=(datetime.now(UTC) + timedelta(days=1)).isoformat()).status_code == 200
    assert stock(settings.database_url) == original
    store = ProcurementStore(settings.database_url)
    copied = store.cancel_schedule(current['id'], admin, '取消排期并保留库存', True)['copied_update']
    assert copied['inventory_items'][0]['inventory_quantity'] == '18'
    with transaction(settings.database_url) as db:
        assert db.execute('SELECT source_purchaser FROM procurement_saved_changes WHERE update_id=%s', (copied['id'],)).fetchone()[0] == '测试采购员'
    with transaction(settings.database_url) as db:
        count = db.execute('SELECT count(*) FROM procurement_price_batches').fetchone()[0]
    def fail(*args):
        raise RuntimeError('injected queue failure')
    with monkeypatch.context() as patch:
        patch.setattr(research, 'enqueue', fail)
        with pytest.raises(RuntimeError, match='injected'):
            store.publish_update(copied['id'], admin, 'immediate')
    assert stock(settings.database_url) == original
    with transaction(settings.database_url) as db:
        assert db.execute('SELECT count(*) FROM procurement_price_batches').fetchone()[0] == count
    store.publish_update(copied['id'], admin, 'immediate')
    assert stock(settings.database_url) == ('18', '22')
    material = next(m for m in client.get(PREFIX + '/overview?read_mode=ledger').json()['materials'] if m['code']=='A')
    assert material['price_modifier']['name'] == '测试采购员'


@pytest.mark.parametrize('price', [None, 0])
def test_empty_inventory_price_activates_as_missing(ready, price):
    settings, client, _, store = ready
    upload(client, [('A', 0, None, price)])
    current = client.get(PREFIX + '/updates/current').json()['current']
    response = publish(client, current)
    assert response.status_code == 200, response.text
    assert stock(settings.database_url) == ('0', None)
    store.process_events()


def test_download_template_round_trips_through_excel_preview(ready):
    _, client, _, _ = ready
    response = client.get(PREFIX + '/import-template')
    assert response.status_code == 200
    assert 'spreadsheetml.sheet' in response.headers['content-type']
    book = load_workbook(BytesIO(response.content))
    sheet = book['原料行情总表']
    assert sheet.max_row == 1
    price_date = sheet['E1'].value.date().isoformat()
    sheet.append(['A', '模板采购员', 12.5, 8.2, 11.3])
    stream = BytesIO()
    book.save(stream)
    book.close()
    preview = client.post(PREFIX + '/excel-preview', files={'file': ('template.xlsx', stream.getvalue())},
                          data={'sheet': '原料行情总表', 'price_date': price_date})
    assert preview.status_code == 200, preview.text
    row = preview.json()['selection']['rows'][0]
    assert row['purchaser'] == '模板采购员'
    assert (row['code'], row['inventory_quantity'], row['inventory_price'], row['price']) == ('A', '12.5', '8.2', '11.3')


def test_report_purchaser_blank_falls_back_and_invalid_blocks(ready):
    _, client, _, _ = ready
    content = '编号,名称,单位,行情价格,采购员\nA,原料A,kg,30,'
    invalid = procurement_post(client, PREFIX + '/import-preview', json={'source_name':'测试CSV','effective_date':'2026-11-02','content':content+'长'*101})
    assert invalid.status_code == 200
    assert invalid.json()['skipped_count'] == 1
    assert 'invalid_purchaser' in invalid.json()['rows'][0]['issues']
    saved = procurement_post(client, PREFIX + '/imports', json={'source_name':'测试CSV','effective_date':'2026-11-02','content':content})
    assert saved.status_code == 201, saved.text
    material = next(m for m in client.get(PREFIX + '/overview?compact=true').json()['materials'] if m['code']=='A')
    assert material['price_modifier']['kind'] == 'system'
    assert material['price_modifier']['name']
