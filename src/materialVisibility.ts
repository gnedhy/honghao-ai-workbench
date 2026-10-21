import type {ProcurementOverview} from "./types";

// Explicit status annotations only; missing prices and stock do not imply disuse.
const unusedAnnotation = /(?:^|[（(【\[])\s*(?:(?:此)?品号不用|不用|不再使用|停用|已停用|已停|作废|已作废|弃用|废弃|勿用)\s*(?:[）)】\]]|$)/;

export function isDailyMaterial(material: {code: string; name?: string}) {
  return !unusedAnnotation.test(material.code) && !unusedAnnotation.test(material.name ?? "");
}

export function dailyProcurementOverview(data: ProcurementOverview): ProcurementOverview {
  const materials = data.materials.filter(isDailyMaterial);
  return {...data, materials, metrics: {...data.metrics, material_count: data.read_page ? data.read_page.scope_total : materials.length}};
}
