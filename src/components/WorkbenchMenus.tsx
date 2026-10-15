import {EmptyState} from "./WorkbenchLayout";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {List,  CalendarDays, Check, ChevronRight, Search, Trash2 } from "lucide-react";
import styles from "./WorkbenchSurface.module.css";

export function positionWorkbenchDisplayMenu(menu: HTMLDetailsElement) {
  if (!menu.open) return;
  const popup = menu.querySelector<HTMLElement>(":scope > div");
  const summary = menu.querySelector("summary");
  if (!popup || !summary) return;
  menu.dataset.openUp = "false";
  popup.style.maxHeight = "";
  let boundary = menu.parentElement;
  while (boundary && boundary !== document.body && !/(auto|scroll|hidden|clip)/.test(getComputedStyle(boundary).overflowY)) boundary = boundary.parentElement;
  const bounds = boundary?.getBoundingClientRect();
  const top = Math.max(12, (bounds?.top ?? 0) + 8);
  const bottom = Math.min(window.innerHeight - 12, (bounds?.bottom ?? window.innerHeight) - 8);
  const anchor = summary.getBoundingClientRect();
  const below = bottom - popup.getBoundingClientRect().top, above = anchor.top - top - 4;
  const openUp = popup.scrollHeight > below && above > below;
  menu.dataset.openUp = String(openUp);
  popup.style.maxHeight = `${Math.max(0, openUp ? above : below)}px`;
  popup.style.overflowY = "auto";
  popup.scrollTop = 0;
  const fields = popup.querySelector<HTMLElement>(`.${styles.columnGrid}`);
  if (fields) fields.scrollTop = 0;
}

export function TrendMaterialMenu({ materials, selected, onSelect, label = "趋势原料", placeholder = "搜索原料编号" }: { materials: { id: string; code: string }[]; selected: string; onSelect: (code: string) => void; label?: string; placeholder?: string }) {
  const menu = useRef<HTMLDetailsElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const matches = materials.filter(item => item.code.toLowerCase().includes(query.trim().toLowerCase()));
  const close = (focus = false) => { if (menu.current) menu.current.open = false; if (focus) menu.current?.querySelector("summary")?.focus({preventScroll:true}); };
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
        {!matches.length && <EmptyState compact icon={Search} title="没有匹配的原料"/>}
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
  const close = (focus = false) => { if (menu.current) menu.current.open = false; if (focus) menu.current?.querySelector("summary")?.focus({preventScroll:true}); };
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) close(); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);
  const apply = (value: typeof period) => { onChange(value); close(true); };
  return <details ref={menu} className={`${styles.columnMenu} ${styles.filterMenu} ${styles.moverDateMenu}`} onToggle={event => { if (event.currentTarget.open) {
    setCustom(typeof period !== "string"); setStart(range.start); setEnd(range.end);
    const panel = event.currentTarget.querySelector<HTMLDivElement>(":scope > div");
    if (panel) {
      panel.style.transform = "";
      const bounds = panel.getBoundingClientRect();
      const left = Math.max(8, Math.min(bounds.left, window.innerWidth - bounds.width - 8));
      panel.style.transform = `translateX(${left - bounds.left}px)`;
    }
  } }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) close(); }} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); } }}>
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

export function WorkbenchOptionMenu({ label, value, options, onSelect, onDelete, display, header, className = "", side }: {
  label: string;
  value: string;
  options: { value: string; label: string; disabled?: boolean; title?: string; icon?:ReactNode }[];
  onSelect: (value: string) => void;
  onDelete?: (value: string) => void;
  display?: ReactNode;
  header?: ReactNode;
  className?: string;
  side?: 'right';
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  const [openUp, setOpenUp] = useState(false);
  const close = () => { if (menu.current) menu.current.open = false; menu.current?.querySelector("summary")?.focus({preventScroll:true}); };
  useEffect(()=>{
    if(!side)return;
    const dismiss=(event:Event)=>{if(menu.current?.querySelector(':scope > div')?.matches(':popover-open')&&(!(event.target instanceof Node)||!menu.current.contains(event.target)))menu.current.open=false;};
    document.addEventListener('scroll',dismiss,true);window.addEventListener('resize',dismiss);
    return()=>{document.removeEventListener('scroll',dismiss,true);window.removeEventListener('resize',dismiss);};
  },[side]);
  return <details ref={menu} className={`${styles.columnMenu} ${styles.personMenu} ${className}`} data-open-up={openUp}
    onToggle={event => {
      if(side){
        const panel=event.currentTarget.querySelector<HTMLDivElement>(':scope > div');
        if(!event.currentTarget.open){panel?.hidePopover();return;}
        const anchor=event.currentTarget.querySelector('summary')?.getBoundingClientRect();
        if(!panel||!anchor)return;
        panel.showPopover();const bounds=panel.getBoundingClientRect();
        panel.style.left=`${Math.max(8,Math.min(anchor.left+6,window.innerWidth-bounds.width-8))}px`;
        panel.style.top=`${Math.max(8,anchor.bottom+bounds.height+12<=window.innerHeight?anchor.bottom+4:anchor.top-bounds.height-4)}px`;
        return;
      }
      if (!event.currentTarget.open) return;
      const summary = event.currentTarget.querySelector("summary")?.getBoundingClientRect();
      const list = event.currentTarget.querySelector(":scope > div")?.getBoundingClientRect();
      if (!summary || !list) return;
      let boundary = event.currentTarget.parentElement;
      while (boundary && boundary !== document.body && !/(auto|scroll|hidden|clip)/.test(getComputedStyle(boundary).overflowY)) boundary = boundary.parentElement;
      const top = Math.max(0, boundary?.getBoundingClientRect().top ?? 0);
      const bottom = Math.min(window.innerHeight, boundary?.getBoundingClientRect().bottom ?? window.innerHeight);
      const above = summary.top - top;
      const below = bottom - summary.bottom;
      setOpenUp(below < list.height + 4 && above > below);
    }}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false; }}
    onKeyDown={event => {
      if (event.key === "Escape" && menu.current?.open) { event.preventDefault(); event.stopPropagation(); close(); }
      if (!menu.current?.open || !["ArrowDown", "ArrowUp"].includes(event.key)) return;
      event.preventDefault();
      const buttons = Array.from(menu.current.querySelectorAll<HTMLButtonElement>("button[data-option]:not(:disabled)"));
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "ArrowDown" ? (index + 1) % buttons.length : (index < 0 ? buttons.length : index) - 1;
      buttons[next]?.focus({preventScroll:true});
    }}>
    <summary aria-label={label}><span>{display ?? options.find(option => option.value === value)?.label ?? "请选择"}</span><ChevronRight size={13} /></summary>
    <div popover={side?'auto':undefined} onToggle={side?event=>{event.stopPropagation();if(!event.currentTarget.matches(':popover-open')&&menu.current)menu.current.open=false;}:undefined}>{header}{options.length ? options.map(option => {
      const choose = <button type="button" key={option.value} data-option disabled={option.disabled} title={option.title}
        aria-pressed={value === option.value} onClick={() => { onSelect(option.value); close(); }}>
        {option.icon?<span className="workbench-option-label">{option.icon}{option.label}</span>:option.label}{value === option.value && <Check size={14} />}</button>;
      return onDelete ? <div className={styles.optionRow} key={option.value}>{choose}
        <button type="button" className={styles.optionDelete} aria-label={`删除“${option.label}”`}
          onClick={() => { close(); onDelete(option.value); }}><Trash2 size={14} /></button></div>
        : choose;
    })
      : <EmptyState compact icon={List} title="暂无可选项"/>}</div>
  </details>;
}
