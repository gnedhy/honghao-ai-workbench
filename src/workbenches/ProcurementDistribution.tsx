import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Info, SlidersHorizontal } from "lucide-react";
import { DiscardChangesDialog, SettingsGroup } from "../components/SettingsDialog";
import { fetchActivationGrants, fetchProcurementOverview, saveActivationGrant, saveDepartmentMaterials, type ActivationGrants } from "../api";
import type { ProcurementOverview } from "../types";
import styles from "./ProcurementWorkbench.module.css";

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
  useEffect(() => {
    if (!dirty && !busy) return;
    const leave = (event: Event) => { if (busy || !window.confirm("放弃尚未保存的部门范围调整？")) event.preventDefault(); };
    window.addEventListener("procurement-before-leave",leave);
    return () => window.removeEventListener("procurement-before-leave",leave);
  },[dirty,busy]);
  const group = data?.departments?.find(item => item.id === selected);
  const returnToList = () => { setConfirmReturn(false); setEditing(false); setSelected(null); };
  return <section className={`${styles.section} ${selected ? styles.ledgerSection : styles.subpageSection}`}>
    {confirmReturn && <DiscardChangesDialog description="返回部门列表后，未保存的范围调整将不会保留。" onCancel={() => setConfirmReturn(false)} onDiscard={returnToList} />}
    <div className={`${styles.sectionHeading} ${styles.ledgerHeading}`}><div><div className={styles.ledgerTitle}><h2>{group?.name ?? "数据分流"}</h2>{group && <small>{group.material_ids.length} 项原料</small>}</div><p className={styles.sectionDescription}>{!data ? "正在读取价格版本" : data.batches[0] ? `最新价格版本 v${data.batches[0].version} · ${data.batches[0].price_date?.replaceAll("-", ".") ?? "日期未记录"}` : "尚无价格版本"}。启用后自动更新，草稿不影响部门价格。</p></div>{selected && <button className="secondary-button" disabled={busy} onClick={() => { if (dirty) setConfirmReturn(true); else returnToList(); }}>返回部门列表</button>}</div>
    {error && <p role="alert" className={styles.error}>{error}<button onClick={() => void load()}>重试</button></p>}
{!data ? !error && <p>正在读取价格版本…</p> : !selected ? <div className={styles.tableWrap}><table className={`${styles.table} ${styles.distributionTable}`}><thead><tr><th>部门</th><th>关联原料</th><th>价格状态</th><th>操作</th></tr></thead><tbody>{data.departments?.map(item => { const missing = Math.max(0, item.material_ids.length-item.priced); return <tr key={item.id}><td>{item.name}</td><td>{item.material_ids.length} 项</td><td><span className={missing ? styles.distributionMissing : styles.distributionStatus}>{!item.material_ids.length ? "未关联原料" : missing ? `待定价 ${missing} 项` : "已定价"}</span></td><td><div className={styles.distributionActions}><button className="secondary-button" onClick={() => setSelected(item.id)}>查看明细</button>{data.capabilities?.can_manage_catalog && <button className="secondary-button" onClick={() => {setIds([...item.material_ids]); setOriginalIds([...item.material_ids]); setEditing(true); setSelected(item.id);}}>调整范围</button>}</div></td></tr>; })}</tbody></table>{!data.departments?.length && <p>尚未建立部门原料清单。</p>}</div> : group && <>
      {renderLedger(data, {
        materialIds: editing ? undefined : group.material_ids,
        actions: editing ? <div className={styles.rangeActions}>
          <button className="secondary-button" disabled={busy || !dirty} onClick={() => { setIds([...originalIds]); setError(""); }}>重置选择</button>
          <button className="secondary-button" disabled={busy} onClick={() => { setIds([...originalIds]); setEditing(false); setError(""); }}>取消编辑</button>
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

export function ProcurementActivationGrants({ admin, onChanged, scope = "procurement" }: { admin: boolean; onChanged: () => void; scope?: "procurement" | "research" }) {
  const [allOpen,setAllOpen] = useState(false);
  const [data,setData] = useState<ActivationGrants | null>(null);
  const [error,setError] = useState("");
  const [busy,setBusy] = useState(false);
  const [pending,setPending] = useState<{id:string;name:string;enabled:boolean;manager?:boolean} | null>(null);
  useEffect(() => { fetchActivationGrants(scope).then(setData).catch(e => setError(e.message)); }, [scope]);
  const save = async (id: string, enabled: boolean, manager?: boolean) => {setBusy(true); setError(""); try {setData(await saveActivationGrant(id,enabled,manager,scope)); window.dispatchEvent(new Event("activation-grants-changed")); onChanged(); setPending(null);} catch(e){setError((e as Error).message);} finally{setBusy(false);} };
  const action = pending?.manager === true ? "确认管理授权" : pending?.manager === false ? "取消管理授权" : pending?.enabled ? "确认授权" : "取消授权";
  return <><div hidden={allOpen}>{pending && <DiscardChangesDialog title={`${action}？`} description={<>{`即将${pending.manager === true ? "授予" : pending.manager === false || !pending.enabled ? "撤销" : "授予"}“${pending.name}”的${scope === "research" ? "研发成本" : "采购价格"}${pending.manager !== undefined ? "启用权分配资格" : "独立启用权"}。`}{pending.manager === false && "该人员的独立启用权继续保留。"}{!pending.enabled && "管理权限自带的启用权不受影响。"}{!pending.enabled && scope === "procurement" && "如因此失去启用权，未执行排期将暂停。"}{error && <span role="alert" className={styles.error}>{error}</span>}</>} cancelLabel="放弃操作" confirmLabel={busy ? "正在处理…" : action} intent={pending.enabled && pending.manager !== false ? "primary" : "danger"} disabled={busy} onCancel={() => {setPending(null);setError("");}} onDiscard={() => {if (!busy) void save(pending.id,pending.enabled,pending.manager);}}/>}{error && !pending && <p role="alert" className={styles.error}>{error}</p>}{!data ? <p>正在读取授权…</p> : <><div className={`${styles.tableWrap} ${styles.grantTable}`}><table className={styles.table}><thead><tr><th>人员</th><th><span className={styles.grantHeading}>权限状态<button className="access-policy-help" type="button" aria-label="查看启用授权说明"><Info size={14}/><span role="tooltip"><small>调整授权，确认后生效。</small><small>管理人员自带启用权。</small><small>额外授权不包含分配权限。</small></span></button></span></th><th>启用授权</th>{admin && <th>可分配启用权</th>}</tr></thead><tbody>{data.users.map(user => <tr key={user.id}><td><div className={styles.grantPerson}>{user.name}{user.manager && <span className={styles.grantBadge}>可分配授权</span>}</div>{!user.eligible && <small>账号已停用或无编辑权限</small>}</td><td><span className={styles.grantBadge} data-status={user.role_granted ? "management" : user.eligible && user.granted ? "granted" : !user.eligible && user.granted ? "invalid" : "none"}>{user.role_granted ? "管理权限" : !user.eligible ? (user.granted ? "已失效" : "不可授权") : user.granted ? "额外授权" : "未授权"}</span></td><td>{user.role_granted ? <span aria-label="管理权限无需额外授权">—</span> : <div className={styles.grantControl}><button type="button" role="switch" className="settings-mode-switch" aria-label={`${user.name}独立启用授权`} disabled={busy || (!user.eligible && !user.granted) || (!admin && user.manager)} aria-checked={pending?.id === user.id ? pending.enabled : user.granted} onClick={() => {setError("");setPending({id:user.id,name:user.name,enabled:!user.granted});}}><span/></button></div>}</td>{admin && <td><button type="button" role="switch" className="settings-mode-switch" aria-label={`${user.name}管理授权`} aria-checked={pending?.id === user.id && pending.manager !== undefined ? pending.manager : user.manager} disabled={busy || !user.eligible} onClick={() => {setError("");setPending({id:user.id,name:user.name,enabled:true,manager:!user.manager});}}><span/></button></td>}</tr>)}</tbody></table></div><SettingsGroup id={`${scope}-grant-records`} title="授权记录" description="" summary={`${data.total} 条`} defaultOpen>
      <GrantEvents events={data.events}/>
      {data.has_more && <button type="button" className="secondary-button" onClick={() => setAllOpen(true)}>查看更多</button>}
    </SettingsGroup></>}</div>{allOpen && <GrantHistory scope={scope} onBack={() => setAllOpen(false)}/>}</>;
}

type GrantEvent = ActivationGrants["events"][number];
function grantEventText(event:GrantEvent) {
  const name=event.target_name || event.target_id;
  const change=event.action !== "grant.enabled" ? `撤销${name}启用权` : event.detail?.manager === true ? `授予${name}启用权分配资格` : event.detail?.manager === false ? `取消${name}启用权分配资格` : `授予${name}启用权`;
  return `${event.actor} · ${change}`;
}
function GrantEvents({events,timeOnly=false}:{events:GrantEvent[];timeOnly?:boolean}) {
  return events.length ? <div className={styles.grantEvents}>{events.map(event=><div key={event.id}><span>{grantEventText(event)}</span><time dateTime={event.created_at}>{new Intl.DateTimeFormat("zh-CN",{timeZone:"Asia/Shanghai",...(timeOnly ? {} : {dateStyle:"short" as const}),timeStyle:"short"}).format(new Date(event.created_at))}</time></div>)}</div> : <p>暂无授权记录</p>;
}
function GrantHistory({scope,onBack}:{scope:"procurement"|"research";onBack:()=>void}) {
  const section=useRef<HTMLElement>(null);
  useLayoutEffect(()=>{section.current?.scrollIntoView({block:"start"});},[]);
  const [events,setEvents]=useState<GrantEvent[]>([]);
  const [more,setMore]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const load=async(offset:number)=>{setBusy(true);setError("");try{const result=await fetchActivationGrants(scope,offset,50);setEvents(previous=>offset ? [...previous,...result.events] : result.events);setMore(result.has_more);}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  useEffect(()=>{void load(0);},[scope]);
  const groups=new Map<string,GrantEvent[]>();
  for(const event of events){const date=new Intl.DateTimeFormat("zh-CN",{timeZone:"Asia/Shanghai",dateStyle:"long"}).format(new Date(event.created_at));groups.set(date,[...(groups.get(date)??[]),event]);}
  return <section ref={section} aria-label="全部授权记录"><button type="button" className="secondary-button" onClick={onBack}><ArrowLeft size={14}/>返回授权设置</button><h3>全部授权记录</h3>
    {error && <p role="alert">{error}<button className="secondary-button" onClick={()=>void load(events.length)}>重试</button></p>}
    {!busy && !error && !events.length && <p>暂无授权记录</p>}
    <ol className="settings-timeline">{[...groups].map(([date,rows])=><li key={date}><div className="changelog-date">{date}</div><div className="settings-timeline-content"><GrantEvents events={rows} timeOnly/></div></li>)}</ol>
    {busy ? <p role="status">正在读取授权记录…</p> : more && !error && <button type="button" className="secondary-button" onClick={()=>void load(events.length)}>加载更早记录</button>}
  </section>;
}
