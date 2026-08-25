import type { Conversation, ConversationMessage, ModuleStatus, Project, TaskItem, WorkbenchStatus } from "./types";

export type ServiceHealth = {
  status: "ok";
  service: string;
  api_version: string;
  schema_version: number;
};

export type ServiceConnection =
  | { state: "checking" }
  | { state: "online"; health: ServiceHealth }
  | { state: "offline" };

export async function fetchServiceHealth(signal?: AbortSignal): Promise<ServiceHealth> {
  const response = await fetch("/api/health", { signal });
  if (!response.ok) throw new Error(`Health request failed with ${response.status}`);

  const health = await response.json() as ServiceHealth;
  if (health.status !== "ok" || typeof health.schema_version !== "number") {
    throw new Error("Health response is invalid");
  }
  return health;
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) throw new Error(`Request failed with ${response.status}`);
  return response.json() as Promise<T>;
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
