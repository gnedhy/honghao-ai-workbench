import { Switch } from "./Switch";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, Info } from "lucide-react";
import { DiscardChangesDialog, SettingsGroup } from "./Interaction";
import { fetchActivationGrants, saveActivationGrant, type ActivationGrants } from "../api";
import styles from "./WorkbenchSurface.module.css";
export function ProcurementActivationGrants({ admin, onChanged, scope = "procurement" }: { admin: boolean; onChanged: () => void; scope?: "procurement" | "research" }) {
  const [allOpen,setAllOpen] = useState(false);
  const [data,setData] = useState<ActivationGrants | null>(null);
  const [error,setError] = useState("");
  const [busy,setBusy] = useState(false);
  const [pending,setPending] = useState<{id:string;name:string;enabled:boolean;manager?:boolean} | null>(null);
  useEffect(() => { fetchActivationGrants(scope).then(setData).catch(e => setError(e.message)); }, [scope]);
  const save = async (id: string, enabled: boolean, manager?: boolean) => {setBusy(true); setError(""); try {setData(await saveActivationGrant(id,enabled,manager,scope)); window.dispatchEvent(new Event("activation-grants-changed")); onChanged(); setPending(null);} catch(e){setError((e as Error).message);} finally{setBusy(false);} };
  const action = pending?.manager === true ? "确认管理授权" : pending?.manager === false ? "取消管理授权" : pending?.enabled ? "确认授权" : "取消授权";
  return <><div hidden={allOpen}>{pending && <DiscardChangesDialog title={`${action}？`} description={<>{`即将${pending.manager === true ? "授予" : pending.manager === false || !pending.enabled ? "撤销" : "授予"}“${pending.name}”的${scope === "research" ? "研发成本" : "采购价格"}${pending.manager !== undefined ? "启用权分配资格" : "独立启用权"}。`}{pending.manager === false && "该人员的独立启用权继续保留。"}{!pending.enabled && "管理权限自带的启用权不受影响。"}{!pending.enabled && scope === "procurement" && "如因此失去启用权，未执行排期将暂停。"}{error && <span role="alert" className={styles.error}>{error}</span>}</>} cancelLabel="放弃操作" confirmLabel={busy ? "正在处理…" : action} intent={pending.enabled && pending.manager !== false ? "primary" : "danger"} disabled={busy} onCancel={() => {setPending(null);setError("");}} onDiscard={() => {if (!busy) void save(pending.id,pending.enabled,pending.manager);}}/>}{error && !pending && <p role="alert" className={styles.error}>{error}</p>}{!data ? <p>正在读取授权…</p> : <><div className={`${styles.tableWrap} ${styles.grantTable}`}><table className={styles.table}><thead><tr><th>人员</th><th><span className={styles.grantHeading}>权限状态<button className="access-policy-help" type="button" aria-label="查看启用授权说明"><Info size={14}/><span role="tooltip"><small>调整授权，确认后生效。</small><small>管理人员自带启用权。</small><small>额外授权不包含分配权限。</small></span></button></span></th><th>启用授权</th>{admin && <th>可分配启用权</th>}</tr></thead><tbody>{data.users.map(user => <tr key={user.id}><td><div className={styles.grantPerson}>{user.name}{user.manager && <span className={styles.grantBadge}>可分配授权</span>}</div>{!user.eligible && <small>账号已停用或无编辑权限</small>}</td><td><span className={styles.grantBadge} data-status={user.role_granted ? "management" : user.eligible && user.granted ? "granted" : !user.eligible && user.granted ? "invalid" : "none"}>{user.role_granted ? "管理权限" : !user.eligible ? (user.granted ? "已失效" : "不可授权") : user.granted ? "额外授权" : "未授权"}</span></td><td>{user.role_granted ? <span aria-label="管理权限无需额外授权">—</span> : <div className={styles.grantControl}><Switch type="button" role="switch" className="settings-mode-switch" aria-label={`${user.name}独立启用授权`} disabled={busy || (!user.eligible && !user.granted) || (!admin && user.manager)} aria-checked={user.granted} onClick={() => {setError("");setPending({id:user.id,name:user.name,enabled:!user.granted});}}><span/></Switch></div>}</td>{admin && <td><Switch type="button" role="switch" className="settings-mode-switch" aria-label={`${user.name}管理授权`} aria-checked={user.manager} disabled={busy || !user.eligible} onClick={() => {setError("");setPending({id:user.id,name:user.name,enabled:true,manager:!user.manager});}}><span/></Switch></td>}</tr>)}</tbody></table></div><SettingsGroup id={`${scope}-grant-records`} title="授权记录" description="" summary={`${data.total} 条`} defaultOpen>
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
