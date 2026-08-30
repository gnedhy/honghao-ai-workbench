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

export type AdminWorkbenchSetting = {
  id: WorkbenchId;
  current_mode: WorkbenchMode;
  pending_mode: WorkbenchMode;
};

export type AdminModuleSettings = {
  environment: RuntimeEnvironment;
  modules: AdminModuleSetting[];
  workbenches: AdminWorkbenchSetting[];
};

export type ActivationReview = "business" | "security" | "code" | "rollback";

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

export type ProcurementMaterial = {
  id: string;
  code: string;
  name: string;
  unit: string;
  latest_price?: string | null;
  inventory_price?: string | null;
  in_transit_price?: string | null;
  suggested_price?: string | null;
  updated_at: string;
};

export type ProcurementIssue = {
  id: string;
  material_id: string;
  material_code: string;
  material_name: string;
  kind: "missing_price" | "price_spike";
  label: string;
  status: "open" | "reviewed" | "resolved";
  created_at: string;
  reviewed_at: string | null;
};

export type ProcurementBatch = {
  id: string;
  version: number;
  published_at: string;
  item_count: number;
};

export type ProcurementPriceHistory = {
  id: string;
  material_code: string;
  material_name: string;
  unit: string;
  source_name: string;
  latest_price?: string | null;
  inventory_price?: string | null;
  in_transit_price?: string | null;
  recorded_at: string;
};

export type ProcurementOverview = {
  metrics: {
    material_count: number;
    open_issue_count: number;
    missing_price_count: number;
    published_batch_count: number;
  };
  materials: ProcurementMaterial[];
  issues: ProcurementIssue[];
  batches: ProcurementBatch[];
  working_state: {
    status: "draft" | "ready" | "submitted";
    submitted_by: string | null;
    submitted_at: string | null;
  };
};

export type ProcurementImportPreview = {
  received_count: number;
  importable_count: number;
  skipped_count: number;
  rows: Array<{
    code: string;
    name: string;
    unit: string;
    latest_price: string | null;
    inventory_price: string | null;
    in_transit_price: string | null;
    suggested_price: string | null;
    issues: string[];
    importable: boolean;
  }>;
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
