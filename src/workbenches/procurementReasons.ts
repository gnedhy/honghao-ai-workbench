export const REVIEW_REASONS = ["已核对供应商报价", "市场行情波动", "采购数量或议价调整", "规格或质量调整", "运费或税费变化"];
export const PRICE_REASONS = ["供应商报价", "议价调整", "数据更正"];

export type ReasonSelection = { selected: string; custom: string };

export function resolveReason(value: ReasonSelection | undefined): string {
  const reason = (value?.selected === "other" ? value.custom : value?.selected ?? "").trim();
  return reason.length >= 4 && reason.length <= 200 ? reason : "";
}
