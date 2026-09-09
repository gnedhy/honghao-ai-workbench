from tests.helpers import authenticated_client
from tests.test_procurement_workbench import procurement_settings
from tests.test_procurement_isolation import import_prices, publish


def test_new_date_change_uses_formal_price_at_save_time(tmp_path):
    root = '/api/workbenches/procurement'
    with authenticated_client(procurement_settings(tmp_path)) as client:
        base = import_prices(client, '2026-09-01', [('A', 10)])
        publish(client, base)
        material = base['input_items'][0]['material_id']
        assert procurement_post(client,f'{root}/materials/{material}/adjustments', json={'price': '11', 'effective_date': '2026-09-02', 'reason': '供应商最新报价'}).status_code == 201
        current = client.get(root + '/updates/current').json()['current']
        version = publish(client, current).json()
        change = client.get(f"{root}/batches/{version['id']}").json()['changes'][0]['items'][0]
        assert (change['before'], change['after'], change['before_basis']) == ('10', '11', 'saved')
        later = publish(client, import_prices(client, '2026-09-03', [('A', 12)])).json()
        assert later['version'] > version['version']
        assert client.get(f"{root}/batches/{version['id']}").json()['changes'][0]['items'][0] == change


def test_version_changes_only_include_its_work_batch(tmp_path):
    root = '/api/workbenches/procurement'
    with authenticated_client(procurement_settings(tmp_path)) as client:
        first = import_prices(client, '2026-09-01', [('A', 10)])
        version = publish(client, first).json()
        before = client.get(f"{root}/batches/{version['id']}").json()
        assert before['changes']
        assert all(item['event'] == 'imported' for item in before['changes'])
        import_prices(client, '2026-09-02', [('A', 11)])
        assert client.get(f"{root}/batches/{version['id']}").json()['changes'] == before['changes']


def test_change_prices_use_replaced_history_not_current_price(tmp_path):
    root = '/api/workbenches/procurement'
    with authenticated_client(procurement_settings(tmp_path)) as client:
        draft = import_prices(client, '2026-09-01', [('A', 10)])
        material = draft['input_items'][0]['material_id']
        for amount in ['11', '12']:
            result = procurement_post(client,f'{root}/materials/{material}/adjustments', json={'price': amount, 'effective_date': '2026-09-01', 'reason': '供应商最新报价'})
            assert result.status_code == 201
        current = client.get(root + '/updates/current').json()['current']
        version = publish(client, current).json()
        changes = client.get(f"{root}/batches/{version['id']}").json()['changes']
        assert [(event['items'][0]['before'], event['items'][0]['after']) for event in changes[:2]] == [('11', '12'), ('10', '11')]
        assert changes[-1]['items'][0]['before_recorded'] is False


def test_version_summary_matches_frozen_snapshot_details(tmp_path):
    root = '/api/workbenches/procurement'
    with authenticated_client(procurement_settings(tmp_path)) as client:
        first = publish(client, import_prices(client, '2026-09-01', [('A', 10), ('B', 10), ('C', 10)])).json()
        assert client.get(f"{root}/batches/{first['id']}").json()['comparison']['first'] == 3
        second = publish(client, import_prices(client, '2026-09-02', [('A', 11), ('B', 9), ('C', 10)])).json()
        detail = client.get(f"{root}/batches/{second['id']}").json()
        summary = detail['comparison']
        assert (summary['up'], summary['down'], summary['unchanged'], summary['first']) == (1, 1, 1, 0)
        assert sum(summary[key] for key in ['up', 'down', 'unchanged', 'first', 'missing']) == detail['item_count']
        overview = client.get(root + '/overview').json()
        assert overview['batches'][0]['comparison'] == summary
        import_prices(client, '2026-09-03', [('A', 15), ('B', 15), ('C', 15)])
        assert client.get(f"{root}/batches/{second['id']}").json()['comparison'] == summary
from tests.procurement_helpers import procurement_post
