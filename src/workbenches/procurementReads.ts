import {fetchJson} from "../api";
import type {ProcurementMaterialDetail,ProcurementOverview} from "../types";
export function fetchProcurementMaterialCompact(id:string,signal?:AbortSignal) {
  return fetchJson<ProcurementMaterialDetail>(`/api/workbenches/procurement/materials/${encodeURIComponent(id)}?compact=true`,{signal});
}

export function fetchProcurementOverviewCompact(signal?:AbortSignal) {
  return fetchJson<ProcurementOverview>("/api/workbenches/procurement/overview?compact=true",{signal});
}

export function fetchProcurementSummary(signal?:AbortSignal) {return fetchJson<ProcurementOverview>("/api/workbenches/procurement/overview?read_mode=summary",{signal});}
