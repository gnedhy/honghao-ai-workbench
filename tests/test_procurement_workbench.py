import sqlite3
from pathlib import Path

from api.database import Database
from api.identity import IdentityStore
from api.main import create_app
from api.modules import default_module_modes
from api.settings import Settings
from api.workbenches import default_workbench_modes
from tests.helpers import TEST_ADMIN_PASSWORD, authenticated_client
from fastapi.testclient import TestClient


SAMPLE_CONTENT = """编号,名称,单位,最新价,库存价,在途价,上次最新价
CF004,CF004,kg,12.2,13,12.4,12
CF854,CF854,kg,9.65,8.7,9.8,8.7
CF897,CF897,kg,17,18.5,17.1,17.3
CF947,CF947,kg,15.1,17.3,15.2,17.3
纯水,纯水,kg,0,0,0,0
"""
PUBLISHER_PASSWORD = "Publisher-Password-2026"


def switch_to_publisher(settings: Settings, client: TestClient) -> None:
    IdentityStore(settings.database_path).create_user(
        username="procurement-publisher",
        display_name="采购发布人",
        department="采购部",
        password=PUBLISHER_PASSWORD,
        is_system_admin=True,
    )
    client.post("/api/logout")
    assert client.post(
        "/api/login",
        json={"username": "procurement-publisher", "password": PUBLISHER_PASSWORD},
    ).status_code == 200


def switch_to_test_admin(client: TestClient) -> None:
    client.post("/api/logout")
    assert client.post(
        "/api/login",
        json={"username": "test-admin", "password": TEST_ADMIN_PASSWORD},
    ).status_code == 200


def procurement_settings(tmp_path: Path) -> Settings:
    workbench_modes = default_workbench_modes()
    workbench_modes["procurement"] = "active"
    return Settings.from_data_dir(
        tmp_path / "data",
        workbench_modes=workbench_modes,
        module_modes=default_module_modes("test"),
    )


def test_procurement_migration_is_additive_and_overview_starts_empty(tmp_path: Path) -> None:
    settings = procurement_settings(tmp_path)

    with authenticated_client(settings) as client:
        response = client.get("/api/workbenches/procurement/overview")

    assert response.status_code == 200
    assert response.json()["metrics"] == {
        "material_count": 0,
        "open_issue_count": 0,
        "missing_price_count": 0,
        "published_batch_count": 0,
    }
    assert Database(settings.database_path).schema_version() == 5
    assert not list((settings.data_dir / "backups").glob("pre-procurement-migration-*.db"))
    with sqlite3.connect(settings.database_path) as connection:
        version = connection.execute(
            "SELECT value FROM schema_metadata WHERE key = 'workbench_procurement_schema_version'"
        ).fetchone()
    assert version == (1,)


def test_existing_database_is_backed_up_before_procurement_migration(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    with authenticated_client(Settings.from_data_dir(data_dir)):
        pass

    with authenticated_client(procurement_settings(tmp_path)):
        pass

    backups = list((data_dir / "backups").glob("pre-procurement-migration-*.db"))
    assert len(backups) == 1
    assert backups[0].stat().st_size > 0


def test_import_preview_keeps_zero_price_and_skips_duplicate_codes(tmp_path: Path) -> None:
    settings = procurement_settings(tmp_path)
    content = """编号,名称,单位,最新价,库存价,在途价,上次最新价
CF004,CF004,kg,12.2,13,12.4,12
ZERO,纯水,kg,0,0,0,0
MISS,待补原料,kg,,,,
DUP,重复原料A,kg,10,,,9
DUP,重复原料B,kg,11,,,9
"""

    with authenticated_client(settings) as client:
        response = client.post(
            "/api/workbenches/procurement/import-preview",
            json={"source_name": "复制粘贴", "content": content},
        )
        rejected = client.post(
            "/api/workbenches/procurement/imports",
            json={"source_name": "复制粘贴", "content": content},
        )

    assert response.status_code == 200
    rows = response.json()["rows"]
    assert len(rows) == 5
    zero = next(row for row in rows if row["code"] == "ZERO")
    missing = next(row for row in rows if row["code"] == "MISS")
    duplicates = [row for row in rows if row["code"] == "DUP"]
    assert zero["suggested_price"] == "0"
    assert "missing_price" not in zero["issues"]
    assert missing["issues"] == ["missing_price"]
    assert all(row["importable"] is False and "duplicate_code" in row["issues"] for row in duplicates)
    assert rejected.status_code == 422
    assert "重复编码或计量单位冲突" in rejected.json()["detail"]


def test_confirm_import_and_publish_immutable_price_batch(tmp_path: Path) -> None:
    settings = procurement_settings(tmp_path)

    with authenticated_client(settings) as client:
        imported = client.post(
            "/api/workbenches/procurement/imports",
            json={"source_name": "成本报价试点工作簿", "content": SAMPLE_CONTENT},
        )
        submitted = client.post("/api/workbenches/procurement/submit")
        self_publish = client.post("/api/workbenches/procurement/batches/publish")
        switch_to_publisher(settings, client)
        published = client.post("/api/workbenches/procurement/batches/publish")
        overview = client.get("/api/workbenches/procurement/overview")
        history = client.get("/api/workbenches/procurement/price-history")
        batch = client.get(f"/api/workbenches/procurement/batches/{published.json()['id']}")

    assert imported.status_code == 201
    assert imported.json()["imported_count"] == 5
    assert imported.json()["skipped_count"] == 0
    assert submitted.status_code == 200
    assert self_publish.status_code == 409
    assert "不能是同一账号" in self_publish.json()["detail"]
    assert published.status_code == 201
    assert published.json()["version"] == 1
    assert published.json()["item_count"] == 5
    assert overview.json()["metrics"] == {
        "material_count": 5,
        "open_issue_count": 0,
        "missing_price_count": 0,
        "published_batch_count": 1,
    }
    pure_water = next(item for item in batch.json()["items"] if item["code"] == "纯水")
    assert pure_water["recommended_price"] == "0"
    assert len(history.json()) == 5
    assert next(item for item in history.json() if item["material_code"] == "纯水")["latest_price"] == "0"


def test_missing_price_blocks_publish_until_corrected(tmp_path: Path) -> None:
    settings = procurement_settings(tmp_path)
    missing = """编号,名称,单位,最新价,库存价,在途价
MISS,待补原料,kg,,,
"""
    corrected = """编号,名称,单位,最新价,库存价,在途价
MISS,待补原料,kg,8.25,,
"""

    with authenticated_client(settings) as client:
        assert client.post(
            "/api/workbenches/procurement/imports",
            json={"source_name": "缺价样本", "content": missing},
        ).status_code == 201
        blocked = client.post("/api/workbenches/procurement/submit")
        assert client.post(
            "/api/workbenches/procurement/imports",
            json={"source_name": "补价样本", "content": corrected},
        ).status_code == 201
        assert client.post("/api/workbenches/procurement/submit").status_code == 200
        switch_to_publisher(settings, client)
        published = client.post("/api/workbenches/procurement/batches/publish")

    assert blocked.status_code == 409
    assert "未解决" in blocked.json()["detail"]
    assert published.status_code == 201


def test_price_spike_requires_manager_review_and_old_batch_stays_unchanged(tmp_path: Path) -> None:
    settings = procurement_settings(tmp_path)
    first = """编号,名称,单位,最新价,库存价,在途价
RM-01,试点原料,kg,10,,
"""
    changed = """编号,名称,单位,最新价,库存价,在途价
RM-01,试点原料,kg,20,,
"""

    with authenticated_client(settings) as client:
        client.post("/api/workbenches/procurement/imports", json={"source_name": "首批", "content": first})
        client.post("/api/workbenches/procurement/submit")
        switch_to_publisher(settings, client)
        batch_one = client.post("/api/workbenches/procurement/batches/publish").json()
        client.post("/api/workbenches/procurement/imports", json={"source_name": "调价", "content": changed})
        blocked = client.post("/api/workbenches/procurement/submit")
        overview = client.get("/api/workbenches/procurement/overview").json()
        spike = next(issue for issue in overview["issues"] if issue["kind"] == "price_spike")
        reviewed = client.post(f"/api/workbenches/procurement/issues/{spike['id']}/review")
        client.post("/api/workbenches/procurement/submit")
        switch_to_test_admin(client)
        batch_two = client.post("/api/workbenches/procurement/batches/publish").json()
        old_batch = client.get(f"/api/workbenches/procurement/batches/{batch_one['id']}").json()

    assert blocked.status_code == 409
    assert reviewed.status_code == 200
    assert batch_two["version"] == 2
    assert old_batch["items"][0]["recommended_price"] == "10"


def test_procurement_real_routes_require_active_mode(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")

    with authenticated_client(settings) as client:
        response = client.get("/api/workbenches/procurement/overview")

    assert response.status_code == 404


def test_procurement_scope_levels_enforce_view_edit_and_field_policy(tmp_path: Path) -> None:
    settings = procurement_settings(tmp_path)

    with authenticated_client(settings) as admin:
        assert admin.put(
            "/api/admin/fields/procurement.material_unit_price",
            json={
                "read_min_level": 2,
                "write_min_level": 3,
                "read_scope_ids": ["procurement"],
                "write_scope_ids": ["procurement"],
            },
        ).status_code == 200
        IdentityStore(settings.database_path).create_user(
            username="buyer-viewer",
            display_name="采购查看用户",
            department="采购部",
            password="Buyer-Viewer-Password-2026",
            scope_levels={"procurement": 2},
        )

    with TestClient(create_app(settings)) as viewer:
        assert viewer.post(
            "/api/login",
            json={"username": "buyer-viewer", "password": "Buyer-Viewer-Password-2026"},
        ).status_code == 200
        overview = viewer.get("/api/workbenches/procurement/overview")
        write = viewer.post(
            "/api/workbenches/procurement/import-preview",
            json={"source_name": "越权测试", "content": SAMPLE_CONTENT},
        )

    assert overview.status_code == 200
    assert write.status_code == 403


def test_procurement_migration_failure_does_not_block_the_platform(tmp_path: Path, monkeypatch) -> None:
    settings = procurement_settings(tmp_path)

    def fail_migration(_settings: Settings, *, backup_before_migration: bool = True) -> int:
        raise sqlite3.OperationalError("procurement migration failed")

    monkeypatch.setattr("api.main.migrate_procurement_data", fail_migration)
    with authenticated_client(settings) as client:
        health = client.get("/api/health")
        readiness = client.get("/api/readiness")
        registry = client.get("/api/workbenches")
        procurement = client.get("/api/workbenches/procurement/overview")

    assert health.status_code == 200
    assert readiness.status_code == 200
    assert registry.status_code == 200
    assert procurement.status_code == 503
