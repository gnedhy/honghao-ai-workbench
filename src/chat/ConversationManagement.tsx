import {lazy,Suspense,useEffect,useRef,useState} from 'react';
import {ArrowLeft,Archive,RefreshCw,Search,Trash2,Undo2} from 'lucide-react';
import {fetchMessages,type ConversationUpdate} from '../api';
import type {Conversation,ConversationMessage,Project} from '../types';
import {DiscardChangesDialog} from '../components/Interaction';
import {EmptyState, PageState} from '../components/WorkbenchLayout';

const MessageBody=lazy(()=>import('./MessageBody'));
export type ConversationManagementProps={
  ownerId:string;conversations:Conversation[];projects:Project[];state:'loading'|'ready'|'error';
  onUpdate:(row:Conversation,changes:ConversationUpdate)=>Promise<boolean>;
  onDelete:(row:Conversation)=>Promise<boolean>;
  onRetry:()=>Promise<void>;onAccessLost:(error:unknown)=>boolean;onBusy:(value:boolean)=>void;
};

export function ConversationManagement({ownerId,conversations,projects,state,onUpdate,onDelete,onRetry,onAccessLost,onBusy}:ConversationManagementProps){
  const [query,setQuery]=useState('');const [selected,setSelected]=useState<string|null>(null);
  const [deleting,setDeleting]=useState<string|null>(null);const [saving,setSaving]=useState(false);
  const busy=useRef(false);const heading=useRef<HTMLHeadingElement>(null);
  const [error,setError]=useState('');const [notice,setNotice]=useState('');
  const [messages,setMessages]=useState<ConversationMessage[]>([]);
  const [readState,setReadState]=useState<'loading'|'ready'|'error'>('ready');
  const [readRevision,setReadRevision]=useState(0);
  const rows=[...conversations].reverse().filter(row=>row.archived);
  const visible=rows.filter(row=>row.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const current=rows.find(row=>row.id===selected);
  const previewMessages=messages.filter(message=>message.conversation_id===selected);
  const projectName=(row:Conversation)=>projects.find(project=>project.id===row.project_id)?.title??'未关联项目';
  useEffect(()=>{heading.current?.closest('article')?.scrollTo({top:0});heading.current?.focus({preventScroll:true});},[selected]);
  useEffect(()=>{
    if(!selected)return;
    const controller=new AbortController();setMessages(values=>values.filter(message=>message.conversation_id===selected));setReadState('loading');
    void fetchMessages(selected,controller.signal,ownerId).then(values=>{
      if(!controller.signal.aborted){setMessages(values);setReadState('ready');}
    }).catch(reason=>{if(!controller.signal.aborted){if(onAccessLost(reason))setMessages([]);setReadState('error');}});
    return()=>controller.abort();
  },[selected,ownerId,readRevision,onAccessLost]);
  const back=()=>setSelected(null);
  const change=async(row:Conversation,permanent=false)=>{
    if(busy.current)return;busy.current=true;setSaving(true);onBusy(true);setError('');setNotice('');
    try{
      if(await (permanent?onDelete(row):onUpdate(row,{archived:false}))){
        setDeleting(null);back();setNotice(permanent?'会话已永久删除。':'已恢复，会话已回到侧栏。');
      }
    }catch{setDeleting(null);setError('操作结果未确认，已重新读取列表，请核对后重试。运行中的会话需先停止。');}
    finally{busy.current=false;setSaving(false);onBusy(false);}
  };
  const actions=(row:Conversation)=><div className="conversation-management__actions">
    {row.owner_id===ownerId?<>
      <button className="icon-button" type="button" disabled={saving} title="恢复会话" aria-label="恢复会话" onClick={()=>void change(row)}><Undo2 size={15}/></button>
      <button className="icon-button" type="button" disabled={saving} title="删除会话" aria-label="删除会话" onClick={()=>setDeleting(row.id)}><Trash2 size={15}/></button>
    </>:<span className="conversation-management__meta">只读</span>}
  </div>;
  return <section className="admin-settings-section conversation-management" aria-label="会话管理">
    <div className="admin-section-heading"><div><h2 ref={heading} tabIndex={-1}>会话管理</h2><p>查看或恢复归档会话，也可永久删除。</p></div></div>
    <div className="audit-toolbar">
      {!current&&<label className="search-field search-field--short"><Search size={15}/><input aria-label="搜索会话名称" placeholder="搜索会话名称" value={query} disabled={saving} onChange={event=>setQuery(event.target.value)}/></label>}
      <span className="audit-filter-count">{current?'只读预览':`${visible.length} 个会话`}</span>
      <button className="icon-button" type="button" aria-label="刷新会话列表" title="刷新" disabled={saving||state==='loading'} onClick={()=>void onRetry().catch(()=>{})}><RefreshCw size={15}/></button>
    </div>
    {error&&<PageState error className="settings-state is-error">{error}</PageState>}
    {state==='loading'&&!conversations.length&&<PageState className="settings-state">正在读取会话…</PageState>}
    {state==='error'&&<PageState error className="settings-state is-error" onRetry={()=>void onRetry().catch(()=>{})}>会话列表读取失败，请重试。</PageState>}
    {current?<>
      <div className="conversation-management__preview-heading"><button className="icon-button" type="button" aria-label="返回会话列表" disabled={saving} onClick={back}><ArrowLeft size={16}/></button><h3>{current.title}</h3>{actions(current)}</div>
      <p className="conversation-management__meta">{current.mode==='work'?'工作':'聊天'} · {projectName(current)} · 只读预览</p>
      <div className="audit-list" tabIndex={0} role="region" aria-label="会话内容预览" aria-busy={readState==='loading'}>
        {readState==='loading'&&!previewMessages.length&&<PageState className="settings-state">正在读取会话内容…</PageState>}
        {readState==='error'&&<PageState error className="settings-state is-error" onRetry={()=>setReadRevision(value=>value+1)}>内容读取失败，请重试。</PageState>}
        {readState==='ready'&&!previewMessages.length&&<EmptyState icon={Archive} className="settings-state" title="暂无会话内容"/>}
        <Suspense fallback={<PageState className="settings-state">正在准备预览…</PageState>}>{previewMessages.map(message=><div className="conversation-management__message" key={message.id}><strong className="conversation-management__meta">{message.role==='assistant'?'回复':message.role==='tool'?'信息':'你'}</strong><MessageBody content={message.content}/></div>)}</Suspense>
      </div>
    </>:<>
      <div className="audit-list conversation-management__list" tabIndex={0} role="region" aria-label="归档会话列表">{visible.map(row=><div className="audit-row conversation-management__row" key={row.id}><span className="audit-row__icon"><Archive size={14}/></span><button type="button" disabled={saving} title={row.title} aria-label={`查看会话：${row.title}`} onClick={()=>{setMessages([]);setReadState('loading');setSelected(row.id);setNotice('');setError('');}}><strong>{row.title}</strong><p>{row.mode==='work'?'工作':'聊天'} · {projectName(row)}</p></button>{actions(row)}</div>)}
        {state==='ready'&&!visible.length&&<EmptyState icon={query?Search:Archive} className="settings-state" title={query?'没有匹配的会话':'暂无已归档会话'}/>}
      </div>
    </>}
    {notice&&<p className="audit-footer" role="status">{notice}</p>}
    {deleting&&<DiscardChangesDialog title="永久删除会话？" description={<>将永久删除“{conversations.find(row=>row.id===deleting)?.title}”的全部消息、关联任务和运行记录，无法恢复。该会话尚未发送的内容也会清除。</>} cancelLabel="取消" confirmLabel="永久删除" disabled={saving} onCancel={()=>setDeleting(null)} onDiscard={()=>{const row=conversations.find(row=>row.id===deleting);if(row)void change(row,true);}}/>}
  </section>;
}
