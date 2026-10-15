"""Request accounting, account isolation and key rotation on disposable PostgreSQL."""
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal
from pathlib import Path
from uuid import uuid4
import os

import pytest
from api.ai_control import AIControlStore, AIBudgetExceeded
from api.database import WorkspaceAccessError, WorkspaceConflictError
from api.identity import IdentityStore
from api.postgres import transaction


@pytest.fixture
def control(tmp_path):
    url = os.environ['HONGHAO_DATABASE_URL']
    identity = IdentityStore(url)
    actors = [identity.create_user(username=name, display_name=name, department=None,
        password='Synthetic-Only-20261014!', is_system_admin=name == 'admin', ai_enabled=True)['id']
        for name in ('admin', 'alice', 'bob')]
    return AIControlStore(url, tmp_path), actors


def save(store, admin, section, **changes):
    row = store.config()[section]
    return store.save(section, row['revision'], {**row['value'], **changes}, admin)


def begin(store, actor, **changes):
    selection = store.selection(actor)
    return store.begin_request(actor=actor, run_id=str(uuid4()), model=selection['model'], purpose='foreground',
        price_snapshot=selection['prices'], input_upper=1048576, output_upper=4096, **changes)


def settle(store, request, input_tokens=1000, cached_tokens=0, output_tokens=1000):
    store.settle_request(request, {'input_tokens': input_tokens, 'input_tokens_details': {'cached_tokens': cached_tokens},
        'output_tokens': output_tokens, 'output_tokens_details': {'reasoning_tokens': output_tokens}})


def test_settings_authorization_conflicts_and_capacity(control):
    store, (admin, alice, _) = control
    original = store.config()['models']
    assert original['value']['default_effort'] == 'high'
    assert store.catalog(alice)['models'][0]['id'] == 'deepseek-flash'
    with pytest.raises(WorkspaceAccessError):
        store.save('models', original['revision'], original['value'], alice)
    save(store, admin, 'models', default_effort='max')
    with pytest.raises(WorkspaceConflictError):
        store.save('models', original['revision'], original['value'], admin)
    with pytest.raises(WorkspaceConflictError):
        save(store, admin, 'models', enabled_models=['deepseek-flash', 'deepseek-v4-pro'])
    pro_prices = original['value']['prices']['deepseek-v4-pro']
    with pytest.raises(WorkspaceAccessError):
        store.begin_request(alice, None, 'deepseek-v4-pro', 'test', pro_prices, 50, 32)
    connection_test = store.begin_request(admin, None, 'deepseek-v4-pro', 'test', pro_prices, 50, 32)
    store.void_request(connection_test)
    assert 'deepseek-v4-pro' not in store.config()['models']['value']['validated_models']
    with pytest.raises(WorkspaceConflictError):
        save(store, admin, 'models', validated_models=['deepseek-flash', 'deepseek-v4-pro'])
    store.mark_model_validated('deepseek-v4-pro')
    save(store, admin, 'models', enabled_models=['deepseek-flash', 'deepseek-v4-pro'])
    assert store.selection(alice, 'deepseek-v4-pro')['prices']['output'] == '27'
    with pytest.raises(WorkspaceConflictError):
        save(store, admin, 'concurrency', verified_capacity=4, max_running=4)
    with pytest.raises(WorkspaceConflictError):
        save(store, admin, 'concurrency', max_running=2)
    store.set_verified_capacity(4)
    assert save(store, admin, 'concurrency', max_running=4)['value']['max_running'] == 4


def test_decimal_cached_reasoning_accounting_soft_cutoff_and_pending(control):
    store, (admin, alice, bob) = control
    save(store, admin, 'budget', company_monthly_cny='0.009', user_monthly_cny='1')
    # In-flight upper bounds do not pre-reserve entire context windows against a soft budget.
    requests = [begin(store, alice), begin(store, bob)]
    settle(store, requests[0], cached_tokens=500)
    assert Decimal(store.usage(alice)['totals']['cost_cny']) == Decimal('0.00902')
    assert store.usage(alice)['totals']['total_tokens'] == 2000
    with pytest.raises(AIBudgetExceeded):
        begin(store, bob)
    settle(store, requests[1], input_tokens=10, output_tokens=10)
    assert store.usage()['totals']['requests'] == 2
    # Idempotent terminal processing must not charge twice or change historic amounts.
    settle(store, requests[0], input_tokens=5000)
    assert Decimal(store.usage(alice)['totals']['cost_cny']) == Decimal('0.00902')


def test_pending_usage_and_user_overrides_are_isolated(control):
    store, (admin, alice, bob) = control
    save(store, admin, 'budget', user_monthly_cny='1', user_overrides={alice: '0.001'})
    request = begin(store, alice)
    store.settle_request(request, {'total_tokens': 400})
    assert Decimal(store.usage(alice)['totals']['pending_cny']) == Decimal('0.0032')
    assert store.usage(alice)['totals']['total_tokens']==400
    with pytest.raises(AIBudgetExceeded):
        begin(store, alice)
    other = begin(store, bob)
    store.void_request(other)
    assert store.usage(bob)['totals']['requests'] == 0
    assert store.usage(alice)['departments'] == []
    assert {row['owner_id'] for row in store.usage(alice)['users']} == {alice}
    settle(store, request, input_tokens=10, output_tokens=10)
    assert store.usage(alice)['totals']['pending_cny'] == '0'
    assert begin(store, alice)


def test_billing_ledger_survives_deleted_owner_and_price_changes(control):
    store, (admin, alice, _) = control
    request = begin(store, alice)
    prices = store.config()['models']['value']['prices']
    prices['deepseek-flash']['output'] = '100'
    save(store, admin, 'models', prices=prices)
    settle(store, request)
    assert Decimal(store.usage(alice)['totals']['cost_cny']) == Decimal('0.01')
    with transaction(store.url, write=True) as db:
        db.execute('DELETE FROM identity_users WHERE id=%s', (alice,))
    assert Decimal(store.usage()['totals']['cost_cny']) == Decimal('0.01')
    with pytest.raises(WorkspaceAccessError):
        store.usage(alice)


def test_beijing_month_boundaries_and_recovery(control):
    store, (_, alice, _) = control
    request = begin(store, alice)
    store.recover_inflight()
    assert Decimal(store.usage(alice)['totals']['pending_cny']) > 2
    settle(store, request)
    month, since, until = store._month()
    assert month == since.strftime('%Y-%m') and until.day == 1 and until.hour == 0
    with transaction(store.url, write=True) as db:
        db.execute('UPDATE ai_request_usage SET created_at=%s WHERE id=%s', (until, request))
    assert store.usage(alice)['totals']['requests'] == 0
    with transaction(store.url, write=True) as db:
        db.execute("UPDATE ai_request_usage SET created_at=%s::timestamptz-interval '1 microsecond' WHERE id=%s", (until, request))
    assert store.usage(alice)['totals']['requests'] == 1


def test_boundary_validation_and_parallel_settlement(control):
    store, (admin, alice, bob) = control
    for value in (float('nan'), float('inf'), True, '-1', {}, '1e100'):
        with pytest.raises(WorkspaceConflictError):
            save(store, admin, 'budget', company_monthly_cny=value)
    with pytest.raises(WorkspaceConflictError):
        save(store, admin, 'models', allowed_efforts=[{}])
    request = begin(store, alice)
    with pytest.raises(WorkspaceConflictError):
        settle(store, request, input_tokens=20, cached_tokens=21)
    store.mark_unknown(request)
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(lambda _: settle(store, request), range(2)))
    assert Decimal(store.usage()['totals']['cost_cny']) == Decimal('0.01')
    with transaction(store.url, write=True) as db:
        db.execute('UPDATE identity_users SET is_active=0 WHERE id=%s', (bob,))
    with pytest.raises(WorkspaceAccessError):
        begin(store, bob)


def test_private_versioned_keys_legacy_fallback_and_link_rejection(control, tmp_path):
    store, (admin, alice, _) = control
    key = 'sk-' + 'SyntheticOnly' * 4
    legacy = tmp_path / 'legacy.txt'
    legacy.write_text('api_key = "' + key + '"', encoding='utf-8-sig')
    assert store.read_key(fallback=legacy) == key
    assert store.key_status(legacy)['configured']
    with pytest.raises(WorkspaceAccessError):
        store.replace_key(key, alice)
    first = store.replace_key(key, admin)
    second = store.replace_key(key + 'Rotation', admin)
    assert key not in str(first) and key not in str(store.key_status())
    assert store.read_key(first['version']) == key
    assert store.read_key() == key + 'Rotation'
    assert store.read_key(fallback=legacy) == key
    assert store.selection(alice)['key_version'] == second['version']
    request = begin(store, alice)
    settle(store, request)
    from api.operations import _references, _table_evidence
    with transaction(store.url) as db:
        referenced, _ = _references(db, store.data_dir)
        evidence = _table_evidence(db)
    assert evidence['ai_credentials']['count'] == 2
    assert evidence['ai_request_usage']['count'] == 1
    assert len([path for path in referenced if path.startswith('private-ai-credentials/')]) == 2
    path = store.key_path(first['version'])
    if os.name != 'nt':
        assert path.stat().st_mode & 0o777 == 0o600
        assert path.parent.stat().st_mode & 0o777 == 0o700
        path.unlink()
        path.symlink_to(legacy)
        with pytest.raises(WorkspaceConflictError):
            store.read_key(first['version'])
    with pytest.raises(ValueError):
        store.key_path('../../outside')
    with pytest.raises(WorkspaceConflictError):
        store.replace_key('sk-secret\nnew-line', admin)
