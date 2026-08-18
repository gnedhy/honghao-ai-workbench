from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, Request
from pydantic import BaseModel

from api.database import Database
from api.settings import Settings


API_VERSION = "0.1.0"
SERVICE_NAME = "honghao-ai-api"


class HealthResponse(BaseModel):
    status: Literal["ok"]
    service: str
    api_version: str
    schema_version: int


def create_app(settings: Settings | None = None) -> FastAPI:
    runtime_settings = settings or Settings.from_environment()
    database = Database(runtime_settings.database_path)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        runtime_settings.ensure_directories()
        database.initialize()
        app.state.database = database
        yield

    app = FastAPI(title="Honghao AI API", version=API_VERSION, lifespan=lifespan)

    @app.get("/api/health", response_model=HealthResponse)
    def health(request: Request) -> HealthResponse:
        return HealthResponse(
            status="ok",
            service=SERVICE_NAME,
            api_version=API_VERSION,
            schema_version=request.app.state.database.schema_version(),
        )

    return app


app = create_app()
