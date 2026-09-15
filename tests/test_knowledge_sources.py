import json
from io import BytesIO
from pathlib import Path
from urllib.parse import quote

import psycopg
import pytest
from fastapi.testclient import TestClient
from pypdf import PdfWriter

from api.identity import IdentityStore
from api.knowledge import KnowledgeStore
from api.main import create_app
from api.postgres import WRITE_LOCK, connect, transaction
from api.modules import default_module_modes
from api.settings import Settings
from tests.helpers import TEST_ADMIN_PASSWORD, authenticated_client


def knowledge_settings(data_dir: Path) -> Settings:
    modes = default_module_modes()
    modes["knowledge"] = "active"
    return Settings.from_data_dir(data_dir, module_modes=modes)


def pdf_from_objects(objects: list[bytes]) -> bytes:
    pdf = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for number, body in enumerate(objects, start=1):
        offsets.append(len(pdf))
        pdf.extend(f"{number} 0 obj\n".encode("ascii") + body + b"\nendobj\n")
    xref_offset = len(pdf)
    pdf.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    pdf.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        pdf.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    pdf.extend(
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n".encode("ascii")
    )
    return bytes(pdf)


def pdf_with_text(text: str) -> bytes:
    content = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode("ascii")
    return pdf_from_objects(
        [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
            b"<< /Length " + str(len(content)).encode("ascii") + b" >>\nstream\n" + content + b"\nendstream",
        ]
    )


def image_only_pdf() -> bytes:
    content = b"q 100 0 0 100 72 600 cm /Im1 Do Q"
    return pdf_from_objects(
        [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>",
            b"<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n\x80\nendstream",
            b"<< /Length " + str(len(content)).encode("ascii") + b" >>\nstream\n" + content + b"\nendstream",
        ]
    )


def encrypted_pdf() -> bytes:
    output = BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    writer.encrypt("secret")
    writer.write(output)
    return output.getvalue()


def test_admin_can_upload_and_retrieve_quarantined_pdf_source(tmp_path: Path) -> None:
    settings = knowledge_settings(tmp_path / "data")
    pdf = b"%PDF-1.4\n% test source\n"

    with authenticated_client(settings) as client:
        uploaded = client.post(
            "/api/knowledge/sources",
            files={"file": ("产品说明书.pdf", pdf, "application/pdf")},
        )

        assert uploaded.status_code == 201
        source = uploaded.json()
        assert source["filename"] == "产品说明书.pdf"
        assert source["safety_status"] == "quarantined"
        assert source["processing_status"] == "not_started"
        assert source["size_bytes"] == len(pdf)
        assert "stored_path" not in source

        downloaded = client.get(f"/api/knowledge/sources/{source['id']}/file")

    assert downloaded.status_code == 200
    assert downloaded.content == pdf
    assert quote("产品说明书.pdf") in downloaded.headers["content-disposition"]


def test_safe_text_pdf_creates_reviewable_markdown_version(tmp_path: Path) -> None:
    settings = knowledge_settings(tmp_path / "data")

    with authenticated_client(settings) as client:
        uploaded = client.post(
            "/api/knowledge/sources",
            files={"file": ("TDS-100.pdf", pdf_with_text("TDS sample"), "application/pdf")},
        ).json()

        confirmed = client.post(f"/api/knowledge/sources/{uploaded['id']}/confirm-safe")
        confirmed_again = client.post(f"/api/knowledge/sources/{uploaded['id']}/confirm-safe")

        assert confirmed.status_code == 200
        assert confirmed.json()["safety_status"] == "confirmed"
        assert confirmed.json()["processing_status"] == "parsed"
        assert confirmed_again.status_code == 200

        versions = client.get(f"/api/knowledge/sources/{uploaded['id']}/versions")
        assert versions.status_code == 200
        assert len(versions.json()) == 1
        version = versions.json()[0]
        assert version["status"] == "draft"
        assert version["source_ids"] == [uploaded["id"]]

        markdown = client.get(
            f"/api/knowledge/sources/{uploaded['id']}/versions/{version['id']}/markdown"
        )

    assert markdown.status_code == 200
    assert "TDS-100.pdf" in markdown.text
    assert "TDS sample" in markdown.text


def test_image_only_pdf_waits_for_ocr_and_keeps_original(tmp_path: Path) -> None:
    settings = knowledge_settings(tmp_path / "data")
    pdf = image_only_pdf()

    with authenticated_client(settings) as client:
        uploaded = client.post(
            "/api/knowledge/sources",
            files={"file": ("扫描说明书.pdf", pdf, "application/pdf")},
        ).json()

        confirmed = client.post(f"/api/knowledge/sources/{uploaded['id']}/confirm-safe")
        versions = client.get(f"/api/knowledge/sources/{uploaded['id']}/versions")
        original = client.get(f"/api/knowledge/sources/{uploaded['id']}/file")

    assert confirmed.status_code == 200
    assert confirmed.json()["safety_status"] == "confirmed"
    assert confirmed.json()["processing_status"] == "awaiting_ocr"
    assert confirmed.json()["failure_reason"] == "no_extractable_text"
    assert versions.json() == []
    assert original.content == pdf


def test_damaged_pdf_reports_stable_failure_and_keeps_original(tmp_path: Path) -> None:
    settings = knowledge_settings(tmp_path / "data")
    pdf = b"%PDF-this-is-not-a-valid-document"

    with authenticated_client(settings) as client:
        uploaded = client.post(
            "/api/knowledge/sources",
            files={"file": ("损坏文件.pdf", pdf, "application/pdf")},
        ).json()

        confirmed = client.post(f"/api/knowledge/sources/{uploaded['id']}/confirm-safe")
        original = client.get(f"/api/knowledge/sources/{uploaded['id']}/file")

    assert confirmed.status_code == 200
    assert confirmed.json()["safety_status"] == "confirmed"
    assert confirmed.json()["processing_status"] == "parse_failed"
    assert confirmed.json()["failure_reason"] == "invalid_or_damaged_pdf"
    assert original.content == pdf


def test_encrypted_pdf_is_not_parsed(tmp_path: Path) -> None:
    settings = knowledge_settings(tmp_path / "data")

    with authenticated_client(settings) as client:
        uploaded = client.post(
            "/api/knowledge/sources",
            files={"file": ("加密文件.pdf", encrypted_pdf(), "application/pdf")},
        ).json()

        confirmed = client.post(f"/api/knowledge/sources/{uploaded['id']}/confirm-safe")

    assert confirmed.status_code == 200
    assert confirmed.json()["safety_status"] == "confirmed"
    assert confirmed.json()["processing_status"] == "encrypted"
    assert confirmed.json()["failure_reason"] == "encrypted_pdf"


def test_upload_rejects_non_pdf_inputs(tmp_path: Path) -> None:
    settings = knowledge_settings(tmp_path / "data")

    with authenticated_client(settings) as client:
        wrong_extension = client.post(
            "/api/knowledge/sources",
            files={"file": ("说明书.txt", b"%PDF-1.4", "application/pdf")},
        )
        wrong_mime = client.post(
            "/api/knowledge/sources",
            files={"file": ("说明书.pdf", b"%PDF-1.4", "text/plain")},
        )
        wrong_content = client.post(
            "/api/knowledge/sources",
            files={"file": ("说明书.pdf", b"not a pdf", "application/pdf")},
        )

    assert {wrong_extension.status_code, wrong_mime.status_code, wrong_content.status_code} == {422}


def test_duplicate_pdf_is_kept_as_a_separate_traceable_source(tmp_path: Path) -> None:
    settings = knowledge_settings(tmp_path / "data")
    pdf = pdf_with_text("same source")

    with authenticated_client(settings) as client:
        first = client.post(
            "/api/knowledge/sources",
            files={"file": ("原始名称.pdf", pdf, "application/pdf")},
        ).json()
        duplicate = client.post(
            "/api/knowledge/sources",
            files={"file": ("再次上传.pdf", pdf, "application/pdf")},
        ).json()
        duplicate_file = client.get(f"/api/knowledge/sources/{duplicate['id']}/file")

    assert duplicate["id"] != first["id"]
    assert duplicate["duplicate_of"] == first["id"]
    assert duplicate_file.content == pdf


def test_upload_rejects_pdf_over_50_mb(tmp_path: Path) -> None:
    settings = knowledge_settings(tmp_path / "data")
    oversized_pdf = b"%PDF-" + b"x" * (50 * 1024 * 1024)

    with authenticated_client(settings) as client:
        response = client.post(
            "/api/knowledge/sources",
            files={"file": ("过大文件.pdf", oversized_pdf, "application/pdf")},
        )

    assert response.status_code == 422
    assert response.json()["detail"] == "PDF source exceeds 50 MB"


def test_resource_acl_hides_admin_source_from_other_knowledge_users(tmp_path: Path) -> None:
    settings = knowledge_settings(tmp_path / "data")

    with authenticated_client(settings) as admin:
        source = admin.post(
            "/api/knowledge/sources",
            files={"file": ("管理员资料.pdf", pdf_with_text("private"), "application/pdf")},
        ).json()
        created = admin.post(
            "/api/users",
            json={
                "username": "knowledge-user",
                "display_name": "知识专员",
                "department": "知识管理",
                "password": "Knowledge-Password-2026",
                "scope_levels": {"knowledge": 4},
            },
        )
        assert created.status_code == 201

        with TestClient(create_app(settings)) as knowledge_user:
            login = knowledge_user.post(
                "/api/login",
                json={"username": "knowledge-user", "password": "Knowledge-Password-2026"},
            )
            hidden = knowledge_user.get(f"/api/knowledge/sources/{source['id']}/file")
            own_source = knowledge_user.post(
                "/api/knowledge/sources",
                files={"file": ("待检查.pdf", pdf_with_text("check"), "application/pdf")},
            ).json()
            cannot_confirm = knowledge_user.post(
                f"/api/knowledge/sources/{own_source['id']}/confirm-safe"
            )
            quarantined_file = knowledge_user.get(
                f"/api/knowledge/sources/{own_source['id']}/file"
            )

    assert login.status_code == 200
    assert hidden.status_code == 404
    assert cannot_confirm.status_code == 403
    assert quarantined_file.status_code == 423


def test_source_access_requires_knowledge_scope_before_resource_scope(tmp_path: Path) -> None:
    settings = knowledge_settings(tmp_path / "data")

    with authenticated_client(settings) as admin:
        source = admin.post(
            "/api/knowledge/sources",
            files={"file": ("采购说明书.pdf", pdf_with_text("shared"), "application/pdf")},
        ).json()
        admin.post(f"/api/knowledge/sources/{source['id']}/confirm-safe")
        with transaction(settings.database_url, write=True) as connection:
            connection.execute(
                "UPDATE knowledge_sources SET read_min_level = 2, read_scope_ids = %s WHERE id = %s",
                (json.dumps(["procurement"]), source["id"]),
            )
        admin.post(
            "/api/users",
            json={
                "username": "procurement-reader",
                "display_name": "采购查看人",
                "password": "Procurement-Reader-2026",
                "scope_levels": {"procurement": 2, "knowledge": 2},
            },
        )
        admin.post(
            "/api/users",
            json={
                "username": "procurement-only",
                "display_name": "仅采购查看人",
                "password": "Procurement-Only-2026",
                "scope_levels": {"procurement": 2},
            },
        )

        with TestClient(create_app(settings)) as reader:
            reader.post(
                "/api/login",
                json={"username": "procurement-reader", "password": "Procurement-Reader-2026"},
            )
            downloaded = reader.get(f"/api/knowledge/sources/{source['id']}/file")
        with TestClient(create_app(settings)) as procurement_only:
            procurement_only.post(
                "/api/login",
                json={"username": "procurement-only", "password": "Procurement-Only-2026"},
            )
            denied = procurement_only.get(f"/api/knowledge/sources/{source['id']}/file")

    assert downloaded.status_code == 200
    assert downloaded.content.startswith(b"%PDF")
    assert denied.status_code == 403


def test_source_storage_has_no_static_or_traversal_url(tmp_path: Path) -> None:
    settings = knowledge_settings(tmp_path / "data")

    with authenticated_client(settings) as client:
        source = client.post(
            "/api/knowledge/sources",
            files={"file": ("边界测试.pdf", pdf_with_text("boundary"), "application/pdf")},
        ).json()
        static_guess = client.get(f"/knowledge/sources/{source['id']}.pdf")
        traversal = client.get("/api/knowledge/sources/%2E%2E%2Fhonghao.db/file")

    assert static_guess.status_code == 404
    assert traversal.status_code == 404


def test_derived_index_survives_restart_without_runtime_ddl(tmp_path: Path) -> None:
    settings = knowledge_settings(tmp_path / "data")

    with authenticated_client(settings) as client:
        source = client.post(
            "/api/knowledge/sources",
            files={"file": ("可重建.pdf", pdf_with_text("rebuild"), "application/pdf")},
        ).json()
        client.post(f"/api/knowledge/sources/{source['id']}/confirm-safe")

    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with transaction(settings.database_url, write=True) as connection:
            connection.execute("DROP VIEW knowledge_derived_index")

    with authenticated_client(settings) as restarted:
        versions = restarted.get(f"/api/knowledge/sources/{source['id']}/versions")

    assert versions.status_code == 200
    assert len(versions.json()) == 1


def test_old_schema_is_rejected_without_silently_rewriting_source_permissions(tmp_path: Path) -> None:
    """Only current snapshots may be imported; older SQLite schemas must use the old app to upgrade first."""
    settings = knowledge_settings(tmp_path / "data")

    with authenticated_client(settings) as client:
        source = client.post(
            "/api/knowledge/sources",
            files={"file": ("旧权限.pdf", pdf_with_text("legacy"), "application/pdf")},
        ).json()
        system_only_source = client.post(
            "/api/knowledge/sources",
            files={"file": ("旧系统专用.pdf", pdf_with_text("system-only"), "application/pdf")},
        ).json()

    with transaction(settings.database_url, write=True) as connection:
        connection.execute(
            "UPDATE knowledge_sources SET read_min_level = 1 WHERE id = %s",
            (source["id"],),
        )
        connection.execute(
            "UPDATE knowledge_sources SET read_min_level = 5, read_scope_ids = %s WHERE id = %s",
            (json.dumps(["procurement"]), system_only_source["id"]),
        )
        connection.execute(
            "UPDATE schema_metadata SET value = 5 WHERE key = 'knowledge_schema_version'"
        )

    with pytest.raises(RuntimeError, match="Unsupported knowledge schema version"):
        KnowledgeStore(settings.database_url, settings.data_dir).initialize()

    with transaction(settings.database_url) as connection:
        assert connection.execute(
            "SELECT read_min_level FROM knowledge_sources WHERE id = %s",
            (source["id"],),
        ).fetchone() == (1,)
        assert connection.execute(
            "SELECT read_min_level, read_scope_ids FROM knowledge_sources WHERE id = %s",
            (system_only_source["id"],),
        ).fetchone() == (5, json.dumps(["procurement"]))
        assert connection.execute(
            "SELECT value FROM schema_metadata WHERE key = 'knowledge_schema_version'"
        ).fetchone() == (5,)


def test_multi_source_markdown_requires_access_to_every_source(tmp_path: Path) -> None:
    settings = knowledge_settings(tmp_path / "data")

    with authenticated_client(settings) as admin:
        private_source = admin.post(
            "/api/knowledge/sources",
            files={"file": ("管理员来源.pdf", pdf_with_text("private"), "application/pdf")},
        ).json()
        admin.post(f"/api/knowledge/sources/{private_source['id']}/confirm-safe")
        admin.post(
            "/api/users",
            json={
                "username": "knowledge-reader",
                "display_name": "知识读取人",
                "department": "知识管理",
                "password": "Knowledge-Reader-2026",
                "scope_levels": {"knowledge": 4},
            },
        )

        with TestClient(create_app(settings)) as reader:
            reader.post(
                "/api/login",
                json={"username": "knowledge-reader", "password": "Knowledge-Reader-2026"},
            )
            shared_source = reader.post(
                "/api/knowledge/sources",
                files={"file": ("共享来源.pdf", pdf_with_text("shared"), "application/pdf")},
            ).json()
            admin.post(f"/api/knowledge/sources/{shared_source['id']}/confirm-safe")
            combined = admin.post(
                "/api/knowledge/versions",
                json={"source_ids": [shared_source["id"], private_source["id"]]},
            )
            assert combined.status_code == 201
            version = combined.json()
            assert version["source_ids"] == [shared_source["id"], private_source["id"]]
            combined_markdown = admin.get(
                f"/api/knowledge/sources/{shared_source['id']}/versions/{version['id']}/markdown"
            )
            duplicate_only = admin.post(
                "/api/knowledge/versions",
                json={"source_ids": [shared_source["id"], shared_source["id"]]},
            )
            forbidden_merge = reader.post(
                "/api/knowledge/versions",
                json={"source_ids": [shared_source["id"], private_source["id"]]},
            )

            hidden_versions = reader.get(
                f"/api/knowledge/sources/{shared_source['id']}/versions"
            )
            hidden_markdown = reader.get(
                f"/api/knowledge/sources/{shared_source['id']}/versions/{version['id']}/markdown"
            )

    assert version["id"] not in {item["id"] for item in hidden_versions.json()}
    assert hidden_markdown.status_code == 404
    assert duplicate_only.status_code == 422
    assert forbidden_merge.status_code == 403
    assert "共享来源.pdf" in combined_markdown.text
    assert "管理员来源.pdf" in combined_markdown.text


def test_unauthorized_source_insert_removes_uploaded_file(tmp_path: Path) -> None:
    settings = knowledge_settings(tmp_path / "data")
    with authenticated_client(settings):
        store = KnowledgeStore(settings.database_url, settings.data_dir)
        with pytest.raises(PermissionError):
            store.create_source(
                BytesIO(pdf_with_text("rollback")), filename="失败上传.pdf", mime_type="application/pdf",
                created_by_user_id="missing-user", read_min_level=4, read_scope_ids=[],
            )
        assert list(store.sources_dir.iterdir()) == []
        with transaction(settings.database_url) as connection:
            assert connection.execute("SELECT COUNT(*) FROM knowledge_sources").fetchone() == (0,)


def test_restart_recovers_interrupted_source_processing(tmp_path: Path) -> None:
    settings = knowledge_settings(tmp_path / "data")
    with authenticated_client(settings) as client:
        source = client.post(
            "/api/knowledge/sources",
            files={"file": ("处理中.pdf", pdf_with_text("interrupted"), "application/pdf")},
        ).json()
        with transaction(settings.database_url, write=True) as connection:
            connection.execute(
                "UPDATE knowledge_sources SET safety_status='confirmed', processing_status='processing' WHERE id=%s",
                (source['id'],),
            )
    with authenticated_client(settings) as client:
        recovered = client.get(f"/api/knowledge/sources/{source['id']}").json()
        assert recovered['processing_status'] == 'parse_failed'
        assert recovered['failure_reason'] == 'interrupted'
        assert client.get(f"/api/knowledge/sources/{source['id']}/file").status_code == 200


def test_source_upload_rechecks_permission_after_reading_file(tmp_path: Path) -> None:
    settings = knowledge_settings(tmp_path / "data")
    with authenticated_client(settings):
        editor = IdentityStore(settings.database_url).create_user(
            username="knowledge-editor", display_name="知识编辑", department=None,
            password=TEST_ADMIN_PASSWORD, scope_levels={"knowledge": 3},
        )
        store = KnowledgeStore(settings.database_url, settings.data_dir)

        class RevokingStream(BytesIO):
            def read(self, size=-1):
                chunk = super().read(size)
                with transaction(settings.database_url, write=True) as connection:
                    connection.execute(
                        "UPDATE identity_user_scopes SET access_level=2 WHERE user_id=%s AND scope_id='knowledge'",
                        (editor['id'],),
                    )
                return chunk

        with pytest.raises(PermissionError, match="知识操作权限已变化"):
            store.create_source(
                RevokingStream(pdf_with_text("permission changed")), filename="失效权限.pdf",
                mime_type="application/pdf", created_by_user_id=editor['id'],
                read_min_level=3, read_scope_ids=['knowledge'],
            )
        assert list(store.sources_dir.iterdir()) == []
        with transaction(settings.database_url) as connection:
            assert connection.execute("SELECT COUNT(*) FROM knowledge_sources").fetchone() == (0,)


def test_safe_confirmation_rechecks_admin_before_claiming_source(tmp_path: Path, monkeypatch) -> None:
    settings = knowledge_settings(tmp_path / "data")
    with authenticated_client(settings) as client:
        source = client.post(
            "/api/knowledge/sources",
            files={"file": ("待确认.pdf", pdf_with_text("pending"), "application/pdf")},
        ).json()
        reviewer = IdentityStore(settings.database_url).create_user(
            username="knowledge-reviewer", display_name="知识确认人", department=None,
            password=TEST_ADMIN_PASSWORD, is_system_admin=True,
        )
        store = KnowledgeStore(settings.database_url, settings.data_dir)
        original_get_source = store.get_source

        def deactivate_after_loading_source(source_id):
            loaded = original_get_source(source_id)
            with transaction(settings.database_url, write=True) as connection:
                connection.execute("UPDATE identity_users SET is_active=0 WHERE id=%s", (reviewer['id'],))
            return loaded

        monkeypatch.setattr(store, 'get_source', deactivate_after_loading_source)
        with pytest.raises(PermissionError, match="账号已失效"):
            store.confirm_safe(source['id'], reviewer['id'])
        unchanged = original_get_source(source['id'])
        assert unchanged['safety_status'] == 'quarantined'
        assert unchanged['processing_status'] == 'not_started'
        assert store.list_versions(source['id']) == []


def test_merged_version_rechecks_admin_after_parsing_outside_write_lock(tmp_path: Path, monkeypatch) -> None:
    settings = knowledge_settings(tmp_path / "data")
    with authenticated_client(settings) as client:
        sources = []
        for name in ('first', 'second'):
            source = client.post(
                "/api/knowledge/sources",
                files={"file": (name + ".pdf", pdf_with_text(name), "application/pdf")},
            ).json()
            assert client.post(f"/api/knowledge/sources/{source['id']}/confirm-safe").status_code == 200
            sources.append(source)
        reviewer = IdentityStore(settings.database_url).create_user(
            username="merge-reviewer", display_name="知识合并人", department=None,
            password=TEST_ADMIN_PASSWORD, is_system_admin=True,
        )
        store = KnowledgeStore(settings.database_url, settings.data_dir)
        original_files = set(store.items_dir.rglob('*.md'))

        def parse_while_permission_changes(source):
            with connect(settings.database_url) as connection, connection.transaction():
                assert connection.execute("SELECT pg_try_advisory_xact_lock(%s)", (WRITE_LOCK,)).fetchone() == (True,)
            with transaction(settings.database_url, write=True) as connection:
                connection.execute("UPDATE identity_users SET access_level=1 WHERE id=%s", (reviewer['id'],))
            return {"status": "parsed", "text": "已解析"}

        monkeypatch.setattr(store, '_run_parser', parse_while_permission_changes)
        with pytest.raises(PermissionError, match="知识操作权限已变化"):
            store.create_version_from_sources([source['id'] for source in sources], reviewer['id'])
        assert set(store.items_dir.rglob('*.md')) == original_files
        with transaction(settings.database_url) as connection:
            assert connection.execute("SELECT COUNT(*) FROM knowledge_versions").fetchone() == (2,)
