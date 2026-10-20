const codeOrder = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export const compareCodes = codeOrder.compare;

export function trendEligibleIds(samples: {id:string;date:string;values:(string|number|null|undefined)[]}[], range:{start:string;end:string}) {
  const periods = new Map<string, Set<string>[]>(), eligible = new Set<string>();
  for (const sample of samples) {
    const day = sample.date.slice(0,10);
    if (day < range.start || day > range.end || eligible.has(sample.id)) continue;
    const series = periods.get(sample.id) ?? [];
    sample.values.forEach((value,index) => {
      if (value == null || String(value).trim() === "" || !Number.isFinite(Number(value))) return;
      (series[index] ??= new Set()).add(sample.date);
      if (series[index].size >= 2) eligible.add(sample.id);
    });
    periods.set(sample.id,series);
  }
  return eligible;
}

export function preferredTrendId(items:{id:string;code:string}[], eligible:ReadonlySet<string>) {
  return [...items].sort((a,b)=>Number(eligible.has(b.id))-Number(eligible.has(a.id)) || compareCodes(a.code,b.code))[0]?.id ?? "";
}
