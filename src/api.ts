import type { AccessLevel, AccessScope, ActivationReview, AdminModuleSetting, AdminModuleSettings, AuditEvent, Conversation, ConversationMessage, CurrentUser, ManagedUser, ModuleMode, ModuleStatus, Project, RuntimeEnvironment, Section, SensitiveFieldPolicy, TaskItem, WorkbenchStatus } from "./types";

export type ServiceHealth = {
  status: "ok";
  service: string;
  api_version: string;
  environment: RuntimeEnvironment | null;
};

export type ServiceConnection =
  | { state: "checking" }
  | { state: "online"; health: ServiceHealth }
  | { state: "offline" };

export async function fetchServiceHealth(signal?: AbortSignal): Promise<ServiceHealth> {
  const response = await fetch("/api/health", { signal });
  if (!response.ok) throw new Error(`Health request failed with ${response.status}`);

  const health = await response.json() as ServiceHealth;
  if (health.status !== "ok" || typeof health.api_version !== "string") {
    throw new Error("Health response is invalid");
  }
  const readiness = await fetch("/api/readiness", { signal });
  if (!readiness.ok) throw new Error(`Readiness request failed with ${readiness.status}`);
  return health;
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) throw new Error(`Request failed with ${response.status}`);
  return response.json() as Promise<T>;
}

export function fetchCurrentUser(signal?: AbortSignal): Promise<CurrentUser> {
  return fetchJson<CurrentUser>("/api/me", { signal });
}

export function login(username: string, password: string): Promise<CurrentUser> {
  return fetchJson<CurrentUser>("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
}

export async function logout(): Promise<void> {
  const response = await fetch("/api/logout", { method: "POST" });
  if (!response.ok) throw new Error(`Logout failed with ${response.status}`);
}

export function fetchProjects(signal?: AbortSignal): Promise<Project[]> {
  return fetchJson<Project[]>("/api/projects", { signal });
}

export function fetchConversations(signal?: AbortSignal): Promise<Conversation[]> {
  return fetchJson<Conversation[]>("/api/conversations", { signal });
}

export function fetchTasks(signal?: AbortSignal): Promise<TaskItem[]> {
  return fetchJson<TaskItem[]>("/api/tasks", { signal });
}

export function fetchWorkbenches(signal?: AbortSignal): Promise<WorkbenchStatus[]> {
  return fetchJson<WorkbenchStatus[]>("/api/workbenches", { signal });
}

export function fetchModules(signal?: AbortSignal): Promise<ModuleStatus[]> {
  return fetchJson<ModuleStatus[]>("/api/modules", { signal });
}

export function fetchAdminModuleSettings(): Promise<AdminModuleSettings> {
  return fetchJson<AdminModuleSettings>("/api/admin/module-settings");
}

export function updateAdminModuleSetting(
  moduleId: Section,
  mode: ModuleMode,
  reviews: ActivationReview[] = [],
): Promise<AdminModuleSetting> {
  return fetchJson<AdminModuleSetting>(`/api/admin/module-settings/${moduleId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode, reviews }),
  });
}

export function fetchUsers(): Promise<ManagedUser[]> {
  return fetchJson<ManagedUser[]>("/api/users");
}

export function createUser(input: {
  username: string;
  display_name: string;
  department: string | null;
  password: string;
  is_system_admin: boolean;
  scope_levels: Partial<Record<AccessScope, AccessLevel>>;
}): Promise<ManagedUser> {
  return fetchJson<ManagedUser>("/api/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function updateUser(userId: string, input: { is_active?: boolean; is_system_admin?: boolean; scope_levels?: Partial<Record<AccessScope, AccessLevel>> }): Promise<ManagedUser> {
  return fetchJson<ManagedUser>(`/api/users/${userId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function fetchSensitiveFields(): Promise<SensitiveFieldPolicy[]> {
  return fetchJson<SensitiveFieldPolicy[]>("/api/admin/fields");
}

export function createSensitiveField(
  input: Omit<SensitiveFieldPolicy, "id">,
): Promise<SensitiveFieldPolicy> {
  return fetchJson<SensitiveFieldPolicy>("/api/admin/fields", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function updateSensitiveField(
  fieldId: string,
  input: Pick<SensitiveFieldPolicy, "read_min_level" | "write_min_level" | "read_scope_ids" | "write_scope_ids">,
): Promise<SensitiveFieldPolicy> {
  return fetchJson<SensitiveFieldPolicy>(`/api/admin/fields/${fieldId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function fetchAuditEvents(): Promise<AuditEvent[]> {
  return fetchJson<AuditEvent[]>("/api/admin/audit-events");
}

export function fetchMessages(conversationId: string, signal?: AbortSignal): Promise<ConversationMessage[]> {
  return fetchJson<ConversationMessage[]>(`/api/conversations/${conversationId}/messages`, { signal });
}

export function createProject(title: string): Promise<Project> {
  return fetchJson<Project>("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
}

export function createConversation(
  title: string,
  projectId: string | null,
): Promise<Conversation> {
  return fetchJson<Conversation>("/api/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, project_id: projectId }),
  });
}

export function setConversationProject(
  conversationId: string,
  projectId: string | null,
): Promise<Conversation> {
  return fetchJson<Conversation>(`/api/conversations/${conversationId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: projectId }),
  });
}

export function submitConversation(
  conversationId: string,
  mode: "chat" | "work",
  content: string,
  submissionKey: string,
): Promise<{ message: ConversationMessage; task: TaskItem | null }> {
  return fetchJson(`/api/conversations/${conversationId}/submissions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode, content, submission_key: submissionKey }),
  });
}

export function createConversationSubmission(
  title: string,
  projectId: string | null,
  mode: "chat" | "work",
  content: string,
  submissionKey: string,
): Promise<{ conversation: Conversation; message: ConversationMessage; task: TaskItem | null }> {
  return fetchJson("/api/conversation-submissions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, project_id: projectId, mode, content, submission_key: submissionKey }),
  });
}
