import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path

from api.database import Database
from api.identity import IdentityStore
from api.main import create_app
from api.modules import default_module_modes
from api.procurement import ProcurementStore
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
    with sqlite3.connect(settings.database_path) as connection:
        exists = connection.execute(
            "SELECT 1 FROM identity_users WHERE username = 'procurement-publisher'"
        ).fetchone()
    if not exists:
        IdentityStore(settings.database_path).create_user(
            username="procurement-publisher",
            display_name="采购发布人",
            department="采购部",
            password=PUBLISHER_PASSWORD,
            is_system_admin=True,
        )
    procurement_post(client,"/api/logout")
    assert procurement_post(client,
        "/api/login",
        json={"username": "procurement-publisher", "password": PUBLISHER_PASSWORD},
    ).status_code == 200


def switch_to_test_admin(client: TestClient) -> None:
    procurement_post(client,"/api/logout")
    assert procurement_post(client,
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
    assert version == (7,)


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
        response = procurement_post(client,
            "/api/workbenches/procurement/import-preview",
            json={"source_name": "复制粘贴", "effective_date": "2026-07-30", "content": content},
        )
        rejected = procurement_post(client,
            "/api/workbenches/procurement/imports",
            json={"source_name": "复制粘贴", "effective_date": "2026-07-30", "content": content},
        )

    assert response.status_code == 200
    rows = response.json()["rows"]
    assert len(rows) == 5
    zero = next(row for row in rows if row["code"] == "ZERO")
    missing = next(row for row in rows if row["code"] == "MISS")
    duplicates = [row for row in rows if row["code"] == "DUP"]
    assert zero["suggested_price"] == "0"
    assert "missing_price" not in zero["issues"]
    assert set(missing["issues"]) == {"missing_price", "unknown_code"}
    assert all(row["importable"] is False and "duplicate_code" in row["issues"] for row in duplicates)
    assert rejected.status_code == 422
    assert "重复" in rejected.json()["detail"]


def test_single_buyer_can_publish_immutable_price_batch(tmp_path: Path) -> None:
    settings = procurement_settings(tmp_path)

    with authenticated_client(settings) as client:
        imported = procurement_post(client,
            "/api/workbenches/procurement/imports",
            json={"source_name": "成本报价试点工作簿", "effective_date": "2026-07-30", "content": SAMPLE_CONTENT},
        )
        update = client.get("/api/workbenches/procurement/updates/current").json()["current"]
        published = procurement_post(client,f"/api/workbenches/procurement/updates/{update['id']}/publish", json={"mode": "immediate"})
        overview = client.get("/api/workbenches/procurement/overview")
        history = client.get("/api/workbenches/procurement/price-history")
        batch = client.get(f"/api/workbenches/procurement/batches/{published.json()['id']}")

    assert imported.status_code == 201
    assert imported.json()["imported_count"] == 5
    assert imported.json()["skipped_count"] == 0
    cf004_update = next(item for item in update["items"] if item["code"] == "CF004")
    assert cf004_update["comparison_basis"] == "previous_inquiry"
    assert round(cf004_update["change"], 4) == 0.0167
    assert published.status_code == 200
    assert published.json()["version"] == 1
    assert published.json()["item_count"] == 5
    assert overview.json()["metrics"] == {
        "material_count": 5,
        "open_issue_count": 0,
        "missing_price_count": 0,
        "published_batch_count": 1,
    }
    cf004 = next(item for item in overview.json()["materials"] if item["code"] == "CF004")
    assert cf004["previous_latest_price"] == "12"
    assert cf004["price_date"] == "2026-07-30"
    pure_water = next(item for item in batch.json()["items"] if item["code"] == "纯水")
    assert pure_water["recommended_price"] == "0"
    assert len(history.json()) == 5
    assert history.json()[0]["recorded_at"] == "2026-07-30T00:00:00+00:00"
    assert next(item for item in history.json() if item["material_code"] == "纯水")["latest_price"] == "0"
    assert overview.json()["working_state"]["latest_import"] is None


def test_ledger_keeps_published_price_date_when_a_new_draft_exists(tmp_path: Path) -> None:
    settings = procurement_settings(tmp_path)
    first = """编号,名称,单位,最新价,库存价,在途价
RM-01,试点原料,kg,10,,
"""
    changed = """编号,名称,单位,最新价,库存价,在途价
RM-01,试点原料,kg,11,,
"""

    with authenticated_client(settings) as client:
        procurement_post(client,
            "/api/workbenches/procurement/imports",
            json={"source_name": "首批", "effective_date": "2026-07-23", "content": first},
        )
        first_update = client.get("/api/workbenches/procurement/updates/current").json()["current"]
        published = procurement_post(client,
            f"/api/workbenches/procurement/updates/{first_update['id']}/publish",
            json={"mode": "immediate"},
        ).json()
        procurement_post(client,
            "/api/workbenches/procurement/imports",
            json={"source_name": "待发布调价", "effective_date": "2026-07-30", "content": changed},
        )
        overview = client.get("/api/workbenches/procurement/overview").json()
        batch = client.get(f"/api/workbenches/procurement/batches/{published['id']}").json()

    material = overview["materials"][0]
    assert material["published_price"] == "10"
    assert material["published_price_date"] == "2026-07-23"
    assert material["price_date"] == "2026-07-30"
    assert material["draft_price"] == "11"
    assert batch["price_date"] == "2026-07-23"
    assert batch["activated_at"]
    assert batch["source_name"] == "首批"
    assert batch["status"] == "active"
    assert batch["published_by_name"]
    assert batch["items"][0]["latest_price"] == "10"


def test_missing_price_blocks_publish_until_corrected(tmp_path: Path) -> None:
    settings = procurement_settings(tmp_path)
    missing = """编号,名称,单位,最新价,库存价,在途价
MISS,待补原料,kg,,,
"""
    with authenticated_client(settings) as client:
        assert procurement_post(client,
            "/api/workbenches/procurement/imports",
            json={"source_name": "缺价样本", "effective_date": "2026-07-30", "content": missing},
        ).status_code == 422
        initial = client.get("/api/workbenches/procurement/overview").json()
        assert initial["current_update"] is None
        assert initial["materials"][0]["published_price"] is None
        material = initial["materials"][0]
        assert procurement_post(client,
            f"/api/workbenches/procurement/materials/{material['id']}/adjustments",
            json={"price": "8.25", "effective_date": "2026-07-30", "reason": "补录当前确认价格"},
        ).status_code == 201
        corrected_overview = client.get("/api/workbenches/procurement/overview").json()
        update_id = corrected_overview["current_update"]["id"]
        published = procurement_post(client,f"/api/workbenches/procurement/updates/{update_id}/publish", json={"mode": "immediate"})

    assert corrected_overview["metrics"]["open_issue_count"] == 0
    assert corrected_overview["working_state"]["latest_import"]["source_name"] == "手工价格修正"
    assert published.status_code == 200


def test_price_spike_requires_buyer_confirmation_and_old_batch_stays_unchanged(tmp_path: Path) -> None:
    settings = procurement_settings(tmp_path)
    first = """编号,名称,单位,最新价,库存价,在途价
RM-01,试点原料,kg,10,,
"""
    changed = """编号,名称,单位,最新价,库存价,在途价
RM-01,试点原料,kg,20,,
"""

    with authenticated_client(settings) as client:
        procurement_post(client,"/api/workbenches/procurement/imports", json={"source_name": "首批", "effective_date": "2026-07-23", "content": first})
        first_update = client.get("/api/workbenches/procurement/updates/current").json()["current"]
        batch_one = procurement_post(client,f"/api/workbenches/procurement/updates/{first_update['id']}/publish", json={"mode": "immediate"}).json()
        procurement_post(client,"/api/workbenches/procurement/imports", json={"source_name": "调价", "effective_date": "2026-07-30", "content": changed})
        overview = client.get("/api/workbenches/procurement/overview").json()
        update_id = overview["current_update"]["id"]
        spike = next(issue for issue in overview["issues"] if issue["kind"] == "price_spike")
        short_reason = procurement_post(client,
            f"/api/workbenches/procurement/updates/{update_id}/issues/{spike['id']}/review",
            json={"reason": "短"},
        )
        blocked = procurement_post(client,f"/api/workbenches/procurement/updates/{update_id}/publish", json={"mode": "immediate"})
        reviewed = procurement_post(client,
            f"/api/workbenches/procurement/updates/{update_id}/issues/{spike['id']}/review",
            json={"reason": "已核对供应商书面报价，确认本次上涨"},
        )
        batch_two = procurement_post(client,f"/api/workbenches/procurement/updates/{update_id}/publish", json={"mode": "immediate"}).json()
        old_batch = client.get(f"/api/workbenches/procurement/batches/{batch_one['id']}").json()

    assert short_reason.status_code == 422
    assert blocked.status_code == 409
    assert reviewed.status_code == 200
    assert batch_two["version"] == 2
    assert old_batch["items"][0]["recommended_price"] == "10"


def test_reviewing_an_issue_through_the_wrong_update_does_not_mutate_it(tmp_path: Path) -> None:
    settings = procurement_settings(tmp_path)
    first = """编号,名称,单位,最新价,库存价,在途价
RM-01,试点原料,kg,10,,
"""
    changed = """编号,名称,单位,最新价,库存价,在途价
RM-01,试点原料,kg,20,,
"""

    with authenticated_client(settings) as client:
        procurement_post(client,
            "/api/workbenches/procurement/imports",
            json={"source_name": "首批", "effective_date": "2026-07-23", "content": first},
        )
        first_update = client.get("/api/workbenches/procurement/updates/current").json()["current"]
        procurement_post(client,
            f"/api/workbenches/procurement/updates/{first_update['id']}/publish",
            json={"mode": "immediate"},
        )
        procurement_post(client,
            "/api/workbenches/procurement/imports",
            json={"source_name": "调价", "effective_date": "2026-07-30", "content": changed},
        )
        current = client.get("/api/workbenches/procurement/updates/current").json()["current"]
        issue = next(item for item in current["issues"] if item["kind"] == "price_spike")
        response = procurement_post(client,
            f"/api/workbenches/procurement/updates/not-the-update/issues/{issue['id']}/review",
            json={"reason": "已核对供应商报价并确认变动"},
        )
        after = client.get("/api/workbenches/procurement/updates/current").json()["current"]

    after_issue = next(item for item in after["issues"] if item["id"] == issue["id"])
    assert response.status_code == 404
    assert after_issue["status"] == "open"
    assert after_issue["review_reason"] is None
    assert not any(event["event"] == "risk_reviewed" for event in after["events"])


def test_scheduled_activation_keeps_official_price_until_due_and_is_idempotent(tmp_path: Path) -> None:
    settings = procurement_settings(tmp_path)
    first = "编号,名称,单位,最新价\nRM-01,试点原料,kg,10\n"
    changed = "编号,名称,单位,最新价\nRM-01,试点原料,kg,11\n"
    activate_at = datetime.now(UTC) + timedelta(hours=1)

    with authenticated_client(settings) as client:
        procurement_post(client,"/api/workbenches/procurement/imports", json={"source_name": "首批", "effective_date": "2026-07-23", "content": first})
        procurement_post(client,"/api/workbenches/procurement/submit")
        switch_to_publisher(settings, client)
        update = client.get("/api/workbenches/procurement/updates/current").json()["current"]
        assert procurement_post(client, f"/api/workbenches/procurement/updates/{update['id']}/publish", json={"mode": "immediate"}).status_code == 200
        assert client.post("/api/workbenches/procurement/batches/publish").status_code == 409
        procurement_post(client,"/api/workbenches/procurement/imports", json={"source_name": "调价", "effective_date": "2026-07-30", "content": changed})
        update = procurement_post(client,"/api/workbenches/procurement/submit").json()
        switch_to_test_admin(client)
        scheduled = procurement_post(client,
            f"/api/workbenches/procurement/updates/{update['id']}/publish",
            json={"mode": "scheduled", "activate_at": activate_at.isoformat()},
        )
    before = client.get("/api/workbenches/procurement/overview").json()

    assert scheduled.status_code == 200
    assert scheduled.json()["status"] == "scheduled"
    assert before["materials"][0]["published_price"] == "10"
    assert before["materials"][0]["previous_published_price"] is None
    store = ProcurementStore(settings.database_path)
    assert store.process_scheduled(activate_at + timedelta(minutes=1)) == 1
    assert store.process_scheduled(activate_at + timedelta(minutes=2)) == 0
    after = store.overview()
    assert after["materials"][0]["published_price"] == "11"
    assert after["materials"][0]["previous_published_price"] == "10"
    assert after["metrics"]["published_batch_count"] == 2


def test_new_immediate_baseline_forces_scheduled_batch_to_revalidate(tmp_path: Path) -> None:
    settings = procurement_settings(tmp_path)
    activate_at = datetime.now(UTC) + timedelta(hours=1)

    with authenticated_client(settings) as client:
        procurement_post(client,"/api/workbenches/procurement/imports", json={"source_name": "首批", "effective_date": "2026-07-23", "content": "编号,名称,单位,最新价\nRM-01,试点原料,kg,10\n"})
        procurement_post(client,"/api/workbenches/procurement/submit")
        switch_to_publisher(settings, client)
        first_update = client.get("/api/workbenches/procurement/updates/current").json()["current"]
        assert procurement_post(client, f"/api/workbenches/procurement/updates/{first_update['id']}/publish", json={"mode": "immediate"}).status_code == 200
        procurement_post(client,"/api/workbenches/procurement/imports", json={"source_name": "排期调价", "effective_date": "2026-07-30", "content": "编号,名称,单位,最新价\nRM-01,试点原料,kg,11\n"})
        scheduled_update = procurement_post(client,"/api/workbenches/procurement/submit").json()
        switch_to_test_admin(client)
        procurement_post(client,f"/api/workbenches/procurement/updates/{scheduled_update['id']}/publish", json={"mode": "scheduled", "activate_at": activate_at.isoformat()})
        procurement_post(client,"/api/workbenches/procurement/imports", json={"source_name": "即时调价", "effective_date": "2026-08-01", "content": "编号,名称,单位,最新价\nRM-01,试点原料,kg,12\n"})
        immediate = procurement_post(client,"/api/workbenches/procurement/submit").json()
        switch_to_publisher(settings, client)
        for issue in immediate["issues"]:
            if issue["kind"] == "price_spike" and issue["status"] == "open":
                assert procurement_post(client,f"/api/workbenches/procurement/updates/{immediate['id']}/issues/{issue['id']}/review", json={"reason": "已核对较正式基线上涨20%"}).status_code == 200
        assert procurement_post(client,f"/api/workbenches/procurement/updates/{immediate['id']}/publish", json={"mode": "immediate"}).status_code == 200
        overview = client.get("/api/workbenches/procurement/overview").json()

    assert overview["current_update"]["id"] == scheduled_update["id"]
    assert overview["current_update"]["status"] == "revalidation_required"
    assert overview["scheduled_update"] is None
    assert ProcurementStore(settings.database_path).process_scheduled(activate_at + timedelta(minutes=1)) == 0
    assert ProcurementStore(settings.database_path).overview()["materials"][0]["published_price"] == "12"


def test_cancel_schedule_keeps_official_baseline_and_can_copy_draft(tmp_path: Path) -> None:
    settings = procurement_settings(tmp_path)
    activate_at = datetime.now(UTC) + timedelta(hours=1)
    with authenticated_client(settings) as client:
        procurement_post(client,"/api/workbenches/procurement/imports", json={"source_name": "首批", "effective_date": "2026-07-23", "content": "编号,名称,单位,最新价\nRM-01,试点原料,kg,10\n"})
        procurement_post(client,"/api/workbenches/procurement/submit")
        switch_to_publisher(settings, client)
        first_update = client.get("/api/workbenches/procurement/updates/current").json()["current"]
        assert procurement_post(client, f"/api/workbenches/procurement/updates/{first_update['id']}/publish", json={"mode": "immediate"}).status_code == 200
        procurement_post(client,"/api/workbenches/procurement/imports", json={"source_name": "排期调价", "effective_date": "2026-07-30", "content": "编号,名称,单位,最新价\nRM-01,试点原料,kg,11\n"})
        update = procurement_post(client,"/api/workbenches/procurement/submit").json()
        switch_to_test_admin(client)
        procurement_post(client,f"/api/workbenches/procurement/updates/{update['id']}/publish", json={"mode": "scheduled", "activate_at": activate_at.isoformat()})
        cancelled = procurement_post(client,
            f"/api/workbenches/procurement/updates/{update['id']}/cancel-schedule",
            json={"reason": "供应商交期变化，撤销原排期", "copy_to_draft": True},
        )
        overview = client.get("/api/workbenches/procurement/overview").json()

    assert cancelled.status_code == 200
    assert cancelled.json()["status"] == "cancelled"
    assert cancelled.json()["copied_update"]["status"] == "draft"
    assert overview["materials"][0]["published_price"] == "10"
    assert overview["current_update"]["id"] == cancelled.json()["copied_update"]["id"]


def test_procurement_real_routes_require_active_mode(tmp_path: Path) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")

    with authenticated_client(settings) as client:
        response = client.get("/api/workbenches/procurement/overview")

    assert response.status_code == 404


def test_procurement_scope_levels_enforce_view_edit_and_separate_activation(tmp_path: Path) -> None:
    settings = procurement_settings(tmp_path)

    with authenticated_client(settings) as admin:
        IdentityStore(settings.database_path).create_user(
            username="buyer-viewer",
            display_name="采购查看用户",
            department="采购部",
            password="Buyer-Viewer-Password-2026",
            scope_levels={"procurement": 2},
        )
        IdentityStore(settings.database_path).create_user(
            username="buyer-editor",
            display_name="采购员",
            department="采购部",
            password="Buyer-Editor-Password-2026",
            scope_levels={"procurement": 3},
        )

        for row in SAMPLE_CONTENT.strip().splitlines()[1:]:
            code = row.split(",")[0]
            assert admin.post("/api/workbenches/procurement/materials", json={"code": code, "name": code}).status_code == 201

    with TestClient(create_app(settings)) as viewer:
        assert procurement_post(viewer,
            "/api/login",
            json={"username": "buyer-viewer", "password": "Buyer-Viewer-Password-2026"},
        ).status_code == 200
        overview = viewer.get("/api/workbenches/procurement/overview")
        write = procurement_post(viewer,
            "/api/workbenches/procurement/import-preview",
            json={"source_name": "越权测试", "effective_date": "2026-07-30", "content": SAMPLE_CONTENT},
        )

    assert overview.status_code == 200
    assert write.status_code == 403

    with TestClient(create_app(settings)) as editor:
        assert procurement_post(editor,
            "/api/login",
            json={"username": "buyer-editor", "password": "Buyer-Editor-Password-2026"},
        ).status_code == 200
        assert procurement_post(editor,
            "/api/workbenches/procurement/imports",
            json={"source_name": "共同录价", "effective_date": "2026-07-30", "content": SAMPLE_CONTENT},
        ).status_code == 201
        update_id = editor.get("/api/workbenches/procurement/updates/current").json()["current"]["id"]
        assert procurement_post(editor,
            f"/api/workbenches/procurement/updates/{update_id}/publish",
            json={"mode": "immediate"},
        ).status_code == 403


def test_history_views_preferences_adjustments_and_archive(tmp_path: Path) -> None:
    settings = procurement_settings(tmp_path)
    later = SAMPLE_CONTENT.replace("12.2", "13.2", 1)

    with authenticated_client(settings) as client:
        first = procurement_post(client,"/api/workbenches/procurement/imports", json={"source_name": "采购询价单 2026-07-23", "effective_date": "2026-07-23", "content": SAMPLE_CONTENT}).json()
        update_id = client.get("/api/workbenches/procurement/updates/current").json()["current"]["id"]
        assert procurement_post(client,f"/api/workbenches/procurement/updates/{update_id}/publish", json={"mode": "immediate"}).status_code == 200
        procurement_post(client,"/api/workbenches/procurement/imports", json={"source_name": "采购询价单 2026-07-30", "effective_date": "2026-07-30", "content": later})
        batches = client.get("/api/workbenches/procurement/history/batches").json()
        materials = client.get("/api/workbenches/procurement/history/materials").json()
        cf004 = next(item for item in materials if item["material_code"] == "CF004")
        detail = client.get(f"/api/workbenches/procurement/materials/{cf004['material_id']}").json()
        saved = client.put("/api/workbenches/procurement/preferences", json={"ledger_columns": ["unit", "latest_price", "change"], "history_view": "materials", "ledger_view": "paged", "ledger_page_size": 75})
        preferences = client.get("/api/workbenches/procurement/preferences")
        adjusted = procurement_post(client,
            f"/api/workbenches/procurement/materials/{cf004['material_id']}/adjustments",
            json={"price": "13.5", "effective_date": "2026-07-30", "reason": "复核供应商确认价格"},
        )
        conflict = procurement_post(client,
            f"/api/workbenches/procurement/materials/{cf004['material_id']}/adjustments",
            json={"price": "12.8", "effective_date": "2026-07-30", "reason": "尝试重复有效日期", "target_history_id": detail["history"][0]["id"]},
        )
        archived = procurement_post(client,f"/api/workbenches/procurement/imports/{first['id']}/archive")
        remaining = client.get(f"/api/workbenches/procurement/materials/{cf004['material_id']}").json()
        restored = procurement_post(client,f"/api/workbenches/procurement/imports/{first['id']}/restore")

    assert [item["effective_date"] for item in batches] == ["2026-07-30", "2026-07-23"]
    assert batches[0]["material_count"] == 5
    assert cf004["period_count"] == 2
    assert len(detail["history"]) == 2
    assert saved.status_code == 200
    assert preferences.json() == {
        "ledger_columns": ["unit", "latest_price", "change"],
        "history_view": "materials",
        "ledger_view": "paged",
        "ledger_page_size": 75,
    }
    assert adjusted.status_code == 201
    assert conflict.status_code == 409
    assert archived.status_code == 200 and len(remaining["history"]) == 1
    assert restored.status_code == 200


def test_material_identity_permissions_and_old_code_alias_import(tmp_path: Path) -> None:
    settings = procurement_settings(tmp_path)
    buyer_password = "Buyer-Editor-Password-2026"
    manager_password = "Buyer-Manager-Password-2026"

    with authenticated_client(settings) as admin:
        assert procurement_post(admin,
            "/api/workbenches/procurement/imports",
            json={"source_name": "采购询价单 2026-07-30", "effective_date": "2026-07-30", "content": SAMPLE_CONTENT},
        ).status_code == 201
        material = next(item for item in admin.get("/api/workbenches/procurement/overview").json()["materials"] if item["code"] == "CF004")
        IdentityStore(settings.database_path).create_user(
            username="buyer-editor",
            display_name="采购经办人",
            department="采购部",
            password=buyer_password,
            scope_levels={"procurement": 3},
        )
        IdentityStore(settings.database_path).create_user(
            username="buyer-manager",
            display_name="采购负责人",
            department="采购部",
            password=manager_password,
            scope_levels={"procurement": 4},
        )

    with TestClient(create_app(settings)) as editor:
        assert procurement_post(editor,"/api/login", json={"username": "buyer-editor", "password": buyer_password}).status_code == 200
        renamed = editor.patch(
            f"/api/workbenches/procurement/materials/{material['id']}",
            json={"code": "CF004", "name": "聚合氯化铝（采购备注）"},
        )
        denied = editor.patch(
            f"/api/workbenches/procurement/materials/{material['id']}",
            json={"code": "CF004-N", "name": "聚合氯化铝（采购备注）"},
        )

    with TestClient(create_app(settings)) as manager:
        assert procurement_post(manager,"/api/login", json={"username": "buyer-manager", "password": manager_password}).status_code == 200
        assert manager.patch(f"/api/workbenches/procurement/materials/{material['id']}", json={"code": "CF004-N", "name": "测试"}).status_code == 200
        recoded = manager.patch(
            f"/api/workbenches/procurement/materials/{material['id']}",
            json={"code": "CF004-N", "name": "聚合氯化铝（采购备注）"},
        )
        other = next(item for item in manager.get("/api/workbenches/procurement/overview").json()["materials"] if item["code"] == "CF854")
        conflict = manager.patch(
            f"/api/workbenches/procurement/materials/{other['id']}",
            json={"code": "CF004", "name": other["name"]},
        )
        switch_to_test_admin(manager)
        update_id = manager.get("/api/workbenches/procurement/updates/current").json()["current"]["id"]
        assert procurement_post(manager,f"/api/workbenches/procurement/updates/{update_id}/cancel", json={"reason": "完成首轮资料维护测试"}).status_code == 200
        alias_import = procurement_post(manager,
            "/api/workbenches/procurement/imports",
            json={
                "source_name": "采购询价单 2026-08-06",
                "effective_date": "2026-08-06",
                "content": "编号,名称,单位,最新价,库存价,在途价\nCF004,导入名称不覆盖人工备注,kg,12.6,13,12.7\n",
            },
        )
        overview = manager.get("/api/workbenches/procurement/overview").json()

    assert renamed.status_code == 403
    assert denied.status_code == 403
    assert recoded.status_code == 200
    assert recoded.json()["material"]["code"] == "CF004-N"
    assert conflict.status_code == 409
    assert alias_import.status_code == 201
    matching = [item for item in overview["materials"] if item["id"] == material["id"]]
    assert len(matching) == 1
    assert matching[0]["code"] == "CF004-N"
    assert matching[0]["name"] == "聚合氯化铝（采购备注）"
    assert matching[0]["latest_price"] == "12.6"


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
from tests.procurement_helpers import procurement_post
