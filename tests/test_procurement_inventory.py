import json
import os
import psycopg
from api.postgres import migrate, transaction

import pytest
from openpyxl import Workbook

from api.cli import main
from api.identity import IdentityStore
from api.procurement import ProcurementStore
from api.procurement_inventory import import_inventory, inventory_preview
from tests.helpers import authenticated_client
from tests.test_procurement_isolation import import_prices, publish
from tests.test_procurement_scope_permissions import PASSWORD, sign_in
from tests.test_procurement_workbench import procurement_settings


def report(path, rows=None):
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = '原料行情总表'
    sheet.append(['采购员', '品名', '库存数量', '2026-09-08', '库存价格'])
    for row in rows or [('A', 12.34567, 4.5), ('B', 0, 0), ('C', 7, None)]:
        code, quantity, price = row
        sheet.append(['来源采购员', code, quantity, 999, price])
    workbook.save(path)


@pytest.fixture
def inventory_data(tmp_path):
    settings = procurement_settings(tmp_path)
    with authenticated_client(settings) as client:
        first = import_prices(client, '2026-09-01', [('A', 10), ('B', 20), ('C', 30)])
        assert publish(client, first).status_code == 200
        second = import_prices(client, '2026-09-08', [('A', 11), ('B', 19), ('C', 30)])
        assert publish(client, second).status_code == 200
        source = tmp_path / 'inventory.xlsx'
        report(source)
        yield settings, client, source, client.get('/api/me').json()['id']


def apply(data, preview=None, actor=None):
    settings, _, source, admin = data
    preview = preview or inventory_preview(settings.database_url, source.read_bytes())
    return import_inventory(settings.database_url, source, actor or admin,
                            expected_sha256=preview['sha256'], expected_catalog_sha256=preview['catalog_sha256'], data_dir=settings.data_dir)


def overview(client):
    return client.get('/api/workbenches/procurement/overview').json()


def stock(client):
    return {m['code']: (m['inventory_quantity'], m['inventory_price']) for m in overview(client)['materials']}


def test_inventory_preserves_prices_provenance_and_survives_later_price_activation(inventory_data):
    settings, client, source, admin = inventory_data
    before = overview(client)
    preview = inventory_preview(settings.database_url, source.read_bytes())
    assert (preview['matched'], preview['priced'], preview['missing_price'], preview['zero_quantity']) == (3, 1, 2, 1)
    result = apply(inventory_data, preview)
    assert result['updated'] == 3
    assert stock(client) == {'A': ('12.34567', '4.5'), 'B': ('0', None), 'C': ('7', None)}
    after = overview(client)
    for data in [before, after]:
        for material in data['materials']:
            for key in ['inventory_quantity', 'inventory_price']:
                material.pop(key, None)
    assert after == before
    with transaction(settings.database_url) as db:
        raw = db.execute("SELECT raw_price,sheet,source_row,imported_by FROM procurement_inventory WHERE quantity='0'").fetchone()
        assert raw == ('0', '原料行情总表', 3, admin)
        archived = db.execute('SELECT stored_path FROM procurement_source_imports WHERE sha256=%s', (preview['sha256'],)).fetchone()[0]
        from pathlib import Path
        assert Path(archived).read_bytes() == source.read_bytes()
        before_rows = db.execute('SELECT * FROM procurement_inventory ORDER BY material_id').fetchall()
    assert apply(inventory_data)['updated'] == 0
    with transaction(settings.database_url) as db:
        assert db.execute('SELECT * FROM procurement_inventory ORDER BY material_id').fetchall() == before_rows
        assert db.execute("SELECT count(*) FROM procurement_admin_events WHERE action='inventory.imported'").fetchone()[0] == 1
    update = import_prices(client, '2026-09-11', [('A', 12), ('B', 19), ('C', 31)])
    assert stock(client) == {'A': ('12.34567', '4.5'), 'B': ('0', None), 'C': ('7', None)}
    assert publish(client, update).status_code == 200
    assert stock(client) == {'A': ('12.34567', '4.5'), 'B': ('0', None), 'C': ('7', None)}
    assert ProcurementStore(settings.database_url).schema_version() == 7
    assert len(stock(client)) == 3


@pytest.mark.parametrize('rows', [
    [('A', 1, 2), ('A', 3, 4), ('C', 5, 6)],
    [('A', 1, 2), ('B', 3, 4), ('UNKNOWN', 5, 6)],
    [('A', 1, 2), ('B', 3, 4)],
    [('A', -1, 2), ('B', 3, 4), ('C', 5, 6)],
    [('A', None, 2), ('B', 3, 4), ('C', 5, 6)],
    [('A', 1, '3-4'), ('B', 3, 4), ('C', 5, 6)],
    [('A', '=1+1', 2), ('B', 3, 4), ('C', 5, 6)],
])
def test_inventory_rejects_invalid_complete_report_without_writes(inventory_data, rows):
    settings, client, source, _ = inventory_data
    apply(inventory_data)
    before = stock(client)
    report(source, rows)
    with pytest.raises(ValueError):
        apply(inventory_data)
    assert stock(client) == before


def test_inventory_rechecks_file_and_catalog_under_transaction(inventory_data):
    settings, _, source, _ = inventory_data
    preview = inventory_preview(settings.database_url, source.read_bytes())
    source.write_bytes(source.read_bytes() + b'changed')
    with pytest.raises(ValueError, match='文件已变化'):
        apply(inventory_data, preview)
    preview = inventory_preview(settings.database_url, source.read_bytes())
    with transaction(settings.database_url, write=True) as db:
        db.execute("UPDATE procurement_materials SET id='replacement-id' WHERE code='A'")
    with pytest.raises(ValueError, match='原料匹配已变化'):
        apply(inventory_data, preview)
    with transaction(settings.database_url) as db:
        assert db.execute('SELECT count(*) FROM procurement_inventory').fetchone()[0] == 0


def test_inventory_rolls_back_database_and_new_source_archive(inventory_data):
    settings, _, _, _ = inventory_data
    with transaction(os.environ['HONGHAO_TEST_MIGRATION_URL'], write=True) as db:
        db.execute("""CREATE FUNCTION reject_inventory() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'simulated failure' USING ERRCODE='23514'; END $$;
            CREATE TRIGGER reject_inventory BEFORE INSERT ON procurement_inventory
            FOR EACH ROW WHEN (NEW.quantity='0') EXECUTE FUNCTION reject_inventory()""")
    with pytest.raises(psycopg.IntegrityError, match='simulated failure'):
        apply(inventory_data)
    with transaction(settings.database_url) as db:
        assert db.execute('SELECT count(*) FROM procurement_inventory').fetchone()[0] == 0
        assert db.execute('SELECT count(*) FROM procurement_source_imports').fetchone()[0] == 0
    assert not list((settings.data_dir / 'controlled-work' / 'procurement-sources').glob('*.xlsx'))


def test_inventory_permissions_and_cli_preview(inventory_data, capsys):
    settings, client, source, _ = inventory_data
    assert main(['procurement-inventory', str(source)], settings=settings) == 0
    preview = json.loads(capsys.readouterr().out)
    assert preview['matched'] == 3
    assert main(['procurement-inventory', str(source), '--apply'], settings=settings) == 1
    assert '预检' in capsys.readouterr().err
    apply(inventory_data)
    identities = IdentityStore(settings.database_url)
    for name, scopes in [('reader', {'procurement': 2}), ('manager', {'procurement': 4}), ('sales', {'sales': 4})]:
        user = identities.create_user(username=name, display_name=name, department=None, password=PASSWORD, scope_levels=scopes)
        with pytest.raises(PermissionError):
            apply(inventory_data, actor=user['id'])
        sign_in(client, name)
        response = client.get('/api/workbenches/procurement/overview')
        assert response.status_code == (403 if name == 'sales' else 200)
        if name != 'sales':
            assert stock(client)['A'] == ('12.34567', '4.5')
    client.post('/api/logout')
    assert client.get('/api/workbenches/procurement/overview').status_code == 401


def test_inventory_schema_verification_preserves_preferences_and_only_migrates_once(inventory_data):
    settings, _, _, admin = inventory_data
    store = ProcurementStore(settings.database_url)
    store.save_preferences(admin, ['unit', 'latest_price', 'previous_latest_price', 'inventory_price', 'in_transit_price'], 'materials', 'scroll', 100)
    expected = store.preferences(admin)
    assert migrate(os.environ['HONGHAO_TEST_MIGRATION_URL'], 'test') == 2
    assert store.schema_version() == 7
    assert store.preferences(admin) == expected
    store.save_preferences(admin, ['unit', 'latest_price'], 'materials', 'paged', 25)
    assert migrate(os.environ['HONGHAO_TEST_MIGRATION_URL'], 'test') == 2
    assert store.preferences(admin)['ledger_columns'] == ['unit', 'latest_price']
