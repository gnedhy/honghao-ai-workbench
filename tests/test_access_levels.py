import sqlite3
from pathlib import Path

from fastapi.testclient import TestClient

from api.authorization import AuthorizationStore
from api.database import Database
from api.identity import IdentityStore
from api.main import create_app
from api.settings import Settings
from tests.helpers import authenticated_client


def test_each_scope_keeps_its_own_level_and_limits_visible_workbenches(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")
    app = create_app(settings)

    with authenticated_client(settings) as admin, TestClient(app) as sales:
        created = admin.post(
            "/api/users",
            json={
                "username": "sales-user",
                "display_name": "销售经办",
                "department": "销售部",
                "password": "Sales-Password-2026",
                "scope_levels": {"sales": 4, "research": 2},
            },
        )
        login = sales.post(
            "/api/login",
            json={"username": "sales-user", "password": "Sales-Password-2026"},
        )
        workbenches = sales.get("/api/workbenches")

    assert created.status_code == 201
    assert created.json()["is_system_admin"] is False
    assert created.json()["scope_levels"] == {"research": 2, "sales": 4}
    assert login.status_code == 200
    assert [item["id"] for item in workbenches.json()] == ["research", "sales"]


def test_unassigned_user_has_no_workbench_viewer_can_enter_and_system_admin_sees_all(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")
    app = create_app(settings)

    with authenticated_client(settings) as admin, TestClient(app) as member:
        admin.post(
            "/api/users",
            json={
                "username": "member",
                "display_name": "采购查看",
                "password": "Member-Password-2026",
                "scope_levels": {"procurement": 2},
            },
        )
        member.post(
            "/api/login",
            json={"username": "member", "password": "Member-Password-2026"},
        )
        basic = member.get("/api/workbenches")
        all_workbenches = admin.get("/api/workbenches")

    assert basic.status_code == 200
    assert basic.json() == [{"id": "procurement", "mode": "prototype"}]
    assert [item["id"] for item in all_workbenches.json()] == [
        "management",
        "procurement",
        "research",
        "sales",
    ]


def test_scope_level_change_invalidates_existing_session(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")
    app = create_app(settings)

    with authenticated_client(settings) as admin, TestClient(app) as employee:
        user = admin.post(
            "/api/users",
            json={
                "username": "buyer",
                "display_name": "采购查看",
                "password": "Buyer-Password-2026",
                "scope_levels": {"procurement": 2},
            },
        ).json()
        employee.post(
            "/api/login",
            json={"username": "buyer", "password": "Buyer-Password-2026"},
        )
        changed = admin.patch(
            f"/api/users/{user['id']}",
            json={"scope_levels": {"procurement": 3, "research": 2}},
        )
        current = employee.get("/api/me")

    assert changed.status_code == 200
    assert changed.json()["scope_levels"] == {"procurement": 3, "research": 2}
    assert current.status_code == 401


def test_current_system_admin_cannot_remove_own_system_access(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")

    with authenticated_client(settings) as admin:
        current = admin.get("/api/me").json()
        response = admin.patch(
            f"/api/users/{current['id']}",
            json={"is_system_admin": False},
        )

    assert response.status_code == 422


def test_current_system_admin_cannot_resave_own_access_and_keeps_session(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")

    with authenticated_client(settings) as admin:
        current = admin.get("/api/me").json()
        response = admin.patch(
            f"/api/users/{current['id']}",
            json={"is_system_admin": True, "scope_levels": {}},
        )
        session = admin.get("/api/me")

    assert response.status_code == 422
    assert session.status_code == 200


def test_system_admin_never_persists_specific_scopes(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")
    with authenticated_client(settings) as admin:
        created = admin.post(
            "/api/users",
            json={
                "username": "second-admin",
                "display_name": "第二管理员",
                "department": None,
                "password": "Second-Admin-Password-2026",
                "is_system_admin": True,
                "scope_levels": {"sales": 4},
            },
        )

    assert created.status_code == 201
    assert created.json()["is_system_admin"] is True
    assert created.json()["scope_levels"] == {}


def test_user_api_rejects_old_global_level_and_removed_scope_levels(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")
    with authenticated_client(settings) as admin:
        old_shape = admin.post(
            "/api/users",
            json={
                "username": "old-shape",
                "display_name": "旧权限格式",
                "password": "Old-Shape-Password-2026",
                "access_level": 3,
                "scope_ids": ["procurement"],
            },
        )
        invalid_level = admin.post(
            "/api/users",
            json={
                "username": "invalid-scope-level",
                "display_name": "错误范围等级",
                "password": "Invalid-Level-Password-2026",
                "scope_levels": {"procurement": 5},
            },
        )
        removed_basic_level = admin.post(
            "/api/users",
            json={
                "username": "removed-basic-level",
                "display_name": "旧基础等级",
                "password": "Removed-Level-Password-2026",
                "scope_levels": {"procurement": 1},
            },
        )

    assert old_shape.status_code == 422
    assert invalid_level.status_code == 422
    assert removed_basic_level.status_code == 422


def test_fields_follow_only_their_own_scope_and_level(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")
    with authenticated_client(settings):
        pass
    store = AuthorizationStore(settings.database_path)
    # An old cross-scope grant must neither expose prices nor block their owner.
    store.set_field_policy("procurement.material_unit_price", 4, 4, ["research"], ["research"])
    payload = {"material_name": "乙二醇", "unit_price": 4280}
    mapping = {"unit_price": "procurement.material_unit_price"}
    for level in (0, 1, 2, 3, 4):
        expected = payload if level >= 2 else {"material_name": "乙二醇"}
        assert store.filter_readable_fields(payload, mapping, False, {"procurement": level}) == expected
        assert store.can_write_field("procurement.material_unit_price", False, {"procurement": level}) == (level >= 3)
        assert store.filter_readable_fields(payload, mapping, False, {"research": level}) == {"material_name": "乙二醇"}
        assert not store.can_write_field("procurement.material_unit_price", False, {"research": level})
    assert store.can_write_field("procurement.material_unit_price", True, {})
    assert store.filter_readable_fields(payload, mapping, True, {}) == payload


def test_unconfigured_builtin_fields_use_scope_and_unknown_fields_are_denied(tmp_path: Path) -> None:
    from api.authorization import FIELD_CATALOG
    store = AuthorizationStore(tmp_path / "unused.db")
    for field_id, *_ in FIELD_CATALOG:
        scope = field_id.split(".", 1)[0]
        assert store.can_write_field(field_id, False, {scope: 3})
        assert not store.can_write_field(field_id, False, {scope: 2})
    for admin in (False, True):
        assert not store.can_write_field("procurement.unknown", admin, {"procurement": 4})
        assert store.filter_readable_fields({"value": 42}, {"value": "custom.unknown"}, admin, {"procurement": 4}) == {}


def test_identity_v1_migrates_legacy_roles_to_levels_and_scopes(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")
    settings.ensure_directories()
    Database(settings.database_path).initialize()
    legacy = IdentityStore(settings.database_path)
    legacy.initialize()
    user = legacy.create_user(
        username="legacy-buyer",
        display_name="旧采购账号",
        department="采购部",
        password="Legacy-Password-2026",
    )

    with sqlite3.connect(settings.database_path) as connection:
        connection.execute(
            "INSERT INTO identity_user_roles (user_id, role_id) VALUES (?, 'procurement')",
            (user["id"],),
        )
        connection.execute("DELETE FROM identity_user_scopes WHERE user_id = ?", (user["id"],))
        connection.execute("UPDATE identity_users SET access_level = 1 WHERE id = ?", (user["id"],))
        connection.execute(
            "UPDATE schema_metadata SET value = 1 WHERE key = 'identity_schema_version'"
        )

    migrated = IdentityStore(settings.database_path)
    migrated.initialize()
    result = migrated.get_user(user["id"])

    assert result is not None
    assert result["is_system_admin"] is False
    assert result["scope_levels"] == {"procurement": 2}


def test_identity_v2_migrates_global_level_into_each_existing_scope(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")
    settings.ensure_directories()
    Database(settings.database_path).initialize()
    store = IdentityStore(settings.database_path)
    store.initialize()
    user = store.create_user(
        username="legacy-manager",
        display_name="旧范围负责人",
        department="采购部",
        password="Legacy-Manager-2026",
    )

    with sqlite3.connect(settings.database_path) as connection:
        connection.execute("DROP TABLE identity_user_scopes")
        connection.execute(
            "CREATE TABLE identity_user_scopes (user_id TEXT NOT NULL REFERENCES identity_users(id) ON DELETE CASCADE, scope_id TEXT NOT NULL, PRIMARY KEY (user_id, scope_id))"
        )
        connection.executemany(
            "INSERT INTO identity_user_scopes (user_id, scope_id) VALUES (?, ?)",
            [(user["id"], "procurement"), (user["id"], "research")],
        )
        connection.execute(
            "UPDATE identity_users SET access_level = 4 WHERE id = ?", (user["id"],)
        )
        connection.execute(
            "UPDATE schema_metadata SET value = 2 WHERE key = 'identity_schema_version'"
        )

    migrated = IdentityStore(settings.database_path)
    migrated.initialize()

    assert migrated.get_user(user["id"])["scope_levels"] == {
        "procurement": 4,
        "research": 4,
    }


def test_identity_v3_migrates_removed_basic_level_to_view(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")
    settings.ensure_directories()
    Database(settings.database_path).initialize()
    store = IdentityStore(settings.database_path)
    store.initialize()
    user = store.create_user(
        username="legacy-basic",
        display_name="旧基础权限",
        department="采购部",
        password="Legacy-Basic-Password-2026",
        scope_levels={"procurement": 2},
    )

    with sqlite3.connect(settings.database_path) as connection:
        connection.execute(
            "UPDATE identity_user_scopes SET access_level = 1 WHERE user_id = ?",
            (user["id"],),
        )
        connection.execute(
            "UPDATE schema_metadata SET value = 3 WHERE key = 'identity_schema_version'"
        )

    store.initialize()

    assert store.get_user(user["id"])["scope_levels"] == {"procurement": 2}


def test_app_backs_up_database_before_access_migration(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")
    settings.ensure_directories()
    Database(settings.database_path).initialize()
    IdentityStore(settings.database_path).initialize()
    with sqlite3.connect(settings.database_path) as connection:
        connection.execute(
            "UPDATE schema_metadata SET value = 1 WHERE key = 'identity_schema_version'"
        )

    with TestClient(create_app(settings)):
        pass

    backups = list((settings.data_dir / "backups").glob("pre-access-level-migration-*.db"))
    assert len(backups) == 1
    with sqlite3.connect(backups[0]) as connection:
        assert connection.execute(
            "SELECT value FROM schema_metadata WHERE key = 'identity_schema_version'"
        ).fetchone() == (1,)
