import s from "./WorkbenchSurface.module.css";
export function FilterSummary({items,count,onClear}: {items:string[];count:number;onClear:()=>void}) {
  const active=items.filter(Boolean);
  return active.length ? <div className={s.filterTags} aria-label="当前筛选"><span>筛选结果 {count} 项</span>{active.map(item=><span key={item}>{item}</span>)}<button type="button" className={s.clearFilters} onClick={onClear}>清除筛选</button></div> : null;
}
