type PriceMaterial = {
  code: string;
  latest_price?: string | null;
  previous_latest_price?: string | null;
};

type PriceHistoryItem = {
  material_code: string;
  latest_price?: string | null;
  recorded_at: string;
};

type PriceRecord = {
  latest_price?: string | null;
};

export function buildPriceMovement(materials: PriceMaterial[]) {
  const counts = { rising: 0, falling: 0, stable: 0, unavailable: 0 };
  const ranked: Array<{ code: string; changePercent: number }> = [];

  for (const material of materials) {
    const current = toNumber(material.latest_price);
    const previous = toNumber(material.previous_latest_price);
    if (current === null || previous === null || (previous === 0 && current !== 0)) {
      counts.unavailable += 1;
      continue;
    }
    if (current === previous) {
      counts.stable += 1;
      continue;
    }
    const changePercent = Number((((current - previous) / previous) * 100).toFixed(2));
    counts[changePercent > 0 ? "rising" : "falling"] += 1;
    ranked.push({ code: material.code, changePercent });
  }

  ranked.sort((left, right) => Math.abs(right.changePercent) - Math.abs(left.changePercent));
  return { counts, ranked };
}

export function buildPriceTrend(history: PriceHistoryItem[], materialCode: string) {
  return history
    .filter((item) => item.material_code === materialCode)
    .map((item) => ({ recordedAt: item.recorded_at, value: toNumber(item.latest_price) }))
    .filter((item): item is { recordedAt: string; value: number } => item.value !== null)
    .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));
}

export function countValidPrices(history: PriceRecord[]) {
  return history.filter((item) => toNumber(item.latest_price) !== null).length;
}

function toNumber(value?: string | null) {
  if (value == null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
