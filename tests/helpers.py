from collections.abc import Iterator
from contextlib import contextmanager

from fastapi.testclient import TestClient

from api.identity import DuplicateIdentityError, IdentityStore, SYSTEM_ADMIN_ROLE_ID
from api.main import create_app
from api.settings import Settings


TEST_ADMIN_PASSWORD = "Test-Admin-Password-2026"


@contextmanager
def authenticated_client(settings: Settings) -> Iterator[TestClient]:
    with TestClient(create_app(settings)) as client:
        try:
            IdentityStore(settings.database_path).create_user(
                username="test-admin",
                display_name="测试管理员",
                department=None,
                password=TEST_ADMIN_PASSWORD,
                role_ids=[SYSTEM_ADMIN_ROLE_ID],
            )
        except DuplicateIdentityError:
            pass
        login = client.post(
            "/api/login",
            json={"username": "test-admin", "password": TEST_ADMIN_PASSWORD},
        )
        assert login.status_code == 200
        yield client
