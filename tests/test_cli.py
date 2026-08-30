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
