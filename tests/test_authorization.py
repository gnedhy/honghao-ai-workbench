import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from api.authorization import AuthorizationStore
from api.identity import IdentityStore
from api.main import create_app
from api.modules import default_module_modes
from api.settings import Settings
from tests.helpers import authenticated_client


def test_role_permission_changes_take_effect_without_a_new_login(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")
    app = create_app(settings)

    with authenticated_client(settings) as admin, TestClient(app) as employee:
        role = admin.post("/api/roles", json={"name": "工作台访客"}).json()
        admin.post(
            "/api/users",
            json={
                "username": "visitor",
                "display_name": "工作台访客",
                "department": None,
                "password": "Visitor-Password-2026",
                "role_ids": [role["id"]],
            },
        )
        assert employee.post(
            "/api/login",
            json={"username": "visitor", "password": "Visitor-Password-2026"},
        ).status_code == 200

        denied = employee.get("/api/workbenches")
        changed = admin.put(
            f"/api/admin/roles/{role['id']}/permissions",
            json={"permission_ids": ["workbench.view"]},
        )
        policies = admin.get("/api/admin/role-permissions")
        allowed = employee.get("/api/workbenches")
        visible_modules = employee.get("/api/modules")

    assert denied.status_code == 403
    assert changed.status_code == 200
    assert changed.json() == {"role_id": role["id"], "permission_ids": ["workbench.view"]}
    assert {item["role_id"]: item["permission_ids"] for item in policies.json()}[role["id"]] == ["workbench.view"]
    assert allowed.status_code == 200
    assert [module["id"] for module in visible_modules.json()] == ["workbench"]


def test_work_submission_requires_task_management_permission(tmp_path: Path) -> None:
    module_modes = default_module_modes()
    module_modes.update({"chat": "active", "tasks": "active"})
    settings = Settings.from_data_dir(tmp_path / "data", module_modes=module_modes)
    app = create_app(settings)

    with authenticated_client(settings) as admin, TestClient(app) as employee:
        role = admin.post("/api/roles", json={"name": "聊天协作者"}).json()
        admin.put(
            f"/api/admin/roles/{role['id']}/permissions",
            json={"permission_ids": ["chat.use"]},
        )
        admin.post(
            "/api/users",
            json={
                "username": "collaborator",
                "display_name": "聊天协作者",
                "password": "Collaborator-Password-2026",
                "role_ids": [role["id"]],
            },
        )
        employee.post(
            "/api/login",
            json={"username": "collaborator", "password": "Collaborator-Password-2026"},
        )
        conversation = employee.post("/api/conversations", json={"title": "权限验证"}).json()
        payload = {
            "mode": "work",
            "content": "创建一个需要持续执行的任务",
            "submission_key": "39a2717d-b00b-4aae-942c-7dd5f8cf5a7c",
        }

        denied = employee.post(f"/api/conversations/{conversation['id']}/submissions", json=payload)
        admin.put(
            f"/api/admin/roles/{role['id']}/permissions",
            json={"permission_ids": ["chat.use", "tasks.manage"]},
        )
        allowed = employee.post(f"/api/conversations/{conversation['id']}/submissions", json=payload)

    assert denied.status_code == 403
    assert allowed.status_code == 201
    assert allowed.json()["task"]["status"] == "created"


def test_sensitive_field_policy_uses_role_union_for_read_and_write(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")

    with authenticated_client(settings) as admin:
        reader = admin.post("/api/roles", json={"name": "成本查看人"}).json()
        writer = admin.post("/api/roles", json={"name": "成本维护人"}).json()
        changed = admin.put(
            "/api/admin/fields/procurement.material_unit_price",
            json={
                "read_role_ids": [reader["id"]],
                "write_role_ids": [writer["id"]],
            },
        )

    store = AuthorizationStore(settings.database_path)
    payload = {"material_name": "乙二醇", "unit_price": 4280}
    mapping = {"unit_price": "procurement.material_unit_price"}

    assert changed.status_code == 200
    assert store.filter_readable_fields(payload, mapping, [reader["id"]]) == payload
    assert store.filter_readable_fields(payload, mapping, ["employee"]) == {"material_name": "乙二醇"}
    assert store.can_write_field("procurement.material_unit_price", [reader["id"], writer["id"]])
    assert not store.can_write_field("procurement.material_unit_price", [reader["id"]])


def test_system_admin_can_register_a_custom_sensitive_field(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")

    with authenticated_client(settings) as admin:
        reader = admin.post("/api/roles", json={"name": "合同查看人"}).json()
        created = admin.post(
            "/api/admin/fields",
            json={
                "area": "采购",
                "name": "合同付款条件",
                "description": "采购合同约定的付款方式与账期",
                "read_role_ids": [reader["id"]],
                "write_role_ids": [],
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
        "read_role_ids": [reader["id"]],
        "write_role_ids": [],
    }
    assert created_field in fields.json()
    assert any(
        event["action"] == "field.created" and event["target_id"] == created_field["id"]
        for event in events.json()
    )


def test_security_changes_and_logins_are_audited_without_field_values(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")

    with authenticated_client(settings) as admin:
        role = admin.post("/api/roles", json={"name": "报价审阅人"}).json()
        admin.put(
            f"/api/admin/roles/{role['id']}/permissions",
            json={"permission_ids": ["workbench.view"]},
        )
        admin.put(
            "/api/admin/fields/sales.floor_price",
            json={"read_role_ids": [role["id"]], "write_role_ids": []},
        )
        events = admin.get("/api/admin/audit-events")

    assert events.status_code == 200
    actions = {event["action"] for event in events.json()}
    assert {
        "login.succeeded",
        "role.created",
        "role.permissions.updated",
        "field.policy.updated",
    } <= actions
    assert "报价底价" not in events.text


def test_system_admin_cannot_lock_out_the_current_account(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")

    with authenticated_client(settings) as admin:
        current = admin.get("/api/me").json()
        deactivate = admin.patch(f"/api/users/{current['id']}", json={"is_active": False})
        remove_admin_role = admin.patch(f"/api/users/{current['id']}", json={"role_ids": ["employee"]})

    assert deactivate.status_code == 422
    assert remove_admin_role.status_code == 422


def test_non_admin_cannot_read_management_policies_or_audit(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")

    with TestClient(create_app(settings)) as employee:
        IdentityStore(settings.database_path).create_user(
            username="employee",
            display_name="普通员工",
            department=None,
            password="Employee-Password-2026",
            role_ids=["employee"],
        )
        employee.post("/api/login", json={"username": "employee", "password": "Employee-Password-2026"})
        responses = [
            employee.get("/api/admin/permissions"),
            employee.get("/api/admin/role-permissions"),
            employee.get("/api/admin/fields"),
            employee.post(
                "/api/admin/fields",
                json={
                    "area": "销售",
                    "name": "客户折扣",
                    "description": "客户协议折扣",
                    "read_role_ids": [],
                    "write_role_ids": [],
                },
            ),
            employee.get("/api/admin/audit-events"),
        ]

    assert [response.status_code for response in responses] == [403, 403, 403, 403, 403]


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

    assert version == (2,)
    assert custom_fields_table == ("authorization_custom_fields",)


def test_authorization_schema_is_additive_and_not_downgraded(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")

    with TestClient(create_app(settings)) as client:
        health = client.get("/api/health")

    with sqlite3.connect(settings.database_path) as connection:
        version = connection.execute(
            "SELECT value FROM schema_metadata WHERE key = 'authorization_schema_version'"
        ).fetchone()
        connection.execute(
            "UPDATE schema_metadata SET value = 3 WHERE key = 'authorization_schema_version'"
        )

    assert health.json()["schema_version"] == 5
    assert version == (2,)
    with pytest.raises(RuntimeError, match="Unsupported authorization schema version"):
        with TestClient(create_app(settings)):
            pass
