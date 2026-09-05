import type { AccessLevel, AccessScope, ActivationReview, AdminModuleSetting, AdminModuleSettings, AdminWorkbenchSetting, AuditEvent, Conversation, ConversationMessage, CurrentUser, ManagedUser, ModuleMode, ModuleStatus, ProcurementBatch, ProcurementBatchDetail, ProcurementHistoryBatch, ProcurementHistoryBatchDetail, ProcurementImportPreview, ProcurementIssue, ProcurementMaterialDetail, ProcurementOverview, ProcurementPreferences, ProcurementPriceHistory, ProcurementUpdate, Project, RuntimeEnvironment, Section, SensitiveFieldPolicy, TaskItem, WorkbenchId, WorkbenchStatus } from "./types";

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
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { detail?: string } | null;
    throw new Error(payload?.detail ?? `Request failed with ${response.status}`);
  }
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

export function fetchProcurementOverview(signal?: AbortSignal): Promise<ProcurementOverview> {
  return fetchJson<ProcurementOverview>("/api/workbenches/procurement/overview", { signal });
}

export function fetchProcurementPriceHistory(signal?: AbortSignal): Promise<ProcurementPriceHistory[]> {
  return fetchJson<ProcurementPriceHistory[]>("/api/workbenches/procurement/price-history", { signal });
}

export function fetchProcurementHistoryBatches(signal?: AbortSignal): Promise<ProcurementHistoryBatch[]> {
  return fetchJson<ProcurementHistoryBatch[]>("/api/workbenches/procurement/history/batches", { signal });
}

export function fetchProcurementHistoryBatch(id: string, signal?: AbortSignal): Promise<ProcurementHistoryBatchDetail> {
  return fetchJson<ProcurementHistoryBatchDetail>(`/api/workbenches/procurement/history/batches/${id}`, { signal });
}

export function fetchProcurementBatch(id: string, signal?: AbortSignal): Promise<ProcurementBatchDetail> {
  return fetchJson<ProcurementBatchDetail>(`/api/workbenches/procurement/batches/${id}`, { signal });
}

export function fetchProcurementMaterial(id: string, signal?: AbortSignal): Promise<ProcurementMaterialDetail> {
  return fetchJson<ProcurementMaterialDetail>(`/api/workbenches/procurement/materials/${id}`, { signal });
}

export function adjustProcurementPrice(id: string, input: { price: string; effective_date: string; reason: string; target_history_id?: string | null }): Promise<void> {
  return fetchJson<void>(`/api/workbenches/procurement/materials/${id}/adjustments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function updateProcurementMaterial(id: string, input: { code: string; name: string }): Promise<ProcurementMaterialDetail> {
  return fetchJson<ProcurementMaterialDetail>(`/api/workbenches/procurement/materials/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function fetchProcurementPreferences(signal?: AbortSignal): Promise<ProcurementPreferences> {
  return fetchJson<ProcurementPreferences>("/api/workbenches/procurement/preferences", { signal });
}

export function saveProcurementPreferences(input: ProcurementPreferences): Promise<ProcurementPreferences> {
  return fetchJson<ProcurementPreferences>("/api/workbenches/procurement/preferences", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function previewProcurementImport(sourceName: string, effectiveDate: string, content: string): Promise<ProcurementImportPreview> {
  return fetchJson<ProcurementImportPreview>("/api/workbenches/procurement/import-preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source_name: sourceName, effective_date: effectiveDate, content }),
  });
}

export function confirmProcurementImport(sourceName: string, effectiveDate: string, content: string): Promise<void> {
  return fetchJson<void>("/api/workbenches/procurement/imports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source_name: sourceName, effective_date: effectiveDate, content }),
  });
}

export function reviewProcurementIssue(updateId: string, issueId: string, reason: string): Promise<ProcurementIssue> {
  return fetchJson<ProcurementIssue>(`/api/workbenches/procurement/updates/${updateId}/issues/${issueId}/review`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason }),
  });
}

export function submitProcurementUpdate(updateId: string): Promise<ProcurementUpdate> {
  return fetchJson<ProcurementUpdate>(`/api/workbenches/procurement/updates/${updateId}/submit`, { method: "POST" });
}

export function returnProcurementUpdate(updateId: string, reason: string): Promise<ProcurementUpdate> {
  return fetchJson<ProcurementUpdate>(`/api/workbenches/procurement/updates/${updateId}/return`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason }),
  });
}

export function publishProcurementUpdate(updateId: string, input: { mode: "immediate" | "scheduled"; activate_at?: string }): Promise<ProcurementBatch | ProcurementUpdate> {
  return fetchJson<ProcurementBatch | ProcurementUpdate>(`/api/workbenches/procurement/updates/${updateId}/publish`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
}

export function cancelProcurementSchedule(updateId: string, reason: string, copyToDraft = false): Promise<ProcurementUpdate & { copied_update?: ProcurementUpdate | null }> {
  return fetchJson<ProcurementUpdate & { copied_update?: ProcurementUpdate | null }>(`/api/workbenches/procurement/updates/${updateId}/cancel-schedule`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason, copy_to_draft: copyToDraft }),
  });
}

export function submitProcurementPrices(): Promise<void> {
  return fetchJson<void>("/api/workbenches/procurement/submit", { method: "POST" });
}

export function publishProcurementBatch(): Promise<ProcurementBatch> {
  return fetchJson<ProcurementBatch>("/api/workbenches/procurement/batches/publish", { method: "POST" });
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
  issueUrl?: string,
  pullRequestUrl?: string,
): Promise<AdminModuleSetting> {
  return fetchJson<AdminModuleSetting>(`/api/admin/module-settings/${moduleId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode, reviews, issue_url: issueUrl, pull_request_url: pullRequestUrl }),
  });
}

export function updateAdminWorkbenchSetting(
  workbenchId: WorkbenchId,
  mode: ModuleMode,
  reviews: ActivationReview[] = [],
  issueUrl?: string,
  pullRequestUrl?: string,
): Promise<AdminWorkbenchSetting> {
  return fetchJson<AdminWorkbenchSetting>(`/api/admin/workbench-settings/${workbenchId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode, reviews, issue_url: issueUrl, pull_request_url: pullRequestUrl }),
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
