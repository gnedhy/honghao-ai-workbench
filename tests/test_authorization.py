import os
from pathlib import Path

from fastapi.testclient import TestClient

from api.authorization import AuthorizationStore
from api.database import Database
from api.identity import IdentityStore
from api.main import create_app
from api.postgres import transaction
from api.settings import Settings
from tests.helpers import authenticated_client


def test_field_management_endpoints_are_retired_without_changing_history(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")
    with authenticated_client(settings) as admin:
        store = AuthorizationStore(settings.database_url)
        field = store.create_field("采购", "合同付款条件", "历史配置", 2, 3, ["procurement"], ["procurement"])
        store.audit("field.created", actor_user_id=None, target_type="field", target_id=field["id"])
        before = store.list_field_policies()
        for method, url in [
            ("GET", "/api/admin/fields"),
            ("POST", "/api/admin/fields"),
            ("PUT", "/api/admin/fields/procurement.material_unit_price"),
        ]:
            assert admin.request(method, url, json={}).status_code == 404
        assert store.list_field_policies() == before
        events = admin.get("/api/admin/audit-events")
        assert events.status_code == 200
        assert {"login.succeeded", "field.created"} <= {event["action"] for event in events.json()}
        assert "合同付款条件" not in events.text


def test_non_admin_cannot_read_management_policies_or_audit(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")

    with TestClient(create_app(settings)) as employee:
        IdentityStore(settings.database_url).create_user(
            username="employee",
            display_name="普通员工",
            department=None,
            password="Employee-Password-2026",
            scope_levels={"sales": 2},
        )
        employee.post(
            "/api/login",
            json={"username": "employee", "password": "Employee-Password-2026"},
        )
        responses = [
            employee.get("/api/admin/fields"),
            employee.post(
                "/api/admin/fields",
                json={
                    "area": "销售",
                    "name": "客户折扣",
                    "description": "客户协议折扣",
                    "read_min_level": 2,
                    "write_min_level": 3,
                    "read_scope_ids": ["sales"],
                    "write_scope_ids": ["sales"],
                },
            ),
            employee.get("/api/admin/audit-events"),
        ]

    assert [response.status_code for response in responses] == [404, 404, 403]


def test_authorization_v1_requires_explicit_upgrade_without_recreating_missing_table(tmp_path: Path) -> None:
    """Old SQLite schemas must be upgraded by the old app before PostgreSQL import."""
    settings = Settings.from_data_dir(tmp_path / "data")
    with transaction(os.environ['HONGHAO_TEST_MIGRATION_URL'], write=True) as connection:
        connection.execute("DROP TABLE authorization_custom_fields")
        connection.execute("UPDATE schema_metadata SET value=1 WHERE key='authorization_schema_version'")
    with TestClient(create_app(settings)) as client:
        assert client.get('/api/readiness').status_code == 503
        assert client.get('/api/admin/audit-events').status_code == 503
    with transaction(settings.database_url) as connection:
        assert connection.execute("SELECT value FROM schema_metadata WHERE key='authorization_schema_version'").fetchone() == (1,)
        assert connection.execute("SELECT to_regclass('authorization_custom_fields')").fetchone() == (None,)


def test_authorization_v3_is_rejected_without_rewriting_legacy_field_levels(tmp_path: Path) -> None:
    """A prior application's basic-to-view conversion is not performed by PostgreSQL startup."""
    settings = Settings.from_data_dir(tmp_path / "data")
    store = AuthorizationStore(settings.database_url)
    store.set_field_policy('procurement.material_unit_price', 2, 3, ['procurement'], ['procurement'])
    with transaction(settings.database_url, write=True) as connection:
        connection.execute("UPDATE authorization_field_policies SET read_min_level=1,write_min_level=1 WHERE field_id='procurement.material_unit_price'")
        connection.execute("UPDATE schema_metadata SET value=3 WHERE key='authorization_schema_version'")
    with TestClient(create_app(settings)) as client:
        assert client.get('/api/readiness').status_code == 503
        assert client.get('/api/admin/audit-events').status_code == 503
    with transaction(settings.database_url) as connection:
        assert connection.execute("SELECT read_min_level,write_min_level,read_scope_ids,write_scope_ids FROM authorization_field_policies WHERE field_id='procurement.material_unit_price'").fetchone() == (1, 1, '["procurement"]', '["procurement"]')
        assert connection.execute("SELECT value FROM schema_metadata WHERE key='authorization_schema_version'").fetchone() == (3,)


def test_authorization_schema_is_additive_and_not_downgraded(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")

    with TestClient(create_app(settings)) as client:
        health = client.get("/api/health")

    with transaction(settings.database_url, write=True) as connection:
        version = connection.execute(
            "SELECT value FROM schema_metadata WHERE key = 'authorization_schema_version'"
        ).fetchone()
        connection.execute(
            "UPDATE schema_metadata SET value = 6 WHERE key = 'authorization_schema_version'"
        )

    assert health.status_code == 200
    assert Database(settings.database_url).schema_version() == 5
    assert version == (5,)
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/readiness").status_code == 503
        assert client.get("/api/admin/fields").status_code == 503
