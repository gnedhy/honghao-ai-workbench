import sqlite3
from pathlib import Path

from fastapi.testclient import TestClient

from api.authorization import AuthorizationStore
from api.database import Database
from api.identity import IdentityStore
from api.main import create_app
from api.settings import Settings
from tests.helpers import authenticated_client


def test_system_admin_can_register_a_custom_sensitive_field(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")

    with authenticated_client(settings) as admin:
        created = admin.post(
            "/api/admin/fields",
            json={
                "area": "采购",
                "name": "合同付款条件",
                "description": "采购合同约定的付款方式与账期",
                "read_min_level": 2,
                "write_min_level": 3,
                "read_scope_ids": ["procurement", "management"],
                "write_scope_ids": ["procurement"],
            },
        )
        fields = admin.get("/api/admin/fields")
        events = admin.get("/api/admin/audit-events")

    created_field = created.json()
    assert created.status_code == 201
    assert created_field["id"].startswith("custom.")
    assert {key: value for key, value in created_field.items() if key != "id"} == {
        "area": "采购",
        "name": "合同付款条件",
        "description": "采购合同约定的付款方式与账期",
        "read_min_level": 2,
        "write_min_level": 3,
        "read_scope_ids": ["management", "procurement"],
        "write_scope_ids": ["procurement"],
    }
    assert created_field in fields.json()
    assert any(
        event["action"] == "field.created" and event["target_id"] == created_field["id"]
        for event in events.json()
    )


def test_view_permission_cannot_be_used_as_field_write_permission(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")

    with authenticated_client(settings) as admin:
        response = admin.put(
            "/api/admin/fields/procurement.material_unit_price",
            json={
                "read_min_level": 2,
                "write_min_level": 2,
                "read_scope_ids": ["procurement"],
                "write_scope_ids": ["procurement"],
            },
        )

    assert response.status_code == 422


def test_security_changes_and_logins_are_audited_without_field_values(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")

    with authenticated_client(settings) as admin:
        admin.put(
            "/api/admin/fields/sales.floor_price",
            json={
                "read_min_level": 2,
                "write_min_level": 3,
                "read_scope_ids": ["sales", "management"],
                "write_scope_ids": ["sales"],
            },
        )
        events = admin.get("/api/admin/audit-events")

    assert events.status_code == 200
    assert {"login.succeeded", "field.policy.updated"} <= {
        event["action"] for event in events.json()
    }
    assert "报价底价" not in events.text


def test_non_admin_cannot_read_management_policies_or_audit(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")

    with TestClient(create_app(settings)) as employee:
        IdentityStore(settings.database_path).create_user(
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

    assert [response.status_code for response in responses] == [403, 403, 403]


def test_authorization_schema_migrates_custom_fields_additively(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")

    with TestClient(create_app(settings)):
        pass
    with sqlite3.connect(settings.database_path) as connection:
        connection.execute("DROP TABLE authorization_custom_fields")
        connection.execute(
            "UPDATE schema_metadata SET value = 1 WHERE key = 'authorization_schema_version'"
        )

    with TestClient(create_app(settings)):
        pass
    with sqlite3.connect(settings.database_path) as connection:
        version = connection.execute(
            "SELECT value FROM schema_metadata WHERE key = 'authorization_schema_version'"
        ).fetchone()
        custom_fields_table = connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'authorization_custom_fields'"
        ).fetchone()

    assert version == (5,)
    assert custom_fields_table == ("authorization_custom_fields",)


def test_authorization_v3_migrates_removed_basic_level_to_view(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")

    with TestClient(create_app(settings)):
        pass
    store = AuthorizationStore(settings.database_path)
    store.set_field_policy(
        "procurement.material_unit_price",
        2,
        3,
        ["procurement"],
        ["procurement"],
    )
    with sqlite3.connect(settings.database_path) as connection:
        connection.execute(
            "UPDATE authorization_field_policies SET read_min_level = 1, write_min_level = 1 WHERE field_id = 'procurement.material_unit_price'"
        )
        connection.execute(
            "UPDATE schema_metadata SET value = 3 WHERE key = 'authorization_schema_version'"
        )

    store.initialize()
    policy = next(
        item for item in store.list_field_policies()
        if item["id"] == "procurement.material_unit_price"
    )

    assert policy["read_min_level"] == 2
    assert policy["write_min_level"] == 3


def test_authorization_schema_is_additive_and_not_downgraded(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")

    with TestClient(create_app(settings)) as client:
        health = client.get("/api/health")

    with sqlite3.connect(settings.database_path) as connection:
        version = connection.execute(
            "SELECT value FROM schema_metadata WHERE key = 'authorization_schema_version'"
        ).fetchone()
        connection.execute(
            "UPDATE schema_metadata SET value = 6 WHERE key = 'authorization_schema_version'"
        )

    assert health.status_code == 200
    assert Database(settings.database_path).schema_version() == 5
    assert version == (5,)
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/readiness").status_code == 503
        assert client.get("/api/admin/fields").status_code == 503
