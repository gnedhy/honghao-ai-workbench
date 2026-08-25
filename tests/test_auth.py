import sqlite3
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from api.database import Database
from api.identity import IdentityStore, SYSTEM_ADMIN_ROLE_ID
from api.main import create_app
from api.settings import Settings


def create_admin(settings: Settings, password: str = "Correct-Horse-2026") -> None:
    IdentityStore(settings.database_path).create_user(
        username="admin",
        display_name="系统管理员",
        department="总经办",
        password=password,
        role_ids=[SYSTEM_ADMIN_ROLE_ID],
    )


def test_admin_can_log_in_and_read_current_session(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")
    app = create_app(settings)

    with TestClient(app) as client:
        create_admin(settings)
        login = client.post(
            "/api/login",
            json={"username": "admin", "password": "Correct-Horse-2026"},
        )
        current = client.get("/api/me")

    assert login.status_code == 200
    assert login.json() == {
        "id": login.json()["id"],
        "username": "admin",
        "display_name": "系统管理员",
        "department": "总经办",
        "roles": [{"id": "system-admin", "name": "系统管理员", "system": True}],
    }
    assert current.status_code == 200
    assert current.json() == login.json()
    assert "HttpOnly" in login.headers["set-cookie"]
    assert "SameSite=strict" in login.headers["set-cookie"]
    assert "Correct-Horse-2026" not in login.text


def test_logout_invalidates_the_server_session(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")

    with TestClient(create_app(settings)) as client:
        create_admin(settings)
        client.post("/api/login", json={"username": "admin", "password": "Correct-Horse-2026"})
        logout = client.post("/api/logout")
        current = client.get("/api/me")

    assert logout.status_code == 204
    assert current.status_code == 401


def test_business_apis_require_authentication(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")

    with TestClient(create_app(settings)) as client:
        health = client.get("/api/health")
        modules_before_login = client.get("/api/modules")
        create_admin(settings)
        client.post("/api/login", json={"username": "admin", "password": "Correct-Horse-2026"})
        modules_after_login = client.get("/api/modules")

    assert health.status_code == 200
    assert modules_before_login.status_code == 401
    assert modules_after_login.status_code == 200


def test_admin_can_create_a_custom_role_and_multi_role_user(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")

    with TestClient(create_app(settings)) as client:
        create_admin(settings)
        client.post("/api/login", json={"username": "admin", "password": "Correct-Horse-2026"})
        role = client.post("/api/roles", json={"name": "成本审阅人"})
        user = client.post(
            "/api/users",
            json={
                "username": "buyer",
                "display_name": "采购专员",
                "department": "采购部",
                "password": "Buyer-Password-2026",
                "role_ids": ["employee", role.json()["id"]],
            },
        )
        client.post("/api/logout")
        login = client.post(
            "/api/login",
            json={"username": "buyer", "password": "Buyer-Password-2026"},
        )

    assert role.status_code == 201
    assert role.json()["name"] == "成本审阅人"
    assert role.json()["system"] is False
    assert user.status_code == 201
    assert login.status_code == 200
    assert {item["name"] for item in login.json()["roles"]} == {"普通员工", "成本审阅人"}


def test_role_change_invalidates_existing_sessions(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")
    app = create_app(settings)

    with TestClient(app) as admin_client, TestClient(app) as employee_client:
        create_admin(settings)
        admin_client.post("/api/login", json={"username": "admin", "password": "Correct-Horse-2026"})
        employee = admin_client.post(
            "/api/users",
            json={
                "username": "employee",
                "display_name": "普通员工",
                "department": "采购部",
                "password": "Employee-Password-2026",
                "role_ids": ["employee"],
            },
        ).json()
        employee_client.post(
            "/api/login",
            json={"username": "employee", "password": "Employee-Password-2026"},
        )
        changed = admin_client.patch(
            f"/api/users/{employee['id']}",
            json={"role_ids": ["procurement"]},
        )
        current = employee_client.get("/api/me")

    assert changed.status_code == 200
    assert [role["id"] for role in changed.json()["roles"]] == ["procurement"]
    assert current.status_code == 401


def test_deactivated_account_cannot_keep_or_create_a_session(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")
    app = create_app(settings)

    with TestClient(app) as admin_client, TestClient(app) as employee_client:
        create_admin(settings)
        admin_client.post("/api/login", json={"username": "admin", "password": "Correct-Horse-2026"})
        employee = admin_client.post(
            "/api/users",
            json={
                "username": "employee",
                "display_name": "普通员工",
                "department": "采购部",
                "password": "Employee-Password-2026",
                "role_ids": ["employee"],
            },
        ).json()
        employee_client.post(
            "/api/login",
            json={"username": "employee", "password": "Employee-Password-2026"},
        )
        admin_client.patch(f"/api/users/{employee['id']}", json={"is_active": False})
        current = employee_client.get("/api/me")
        login_again = employee_client.post(
            "/api/login",
            json={"username": "employee", "password": "Employee-Password-2026"},
        )

    assert current.status_code == 401
    assert login_again.status_code == 401


def test_wrong_password_is_rejected_without_sensitive_response_data(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")

    with TestClient(create_app(settings)) as client:
        create_admin(settings)
        response = client.post(
            "/api/login",
            json={"username": "admin", "password": "Wrong-Password-2026"},
        )

    assert response.status_code == 401
    assert response.json() == {"detail": "Invalid username or password"}
    assert "Wrong-Password-2026" not in response.text
    assert "hash" not in response.text.lower()


def test_expired_session_is_rejected(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data", session_ttl_seconds=1)

    with TestClient(create_app(settings)) as client:
        create_admin(settings)
        client.post("/api/login", json={"username": "admin", "password": "Correct-Horse-2026"})
        time.sleep(1.1)
        current = client.get("/api/me")

    assert current.status_code == 401


def test_identity_schema_is_additive_to_core_schema_v5(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")

    with TestClient(create_app(settings)) as client:
        health = client.get("/api/health")

    with sqlite3.connect(settings.database_path) as connection:
        identity_version = connection.execute(
            "SELECT value FROM schema_metadata WHERE key = 'identity_schema_version'"
        ).fetchone()

    assert health.json()["schema_version"] == 5
    assert identity_version == (1,)


def test_non_admin_cannot_manage_users_or_roles(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")

    with TestClient(create_app(settings)) as client:
        IdentityStore(settings.database_path).create_user(
            username="employee",
            display_name="普通员工",
            department=None,
            password="Employee-Password-2026",
            role_ids=["employee"],
        )
        client.post(
            "/api/login",
            json={"username": "employee", "password": "Employee-Password-2026"},
        )
        roles = client.get("/api/roles")
        users = client.get("/api/users")

    assert roles.status_code == 403
    assert users.status_code == 403


def test_newer_identity_schema_is_not_silently_downgraded(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")
    settings.ensure_directories()
    Database(settings.database_path).initialize()
    with sqlite3.connect(settings.database_path) as connection:
        connection.execute(
            "INSERT INTO schema_metadata (key, value) VALUES ('identity_schema_version', 2)"
        )

    with pytest.raises(RuntimeError, match="Unsupported identity schema version"):
        with TestClient(create_app(settings)):
            pass

    with sqlite3.connect(settings.database_path) as connection:
        version = connection.execute(
            "SELECT value FROM schema_metadata WHERE key = 'identity_schema_version'"
        ).fetchone()
    assert version == (2,)
