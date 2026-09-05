from datetime import UTC, datetime, timedelta
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import sqlite3

from api.identity import IdentityStore
from api.procurement import ProcurementStore
from tests.helpers import authenticated_client
from tests.test_procurement_workbench import procurement_settings


def import_prices(client, day, rows):
    response = client.post('/api/workbenches/procurement/imports', json={
        'source_name': '隔离回归', 'effective_date': day,
        'content': '编号,名称,单位,最新价\n' + ''.join(f'{code},{code},kg,{value}\n' for code, value in rows),
    })
    assert response.status_code == 201, response.text
    return client.get('/api/workbenches/procurement/updates/current').json()['current']


def publish(client, update, **kwargs):
    return client.post(f"/api/workbenches/procurement/updates/{update['id']}/publish", json={'mode': 'immediate', **kwargs})


def confirm_risks(client, update):
    for issue in update['issues']:
        if issue['kind'] == 'price_spike' and issue['status'] == 'open':
            assert client.post(f"/api/workbenches/procurement/updates/{update['id']}/issues/{issue['id']}/review", json={'reason': '供应商报价已核对'}).status_code == 200


def test_scheduled_prices_are_not_used_by_another_immediate_update(tmp_path: Path):
    with authenticated_client(procurement_settings(tmp_path)) as client:
        assert publish(client, import_prices(client, '2026-08-01', [('A', 10), ('B', 10)])).status_code == 200
        scheduled = import_prices(client, '2026-08-02', [('A', 20)])
        confirm_risks(client, scheduled)
        assert publish(client, scheduled, mode='scheduled', activate_at=(datetime.now(UTC) + timedelta(days=10)).isoformat()).status_code == 200
        current = import_prices(client, '2026-08-03', [('B', 11)])
        result = publish(client, current)
        assert result.status_code == 200, result.text
        snapshot = client.get(f"/api/workbenches/procurement/batches/{result.json()['id']}").json()['items']
        assert {item['code']: item['latest_price'] for item in snapshot} == {'A': '10', 'B': '11'}


def test_cancelled_missing_price_does_not_contaminate_next_baseline(tmp_path: Path):
    with authenticated_client(procurement_settings(tmp_path)) as client:
        assert publish(client, import_prices(client, '2026-08-01', [('A', 10), ('B', 10)])).status_code == 200
        cancelled = import_prices(client, '2026-08-02', [('A', '')])
        assert client.post(f"/api/workbenches/procurement/updates/{cancelled['id']}/cancel", json={'reason': '本轮报价作废'}).status_code == 200
        current = import_prices(client, '2026-08-03', [('B', 11)])
        result = publish(client, current)
        assert result.status_code == 200, result.text
        items = client.get(f"/api/workbenches/procurement/batches/{result.json()['id']}").json()['items']
        assert {item['code']: item['latest_price'] for item in items} == {'A': '10', 'B': '11'}


def test_repeated_import_uses_official_price_for_risk(tmp_path: Path):
    with authenticated_client(procurement_settings(tmp_path)) as client:
        assert publish(client, import_prices(client, '2026-08-01', [('A', 10)])).status_code == 200
        import_prices(client, '2026-08-02', [('A', 11)])
        current = import_prices(client, '2026-08-02', [('A', 12)])
        assert current['summary']['risk_count'] == 1
        assert publish(client, current).status_code == 409
        confirm_risks(client, current)
        assert publish(client, current).status_code == 200


def test_copy_of_invalidated_schedule_requires_fresh_confirmation(tmp_path: Path):
    with authenticated_client(procurement_settings(tmp_path)) as client:
        assert publish(client, import_prices(client, '2026-08-01', [('A', 10)])).status_code == 200
        scheduled = import_prices(client, '2026-08-02', [('A', 20)])
        confirm_risks(client, scheduled)
        assert publish(client, scheduled, mode='scheduled', activate_at=(datetime.now(UTC) + timedelta(days=10)).isoformat()).status_code == 200
        current = import_prices(client, '2026-08-03', [('A', 10)])
        confirm_risks(client, current)
        assert publish(client, current).status_code == 200
        copied = client.post(f"/api/workbenches/procurement/updates/{scheduled['id']}/cancel-schedule", json={'reason': '重新检查原排期', 'copy_to_draft': True}).json()['copied_update']
        assert copied['summary']['risk_count'] == 1
        assert publish(client, copied).status_code == 409


def test_restricted_reader_cannot_read_prices_in_nested_responses(tmp_path: Path):
    settings = procurement_settings(tmp_path)
    with authenticated_client(settings) as client:
        assert publish(client, import_prices(client, '2026-08-01', [('A', 10)])).status_code == 200
        import_prices(client, '2026-08-02', [('A', 11)])
        assert client.put('/api/admin/fields/procurement.material_unit_price', json={
            'read_min_level': 4, 'write_min_level': 4,
            'read_scope_ids': ['procurement'], 'write_scope_ids': ['procurement'],
        }).status_code == 200
        IdentityStore(settings.database_path).create_user(username='restricted', display_name='查看账号', department='采购', password='Isolated-Test-Password-2026', scope_levels={'procurement': 2})
        client.post('/api/logout')
        assert client.post('/api/login', json={'username': 'restricted', 'password': 'Isolated-Test-Password-2026'}).status_code == 200
        overview = client.get('/api/workbenches/procurement/overview').json()
        current = client.get('/api/workbenches/procurement/updates/current').json()['current']
        forbidden = {'latest_price', 'published_price', 'draft_price', 'draft_change', 'change'}
        for item in overview['materials'] + overview['current_update']['items'] + current['items']:
            assert not forbidden.intersection(item)


def test_scheduled_baseline_keeps_approver_identity(tmp_path: Path):
    settings = procurement_settings(tmp_path)
    with authenticated_client(settings) as client:
        current = import_prices(client, '2026-08-01', [('A', 10)])
        due = datetime.now(UTC) + timedelta(hours=1)
        assert publish(client, current, mode='scheduled', activate_at=due.isoformat()).status_code == 200
        store = ProcurementStore(settings.database_path)
        assert store.process_scheduled(due + timedelta(seconds=1)) == 1
        detail = store.get_batch(store.overview()['batches'][0]['id'])
        assert detail['published_by_name'] is not None


def test_changed_candidate_invalidates_confirmation_but_unrelated_edit_does_not(tmp_path: Path):
    with authenticated_client(procurement_settings(tmp_path)) as client:
        assert publish(client, import_prices(client, '2026-08-01', [('A', 10), ('B', 10)])).status_code == 200
        current = import_prices(client, '2026-08-02', [('A', 20)])
        confirm_risks(client, current)
        current = import_prices(client, '2026-08-02', [('B', 11)])
        assert current['summary']['risk_count'] == 0
        current = import_prices(client, '2026-08-02', [('A', 21)])
        assert current['summary']['risk_count'] == 1
        assert publish(client, current).status_code == 409


def test_full_snapshot_validation_rejects_missing_price_without_issue(tmp_path: Path):
    settings = procurement_settings(tmp_path)
    with authenticated_client(settings) as client:
        current = import_prices(client, '2026-08-01', [('A', '')])
        with sqlite3.connect(settings.database_path) as connection:
            connection.execute("DELETE FROM procurement_issues WHERE update_id=?", (current['id'],))
        assert publish(client, current).status_code == 409
        assert publish(client, current, mode='scheduled', activate_at=(datetime.now(UTC) + timedelta(days=1)).isoformat()).status_code == 409
        assert client.get('/api/workbenches/procurement/overview').json()['batches'] == []


def test_concurrent_activation_only_creates_one_baseline(tmp_path: Path):
    settings = procurement_settings(tmp_path)
    with authenticated_client(settings) as client:
        current = import_prices(client, '2026-08-01', [('A', 10)])
        with sqlite3.connect(settings.database_path) as connection:
            actor = connection.execute('SELECT created_by FROM procurement_updates WHERE id=?', (current['id'],)).fetchone()[0]
        def attempt():
            try:
                ProcurementStore(settings.database_path).publish_update(current['id'], actor, 'immediate')
                return 'published'
            except ValueError:
                return 'rejected'
        with ThreadPoolExecutor(max_workers=2) as executor:
            outcomes = list(executor.map(lambda _: attempt(), range(2)))
        assert sorted(outcomes) == ['published', 'rejected']
        assert len(ProcurementStore(settings.database_path).overview()['batches']) == 1


def test_service_startup_processes_overdue_schedule_once(tmp_path: Path):
    settings = procurement_settings(tmp_path)
    with authenticated_client(settings) as client:
        current = import_prices(client, '2026-08-01', [('A', 10)])
        assert publish(client, current, mode='scheduled', activate_at=(datetime.now(UTC) + timedelta(days=1)).isoformat()).status_code == 200
    with sqlite3.connect(settings.database_path) as connection:
        connection.execute('UPDATE procurement_updates SET scheduled_activate_at=? WHERE id=?', ((datetime.now(UTC) - timedelta(minutes=1)).isoformat(), current['id']))
    for _ in range(2):
        with authenticated_client(settings) as client:
            assert len(client.get('/api/workbenches/procurement/overview').json()['batches']) == 1


def test_manual_correction_and_preview_use_official_risk_reference(tmp_path: Path):
    with authenticated_client(procurement_settings(tmp_path)) as client:
        assert publish(client, import_prices(client, '2026-08-01', [('A', 10)])).status_code == 200
        current = import_prices(client, '2026-08-02', [('A', 11)])
        preview = client.post('/api/workbenches/procurement/import-preview', json={'source_name': '复核', 'effective_date': '2026-08-02', 'content': '编号,名称,单位,最新价\nA,A,kg,12\n'}).json()
        assert 'price_spike' in preview['rows'][0]['issues']
        material_id = current['items'][0]['material_id']
        assert client.post(f'/api/workbenches/procurement/materials/{material_id}/adjustments', json={'price': '12', 'effective_date': '2026-08-02', 'reason': '修改供应商报价'}).status_code == 201
        current = client.get('/api/workbenches/procurement/updates/current').json()['current']
        assert current['summary']['risk_count'] == 1
        assert publish(client, current).status_code == 409


def test_active_import_cannot_be_archived(tmp_path: Path):
    settings = procurement_settings(tmp_path)
    with authenticated_client(settings) as client:
        current = import_prices(client, '2026-08-01', [('A', 10)])
        with sqlite3.connect(settings.database_path) as connection:
            import_id = connection.execute('SELECT id FROM procurement_imports WHERE update_id=?', (current['id'],)).fetchone()[0]
        assert client.post(f'/api/workbenches/procurement/imports/{import_id}/archive').status_code == 409
        assert client.post(f"/api/workbenches/procurement/updates/{current['id']}/cancel", json={'reason': '本轮报价取消'}).status_code == 200
        assert client.post(f'/api/workbenches/procurement/imports/{import_id}/archive').status_code == 200


def test_history_uses_its_own_field_policy(tmp_path: Path):
    settings = procurement_settings(tmp_path)
    with authenticated_client(settings) as client:
        current = import_prices(client, '2026-08-01', [('A', 10)])
        material_id = current['items'][0]['material_id']
        for field, level in [('material_unit_price', 4), ('supplier_quote', 2)]:
            assert client.put(f'/api/admin/fields/procurement.{field}', json={
                'read_min_level': level, 'write_min_level': 4,
                'read_scope_ids': ['procurement'], 'write_scope_ids': ['procurement'],
            }).status_code == 200
        IdentityStore(settings.database_path).create_user(username='editor', display_name='采购', department='采购', password='Isolated-Test-Password-2026', scope_levels={'procurement': 3})
        client.post('/api/logout')
        assert client.post('/api/login', json={'username': 'editor', 'password': 'Isolated-Test-Password-2026'}).status_code == 200
        detail = client.get(f'/api/workbenches/procurement/materials/{material_id}').json()
        assert 'latest_price' not in detail['material']
        assert detail['history'][0]['latest_price'] == '10'
        edited = client.patch(f'/api/workbenches/procurement/materials/{material_id}', json={'code': 'A', 'name': '原料A'}).json()
        assert 'latest_price' not in edited['material']
        assert edited['history'][0]['latest_price'] == '10'
        assert publish(client, current).status_code == 403
