import pytest

from api.settings import Settings
from tests.helpers import authenticated_client


@pytest.mark.parametrize("route,target,group", [("workbench", "procurement", "workbenches"), ("workbench", "research", "workbenches")])
def test_checkbox_confirmation_and_restore(tmp_path, monkeypatch, route, target, group):
    settings = Settings.from_data_dir(tmp_path / "production", environment="production")
    path = f"/api/admin/{route}-settings/{target}"
    with authenticated_client(settings) as client:
        assert client.put(path, json={"mode": "active"}).status_code == 422
        result = client.put(path, json={"mode": "active", "reviews": ["business", "security", "code", "rollback"]})
        assert result.status_code == 200
        assert result.json()["can_reactivate"]
        assert client.put(path, json={"mode": "off"}).status_code == 200
        status = next(x for x in client.get("/api/admin/module-settings").json()[group] if x["id"] == target)
        assert status["can_reactivate"]
        assert client.put(path, json={"mode": "active", "reviews": ["business"]}).status_code == 422
        assert client.put(path, json={"mode": "active"}).status_code == 200
        monkeypatch.setattr("api.modules.ACTIVATION_REVIEW_REVISION", 2)
        assert client.put(path, json={"mode": "off"}).status_code == 200
        assert client.put(path, json={"mode": "active"}).status_code == 422
        assert client.put(path, json={"mode": "active", "reviews": ["business", "security", "code", "rollback"]}).status_code == 200
    Settings.from_data_dir(settings.data_dir, environment="production")
