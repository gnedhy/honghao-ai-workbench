import { useEffect, useState, type ReactNode } from "react";
import { Info, SlidersHorizontal } from "lucide-react";
import { DiscardChangesDialog, useUnsavedChanges } from "../components/Interaction";
import { fetchProcurementOverview, saveDepartmentMaterials } from "../api";
import type { ProcurementOverview } from "../types";
import styles from "../components/WorkbenchSurface.module.css";

export type DepartmentLedger = {
  materialIds?: string[];
  actions: ReactNode;
  notice: ReactNode;
  selection?: { ids: string[]; disabled: boolean; toggle: (id: string, checked: boolean) => void };
};

export function ProcurementDistribution({ renderLedger, revision }: { renderLedger: (data: ProcurementOverview, department: DepartmentLedger) => ReactNode; revision: number }) {
  const [data, setData] = useState<ProcurementOverview | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmReturn, setConfirmReturn] = useState(false);
  const [ids, setIds] = useState<string[]>([]);
  const [originalIds, setOriginalIds] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const added = ids.filter(id => !originalIds.includes(id)).length;
  const removed = originalIds.filter(id => !ids.includes(id)).length;
  const dirty = editing && (added > 0 || removed > 0);
  const load = () => { setError(""); setData(null); return fetchProcurementOverview().then(setData).catch(e => setError(e.message)); };
  useEffect(() => { void load(); }, [selected]);
  useEffect(() => { if (revision) void fetchProcurementOverview().then(setData).catch(e => setError(e.message)); }, [revision]);
  const unsaved = useUnsavedChanges(dirty, busy, "尚未保存的部门范围调整将被放弃。", "procurement-before-leave");
  const group = data?.departments?.find(item => item.id === selected);
  const returnToList = () => { setConfirmReturn(false); setEditing(false); setSelected(null); };
  return <section className={`${styles.section} ${selected ? styles.ledgerSection : styles.subpageSection}`}>
    {unsaved.confirmation}
    {confirmReturn && <DiscardChangesDialog description="返回部门列表后，未保存的范围调整将不会保留。" onCancel={() => setConfirmReturn(false)} onDiscard={returnToList} />}
    <div className={`${styles.sectionHeading} ${styles.ledgerHeading}`}><div><div className={styles.ledgerTitle}><h2>{group?.name ?? "数据分流"}</h2>{group && <small>{group.material_ids.length} 项原料</small>}</div><p className={styles.sectionDescription}>{!data ? "正在读取价格版本" : data.batches[0] ? `最新价格版本 v${data.batches[0].version} · ${data.batches[0].price_date?.replaceAll("-", ".") ?? "日期未记录"}` : "尚无价格版本"}。启用后自动更新，草稿不影响部门价格。</p></div>{selected && <button className="secondary-button" disabled={busy} onClick={() => { if (dirty) setConfirmReturn(true); else returnToList(); }}>返回部门列表</button>}</div>
    {error && <p role="alert" className={styles.error}>{error}<button onClick={() => void load()}>重试</button></p>}
{!data ? !error && <p>正在读取价格版本…</p> : !selected ? <div className={styles.tableWrap}><table className={`${styles.table} ${styles.distributionTable}`}><thead><tr><th>部门</th><th>关联原料</th><th>价格状态</th><th>操作</th></tr></thead><tbody>{data.departments?.map(item => { const missing = Math.max(0, item.material_ids.length-item.priced); return <tr key={item.id}><td>{item.name}</td><td>{item.material_ids.length} 项</td><td><span className={missing ? styles.distributionMissing : styles.distributionStatus}>{!item.material_ids.length ? "未关联原料" : missing ? `待定价 ${missing} 项` : "已定价"}</span></td><td><div className={styles.distributionActions}><button className="secondary-button" onClick={() => setSelected(item.id)}>查看明细</button>{data.capabilities?.can_manage_catalog && <button className="secondary-button" onClick={() => {setIds([...item.material_ids]); setOriginalIds([...item.material_ids]); setEditing(true); setSelected(item.id);}}>调整范围</button>}</div></td></tr>; })}</tbody></table>{!data.departments?.length && <p>尚未建立部门原料清单。</p>}</div> : group && <>
      {renderLedger(data, {
        materialIds: editing ? undefined : group.material_ids,
        actions: editing ? <div className={styles.rangeActions}>
          <button className="secondary-button" disabled={busy || !dirty} onClick={() => { setIds([...originalIds]); setError(""); }}>重置选择</button>
          <button className="secondary-button" disabled={busy} onClick={async () => { if (await unsaved.request()) { setIds([...originalIds]); setEditing(false); setError(""); } }}>取消编辑</button>
          <button className="primary-button" disabled={busy || !dirty} onClick={async () => {
            setBusy(true); setError("");
            try { setData(await saveDepartmentMaterials(group.id, ids)); setEditing(false); }
            catch(e) { setError((e as Error).message); }
            finally { setBusy(false); }
          }}>{busy ? "正在保存…" : "保存范围"}</button>
        </div> : data.capabilities?.can_manage_catalog && <div className={styles.rangeActions}><button className="secondary-button" onClick={() => {
          setIds([...group.material_ids]); setOriginalIds([...group.material_ids]); setError(""); setEditing(true);
        }}><SlidersHorizontal size={14} />调整范围</button></div>,
        notice: editing && <div className={styles.rangeSelectionBar}>
          <span aria-live="polite">已选 {ids.length} 项 · 新增 {added} · 移除 {removed}</span>
          <span>从全部原料中勾选，跨页选择会保留<button type="button" className={styles.comparisonInfo} aria-label="范围调整说明：不删除原料和历史，同一原料可关联多个部门" title="不删除原料和历史，同一原料可关联多个部门"><Info size={14} /></button></span>
        </div>,
        selection: editing ? { ids, disabled: busy, toggle: (id, checked) => setIds(value => checked ? [...new Set([...value, id])] : value.filter(item => item !== id)) } : undefined,
      })}
    </>}
  </section>;
}
