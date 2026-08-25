from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated, Literal
from uuid import UUID

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, StringConstraints

from api.database import Database, SubmissionConflictError
from api.identity import DuplicateIdentityError, IdentityStore, SESSION_COOKIE_NAME
from api.modules import MODULE_IDS, ModuleId, ModuleMode, module_for_api_path
from api.settings import Settings
from api.workbenches import WORKBENCH_IDS, WorkbenchId, WorkbenchMode


API_VERSION = "0.1.0"
SERVICE_NAME = "honghao-ai-api"


class HealthResponse(BaseModel):
    status: Literal["ok"]
    service: str
    api_version: str
    schema_version: int


class WorkbenchStatusResponse(BaseModel):
    id: WorkbenchId
    mode: WorkbenchMode


class ModuleStatusResponse(BaseModel):
    id: ModuleId
    mode: ModuleMode


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


def create_app(settings: Settings | None = None) -> FastAPI:
    runtime_settings = settings or Settings.from_environment()
    database = Database(runtime_settings.database_path)
    identities = IdentityStore(runtime_settings.database_path)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        runtime_settings.ensure_directories()
        database.initialize()
        identities.initialize()
        app.state.database = database
        app.state.identities = identities
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

    def ensure_submission_modules_available(mode: Literal["chat", "work"]) -> None:
        if mode == "work" and runtime_settings.module_modes["tasks"] == "off":
            raise HTTPException(status_code=404, detail="Module not available")

    @app.middleware("http")
    async def guard_disabled_modules(request: Request, call_next):
        module_id = module_for_api_path(request.url.path)
        if module_id is not None and runtime_settings.module_modes[module_id] == "off":
            return JSONResponse(status_code=404, content={"detail": "Module not available"})
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
        )

    @app.post("/api/login", response_model=CurrentUserResponse)
    def login(credentials: LoginRequest, response: Response) -> CurrentUserResponse:
        authenticated = identities.login(
            credentials.username,
            credentials.password,
            runtime_settings.session_ttl_seconds,
        )
        if authenticated is None:
            raise HTTPException(status_code=401, detail="Invalid username or password")
        user, token = authenticated
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
        require_system_admin(request)
        try:
            return RoleResponse(**identities.create_role(role.name))
        except DuplicateIdentityError as error:
            raise HTTPException(status_code=409, detail="Role already exists") from error

    @app.post("/api/users", response_model=UserResponse, status_code=201)
    def create_user(user: UserCreate, request: Request) -> UserResponse:
        require_system_admin(request)
        try:
            return UserResponse(**identities.create_user(
                username=user.username,
                display_name=user.display_name,
                department=user.department,
                password=user.password,
                role_ids=user.role_ids,
            ))
        except DuplicateIdentityError as error:
            raise HTTPException(status_code=409, detail="User already exists") from error
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    @app.get("/api/users", response_model=list[UserResponse])
    def list_users(request: Request) -> list[UserResponse]:
        require_system_admin(request)
        return [UserResponse(**user) for user in identities.list_users()]

    @app.patch("/api/users/{user_id}", response_model=UserResponse)
    def update_user(user_id: str, update: UserUpdate, request: Request) -> UserResponse:
        require_system_admin(request)
        if update.is_active is None and update.role_ids is None:
            raise HTTPException(status_code=422, detail="No account changes supplied")
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
        return UserResponse(**user)

    @app.get("/api/workbenches", response_model=list[WorkbenchStatusResponse])
    def list_workbenches() -> list[WorkbenchStatusResponse]:
        return [
            WorkbenchStatusResponse(id=workbench_id, mode=runtime_settings.workbench_modes[workbench_id])
            for workbench_id in WORKBENCH_IDS
        ]

    @app.get("/api/modules", response_model=list[ModuleStatusResponse])
    def list_modules() -> list[ModuleStatusResponse]:
        return [
            ModuleStatusResponse(id=module_id, mode=runtime_settings.module_modes[module_id])
            for module_id in MODULE_IDS
        ]

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
        ensure_submission_modules_available(submission.mode)
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
        ensure_submission_modules_available(submission.mode)
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
