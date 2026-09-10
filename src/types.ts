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
  primary_department_id?: string | null;
  additional_department_ids?: string[];
  departments?: { id: string; name: string; is_primary: boolean }[];
  is_system_admin: boolean;
  scope_levels: Partial<Record<AccessScope, AccessLevel>>;
};

export type PersonalProfile = CurrentUser & {
  procurement_capabilities: { can_edit: boolean; can_activate: boolean; can_manage_grants: boolean };
};

export type AdminModuleSetting = {
  can_reactivate?: boolean;
  id: Section;
  current_mode: ModuleMode;
  pending_mode: ModuleMode;
};

export type AdminWorkbenchSetting = {
  can_reactivate?: boolean;
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

export type OrganizationDepartment = { id: string; name: string; parent_id: string | null };
export type DepartmentMembership = { primary_department_id: string | null; additional_department_ids: string[] };

export type AuditEvent = {
  id: string;
  action: string;
  target_type: string;
  target_id: string;
  created_at: string;
  actor_name: string | null;
};

export type WorkbenchId = "management" | "procurement" | "research" | "sales";

export type ProcurementPage = "dashboard" | "updates" | "materials" | "distribution" | "history" | "batches";

export const PROCUREMENT_PAGE_LABELS: Record<ProcurementPage, string> = {
  dashboard: "采购看板",
  updates: "原料台账",
  materials: "原料台账",
  distribution: "数据分流",
  history: "价格历史",
  batches: "价格历史",
};

export type WorkbenchMode = "prototype" | "active" | "off";

export type WorkbenchStatus = {
  id: WorkbenchId;
  mode: WorkbenchMode;
};

export type PriceModifier = { kind: "system" | "source" | "unknown"; name: string; id: string | null };

export type ProcurementMaterial = {
  price_modifier?: PriceModifier | null;
  source_purchasers?: string[];
  participants?: Array<{ id: string; name: string }>;
  round_participants?: Array<{ id: string; name: string }>;
  reported?: boolean;
  id: string;
  code: string;
  name: string;
  unit: string;
  latest_price?: string | null;
  previous_latest_price?: string | null;
  inventory_price?: string | null;
  in_transit_price?: string | null;
  suggested_price?: string | null;
  published_price?: string | null;
  previous_published_price?: string | null;
  published_price_date?: string | null;
  draft_price?: string | null;
  draft_change?: number | null;
  draft_status?: ProcurementUpdateStatus | null;
  price_date: string;
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
  review_reason?: string | null;
};

export type ProcurementBatch = {
  provenance?: { origin: string; filename: string; imported_at: string; imported_by: string; reported_count: number };
  published_by_name?: string | null;
  comparison?: { previous_version: number | null; up: number; down: number; unchanged: number; first: number; missing: number; incomparable?: number; items: Record<string, { previous: string | null; previous_raw?: string | null; change: number | null; kind: string }> };
  id: string;
  version: number;
  published_at: string;
  item_count: number;
  price_date?: string | null;
  activated_at?: string | null;
  source_name?: string | null;
  status?: "active" | "historical";
};

export type ProcurementBatchDetail = ProcurementBatch & {
  snapshot_sources?: Record<string, { price_date: string; raw_price: string | null; price_kind: string; sheet: string | null; cell: string | null }>;
  changes?: Array<{ id: string; status?: string; event: string; reason: string | null; created_at: string; actor: string; items?: Array<{ id: string; code: string; name: string; unit: string; before: string | null; after: string | null; before_recorded: boolean; before_basis?: "saved" | "published" | "unknown"; change: number | null }> }>;
  activation_mode?: "immediate" | "scheduled";
  submitted_by_name?: string | null;
  published_by_name?: string | null;
  items: Array<{
    material_id: string;
    code: string;
    name: string;
    unit: string;
    latest_price?: string | null;
    inventory_price?: string | null;
    in_transit_price?: string | null;
    recommended_price?: string | null;
  }>;
};

export type ProcurementUpdateStatus = "draft" | "returned" | "submitted" | "scheduled" | "revalidation_required" | "published" | "cancelled";

export type ProcurementUpdate = {
  changes?: ProcurementBatchDetail["changes"];
  id: string;
  price_date: string;
  source_name: string;
  status: ProcurementUpdateStatus;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  return_reason: string | null;
  activate_at: string | null;
  created_by_name: string;
  submitted_by_name: string | null;
  summary: { coverage_count: number; changed_count: number; unchanged_count: number; error_count: number; risk_count: number };
  items: Array<{ material_id: string; code: string; name: string; unit: string; published_price: string | null; draft_price: string | null; change: number | null; comparison_basis: "published" | "previous_inquiry" | "none" }>;
  input_items: ProcurementUpdate["items"];
  issues: ProcurementIssue[];
  events: Array<{ id: string; event: string; actor_name: string; reason: string | null; created_at: string }>;
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

export type ProcurementHistoryBatch = {
  id: string;
  effective_date: string;
  source_name: string;
  material_count: number;
  up_count: number;
  down_count: number;
  flat_count: number;
  missing_count: number;
  created_by: string;
  created_at: string;
};

export type ProcurementHistoryEntry = {
  id: string;
  material_id: string;
  material_code: string;
  material_name: string;
  unit: string;
  source_name: string;
  effective_date: string;
  created_at: string;
  created_by_name: string;
  latest_price?: string | null;
  previous_price?: string | null;
  inventory_price?: string | null;
  in_transit_price?: string | null;
  change?: number | null;
};

export type ProcurementHistoryBatchDetail = ProcurementHistoryBatch & {
  previous_date: string | null;
  items: ProcurementHistoryEntry[];
};

export type ProcurementMaterialDetail = {
  official_history: Array<{id: string; version: number; version_date: string; latest_price?: string | null; price_date: string | null; raw_price?: string | null; price_kind: string; sheet: string | null; cell: string | null; modifier?: PriceModifier | null}>;
  sources: Array<{sheet: string; row: number; purchaser: string | null; filename: string}>;
  changes?: ProcurementBatchDetail["changes"];
  material: { id: string; code: string; name: string; unit: string; archived: boolean; updated_at: string };
  latest_price?: string | null;
  previous_price?: string | null;
  change?: number | null;
  price_date: string | null;
  status: "active" | "missing";
  history: ProcurementHistoryEntry[];
  adjustments: Array<{ id: string; target_history_id: string | null; replacement_history_id: string; reason: string; created_by: string; created_at: string }>;
};

export type ProcurementPreferences = {
  ledger_columns: string[];
  history_view: "batches" | "materials";
  ledger_view: "scroll" | "paged";
  ledger_page_size: number;
};

export type ProcurementOverview = {
  editors?: Array<{ id: string; name: string }>;
  environment?: string;
  capabilities?: { can_edit: boolean; can_activate: boolean; can_manage_grants: boolean; can_cancel_round: boolean; can_manage_catalog: boolean };
  departments?: Array<{ id: string; name: string; material_ids: string[]; priced: number }>;
  metrics: {
    material_count: number;
    open_issue_count: number;
    missing_price_count: number;
    published_batch_count: number;
  };
  materials: ProcurementMaterial[];
  issues: ProcurementIssue[];
  batches: ProcurementBatch[];
  current_update: ProcurementUpdate | null;
  scheduled_update: ProcurementUpdate | null;
  next_action: string;
  working_state: {
    status: "draft" | "ready" | "submitted";
    submitted_by: string | null;
    submitted_at: string | null;
    submitted_by_name: string | null;
    latest_import: {
      id: string;
      source_name: string;
      effective_date: string;
      item_count: number;
      created_at: string;
      created_by_name: string;
    } | null;
  };
};

export type ProcurementImportPreview = {
  baseline_id: string | null;
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
    reference_price: string | null;
    change: number | null;
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
