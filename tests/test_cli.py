from pathlib import Path

from fastapi.testclient import TestClient

from api.cli import main
from api.main import create_app
from api.settings import Settings


def test_create_admin_cli_creates_a_login_without_default_password(
    tmp_path: Path,
    monkeypatch,
) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")
    answers = iter(["admin", "本地管理员", "总经办"])
    passwords = iter(["Local-Admin-Password-2026", "Local-Admin-Password-2026"])
    monkeypatch.setattr("builtins.input", lambda _: next(answers))
    monkeypatch.setattr("getpass.getpass", lambda _: next(passwords))

    result = main(["create-admin"], settings=settings)

    with TestClient(create_app(settings)) as client:
        login = client.post(
            "/api/login",
            json={"username": "admin", "password": "Local-Admin-Password-2026"},
        )

    assert result == 0
    assert login.status_code == 200
    assert login.json()["is_system_admin"] is True
    assert login.json()["scope_levels"] == {}


def test_serve_cli_requires_a_built_frontend(tmp_path: Path, capsys) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")

    result = main(["serve", "--dist", str(tmp_path / "missing")], settings=settings)

    assert result == 1
    assert "前端构建产物" in capsys.readouterr().err


def test_serve_cli_starts_one_local_service(tmp_path: Path, monkeypatch, capsys) -> None:
    settings = Settings.from_data_dir(tmp_path / "data")
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("ready", encoding="utf-8")
    started: dict[str, object] = {}

    def fake_run(app, *, host: str, port: int, log_level: str) -> None:
        started.update(app=app, host=host, port=port, log_level=log_level)

    monkeypatch.setattr("uvicorn.run", fake_run)

    result = main(["serve", "--dist", str(dist)], settings=settings)

    assert result == 0
    assert started["host"] == "127.0.0.1"
    assert started["port"] == 8000
    assert "测试环境" in capsys.readouterr().out
