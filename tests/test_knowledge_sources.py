import sqlite3
from io import BytesIO
from pathlib import Path
from urllib.parse import quote

from fastapi.testclient import TestClient
from pypdf import PdfWriter

from api.main import create_app
from api.modules import default_module_modes
from api.settings import Settings
from tests.helpers import authenticated_client


def knowledge_settings(data_dir: Path) -> Settings:
    modes = default_module_modes()
    modes["knowledge"] = "active"
    return Settings.from_data_dir(data_dir, module_modes=modes)


def pdf_with_text(text: str) -> bytes:
    content = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode("ascii")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length " + str(len(content)).encode("ascii") + b" >>\nstream\n" + content + b"\nendstream",
    ]
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
    pdf = pdf_with_text("")

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


def test_resource_acl_hides_admin_source_from_other_knowledge_roles(tmp_path: Path) -> None:
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
                "role_ids": ["knowledge-admin"],
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


def test_derived_index_is_rebuilt_on_restart(tmp_path: Path) -> None:
    settings = knowledge_settings(tmp_path / "data")

    with authenticated_client(settings) as client:
        source = client.post(
            "/api/knowledge/sources",
            files={"file": ("可重建.pdf", pdf_with_text("rebuild"), "application/pdf")},
        ).json()
        client.post(f"/api/knowledge/sources/{source['id']}/confirm-safe")

    with sqlite3.connect(settings.database_path) as connection:
        connection.execute("DROP VIEW knowledge_derived_index")

    with authenticated_client(settings) as restarted:
        versions = restarted.get(f"/api/knowledge/sources/{source['id']}/versions")

    assert versions.status_code == 200
    assert len(versions.json()) == 1


def test_multi_source_markdown_requires_access_to_every_source(tmp_path: Path) -> None:
    settings = knowledge_settings(tmp_path / "data")

    with authenticated_client(settings) as admin:
        private_source = admin.post(
            "/api/knowledge/sources",
            files={"file": ("管理员来源.pdf", pdf_with_text("private"), "application/pdf")},
        ).json()
        admin.post(
            "/api/users",
            json={
                "username": "knowledge-reader",
                "display_name": "知识读取人",
                "department": "知识管理",
                "password": "Knowledge-Reader-2026",
                "role_ids": ["knowledge-admin"],
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
            version = reader.get(
                f"/api/knowledge/sources/{shared_source['id']}/versions"
            ).json()[0]

            with sqlite3.connect(settings.database_path) as connection:
                connection.execute(
                    "INSERT INTO knowledge_version_sources (version_id, source_id) VALUES (?, ?)",
                    (version["id"], private_source["id"]),
                )

            hidden_versions = reader.get(
                f"/api/knowledge/sources/{shared_source['id']}/versions"
            )
            hidden_markdown = reader.get(
                f"/api/knowledge/sources/{shared_source['id']}/versions/{version['id']}/markdown"
            )

    assert hidden_versions.json() == []
    assert hidden_markdown.status_code == 404
