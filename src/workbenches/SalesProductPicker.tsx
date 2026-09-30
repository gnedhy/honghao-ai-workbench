import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Plus, Search } from "lucide-react";

import { WorkbenchOptionMenu } from "../components/WorkbenchMenus";
import type { Product } from "./salesModel";
import s from "./SalesProductPicker.module.css";

type Basis = "latest" | "inventory";
const basisLabel = (basis: Basis) => basis === "inventory" ? "库存优先" : "最新优先";
const amount = (value: string | null | undefined) => value == null ? "—" : Number(value).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function SalesProductPicker({ products, selected, basis, cost, add = false, excludeIds = [], onSelect }: {
  products: Product[];
  selected?: Product;
  basis?: Basis;
  cost?: string | null;
  add?: boolean;
  excludeIds?: string[];
  onSelect: (product: Product, basis: Basis) => void;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [department, setDepartment] = useState("");
  const departments = [...new Set(products.map(product => product.department))].filter(Boolean).sort((a, b) => a.localeCompare(b, "zh-CN"));
  const matches = products.filter(product => !excludeIds.includes(product.id) && (!department || product.department === department)
    && `${product.code} ${product.name} ${product.department}`.toLowerCase().includes(query.trim().toLowerCase()));
  const close = (focus = false) => {
    if (menu.current) menu.current.open = false;
    menu.current?.querySelector("details")?.removeAttribute("open");
    if (focus) menu.current?.querySelector("summary")?.focus();
  };
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);
  return <details ref={menu} className={`${s.picker} ${add ? s.addPicker : ""}`}
    onToggle={event => {
      if (event.target !== event.currentTarget) return;
      if (event.currentTarget.open) {
        setQuery("");
        setDepartment("");
        requestAnimationFrame(() => search.current?.focus());
      }
    }}
    onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) close();
    }}
    onKeyDown={event => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
      }
      if (menu.current?.open && (event.key === "ArrowDown" || event.key === "ArrowUp") && event.target instanceof HTMLButtonElement && event.target.matches("[data-cost-option]")) {
        const options = Array.from(menu.current.querySelectorAll<HTMLButtonElement>("button[data-cost-option]:not(:disabled)"));
        if (!options.length) return;
        event.preventDefault();
        const current = options.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "ArrowDown"
          ? Math.min(current + 1, options.length - 1)
          : current < 0 ? options.length - 1 : Math.max(current - 1, 0);
        options[next]?.focus();
      }
    }}>
    <summary aria-label={add ? "添加产品" : "选择产品及成本口径"}>
      {add ? <><Plus size={15} /><strong>添加产品</strong></> : <>
        <strong>{selected?.code ?? "选择产品"}</strong>
        {selected && <><span>{basisLabel(basis ?? "latest")}</span><b>{amount(cost)} <small>元/kg</small></b></>}
      </>}
      <ChevronDown size={14} />
    </summary>
    <div className={s.popover}>
      <div className={s.filters}>
        <label className={s.search}><Search size={14} /><input ref={search} type="search" aria-label="搜索产品" placeholder="搜索产品内编、名称或部门" value={query} onChange={event => setQuery(event.target.value)} /></label>
        <WorkbenchOptionMenu label="筛选部门" value={department} display={department || "全部部门"}
          options={["", ...departments].map(value => ({ value, label: value || "全部部门" }))}
          onSelect={setDepartment} className={s.departmentMenu} />
      </div>
      <div className={s.options}>
        {matches.map(product => <div className={s.option} key={product.id}>
          <div className={s.identity}><strong title={product.code}>{product.code}</strong>{product.name && product.name !== product.code && <small title={product.name}>{product.name}</small>}<small title={product.department}>{product.department}</small></div>
          {(["latest", "inventory"] as const).map(option => {
            const price = option === "latest" ? product.latest_cost : product.inventory_cost;
            const checked = selected?.id === product.id && basis === option;
            return <button key={option} data-cost-option type="button" disabled={price == null} aria-pressed={checked}
              aria-label={`${product.code} ${basisLabel(option)} ${price == null ? "暂无成本" : `${amount(price)} 元每千克`}`}
              onClick={() => { onSelect(product, option); close(true); }}>
              <span>{basisLabel(option)}</span><b>{amount(price)}</b>{checked && <Check size={12} />}
            </button>;
          })}
        </div>)}
        {!matches.length && <p role="status">{excludeIds.length && excludeIds.length === products.length ? "所有产品均已加入" : "没有匹配的产品"}</p>}
      </div>
    </div>
  </details>;
}
