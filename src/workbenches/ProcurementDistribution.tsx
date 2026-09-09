import { useEffect, useState } from "react";
import { Info } from "lucide-react";
import { fetchActivationGrants, fetchProcurementOverview, saveActivationGrant, saveDepartmentMaterials, type ActivationGrants } from "../api";
import type { ProcurementOverview } from "../types";
import styles from "./ProcurementWorkbench.module.css";

export function ProcurementDistribution({ onLocate }: { onLocate: (code: string) => void }) {
  const [data, setData] = useState<ProcurementOverview | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [ids, setIds] = useState<string[]>([]);
  const [originalIds, setOriginalIds] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const added = ids.filter(id => !originalIds.includes(id)).length;
  const removed = originalIds.filter(id => !ids.includes(id)).length;
  const dirty = editing && (added > 0 || removed > 0);
  const load = () => { setError(""); setData(null); return fetchProcurementOverview().then(setData).catch(e => setError(e.message)); };
  useEffect(() => { void load(); }, [selected]);
  useEffect(() => {
    if (!dirty && !busy) return;
    const leave = (event: Event) => { if (busy || !window.confirm("放弃尚未保存的部门范围调整？")) event.preventDefault(); };
    window.addEventListener("procurement-before-leave",leave);
    return () => window.removeEventListener("procurement-before-leave",leave);
  },[dirty,busy]);
  const group = data?.departments?.find(item => item.id === selected);
  const materials = data?.materials.filter(item => (editing || group?.material_ids.includes(item.id)) && `${item.code} ${item.name}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  return <section className={`${styles.section} ${styles.subpageSection}`}>
    <div className={`${styles.sectionHeading} ${styles.ledgerHeading}`}><div><h2>{group?.name ?? "数据分流"}</h2><p className={styles.sectionDescription}>{!data ? "正在读取价格版本" : data.batches[0] ? `最新价格版本 v${data.batches[0].version} · ${data.batches[0].price_date?.replaceAll("-", ".") ?? "日期未记录"}` : "尚无价格版本"}。启用后自动更新，草稿不影响部门价格。</p></div>{selected && <button className="secondary-button" disabled={busy} onClick={() => { if (!editing || window.confirm("放弃尚未保存的范围调整？")) { setEditing(false); setSelected(null); setQuery(""); } }}>返回部门列表</button>}</div>
    {error && <p role="alert" className={styles.error}>{error}<button onClick={() => void load()}>重试</button></p>}
    {!data ? !error && <p>正在读取价格版本…</p> : !selected ? <div className={styles.tableWrap}><table className={`${styles.table} ${styles.distributionTable}`}><thead><tr><th>部门</th><th>关联原料</th><th>价格状态</th><th>操作</th></tr></thead><tbody>{data.departments?.map(item => { const missing = Math.max(0, item.material_ids.length-item.priced); return <tr key={item.id}><td>{item.name}</td><td>{item.material_ids.length} 项</td><td><span className={missing ? styles.distributionMissing : styles.distributionStatus}>{!item.material_ids.length ? "未关联原料" : missing ? `待定价 ${missing} 项` : "已定价"}</span></td><td><div className={styles.distributionActions}><button className="secondary-button" onClick={() => setSelected(item.id)}>查看明细</button>{data.capabilities?.can_manage_catalog && <button className={styles.distributionAdjust} onClick={() => {setIds([...item.material_ids]); setOriginalIds([...item.material_ids]); setEditing(true); setSelected(item.id);}}>调整范围</button>}</div></td></tr>; })}</tbody></table>{!data.departments?.length && <p>尚未建立部门原料清单。</p>}</div> : group && <>
      <div className={`${styles.toolbar} ${styles.rangeToolbar}`}><label className={styles.searchField}><input aria-label="搜索部门原料" placeholder="搜索原料编号" value={query} onChange={e => setQuery(e.target.value)} /></label><span className={styles.rangeCount} aria-live="polite">{editing ? `已选 ${ids.length} 项 · 新增 ${added} · 移除 ${removed}` : `${group.material_ids.length} 项原料`}</span>{!editing && data.capabilities?.can_manage_catalog && <button className="secondary-button" disabled={busy} onClick={() => { setIds([...group.material_ids]); setOriginalIds([...group.material_ids]); setError(""); setEditing(true); }}>调整范围</button>}{editing && <div className={styles.rangeActions}><button className="secondary-button" disabled={busy || !dirty} onClick={() => { setIds([...originalIds]); setError(""); }}>重置选择</button><button className="secondary-button" disabled={busy} onClick={() => {setIds([...originalIds]); setEditing(false); setError(""); setQuery("");}}>取消编辑</button><button className="primary-button" disabled={busy || !dirty} onClick={async () => { setBusy(true); setError(""); try { setData(await saveDepartmentMaterials(group.id, ids)); setEditing(false); } catch(e) {setError((e as Error).message);} finally {setBusy(false);} }}>{busy ? "正在保存…" : "保存范围"}</button></div>}</div>
      {editing && <p className={styles.rangeHint}>仅调整部门原料范围<button type="button" aria-label="范围调整说明：不删除原料和历史，同一原料可关联多个部门" title="不删除原料和历史，同一原料可关联多个部门"><Info size={14} /></button></p>}
      <div className={styles.tableWrap}><table className={styles.table}><thead><tr>{editing && <th>选择</th>}<th>编号</th><th>单位</th><th>价格</th><th>来源日期</th>{!editing && <th>操作</th>}</tr></thead><tbody>{materials.map(item => <tr key={item.id}>{editing && <td><input className={styles.rangeCheckbox} type="checkbox" aria-label={`关联 ${item.code}`} checked={ids.includes(item.id)} disabled={busy} onChange={e => setIds(value => e.target.checked ? [...value,item.id] : value.filter(id => id!==item.id))} /></td>}<td><strong>{item.code}</strong></td><td>{item.unit}</td><td>{item.published_price == null ? "— 未定价" : `¥${item.published_price}`}</td><td>{item.published_price_date ?? "—"}</td>{!editing && <td><button className="secondary-button" onClick={() => onLocate(item.code)}>在总台账查看</button></td>}</tr>)}</tbody></table></div>
    </>}
  </section>;
}

export function ProcurementActivationGrants({ admin, onChanged }: { admin: boolean; onChanged: () => void }) {
  const [data,setData] = useState<ActivationGrants | null>(null);
  const [error,setError] = useState("");
  const [busy,setBusy] = useState(false);
  useEffect(() => { fetchActivationGrants().then(setData).catch(e => setError(e.message)); }, []);
  const save = async (id: string, enabled: boolean, manager?: boolean) => {setBusy(true); setError(""); try {setData(await saveActivationGrant(id,enabled,manager)); onChanged();} catch(e){setError((e as Error).message);} finally{setBusy(false);} };
  return <><p>启用权持续有效，直到撤销；获授权者不能转授权。撤销后，其未执行排期将暂停。</p>{error && <p role="alert" className={styles.error}>{error}</p>}{!data ? <p>正在读取授权…</p> : <><div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>人员</th><th>启用价格</th>{admin && <th>管理授权</th>}</tr></thead><tbody>{data.users.map(user => <tr key={user.id}><td>{user.name}{!user.eligible && <span>账号或价格写权限不可用</span>}</td><td><input type="checkbox" aria-label={`${user.name}启用权`} disabled={busy || (!user.eligible && !user.granted) || (!admin && user.manager)} checked={user.granted} onChange={e => void save(user.id,e.target.checked)} /></td>{admin && <td><input type="checkbox" aria-label={`${user.name}管理授权`} checked={user.manager} disabled={busy || !user.eligible} onChange={e => void save(user.id,true,e.target.checked)} /></td>}</tr>)}</tbody></table></div><h3>授权记录</h3><div className={styles.eventList}>{data.events.map(event => <div key={event.id}><strong>{event.actor} · {event.action === "grant.enabled" ? "授予启用权" : "撤销启用权"}</strong><small>{data.users.find(user => user.id===event.target_id)?.name ?? event.target_id} · {new Intl.DateTimeFormat("zh-CN",{timeZone:"Asia/Shanghai",dateStyle:"short",timeStyle:"short"}).format(new Date(event.created_at))}</small></div>)}</div></>}</>;
}
