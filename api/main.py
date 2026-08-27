from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Literal, cast
from uuid import UUID

from fastapi import FastAPI, File, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field, StringConstraints

from api.authorization import AuthorizationStore, PERMISSIONS, permission_for_request
from api.database import Database, SubmissionConflictError
from api.identity import DuplicateIdentityError, IdentityStore, SESSION_COOKIE_NAME
from api.knowledge import InvalidKnowledgeSourceError, KnowledgeStore
from api.modules import (
    MODULE_IDS,
    ModuleId,
    ModuleMode,
    RuntimeEnvironment,
    load_persisted_module_modes,
    module_for_api_path,
    save_persisted_module_modes,
)
from api.settings import Settings
from api.workbenches import WORKBENCH_IDS, WorkbenchId, WorkbenchMode


API_VERSION = "0.1.0"
SERVICE_NAME = "honghao-ai-api"


class HealthResponse(BaseModel):
    status: Literal["ok"]
    service: str
    api_version: str
    schema_version: int
    environment: RuntimeEnvironment


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


class AdminModuleSettingsResponse(BaseModel):
    environment: RuntimeEnvironment
    modules: list[AdminModuleStatusResponse]


class ModuleSettingUpdate(BaseModel):
    mode: ModuleMode
    reviews: list[Literal["business", "security", "code"]] = Field(default_factory=list)


class LoginRequest(BaseModel):
    username: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
    password: Annotated[str, StringConstraints(min_length=1, max_length=1_000)]


class RoleResponse(BaseModel):
    id: str
    name: str
    system: bool


class CurrentUserResponse(BaseModel):
    id: str
    username: str
    display_name: str
    department: str | None
    roles: list[RoleResponse]


class UserResponse(CurrentUserResponse):
    is_active: bool


class RoleCreate(BaseModel):
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]


class UserCreate(BaseModel):
    username: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100, pattern=r"^[A-Za-z0-9._-]+$")]
    display_name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
    department: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)] | None = None
    password: Annotated[str, StringConstraints(min_length=12, max_length=1_000)]
    role_ids: Annotated[list[str], Field(min_length=1)]


class UserUpdate(BaseModel):
    is_active: bool | None = None
    role_ids: Annotated[list[str], Field(min_length=1)] | None = None


class RolePermissionsUpdate(BaseModel):
    permission_ids: list[str]


class RolePermissionsResponse(BaseModel):
    role_id: str
    permission_ids: list[str]


class FieldPolicyUpdate(BaseModel):
    read_role_ids: list[str]
    write_role_ids: list[str]


class FieldPolicyResponse(BaseModel):
    id: str
    area: str
    name: str
    description: str
    read_role_ids: list[str]
    write_role_ids: list[str]


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
    status: Literal["quarantined", "parsed", "awaiting_ocr", "encrypted", "parse_failed"]
    failure_reason: str | None
    duplicate_of: str | None
    created_at: str
    read_role_ids: list[str]


class KnowledgeVersionResponse(BaseModel):
    id: str
    status: Literal["draft"]
    created_at: str
    source_ids: list[str]


def create_app(settings: Settings | None = None) -> FastAPI:
    runtime_settings = settings or Settings.from_environment()
    database = Database(runtime_settings.database_path)
    identities = IdentityStore(runtime_settings.database_path)
    authorization = AuthorizationStore(runtime_settings.database_path)
    knowledge = KnowledgeStore(runtime_settings.database_path, runtime_settings.data_dir)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        runtime_settings.ensure_directories()
        database.initialize()
        identities.initialize()
        authorization.initialize()
        knowledge.initialize()
        app.state.database = database
        app.state.identities = identities
        app.state.authorization = authorization
        app.state.knowledge = knowledge
        yield

    app = FastAPI(title="Honghao AI API", version=API_VERSION, lifespan=lifespan)

    def current_user(request: Request) -> dict:
        user = getattr(request.state, "current_user", None)
        if user is None:
            raise HTTPException(status_code=401, detail="Authentication required")
        return user

    def require_system_admin(request: Request) -> dict:
        user = current_user(request)
        if not any(role["id"] == "system-admin" for role in user["roles"]):
            raise HTTPException(status_code=403, detail="System administrator required")
        return user

    def ensure_submission_modules_available(mode: Literal["chat", "work"], user: dict) -> None:
        if mode != "work":
            return
        if runtime_settings.module_modes["tasks"] == "off":
            raise HTTPException(status_code=404, detail="Module not available")
        if not authorization.has_permission(
            [role["id"] for role in user["roles"]],
            "tasks.manage",
        ):
            raise HTTPException(status_code=403, detail="Permission denied")

    def readable_source(source_id: str, request: Request) -> dict:
        source = knowledge.get_source(source_id)
        if source is None:
            raise HTTPException(status_code=404, detail="Knowledge source not found")
        role_ids = [role["id"] for role in current_user(request)["roles"]]
        if "system-admin" not in role_ids and not set(role_ids) & set(source["read_role_ids"]):
            raise HTTPException(status_code=404, detail="Knowledge source not found")
        return source

    @app.middleware("http")
    async def guard_disabled_modules(request: Request, call_next):
        module_id = module_for_api_path(request.url.path)
        if module_id is not None and runtime_settings.module_modes[module_id] == "off":
            return JSONResponse(status_code=404, content={"detail": "Module not available"})
        if module_id is not None:
            user = getattr(request.state, "current_user", None)
            role_ids = [role["id"] for role in user["roles"]] if user else []
            if not authorization.has_permission(role_ids, permission_for_request(module_id, request.method)):
                return JSONResponse(status_code=403, content={"detail": "Permission denied"})
        return await call_next(request)

    @app.middleware("http")
    async def require_authentication(request: Request, call_next):
        if request.url.path.startswith("/api/") and request.url.path not in {"/api/health", "/api/login"}:
            token = request.cookies.get(SESSION_COOKIE_NAME)
            user = identities.user_for_session(token) if token else None
            if user is None:
                return JSONResponse(status_code=401, content={"detail": "Authentication required"})
            request.state.current_user = user
        return await call_next(request)

    @app.get("/api/health", response_model=HealthResponse)
    def health(request: Request) -> HealthResponse:
        return HealthResponse(
            status="ok",
            service=SERVICE_NAME,
            api_version=API_VERSION,
            schema_version=request.app.state.database.schema_version(),
            environment=runtime_settings.environment,
        )

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

    @app.post("/api/logout", status_code=204)
    def logout(request: Request, response: Response) -> None:
        token = request.cookies.get(SESSION_COOKIE_NAME)
        if token is None:
            raise HTTPException(status_code=401, detail="Authentication required")
        identities.logout(token)
        response.delete_cookie(SESSION_COOKIE_NAME, path="/api", httponly=True, samesite="strict")

    @app.get("/api/roles", response_model=list[RoleResponse])
    def list_roles(request: Request) -> list[RoleResponse]:
        require_system_admin(request)
        return [RoleResponse(**role) for role in identities.list_roles()]

    @app.post("/api/roles", response_model=RoleResponse, status_code=201)
    def create_role(role: RoleCreate, request: Request) -> RoleResponse:
        actor = require_system_admin(request)
        try:
            created = identities.create_role(role.name)
        except DuplicateIdentityError as error:
            raise HTTPException(status_code=409, detail="Role already exists") from error
        authorization.audit(
            "role.created",
            actor_user_id=actor["id"],
            target_type="role",
            target_id=created["id"],
        )
        return RoleResponse(**created)

    @app.post("/api/users", response_model=UserResponse, status_code=201)
    def create_user(user: UserCreate, request: Request) -> UserResponse:
        actor = require_system_admin(request)
        try:
            created = identities.create_user(
                username=user.username,
                display_name=user.display_name,
                department=user.department,
                password=user.password,
                role_ids=user.role_ids,
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
        if update.is_active is None and update.role_ids is None:
            raise HTTPException(status_code=422, detail="No account changes supplied")
        if user_id == actor["id"] and (
            update.is_active is False
            or (update.role_ids is not None and "system-admin" not in update.role_ids)
        ):
            raise HTTPException(status_code=422, detail="Cannot remove access from the current administrator")
        try:
            user = identities.update_user(
                user_id,
                is_active=update.is_active,
                role_ids=update.role_ids,
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

    @app.get("/api/admin/permissions")
    def list_permissions(request: Request) -> list[dict[str, str]]:
        require_system_admin(request)
        return [
            {"id": permission_id, "module_id": module_id, "name": name, "description": description}
            for permission_id, module_id, name, description in PERMISSIONS
        ]

    @app.get("/api/admin/role-permissions", response_model=list[RolePermissionsResponse])
    def list_role_permissions(request: Request) -> list[RolePermissionsResponse]:
        require_system_admin(request)
        all_permission_ids = [permission[0] for permission in PERMISSIONS]
        return [
            RolePermissionsResponse(
                role_id=role["id"],
                permission_ids=(
                    all_permission_ids
                    if role["id"] == "system-admin"
                    else authorization.permissions_for_role(role["id"])
                ),
            )
            for role in identities.list_roles()
        ]

    @app.put("/api/admin/roles/{role_id}/permissions", response_model=RolePermissionsResponse)
    def update_role_permissions(
        role_id: str,
        update: RolePermissionsUpdate,
        request: Request,
    ) -> RolePermissionsResponse:
        actor = require_system_admin(request)
        try:
            permission_ids = authorization.set_role_permissions(role_id, update.permission_ids)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        authorization.audit(
            "role.permissions.updated",
            actor_user_id=actor["id"],
            target_type="role",
            target_id=role_id,
        )
        return RolePermissionsResponse(role_id=role_id, permission_ids=permission_ids)

    @app.get("/api/admin/fields", response_model=list[FieldPolicyResponse])
    def list_field_policies(request: Request) -> list[FieldPolicyResponse]:
        require_system_admin(request)
        return [FieldPolicyResponse(**field) for field in authorization.list_field_policies()]

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
                update.read_role_ids,
                update.write_role_ids,
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
            and set(update.reviews) != {"business", "security", "code"}
        ):
            raise HTTPException(
                status_code=422,
                detail="Production activation requires business, security, and code reviews",
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
        )
        authorization.audit(
            "module.mode.pending",
            actor_user_id=actor["id"],
            target_type="module",
            target_id=typed_module_id,
        )
        return AdminModuleStatusResponse(
            id=typed_module_id,
            current_mode=runtime_settings.module_modes[typed_module_id],
            pending_mode=update.mode,
        )

    @app.get("/api/workbenches", response_model=list[WorkbenchStatusResponse])
    def list_workbenches() -> list[WorkbenchStatusResponse]:
        return [
            WorkbenchStatusResponse(id=workbench_id, mode=runtime_settings.workbench_modes[workbench_id])
            for workbench_id in WORKBENCH_IDS
        ]

    @app.get("/api/modules", response_model=list[ModuleStatusResponse])
    def list_modules(request: Request) -> list[ModuleStatusResponse]:
        user = current_user(request)
        role_ids = [role["id"] for role in user["roles"]]
        return [
            ModuleStatusResponse(id=module_id, mode=runtime_settings.module_modes[module_id])
            for module_id in MODULE_IDS
            if authorization.has_permission(role_ids, permission_for_request(module_id, "GET"))
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
                read_role_ids=[role["id"] for role in actor["roles"]],
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
        return [KnowledgeVersionResponse(**version) for version in knowledge.list_versions(source_id)]

    @app.get("/api/knowledge/sources/{source_id}/versions/{version_id}/markdown")
    def download_knowledge_markdown(source_id: str, version_id: str, request: Request) -> FileResponse:
        source = readable_source(source_id, request)
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

    return app


app = create_app()
