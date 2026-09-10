import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta

import pytest

from api.authorization import AuthorizationStore
from api.identity import IdentityStore, SESSION_COOKIE_NAME
from api.procurement_collaboration import set_grant
from api.procurement import ProcurementStore
from api.settings import Settings
from tests.helpers import authenticated_client

OLD = "Temporary-Profile-Old-2026"
NEW = "Temporary-Profile-New-2026"


@pytest.fixture
def account(tmp_path):
    settings = Settings.from_data_dir(tmp_path / "profile-test", module_modes={key: "off" for key in ("chat", "knowledge", "automation", "workbench", "tasks")})
    with authenticated_client(settings) as client:
        store = IdentityStore(settings.database_path)
        admin = client.get("/api/me").json()
        buyer = store.create_user(username="temporary-buyer", display_name="临时采购员", department="采购部", password=OLD, scope_levels={"procurement": 3, "research": 2})
        empty = store.create_user(username="temporary-empty", display_name="临时无授权", department=None, password=OLD)
        yield settings, client, store, admin, buyer, empty


def sign_in(client, username="temporary-buyer", password=OLD):
    assert client.post("/api/login", json={"username": username, "password": password}).status_code == 200


def change(client, **changes):
    return client.post("/api/me/password", json={"current_password": OLD, "new_password": NEW, "confirm_password": NEW, **changes})


def test_profile_self_only_and_independent_of_disabled_modules(account):
    settings, client, store, admin, buyer, empty = account
    data = client.get("/api/me/profile").json()
    assert data["is_system_admin"] and data["procurement_capabilities"]["can_manage_grants"]
    ProcurementStore(settings.database_path).initialize()
    AuthorizationStore(settings.database_path).set_field_policy("procurement.material_unit_price", 2, 3, ["procurement"], ["procurement"])
    set_grant(settings.database_path, admin, buyer["id"], True)
    sign_in(client)
    data = client.get("/api/me/profile").json()
    assert data["id"] == buyer["id"] and data["scope_levels"] == {"procurement": 3, "research": 2}
    assert data["procurement_capabilities"]["can_activate"]
    assert not data["procurement_capabilities"]["can_manage_grants"]
    assert "password_hash" not in data and admin["id"] not in str(data)
    assert client.patch(f'/api/users/{buyer["id"]}/profile', json={"display_name": "伪造"}).status_code == 403
    assert client.patch(f'/api/users/{admin["id"]}/profile', json={"display_name": "伪造"}).status_code == 403
    assert change(client, user_id=admin["id"]).status_code == 422
    sign_in(client, "temporary-empty")
    data = client.get("/api/me/profile").json()
    assert data["department"] is None and data["scope_levels"] == {}
    assert not any(data["procurement_capabilities"].values())
    client.post("/api/logout")
    assert client.get("/api/me/profile").status_code == 401
    assert change(client).status_code == 401


def test_admin_profile_only_name_department_and_preserve_history(account):
    settings, client, store, admin, buyer, _ = account
    ProcurementStore(settings.database_path).initialize()
    # An existing saved operation retains its actor name, even after renaming.
    with sqlite3.connect(settings.database_path) as db:
        db.execute("INSERT INTO procurement_saved_changes VALUES (?,?,?,?,?,?,?,?,?)", ("event", "round", "material", buyer["id"], buyer["display_name"], "1", "2", "2026-09-09", datetime.now(UTC).isoformat()))
    before = store.get_user(buyer["id"])
    response = client.patch(f'/api/users/{buyer["id"]}/profile', json={"display_name": " 新姓名 ", "membership": {"primary_department_id": None, "additional_department_ids": []}})
    assert response.status_code == 200 and response.json()["department"] is None
    after = store.get_user(buyer["id"])
    assert after == {**before, "display_name": "新姓名", "department": None, "primary_department_id": None, "additional_department_ids": [], "departments": []}
    for forbidden in ("username", "scope_levels", "is_active", "is_system_admin"):
        assert client.patch(f'/api/users/{buyer["id"]}/profile', json={"display_name": "姓名", forbidden: True}).status_code == 422
    for name in (" ", "名" * 101):
        assert client.patch(f'/api/users/{buyer["id"]}/profile', json={"display_name": name}).status_code == 422
    assert client.patch(f'/api/users/{admin["id"]}/profile', json={"display_name": "管理员新姓名", "department": None}).status_code == 200
    assert client.get("/api/me/profile").json()["display_name"] == "管理员新姓名"
    with sqlite3.connect(settings.database_path) as db:
        assert db.execute("SELECT actor_name FROM procurement_saved_changes").fetchone()[0] == buyer["display_name"]
    event = AuthorizationStore(settings.database_path).list_audit_events()[0]
    assert event["action"] == "user.profile.updated" and event["target_id"] == admin["id"] and event["created_at"]


def test_self_profile_is_read_only_for_users_and_admin(account):
    _, client, store, admin, _, empty = account
    before = store.get_user(admin['id'])
    assert client.patch('/api/me/profile', json={'display_name':'修改'}).status_code == 403
    assert store.get_user(admin['id']) == before
    sign_in(client, 'temporary-empty')
    before = store.get_user(empty['id'])
    for fields in ({'display_name':'修改'}, {'display_name':'修改', 'department':'采购部'}):
        assert client.patch('/api/me/profile', json=fields).status_code == 403
    assert store.get_user(empty['id']) == before
    assert store.login(empty['username'], OLD, 300)


def test_self_profile_rejects_extra_identity_permission_and_password_fields(account):
    _, client, store, admin, buyer, _ = account
    sign_in(client)
    before = store.get_user(buyer['id'])
    for extra in ({'user_id':admin['id']}, {'id':admin['id']}, {'username':'changed'}, {'scope_levels':{'procurement':4}}, {'is_system_admin':True}, {'is_active':False}, {'password':NEW}):
        assert client.patch('/api/me/profile', json={'display_name':'姓名', **extra}).status_code == 422
    for name in (' ', '名' * 101):
        assert client.patch('/api/me/profile', json={'display_name':name}).status_code == 422
    assert store.get_user(buyer['id']) == before
    with pytest.raises(PermissionError):
        store.update_profile(admin['id'], actor_id=buyer['id'], display_name='越权姓名', department=None)


def test_self_profile_rejects_logged_out_and_disabled_accounts(account):
    _, client, store, _, buyer, _ = account
    sign_in(client)
    store.update_user(buyer['id'], is_active=False)
    assert client.patch('/api/me/profile', json={'display_name':'停用修改'}).status_code == 401
    with pytest.raises(PermissionError):
        store.update_profile(buyer['id'], actor_id=buyer['id'], display_name='停用修改', department=None)
    client.cookies.clear()
    assert client.patch('/api/me/profile', json={'display_name':'匿名修改'}).status_code == 401
    assert store.get_user(buyer['id'])['display_name'] == buyer['display_name']


@pytest.mark.parametrize("changes,status", [
    ({"current_password": "incorrect-current"}, 400),
    ({"confirm_password": "Not-Matching-Password"}, 422),
    ({"new_password": "", "confirm_password": ""}, 422),
    ({"new_password": "x" * 1001, "confirm_password": "x" * 1001}, 422),
    ({"new_password": OLD, "confirm_password": OLD}, 422),
])
def test_password_failure_preserves_credentials_sessions_and_redacts(account, changes, status):
    _, client, store, _, buyer, _ = account
    sign_in(client)
    token = client.cookies.get(SESSION_COOKIE_NAME)
    response = change(client, **changes)
    assert response.status_code == status
    assert OLD not in response.text and NEW not in response.text
    assert store.user_for_session(token)["id"] == buyer["id"]
    assert store.login(buyer["username"], OLD, 300)


def test_password_success_revokes_all_sessions_but_not_other_users(account):
    _, client, store, admin, buyer, empty = account
    admin_token = client.cookies.get(SESSION_COOKIE_NAME)
    _, other_token = store.login(empty["username"], OLD, 300)
    _, older_token = store.login(buyer["username"], OLD, 300)
    sign_in(client)
    current_token = client.cookies.get(SESSION_COOKIE_NAME)
    response = change(client)
    assert response.status_code == 200 and 'Max-Age=0' in response.headers["set-cookie"]
    assert client.get("/api/me").status_code == 401
    assert store.user_for_session(current_token) is None and store.user_for_session(older_token) is None
    assert store.user_for_session(other_token) and store.user_for_session(admin_token)
    assert store.login(buyer["username"], OLD, 300) is None
    sign_in(client, password=NEW)
    assert client.get("/api/me/profile").json()["id"] == buyer["id"]


def test_wrong_password_limit_is_account_wide_persistent_and_expires(account):
    settings, client, store, _, buyer, _ = account
    sign_in(client)
    for _ in range(5):
        assert change(client, current_password="wrong-current").status_code == 400
        sign_in(client)  # New sessions cannot bypass the account limit.
    assert change(client).status_code == 429
    token = client.cookies.get(SESSION_COOKIE_NAME)
    assert IdentityStore(settings.database_path).change_password(buyer["id"], token, OLD, NEW, NEW) == "limited"
    with sqlite3.connect(settings.database_path) as db:
        db.execute("UPDATE identity_password_failures SET attempted_at=?", ((datetime.now(UTC)-timedelta(minutes=16)).isoformat(),))
    assert change(client).status_code == 200
    events = AuthorizationStore(settings.database_path).list_audit_events()
    assert "password.limited" in [event["action"] for event in events]
    assert OLD not in str(events) and NEW not in str(events) and "wrong-current" not in str(events)


def test_concurrent_password_changes_have_one_winner(account):
    _, _, store, _, buyer, _ = account
    _, token1 = store.login(buyer["username"], OLD, 300)
    _, token2 = store.login(buyer["username"], OLD, 300)
    barrier = threading.Barrier(2)
    def attempt(token, password):
        barrier.wait()
        return store.change_password(buyer["id"], token, OLD, password, password)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = [pool.submit(attempt, token1, NEW), pool.submit(attempt, token2, NEW + "other")]
        assert sorted(future.result() for future in results) == ["changed", "expired"]
    assert store.user_for_session(token1) is None and store.user_for_session(token2) is None
    assert sum(bool(store.login(buyer["username"], password, 300)) for password in (NEW, NEW+"other")) == 1


def test_in_flight_old_password_login_cannot_restore_session(account, monkeypatch):
    import api.identity as identity
    _, _, store, _, buyer, _ = account
    _, token = store.login(buyer["username"], OLD, 300)
    checked, resume = threading.Event(), threading.Event()
    original = identity._hash_password
    def delayed_hash(password, salt):
        value = original(password, salt)
        if threading.current_thread().name.startswith("old-login"):
            checked.set()
            assert resume.wait(5)
        return value
    monkeypatch.setattr(identity, "_hash_password", delayed_hash)
    with ThreadPoolExecutor(max_workers=1, thread_name_prefix="old-login") as pool:
        pending = pool.submit(store.login, buyer["username"], OLD, 300)
        assert checked.wait(5)
        try:
            assert store.change_password(buyer["id"], token, OLD, NEW, NEW) == "changed"
        finally:
            resume.set()
        assert pending.result() is None
def test_weak_password_is_advisory_not_blocking(account):
    _, client, store, _, buyer, _ = account
    sign_in(client)
    assert change(client, new_password="123456", confirm_password="123456").status_code == 200
    assert store.login(buyer["username"], "123456", 300)
