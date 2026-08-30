export type Section = "chat" | "knowledge" | "automation" | "workbench" | "tasks";

export type ModuleVisibility = Record<Section, boolean>;

export type ModuleMode = "off" | "prototype" | "active";

export type RuntimeEnvironment = "test" | "production";

export type ModuleStatus = {
  id: Section;
  mode: ModuleMode;
};

export type AccessLevel = 2 | 3 | 4;

export type AccessScope = "management" | "procurement" | "research" | "sales" | "knowledge";

export type CurrentUser = {
  id: string;
  username: string;
  display_name: string;
  department: string | null;
  is_system_admin: boolean;
  scope_levels: Partial<Record<AccessScope, AccessLevel>>;
};

export type AdminModuleSetting = {
  id: Section;
  current_mode: ModuleMode;
  pending_mode: ModuleMode;
};

export type AdminModuleSettings = {
  environment: RuntimeEnvironment;
  modules: AdminModuleSetting[];
};

export type ActivationReview = "business" | "security" | "code";

export type ManagedUser = CurrentUser & {
  is_active: boolean;
};

export type SensitiveFieldPolicy = {
  id: string;
  area: string;
  name: string;
  description: string;
  read_min_level: AccessLevel;
  write_min_level: AccessLevel;
  read_scope_ids: AccessScope[];
  write_scope_ids: AccessScope[];
};

export type AuditEvent = {
  id: string;
  action: string;
  target_type: string;
  target_id: string;
  created_at: string;
  actor_name: string | null;
};

export type WorkbenchId = "management" | "procurement" | "research" | "sales";

export type WorkbenchMode = "prototype" | "active" | "off";

export type WorkbenchStatus = {
  id: WorkbenchId;
  mode: WorkbenchMode;
};

export type ConversationView = "new" | "existing";

export type WorkApproval = "pending" | "approved" | "rejected";

export type Project = {
  id: string;
  title: string;
};

export type Conversation = {
  id: string;
  title: string;
  project_id: string | null;
};

export type ConversationMessage = {
  id: string;
  conversation_id: string;
  mode: "chat" | "work";
  content: string;
  created_at: string;
  task_id: string | null;
  task_status: "created" | null;
};

export type KnowledgeItem = {
  title: string;
  scope: string;
  updated: string;
  tags: string[];
  project?: string;
};

export type SkillItem = {
  title: string;
  version: string;
  status: string;
  description: string;
  runs: number;
};

export type WorkflowItem = {
  title: string;
  version: string;
  status: string;
  description: string;
  runs: number;
  updated: string;
  owner: string;
  steps: string[];
};

export type TaskItem = {
  id: string;
  conversation_id: string;
  objective: string;
  project_id: string | null;
  status: "created";
  created_at: string;
  latest_run: string | null;
};
