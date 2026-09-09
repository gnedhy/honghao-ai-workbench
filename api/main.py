from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import ExitStack, asynccontextmanager, suppress
from pathlib import Path
import sqlite3
from typing import Annotated, Literal, cast
from uuid import UUID

from fastapi import FastAPI, File, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.exceptions import RequestValidationError
from fastapi.exception_handlers import request_validation_exception_handler
from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from api.authorization import AuthorizationStore
from api.database import Database, SubmissionConflictError
from api.identity import DuplicateIdentityError, IdentityStore, SESSION_COOKIE_NAME
from api.knowledge import InvalidKnowledgeSourceError, KnowledgeStore
from api.modules import (
    MODULE_IDS,
    ModuleId,
    ModuleMode,
    RuntimeEnvironment,
    REQUIRED_ACTIVATION_REVIEWS,
    create_activation_review_record,
    load_persisted_module_modes,
    module_for_api_path,
    save_persisted_module_modes,
)
from api.settings import Settings
from api.workbenches import (
    WORKBENCH_IDS,
    WorkbenchId,
    WorkbenchMode,
    load_persisted_workbench_modes,
    save_persisted_workbench_modes,
)
from api.operations import migrate_data, migrate_procurement_data, readiness_checks, service_marker
from api.procurement import ProcurementStore, create_procurement_router
from api.procurement_collaboration import capabilities


API_VERSION = "0.1.0"
SERVICE_NAME = "honghao-ai-api"
PUBLIC_API_PATHS = ("/api/health", "/api/readiness", "/api/login")


class HealthResponse(BaseModel):
    status: Literal["ok"]
    service: str
    api_version: str
    environment: RuntimeEnvironment | None


class ReadinessResponse(BaseModel):
    status: Literal["ready", "not_ready"]
    checks: dict[str, Literal["ok", "failed"]]


class WorkbenchStatusResponse(BaseModel):
    id: WorkbenchId
    mode: WorkbenchMode


class ModuleStatusResponse(BaseModel):
    id: ModuleId
    mode: ModuleMode


class AdminModuleStatusResponse(BaseModel):
    id: ModuleId
    current_mode: ModuleMode
    pending_mode: ModuleMode


class AdminWorkbenchStatusResponse(BaseModel):
    id: WorkbenchId
    current_mode: WorkbenchMode
    pending_mode: WorkbenchMode


class AdminModuleSettingsResponse(BaseModel):
    environment: RuntimeEnvironment
    modules: list[AdminModuleStatusResponse]
    workbenches: list[AdminWorkbenchStatusResponse]


class ModuleSettingUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mode: ModuleMode
    reviews: list[Literal["business", "security", "code", "rollback"]] = Field(default_factory=list)
    issue_url: Annotated[str, StringConstraints(pattern=r"^https://github\.com/[^/]+/[^/]+/issues/\d+$", max_length=500)] | None = None
    pull_request_url: Annotated[str, StringConstraints(pattern=r"^https://github\.com/[^/]+/[^/]+/pull/\d+$", max_length=500)] | None = None


class LoginRequest(BaseModel):
    username: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
    password: Annotated[str, StringConstraints(min_length=1, max_length=1_000)]


AccessLevel = Literal[2, 3, 4]
FieldWriteAccessLevel = Literal[3, 4]
AccessScope = Literal["management", "procurement", "research", "sales", "knowledge"]


class CurrentUserResponse(BaseModel):
    id: str
    username: str
    display_name: str
    department: str | None
    is_system_admin: bool
    scope_levels: dict[AccessScope, AccessLevel]


class UserResponse(CurrentUserResponse):
    is_active: bool


class UserCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    username: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100, pattern=r"^[A-Za-z0-9._-]+$")]
    display_name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
    department: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)] | None = None
    password: Annotated[str, StringConstraints(min_length=12, max_length=1_000)]
    is_system_admin: bool = False
    scope_levels: dict[AccessScope, AccessLevel] = Field(default_factory=dict)


class UserUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    is_active: bool | None = None
    is_system_admin: bool | None = None
    scope_levels: dict[AccessScope, AccessLevel] | None = None


class ProfileResponse(CurrentUserResponse):
    procurement_capabilities: dict[str, bool]


class ProfileUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    display_name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
    department: Annotated[str, StringConstraints(strip_whitespace=True, max_length=100)] | None = None


class PasswordUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)
    current_password: Annotated[str, StringConstraints(min_length=1, max_length=1000)]
    new_password: Annotated[str, StringConstraints(min_length=12, max_length=1000)]
    confirm_password: Annotated[str, StringConstraints(min_length=12, max_length=1000)]


class FieldPolicyUpdate(BaseModel):
    read_min_level: AccessLevel
    write_min_level: FieldWriteAccessLevel
    read_scope_ids: list[AccessScope]
    write_scope_ids: list[AccessScope]


class SensitiveFieldCreate(FieldPolicyUpdate):
    area: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=50)]
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
    description: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=300)]


class FieldPolicyResponse(BaseModel):
    id: str
    area: str
    name: str
    description: str
    read_min_level: int
    write_min_level: int
    read_scope_ids: list[AccessScope]
    write_scope_ids: list[AccessScope]


class AuditEventResponse(BaseModel):
    id: str
    action: str
    target_type: str
    target_id: str
    created_at: str
    actor_name: str | None


class ProjectCreate(BaseModel):
    title: str


class ProjectResponse(BaseModel):
    id: str
    title: str


class ProjectUpdate(BaseModel):
    title: str


class ConversationCreate(BaseModel):
    title: str
    project_id: str | None = None


class ConversationResponse(BaseModel):
    id: str
    title: str
    project_id: str | None


class ConversationProjectUpdate(BaseModel):
    project_id: str | None


class ConversationSubmission(BaseModel):
    mode: Literal["chat", "work"]
    content: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=10_000)]
    submission_key: UUID


class InitialConversationSubmission(ConversationSubmission):
    title: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
    project_id: str | None = None


class MessageResponse(BaseModel):
    id: str
    conversation_id: str
    mode: Literal["chat", "work"]
    content: str
    created_at: str
    task_id: str | None
    task_status: Literal["created"] | None


class TaskResponse(BaseModel):
    id: str
    conversation_id: str
    objective: str
    project_id: str | None
    status: Literal["created"]
    created_at: str
    latest_run: None


class SubmissionResponse(BaseModel):
    message: MessageResponse
    task: TaskResponse | None


class InitialSubmissionResponse(SubmissionResponse):
    conversation: ConversationResponse


class KnowledgeSourceResponse(BaseModel):
    id: str
    filename: str
    mime_type: str
    size_bytes: int
    sha256: str
    safety_status: Literal["quarantined", "confirmed"]
    processing_status: Literal["not_started", "processing", "parsed", "awaiting_ocr", "encrypted", "parse_failed"]
    failure_reason: str | None
    duplicate_of: str | None
    created_at: str
    read_min_level: int
    read_scope_ids: list[AccessScope]


class KnowledgeVersionResponse(BaseModel):
    id: str
    status: Literal["draft"]
    created_at: str
    source_ids: list[str]


class KnowledgeVersionCreate(BaseModel):
    source_ids: Annotated[list[str], Field(min_length=2)]


def create_app(settings: Settings | None = None, *, static_dir: Path | None = None) -> FastAPI:
    runtime_settings = settings or Settings.from_environment()
    static_root = static_dir.resolve() if static_dir is not None else None
    database = Database(runtime_settings.database_path)
    identities = IdentityStore(runtime_settings.database_path)
    authorization = AuthorizationStore(runtime_settings.database_path)
    knowledge = KnowledgeStore(runtime_settings.database_path, runtime_settings.data_dir)
    procurement = ProcurementStore(runtime_settings.database_path)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.startup_error = None
        app.state.procurement_error = None
        app.state.procurement_scheduler = "ok"
        scheduler_task: asyncio.Task[None] | None = None

        async def run_procurement_scheduler() -> None:
            while True:
                await asyncio.sleep(30)
                try:
                    procurement.process_scheduled()
                    app.state.procurement_scheduler = "ok"
                except (OSError, RuntimeError, ValueError, sqlite3.Error):
                    app.state.procurement_scheduler = "failed"

        with ExitStack() as stack:
            try:
                runtime_settings.ensure_directories()
                stack.enter_context(service_marker(runtime_settings))
                database_preexisted = runtime_settings.database_path.is_file()
                migrate_data(runtime_settings, include_workbenches=False)
                app.state.database = database
                app.state.identities = identities
                app.state.authorization = authorization
                app.state.knowledge = knowledge
                app.state.procurement = procurement
                if runtime_settings.workbench_modes["procurement"] == "active":
                    try:
                        migrate_procurement_data(
                            runtime_settings,
                            backup_before_migration=database_preexisted,
                        )
                        procurement.process_scheduled()
                        scheduler_task = asyncio.create_task(run_procurement_scheduler())
                    except (OSError, RuntimeError, ValueError, sqlite3.Error) as error:
                        app.state.procurement_error = str(error)
                        app.state.procurement_scheduler = "failed"
            except (OSError, RuntimeError, ValueError) as error:
                app.state.startup_error = str(error)
            try:
                yield
            finally:
                if scheduler_task is not None:
                    scheduler_task.cancel()
                    with suppress(asyncio.CancelledError):
                        await scheduler_task

    app = FastAPI(title="Honghao AI API", version=API_VERSION, lifespan=lifespan)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, error: RequestValidationError):
        if request.url.path == "/api/me/password":
            return JSONResponse(status_code=422, content={"detail": "请填写当前密码及两次新密码，新密码长度须为 12–1000 个字符，且不能包含其他字段"})
        return await request_validation_exception_handler(request, error)

    def current_user(request: Request) -> dict:
        user = getattr(request.state, "current_user", None)
        if user is None:
            raise HTTPException(status_code=401, detail="Authentication required")
        return user

    def require_system_admin(request: Request) -> dict:
        user = current_user(request)
        if not user["is_system_admin"]:
            raise HTTPException(status_code=403, detail="System administrator required")
        return user

    def ensure_submission_modules_available(mode: Literal["chat", "work"], user: dict) -> None:
        if mode != "work":
            return
        if runtime_settings.module_modes["tasks"] == "off":
            raise HTTPException(status_code=404, detail="Module not available")
        if not authorization.has_module_access(
            user["is_system_admin"], user["scope_levels"], "tasks", "POST"
        ):
            raise HTTPException(status_code=403, detail="Permission denied")

    def can_read_source(source: dict, user: dict) -> bool:
        return user["is_system_admin"] or any(
            user["scope_levels"].get(scope_id, 0) >= source["read_min_level"]
            for scope_id in source["read_scope_ids"]
        )

    def readable_source(source_id: str, request: Request) -> dict:
        source = knowledge.get_source(source_id)
        if source is None:
            raise HTTPException(status_code=404, detail="Knowledge source not found")
        if not can_read_source(source, current_user(request)):
            raise HTTPException(status_code=404, detail="Knowledge source not found")
        return source

    @app.middleware("http")
    async def guard_disabled_modules(request: Request, call_next):
        module_id = module_for_api_path(request.url.path)
        if module_id is not None and runtime_settings.module_modes[module_id] == "off":
            return JSONResponse(status_code=404, content={"detail": "Module not available"})
        if module_id is not None:
            user = getattr(request.state, "current_user", None)
            if user is None or not authorization.has_module_access(
                user["is_system_admin"], user["scope_levels"], module_id, request.method
            ):
                return JSONResponse(status_code=403, content={"detail": "Permission denied"})
        return await call_next(request)

    @app.middleware("http")
    async def require_authentication(request: Request, call_next):
        if request.url.path.startswith("/api/") and request.url.path not in PUBLIC_API_PATHS:
            token = request.cookies.get(SESSION_COOKIE_NAME)
            user = identities.user_for_session(token) if token else None
            if user is None:
                return JSONResponse(status_code=401, content={"detail": "Authentication required"})
            request.state.current_user = user
        return await call_next(request)

    @app.middleware("http")
    async def reject_requests_while_unready(request: Request, call_next):
        if (
            getattr(request.app.state, "startup_error", None) is not None
            and request.url.path.startswith("/api/")
            and request.url.path not in {"/api/health", "/api/readiness"}
        ):
            return JSONResponse(status_code=503, content={"detail": "Service not ready"})
        return await call_next(request)

    @app.get("/api/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        return HealthResponse(
            status="ok",
            service=SERVICE_NAME,
            api_version=API_VERSION,
            environment=runtime_settings.environment,
        )

    @app.get("/api/readiness", response_model=ReadinessResponse)
    def readiness() -> ReadinessResponse | JSONResponse:
        checks = readiness_checks(runtime_settings)
        checks["runtime_startup"] = (
            "failed" if app.state.startup_error is not None else "ok"
        )
        if runtime_settings.workbench_modes["procurement"] == "active" and app.state.procurement_error is None:
            checks["procurement_scheduler"] = app.state.procurement_scheduler
        response = ReadinessResponse(
            status="ready" if all(value == "ok" for value in checks.values()) else "not_ready",
            checks=cast(dict[str, Literal["ok", "failed"]], checks),
        )
        if response.status == "not_ready":
            return JSONResponse(status_code=503, content=response.model_dump())
        return response

    @app.post("/api/login", response_model=CurrentUserResponse)
    def login(credentials: LoginRequest, response: Response) -> CurrentUserResponse:
        authenticated = identities.login(
            credentials.username,
            credentials.password,
            runtime_settings.session_ttl_seconds,
        )
        if authenticated is None:
            authorization.audit(
                "login.failed",
                actor_user_id=None,
                target_type="account",
                target_id=credentials.username,
            )
            raise HTTPException(status_code=401, detail="Invalid username or password")
        user, token = authenticated
        authorization.audit(
            "login.succeeded",
            actor_user_id=user["id"],
            target_type="account",
            target_id=user["id"],
        )
        response.set_cookie(
            SESSION_COOKIE_NAME,
            token,
            max_age=runtime_settings.session_ttl_seconds,
            httponly=True,
            samesite="strict",
            path="/api",
        )
        return CurrentUserResponse(**user)

    @app.get("/api/me", response_model=CurrentUserResponse)
    def me(request: Request) -> CurrentUserResponse:
        return CurrentUserResponse(**current_user(request))

    @app.get("/api/me/profile", response_model=ProfileResponse)
    def me_profile(request: Request) -> ProfileResponse:
        user = current_user(request)
        return ProfileResponse(**user, procurement_capabilities=capabilities(runtime_settings.database_path, user))

    @app.post("/api/me/password")
    def me_password(update: PasswordUpdate, request: Request, response: Response) -> dict[str, str]:
        result = identities.change_password(current_user(request)["id"], request.cookies.get(SESSION_COOKIE_NAME, ""), update.current_password, update.new_password, update.confirm_password)
        errors = {"invalid": (422, "两次新密码须一致，长度为 12–1000 个字符"), "expired": (401, "登录状态已变化，请重新登录"), "wrong": (400, "当前密码不正确"), "same": (422, "新密码不能与当前密码相同"), "limited": (429, "当前密码错误次数过多，请在 15 分钟后重试")}
        if result in errors:
            status, message = errors[result]
            raise HTTPException(status_code=status, detail=message)
        response.delete_cookie(SESSION_COOKIE_NAME, path="/api", httponly=True, samesite="strict")
        return {"message": "密码已修改，所有登录会话已退出，请重新登录。"}

    @app.patch("/api/users/{user_id}/profile", response_model=UserResponse)
    def update_profile(user_id: str, update: ProfileUpdate, request: Request) -> UserResponse:
        actor = require_system_admin(request)
        try:
            user = identities.update_profile(user_id, actor_id=actor["id"], display_name=update.display_name, department=update.department or None)
        except PermissionError as error:
            raise HTTPException(status_code=403, detail="Administrator required") from error
        if user is None:
            raise HTTPException(status_code=404, detail="User not found")
        return UserResponse(**user)

    @app.post("/api/logout", status_code=204)
    def logout(request: Request, response: Response) -> None:
        token = request.cookies.get(SESSION_COOKIE_NAME)
        if token is None:
            raise HTTPException(status_code=401, detail="Authentication required")
        identities.logout(token)
        response.delete_cookie(SESSION_COOKIE_NAME, path="/api", httponly=True, samesite="strict")

    @app.post("/api/users", response_model=UserResponse, status_code=201)
    def create_user(user: UserCreate, request: Request) -> UserResponse:
        actor = require_system_admin(request)
        try:
            created = identities.create_user(
                username=user.username,
                display_name=user.display_name,
                department=user.department,
                password=user.password,
                is_system_admin=user.is_system_admin,
                scope_levels=user.scope_levels,
            )
        except DuplicateIdentityError as error:
            raise HTTPException(status_code=409, detail="User already exists") from error
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        authorization.audit(
            "user.created",
            actor_user_id=actor["id"],
            target_type="account",
            target_id=created["id"],
        )
        return UserResponse(**created)

    @app.get("/api/users", response_model=list[UserResponse])
    def list_users(request: Request) -> list[UserResponse]:
        require_system_admin(request)
        return [UserResponse(**user) for user in identities.list_users()]

    @app.patch("/api/users/{user_id}", response_model=UserResponse)
    def update_user(user_id: str, update: UserUpdate, request: Request) -> UserResponse:
        actor = require_system_admin(request)
        if update.is_active is None and update.is_system_admin is None and update.scope_levels is None:
            raise HTTPException(status_code=422, detail="No account changes supplied")
        if user_id == actor["id"]:
            raise HTTPException(status_code=422, detail="Cannot modify the current administrator")
        try:
            user = identities.update_user(
                user_id,
                is_active=update.is_active,
                is_system_admin=update.is_system_admin,
                scope_levels=update.scope_levels,
            )
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        if user is None:
            raise HTTPException(status_code=404, detail="User not found")
        authorization.audit(
            "user.updated",
            actor_user_id=actor["id"],
            target_type="account",
            target_id=user_id,
        )
        return UserResponse(**user)

    @app.get("/api/admin/fields", response_model=list[FieldPolicyResponse])
    def list_field_policies(request: Request) -> list[FieldPolicyResponse]:
        require_system_admin(request)
        return [FieldPolicyResponse(**field) for field in authorization.list_field_policies()]

    @app.post("/api/admin/fields", response_model=FieldPolicyResponse, status_code=201)
    def create_sensitive_field(
        create: SensitiveFieldCreate,
        request: Request,
    ) -> FieldPolicyResponse:
        actor = require_system_admin(request)
        try:
            field = authorization.create_field(
                create.area,
                create.name,
                create.description,
                create.read_min_level,
                create.write_min_level,
                create.read_scope_ids,
                create.write_scope_ids,
            )
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        authorization.audit(
            "field.created",
            actor_user_id=actor["id"],
            target_type="field",
            target_id=field["id"],
        )
        return FieldPolicyResponse(**field)

    @app.put("/api/admin/fields/{field_id}", response_model=FieldPolicyResponse)
    def update_field_policy(
        field_id: str,
        update: FieldPolicyUpdate,
        request: Request,
    ) -> FieldPolicyResponse:
        actor = require_system_admin(request)
        try:
            field = authorization.set_field_policy(
                field_id,
                update.read_min_level,
                update.write_min_level,
                update.read_scope_ids,
                update.write_scope_ids,
            )
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        authorization.audit(
            "field.policy.updated",
            actor_user_id=actor["id"],
            target_type="field",
            target_id=field_id,
        )
        return FieldPolicyResponse(**field)

    @app.get("/api/admin/audit-events", response_model=list[AuditEventResponse])
    def list_audit_events(request: Request) -> list[AuditEventResponse]:
        require_system_admin(request)
        return [AuditEventResponse(**event) for event in authorization.list_audit_events()]

    @app.get("/api/admin/module-settings", response_model=AdminModuleSettingsResponse)
    def get_admin_module_settings(request: Request) -> AdminModuleSettingsResponse:
        require_system_admin(request)
        pending_modes = load_persisted_module_modes(
            runtime_settings.data_dir,
            runtime_settings.environment,
            runtime_settings.module_modes,
        )
        pending_workbench_modes = load_persisted_workbench_modes(
            runtime_settings.data_dir,
            runtime_settings.environment,
            runtime_settings.workbench_modes,
        )
        return AdminModuleSettingsResponse(
            environment=runtime_settings.environment,
            modules=[
                AdminModuleStatusResponse(
                    id=module_id,
                    current_mode=runtime_settings.module_modes[module_id],
                    pending_mode=pending_modes[module_id],
                )
                for module_id in MODULE_IDS
            ],
            workbenches=[
                AdminWorkbenchStatusResponse(
                    id=workbench_id,
                    current_mode=runtime_settings.workbench_modes[workbench_id],
                    pending_mode=pending_workbench_modes[workbench_id],
                )
                for workbench_id in WORKBENCH_IDS
            ],
        )

    @app.put(
        "/api/admin/module-settings/{module_id}",
        response_model=AdminModuleStatusResponse,
    )
    def update_admin_module_setting(
        module_id: str,
        update: ModuleSettingUpdate,
        request: Request,
    ) -> AdminModuleStatusResponse:
        actor = require_system_admin(request)
        if module_id not in MODULE_IDS:
            raise HTTPException(status_code=404, detail="Module not found")
        if (
            runtime_settings.environment == "production"
            and update.mode == "active"
            and (
                set(update.reviews) != REQUIRED_ACTIVATION_REVIEWS
                or update.issue_url is None
                or update.pull_request_url is None
            )
        ):
            raise HTTPException(
                status_code=422,
                detail="Production activation requires business, security, code, and rollback reviews",
            )
        typed_module_id = cast(ModuleId, module_id)
        pending_modes = load_persisted_module_modes(
            runtime_settings.data_dir,
            runtime_settings.environment,
            runtime_settings.module_modes,
        )
        pending_modes[typed_module_id] = update.mode
        save_persisted_module_modes(
            runtime_settings.data_dir,
            runtime_settings.environment,
            pending_modes,
            approved_module=typed_module_id
            if runtime_settings.environment == "production" and update.mode == "active"
            else None,
            approved_review_record=create_activation_review_record(
                update.reviews,
                reviewed_by=actor["id"],
                issue_url=update.issue_url or "",
                pull_request_url=update.pull_request_url or "",
            )
            if runtime_settings.environment == "production" and update.mode == "active"
            else None,
            changed_module=typed_module_id,
            changed_mode=update.mode,
            changed_by=actor["id"],
        )
        authorization.audit(
            f"module.mode.{update.mode}",
            actor_user_id=actor["id"],
            target_type="module",
            target_id=typed_module_id,
        )
        return AdminModuleStatusResponse(
            id=typed_module_id,
            current_mode=runtime_settings.module_modes[typed_module_id],
            pending_mode=update.mode,
        )

    @app.put(
        "/api/admin/workbench-settings/{workbench_id}",
        response_model=AdminWorkbenchStatusResponse,
    )
    def update_admin_workbench_setting(
        workbench_id: str,
        update: ModuleSettingUpdate,
        request: Request,
    ) -> AdminWorkbenchStatusResponse:
        actor = require_system_admin(request)
        if workbench_id not in WORKBENCH_IDS:
            raise HTTPException(status_code=404, detail="Workbench not found")
        if (
            runtime_settings.environment == "production"
            and update.mode == "active"
            and (
                set(update.reviews) != REQUIRED_ACTIVATION_REVIEWS
                or update.issue_url is None
                or update.pull_request_url is None
            )
        ):
            raise HTTPException(
                status_code=422,
                detail="Production activation requires business, security, code, and rollback reviews",
            )
        typed_workbench_id = cast(WorkbenchId, workbench_id)
        pending_modes = load_persisted_workbench_modes(
            runtime_settings.data_dir,
            runtime_settings.environment,
            runtime_settings.workbench_modes,
        )
        pending_modes[typed_workbench_id] = update.mode
        is_production_activation = runtime_settings.environment == "production" and update.mode == "active"
        save_persisted_workbench_modes(
            runtime_settings.data_dir,
            runtime_settings.environment,
            pending_modes,
            approved_workbench=typed_workbench_id if is_production_activation else None,
            approved_review_record=create_activation_review_record(
                update.reviews,
                reviewed_by=actor["id"],
                issue_url=update.issue_url or "",
                pull_request_url=update.pull_request_url or "",
            ) if is_production_activation else None,
            changed_workbench=typed_workbench_id,
            changed_mode=update.mode,
            changed_by=actor["id"],
        )
        authorization.audit(
            f"workbench.mode.{update.mode}",
            actor_user_id=actor["id"],
            target_type="workbench",
            target_id=typed_workbench_id,
        )
        return AdminWorkbenchStatusResponse(
            id=typed_workbench_id,
            current_mode=runtime_settings.workbench_modes[typed_workbench_id],
            pending_mode=update.mode,
        )

    @app.get("/api/workbenches", response_model=list[WorkbenchStatusResponse])
    def list_workbenches(request: Request) -> list[WorkbenchStatusResponse]:
        user = current_user(request)
        return [
            WorkbenchStatusResponse(id=workbench_id, mode=runtime_settings.workbench_modes[workbench_id])
            for workbench_id in WORKBENCH_IDS
            if authorization.can_access_workbench(
                user["is_system_admin"], user["scope_levels"], workbench_id
            )
        ]

    @app.get("/api/modules", response_model=list[ModuleStatusResponse])
    def list_modules(request: Request) -> list[ModuleStatusResponse]:
        user = current_user(request)
        return [
            ModuleStatusResponse(id=module_id, mode=runtime_settings.module_modes[module_id])
            for module_id in MODULE_IDS
            if authorization.has_module_access(
                user["is_system_admin"], user["scope_levels"], module_id, "GET"
            )
        ]

    @app.post("/api/knowledge/sources", response_model=KnowledgeSourceResponse, status_code=201)
    def upload_knowledge_source(request: Request, file: UploadFile = File(...)) -> KnowledgeSourceResponse:
        actor = current_user(request)
        try:
            source = knowledge.create_source(
                file.file,
                filename=file.filename or "source.pdf",
                mime_type=file.content_type or "",
                created_by_user_id=actor["id"],
                read_min_level=actor["scope_levels"].get("knowledge", 4),
                read_scope_ids=[] if actor["is_system_admin"] else ["knowledge"],
            )
        except InvalidKnowledgeSourceError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        authorization.audit(
            "knowledge.source.uploaded",
            actor_user_id=actor["id"],
            target_type="knowledge_source",
            target_id=source["id"],
        )
        return KnowledgeSourceResponse(**source)

    @app.get("/api/knowledge/sources/{source_id}", response_model=KnowledgeSourceResponse)
    def get_knowledge_source(source_id: str, request: Request) -> KnowledgeSourceResponse:
        return KnowledgeSourceResponse(**readable_source(source_id, request))

    @app.get("/api/knowledge/sources/{source_id}/file")
    def download_knowledge_source(source_id: str, request: Request) -> FileResponse:
        source = readable_source(source_id, request)
        if source["safety_status"] == "quarantined" and not current_user(request)["is_system_admin"]:
            raise HTTPException(status_code=423, detail="Knowledge source is quarantined")
        return FileResponse(
            knowledge.source_path(source),
            media_type="application/pdf",
            filename=source["filename"],
        )

    @app.post("/api/knowledge/sources/{source_id}/confirm-safe", response_model=KnowledgeSourceResponse)
    def confirm_knowledge_source_safe(source_id: str, request: Request) -> KnowledgeSourceResponse:
        actor = require_system_admin(request)
        source = knowledge.confirm_safe(source_id, actor["id"])
        if source is None:
            raise HTTPException(status_code=404, detail="Knowledge source not found")
        authorization.audit(
            "knowledge.source.confirmed_safe",
            actor_user_id=actor["id"],
            target_type="knowledge_source",
            target_id=source_id,
        )
        return KnowledgeSourceResponse(**source)

    @app.get(
        "/api/knowledge/sources/{source_id}/versions",
        response_model=list[KnowledgeVersionResponse],
    )
    def list_knowledge_versions(source_id: str, request: Request) -> list[KnowledgeVersionResponse]:
        readable_source(source_id, request)
        user = current_user(request)
        readable_versions = []
        for version in knowledge.list_versions(source_id):
            linked_sources = [knowledge.get_source(linked_id) for linked_id in version["source_ids"]]
            if all(linked is not None and can_read_source(linked, user) for linked in linked_sources):
                readable_versions.append(KnowledgeVersionResponse(**version))
        return readable_versions

    @app.post("/api/knowledge/versions", response_model=KnowledgeVersionResponse, status_code=201)
    def create_knowledge_version(
        request_data: KnowledgeVersionCreate,
        request: Request,
    ) -> KnowledgeVersionResponse:
        actor = require_system_admin(request)
        try:
            version = knowledge.create_version_from_sources(request_data.source_ids, actor["id"])
        except InvalidKnowledgeSourceError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        authorization.audit(
            "knowledge.version.created",
            actor_user_id=actor["id"],
            target_type="knowledge_version",
            target_id=version["id"],
        )
        return KnowledgeVersionResponse(**version)

    @app.get("/api/knowledge/sources/{source_id}/versions/{version_id}/markdown")
    def download_knowledge_markdown(source_id: str, version_id: str, request: Request) -> FileResponse:
        source = readable_source(source_id, request)
        version = next(
            (item for item in knowledge.list_versions(source_id) if item["id"] == version_id),
            None,
        )
        if version is None:
            raise HTTPException(status_code=404, detail="Knowledge version not found")
        for linked_source_id in version["source_ids"]:
            readable_source(linked_source_id, request)
        path = knowledge.version_path(source_id, version_id)
        if path is None:
            raise HTTPException(status_code=404, detail="Knowledge version not found")
        return FileResponse(
            path,
            media_type="text/markdown; charset=utf-8",
            filename=f"{Path(source['filename']).stem}.md",
        )

    @app.post("/api/projects", response_model=ProjectResponse, status_code=201)
    def create_project(project: ProjectCreate, request: Request) -> ProjectResponse:
        return ProjectResponse(**request.app.state.database.create_project(project.title))

    @app.get("/api/projects", response_model=list[ProjectResponse])
    def list_projects(request: Request) -> list[ProjectResponse]:
        return [ProjectResponse(**project) for project in request.app.state.database.list_projects()]

    @app.patch("/api/projects/{project_id}", response_model=ProjectResponse)
    def rename_project(project_id: str, update: ProjectUpdate, request: Request) -> ProjectResponse:
        project = request.app.state.database.rename_project(project_id, update.title)
        if project is None:
            raise HTTPException(status_code=404, detail="Project not found")
        return ProjectResponse(**project)

    @app.post("/api/conversations", response_model=ConversationResponse, status_code=201)
    def create_conversation(conversation: ConversationCreate, request: Request) -> ConversationResponse:
        created = request.app.state.database.create_conversation(conversation.title, conversation.project_id)
        if created is None:
            raise HTTPException(status_code=404, detail="Project not found")
        return ConversationResponse(**created)

    @app.get("/api/conversations", response_model=list[ConversationResponse])
    def list_conversations(request: Request, project_id: str | None = None) -> list[ConversationResponse]:
        return [
            ConversationResponse(**conversation)
            for conversation in request.app.state.database.list_conversations(project_id)
        ]

    @app.patch("/api/conversations/{conversation_id}", response_model=ConversationResponse)
    def set_conversation_project(
        conversation_id: str,
        update: ConversationProjectUpdate,
        request: Request,
    ) -> ConversationResponse:
        conversation = request.app.state.database.set_conversation_project(
            conversation_id,
            update.project_id,
        )
        if conversation is None:
            raise HTTPException(status_code=404, detail="Conversation or project not found")
        return ConversationResponse(**conversation)

    @app.post(
        "/api/conversation-submissions",
        response_model=InitialSubmissionResponse,
        status_code=201,
    )
    def create_conversation_submission(
        submission: InitialConversationSubmission,
        request: Request,
    ) -> InitialSubmissionResponse:
        ensure_submission_modules_available(submission.mode, current_user(request))
        try:
            result = request.app.state.database.create_conversation_submission(
                submission.title,
                submission.project_id,
                submission.mode,
                submission.content,
                str(submission.submission_key),
            )
        except SubmissionConflictError as error:
            raise HTTPException(status_code=409, detail="Submission key already used") from error
        if result is None:
            raise HTTPException(status_code=404, detail="Project not found")
        return InitialSubmissionResponse(**result)

    @app.post(
        "/api/conversations/{conversation_id}/submissions",
        response_model=SubmissionResponse,
        status_code=201,
    )
    def submit_conversation(
        conversation_id: str,
        submission: ConversationSubmission,
        request: Request,
    ) -> SubmissionResponse:
        ensure_submission_modules_available(submission.mode, current_user(request))
        try:
            result = request.app.state.database.submit_conversation(
                conversation_id,
                submission.mode,
                submission.content,
                str(submission.submission_key),
            )
        except SubmissionConflictError as error:
            raise HTTPException(status_code=409, detail="Submission key already used") from error
        if result is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        return SubmissionResponse(**result)

    @app.get(
        "/api/conversations/{conversation_id}/messages",
        response_model=list[MessageResponse],
    )
    def list_messages(conversation_id: str, request: Request) -> list[MessageResponse]:
        if request.app.state.database.get_conversation(conversation_id) is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        return [
            MessageResponse(**message)
            for message in request.app.state.database.list_messages(conversation_id)
        ]

    @app.get("/api/tasks", response_model=list[TaskResponse])
    def list_tasks(request: Request) -> list[TaskResponse]:
        return [TaskResponse(**task) for task in request.app.state.database.list_tasks()]

    @app.get("/api/tasks/{task_id}", response_model=TaskResponse)
    def get_task(task_id: str, request: Request) -> TaskResponse:
        task = request.app.state.database.get_task(task_id)
        if task is None:
            raise HTTPException(status_code=404, detail="Task not found")
        return TaskResponse(**task)

    app.include_router(create_procurement_router(procurement, authorization, runtime_settings))

    if static_root is not None:
        _mount_static_frontend(app, static_root)

    return app


def create_unready_app(static_dir: Path | None = None) -> FastAPI:
    app = FastAPI(title="Honghao AI API", version=API_VERSION)

    @app.get("/api/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        return HealthResponse(
            status="ok",
            service=SERVICE_NAME,
            api_version=API_VERSION,
            environment=None,
        )

    @app.get("/api/readiness", response_model=ReadinessResponse)
    def readiness() -> JSONResponse:
        response = ReadinessResponse(
            status="not_ready",
            checks={
                "data_directory": "failed",
                "database": "failed",
                "module_configuration": "failed",
                "schema_versions": "failed",
                "runtime_startup": "failed",
            },
        )
        return JSONResponse(status_code=503, content=response.model_dump())

    @app.api_route("/api/{api_path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
    def unavailable_api(api_path: str) -> JSONResponse:
        return JSONResponse(status_code=503, content={"detail": "Service not ready"})

    if static_dir is not None:
        _mount_static_frontend(app, static_dir.resolve())
    return app


def _mount_static_frontend(app: FastAPI, static_root: Path) -> None:
    index_path = static_root / "index.html"

    @app.get("/{frontend_path:path}", include_in_schema=False)
    def frontend(frontend_path: str) -> FileResponse:
        if frontend_path == "api" or frontend_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not found")
        candidate = (static_root / frontend_path).resolve()
        if candidate.is_relative_to(static_root) and candidate.is_file():
            return FileResponse(candidate)
        if not index_path.is_file():
            raise HTTPException(status_code=503, detail="Frontend build not available")
        return FileResponse(index_path)


def create_default_app() -> FastAPI:
    try:
        return create_app(Settings.from_environment())
    except (OSError, RuntimeError, ValueError):
        return create_unready_app()


app = create_default_app()
