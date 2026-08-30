import re
from pathlib import Path

from fastapi.testclient import TestClient

from api.main import PUBLIC_API_PATHS, create_app
from api.security_gate import main
from api.settings import Settings


def test_security_gate_rejects_a_hardcoded_secret(tmp_path: Path, capsys) -> None:
    source = tmp_path / "src"
    source.mkdir()
    (source / "client.py").write_text(
        'api_key = "' + "sk-" + 'live-this-must-not-be-committed-123456"',
        encoding="utf-8",
    )

    result = main(["--root", str(tmp_path)])

    assert result == 1
    assert "SEC001" in capsys.readouterr().out


def test_security_gate_rejects_a_publishable_data_file(tmp_path: Path, capsys) -> None:
    data = tmp_path / ".data"
    data.mkdir()
    (data / "customer.db").write_bytes(b"private")

    result = main(["--root", str(tmp_path)])

    assert result == 1
    assert "SEC002" in capsys.readouterr().out


def test_security_gate_rejects_dynamic_execution(tmp_path: Path, capsys) -> None:
    source = tmp_path / "src"
    source.mkdir()
    (source / "unsafe.py").write_text("result = eval(user_input)", encoding="utf-8")

    result = main(["--root", str(tmp_path)])

    assert result == 1
    assert "SEC003" in capsys.readouterr().out


def test_security_gate_rejects_an_unapproved_public_api(tmp_path: Path, capsys) -> None:
    api = tmp_path / "api"
    api.mkdir()
    (api / "main.py").write_text(
        'PUBLIC_API_PATHS = ("/api/health", "/api/readiness", "/api/login", "/api/debug")',
        encoding="utf-8",
    )

    result = main(["--root", str(tmp_path)])

    assert result == 1
    assert "SEC004" in capsys.readouterr().out


def test_every_non_public_api_route_rejects_anonymous_access(tmp_path: Path) -> None:
    app = create_app(Settings.from_data_dir(tmp_path / "data"))
    checked: list[str] = []

    with TestClient(app) as client:
        for route in app.routes:
            path = getattr(route, "path", "")
            if not path.startswith("/api/") or path in PUBLIC_API_PATHS:
                continue
            methods = sorted(set(getattr(route, "methods", set())) - {"HEAD", "OPTIONS"})
            if not methods:
                continue
            concrete_path = re.sub(r"\{[^}]+\}", "untrusted", path)
            response = client.request(methods[0], concrete_path)
            assert response.status_code == 401, f"{methods[0]} {path} bypassed authentication"
            checked.append(path)

    assert checked


def test_security_gate_rejects_a_skipped_test(tmp_path: Path, capsys) -> None:
    tests = tmp_path / "tests"
    tests.mkdir()
    (tests / "test_hidden.py").write_text(
        "@pytest.mark." + 'skip(reason="hide failure")\ndef test_hidden(): pass',
        encoding="utf-8",
    )

    result = main(["--root", str(tmp_path)])

    assert result == 1
    assert "SEC005" in capsys.readouterr().out


def test_security_gate_rejects_a_command_that_hides_failure(tmp_path: Path, capsys) -> None:
    (tmp_path / "package.json").write_text(
        '{"scripts":{"verify":"pytest ' + "|" + '| true"}}',
        encoding="utf-8",
    )

    result = main(["--root", str(tmp_path)])

    assert result == 1
    assert "SEC005" in capsys.readouterr().out


def test_security_gate_scans_configuration_files_for_secrets(tmp_path: Path, capsys) -> None:
    (tmp_path / "settings.json").write_text(
        '{"api_key":"plain-secret-value-123456"}',
        encoding="utf-8",
    )

    assert main(["--root", str(tmp_path)]) == 1
    assert "SEC001" in capsys.readouterr().out


def test_security_gate_rejects_documents_in_public_assets(tmp_path: Path, capsys) -> None:
    public = tmp_path / "public"
    public.mkdir()
    (public / "customer.pdf").write_bytes(b"private")

    assert main(["--root", str(tmp_path)]) == 1
    assert "SEC002" in capsys.readouterr().out


def test_security_gate_scans_tests_and_build_output_for_strong_tokens(tmp_path: Path, capsys) -> None:
    tests = tmp_path / "tests"
    dist = tmp_path / "dist"
    tests.mkdir()
    dist.mkdir()
    token = "ghp_" + "A" * 36
    (tests / "test_client.py").write_text(f'TOKEN = "{token}"', encoding="utf-8")
    (dist / "index.js").write_text(f'window.token = "{token}"', encoding="utf-8")

    assert main(["--root", str(tmp_path)]) == 1
    output = capsys.readouterr().out
    assert "tests" in output
    assert "dist" in output
