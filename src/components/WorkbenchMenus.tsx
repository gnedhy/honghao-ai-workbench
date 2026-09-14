import { useEffect, useRef, useState } from "react";
import { CalendarDays, Check, ChevronRight, Search } from "lucide-react";
import styles from "./WorkbenchSurface.module.css";

export function TrendMaterialMenu({ materials, selected, onSelect, label = "趋势原料", placeholder = "搜索原料编号" }: { materials: { id: string; code: string }[]; selected: string; onSelect: (code: string) => void; label?: string; placeholder?: string }) {
  const menu = useRef<HTMLDetailsElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const matches = materials.filter(item => item.code.toLowerCase().includes(query.trim().toLowerCase()));
  const close = (focus = false) => { if (menu.current) menu.current.open = false; if (focus) menu.current?.querySelector("summary")?.focus(); };
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) close(); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);
  return <details ref={menu} className={`${styles.columnMenu} ${styles.personMenu} ${styles.trendMaterialMenu}`} onToggle={event => { if (event.currentTarget.open) { setQuery(""); search.current?.focus(); } }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) close(); }} onKeyDown={event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
    if (menu.current?.open && ["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      const options = Array.from(menu.current.querySelectorAll<HTMLButtonElement>("button[data-material-option]"));
      const index = options.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "ArrowDown" ? Math.min(index + 1, options.length - 1) : index < 0 ? options.length - 1 : index - 1;
      if (next < 0) search.current?.focus(); else options[next]?.focus();
    }
  }}>
    <summary aria-label={`选择${label}`}><span>{selected || "选择原料"}</span><ChevronRight size={14} /></summary>
    <div>
      <label className={styles.trendMaterialSearch}><Search size={14} /><input ref={search} aria-label={`搜索${label}`} placeholder={placeholder} value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div className={`${styles.filterGroup} ${styles.trendMaterialOptions}`}>
        {matches.map(item => <button key={item.id} data-material-option type="button" aria-pressed={selected === item.code} onClick={event => { event.preventDefault(); onSelect(item.code); close(true); }}>{item.code}{selected === item.code && <Check size={14} />}</button>)}
        {!matches.length && <p role="status">没有匹配的原料</p>}
      </div>
    </div>
  </details>;
}

export function PriceDateRangeMenu({ period, range, onChange, label = "排行日期范围" }: {
  label?: string;
  period: "14d" | "1m" | "3m" | { start: string; end: string };
  range: { start: string; end: string };
  onChange: (value: "14d" | "1m" | "3m" | { start: string; end: string }) => void;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  const [custom, setCustom] = useState(false);
  const [start, setStart] = useState(range.start);
  const [end, setEnd] = useState(range.end);
  const labels = { "14d": "最近14天", "1m": "近一个月", "3m": "近三个月" };
  const close = (focus = false) => { if (menu.current) menu.current.open = false; if (focus) menu.current?.querySelector("summary")?.focus(); };
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) close(); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);
  const apply = (value: typeof period) => { onChange(value); close(true); };
  return <details ref={menu} className={`${styles.columnMenu} ${styles.filterMenu} ${styles.moverDateMenu}`} onToggle={event => { if (event.currentTarget.open) { setCustom(typeof period !== "string"); setStart(range.start); setEnd(range.end); } }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) close(); }} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); } }}>
    <summary aria-label={label} title={`${range.start} — ${range.end}`}><CalendarDays size={14} /><span>{typeof period === "string" ? labels[period] : "自定义日期"}</span><ChevronRight size={13} className={styles.moverDateChevron} /></summary>
    <div><div className={styles.filterGroup}>
      {(["14d", "1m", "3m"] as const).map(value => <button type="button" key={value} aria-pressed={period === value} onClick={event => { event.preventDefault(); apply(value); }}>{labels[value]}{period === value && <Check size={14} />}</button>)}
      <button type="button" aria-expanded={custom} onClick={() => setCustom(true)}>自定义范围{typeof period !== "string" && <Check size={14} />}</button>
    </div>
    {custom && <form className={styles.moverDateForm} onSubmit={event => { event.preventDefault(); if (start && end && start < end) apply({ start, end }); }}>
      <label>开始日期<input type="date" required value={start} max={end || undefined} onInput={event => setStart(event.currentTarget.value)} onChange={event => setStart(event.target.value)} /></label>
      <label>结束日期<input type="date" required value={end} min={start || undefined} onInput={event => setEnd(event.currentTarget.value)} onChange={event => setEnd(event.target.value)} /></label>
      {start && end && start >= end && <small role="alert">结束日期须晚于开始日期</small>}
      <button className="primary-button" type="submit" disabled={!start || !end || start >= end}>应用</button>
    </form>}
    </div>
  </details>;
}
