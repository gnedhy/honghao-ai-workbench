import type { ProcurementPage, ProcurementUpdate } from "../types";

export function defaultProcurementPage(update: ProcurementUpdate | null): ProcurementPage {
  return update ? "materials" : "dashboard";
}
