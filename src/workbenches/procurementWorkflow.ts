import type { ProcurementPage, ProcurementUpdate } from "../types";

export function defaultProcurementPage(update: ProcurementUpdate | null): ProcurementPage {
  return update ? "updates" : "dashboard";
}

export function procurementWorkflowStage(update: ProcurementUpdate | null) {
  if (!update || update.summary.error_count) return 1;
  if (update.status === "scheduled" || !update.summary.risk_count) return 3;
  return 2;
}
