import {lazy,Suspense,useEffect,useRef,useState} from 'react';
import {BookOpen,Brain,ChevronRight,FileText,Pencil,Trash2} from 'lucide-react';
import {fetchPersonalization,updatePersonalization,fetchPersonalMemories,clearPersonalMemories,fetchProjectInstructions,updateProjectInstructions} from '../api';
import type {PersonalizationSettings,PersonalMemory,ProjectInstructions} from '../types';
import {Drawer} from '../components/Drawer';
import {DiscardChangesDialog,useUnsavedChanges} from '../components/Interaction';
import {Switch} from '../components/Switch';
import {EmptyState, PageState} from '../components/WorkbenchLayout';
import './Personalization.css';

const MessageBody=lazy(()=>import('../chat/MessageBody'));
const failureText=(error:unknown)=>{
  if(error instanceof Error&&(error instanceof TypeError||/Failed to fetch|NetworkError|Network request failed|Load failed/i.test(error.message)))return '暂时无法连接服务，输入已保留，请稍后重试。';
  return error instanceof Error?error.message:'操作未完成，请重试。';
};
const denied=(error:unknown)=>[401,403].includes((error as {status?:number})?.status??0);
const dateText=(value:string|null)=>value?new Date(value).toLocaleString('zh-CN',{dateStyle:'medium',timeStyle:'short'}):'尚未保存';
type TextRecord={content:string;revision:number;updated_at:string|null};

function TextEditor({title,description,initial,required=false,allowUnchanged=false,maxLength=16000,markdown=false,onSave,onReload,onClose,onRestore}:{title:string;description:string;initial:TextRecord;required?:boolean;allowUnchanged?:boolean;maxLength?:number;markdown?:boolean;onSave:(value:string,revision:number)=>Promise<TextRecord>;onReload:()=>Promise<TextRecord>;onClose:()=>void;onRestore?:()=>Promise<void>}){
  const [baseline,setBaseline]=useState(initial);const [draft,setDraft]=useState(initial.content);
  const [busy,setBusy]=useState(false);const writing=useRef(false);const [error,setError]=useState('');const [blocked,setBlocked]=useState(false);const [conflict,setConflict]=useState(false);const [restore,setRestore]=useState(false);
  const [saved,setSaved]=useState(false);const [latest,setLatest]=useState<string|null>(null);
  const [editing,setEditing]=useState(!markdown);const editButton=useRef<HTMLButtonElement>(null);const editorInput=useRef<HTMLTextAreaElement>(null);
  useEffect(()=>{if(!markdown)return;if(editing)editorInput.current?.focus();else editButton.current?.focus();},[editing,markdown]);
  const dirty=draft!==baseline.content;
  const leave=useUnsavedChanges(dirty,busy,'本次编辑尚未保存，放弃后将恢复已保存内容。','workbench-before-leave');
  const save=async()=>{if(writing.current||blocked||conflict||draft.length>maxLength||(required&&!draft.trim()))return;writing.current=true;setBusy(true);setError('');try{const value=await onSave(draft,baseline.revision);setBaseline(value);setDraft(value.content);setSaved(true);setLatest(null);if(markdown)setEditing(false);}catch(error){setBlocked(denied(error));setConflict((error as {status?:number}).status===409);setError(failureText(error));}finally{writing.current=false;setBusy(false);}};
  return <Drawer title={title} className={`personalization-editor${markdown?' personalization-instructions settings-dialog settings-dialog--admin':''}`} bodyClassName="personalization-editor__body" onClose={onClose} beforeClose={leave.request} busy={busy} closeLabel={`关闭${title}`}>
    <div className="personalization-editor__intro"><p className="personalization-help">{description}</p></div>
    <div className="personalization-editor__content">
    {markdown&&!editing?<><div className="personalization-reader__toolbar"><span>AGENTS.md</span><button ref={editButton} type="button" className="secondary-button" disabled={busy||blocked} onClick={()=>setEditing(true)}><Pencil size={14}/>编辑{title}</button></div><div className="personalization-reader" role="region" aria-label={`${title} Markdown 内容`} tabIndex={0}>{baseline.content.trim()?<Suspense fallback={<PageState>正在显示指令…</PageState>}><MessageBody content={baseline.content} pending/></Suspense>:<EmptyState icon={FileText} title={`尚未设置${title}`}>点击编辑，添加规则、流程和偏好。</EmptyState>}</div></>:<label className="personalization-editor__field"><span>{title}内容</span><textarea ref={editorInput} aria-label={`${title}内容`}  value={draft} disabled={busy||blocked} maxLength={maxLength} placeholder={title==='编辑记忆'?'更正这条参考信息…':'写下 AI 应遵循的规则、工作流程、操作边界和个人偏好…'} onChange={event=>setDraft(event.target.value)}/></label>}
    {(error||latest!==null)&&<div className="personalization-editor__notice">
    {error&&<PageState error>{error}{conflict&&<><p>其他窗口已更新，当前输入已保留。重新读取最新版本后，核对下方内容再保存。</p><button type="button" className="secondary-button" disabled={busy} onClick={async()=>{setBusy(true);try{const current=await onReload();setBaseline(current);setLatest(current.content);setConflict(false);setError('已读取最新版本；当前输入保留，请核对后保存。');}catch(reason){setBlocked(denied(reason));setError(failureText(reason));}finally{setBusy(false);}}}>读取最新版本</button></>}</PageState>}
    {latest!==null&&<section aria-label="最新已保存内容"><strong>最新已保存内容</strong><pre className="personalization-baseline">{latest||"（空）"}</pre></section>}
    </div>}
    </div>
    <div className="personalization-editor__dock">
    <div className="personalization-editor__status" role="status"><span>{dirty?'有未保存修改':allowUnchanged&&!saved?'当前使用个人指令，保存后改为项目专用':baseline.updated_at?`已保存 · ${dateText(baseline.updated_at)}`:'尚未保存'}</span>{editing&&<span>{draft.length.toLocaleString()} / {maxLength.toLocaleString()} 字符</span>}</div>
    <footer className="personalization-editor__footer">{onRestore&&<button type="button" className="secondary-button" disabled={busy||blocked||conflict} onClick={()=>setRestore(true)}>恢复使用个人指令</button>}<span/><button type="button" className="secondary-button" disabled={busy} onClick={async()=>{if(!await leave.request())return;if(markdown&&editing){setDraft(baseline.content);setEditing(false);setError('');setLatest(null);setConflict(false);}else onClose();}}>{markdown&&!editing?'返回':'取消'}</button>{editing&&<button type="button" className="primary-button" disabled={busy||blocked||conflict||draft.length>maxLength||(!dirty&&(!allowUnchanged||saved))||(required&&!draft.trim())} onClick={()=>void save()}>{busy?'正在保存…':'保存'}</button>}</footer>
    </div>
    {leave.confirmation}
    {restore&&onRestore&&<DiscardChangesDialog title="恢复使用个人指令？" description="项目专用指令及本次未保存编辑将被移除，下一轮工作开始使用个人指令。" confirmLabel="恢复使用" cancelLabel="取消" intent="primary" disabled={busy} onCancel={()=>setRestore(false)} onDiscard={async()=>{if(writing.current)return;writing.current=true;setBusy(true);try{await onRestore();onClose();}catch(reason){setError(failureText(reason));setBlocked(denied(reason));setConflict((reason as {status?:number}).status===409);setRestore(false);}finally{writing.current=false;setBusy(false);}}}/>}
  </Drawer>;
}

export function PersonalizationSettingsPanel({ownerId,onBusy}:{ownerId:string;onBusy:(value:boolean)=>void}){
  const [settings,setSettings]=useState<PersonalizationSettings|null>(null);const [error,setError]=useState('');const [blocked,setBlocked]=useState(false);const [reload,setReload]=useState(0);
  const [busy,setBusy]=useState(false);const writing=useRef(false);const [editor,setEditor]=useState(false);const [memories,setMemories]=useState(false);const [clear,setClear]=useState(false);
  useEffect(()=>{const controller=new AbortController();void fetchPersonalization(controller.signal,ownerId).then(value=>{if(!controller.signal.aborted){setSettings(value);setError('');setBlocked(false);}}).catch(reason=>{if(!controller.signal.aborted){setError(failureText(reason));setBlocked(denied(reason));}});return()=>controller.abort();},[reload,ownerId]);
  const change=async(action:()=>Promise<void>)=>{if(writing.current)return;writing.current=true;setBusy(true);onBusy(true);setError('');try{await action();}catch(reason){setClear(false);setError(failureText(reason));setBlocked(denied(reason));}finally{writing.current=false;setBusy(false);onBusy(false);}};
  useUnsavedChanges(false,busy,'正在保存设置，请稍候。','workbench-before-leave');
  const record=(value:PersonalizationSettings):TextRecord=>({content:value.instructions,revision:value.revision,updated_at:value.updated_at});
  return <section className="admin-settings-section personalization" aria-label="个性化"><h2>个性化</h2>
    {error&&<PageState error>{error}{!blocked&&<button className="secondary-button" type="button" disabled={busy} onClick={()=>setReload(value=>value+1)}>重新读取</button>}</PageState>}
    {!settings&&!error&&<PageState>正在读取个性化设置…</PageState>}
    {settings&&<><section><h3>记忆</h3><p className="personalization-help">保存对你有用的信息，在以后的对话中参考；记忆不会覆盖你的指令。</p><div className="personalization-card">
      <div className="personalization-row"><span className="module-setting-row__icon" aria-hidden="true"><Brain size={16}/></span><div><strong>启用个人记忆</strong><p>在聊天和工作中参考已保存的信息，并在后台整理新的记忆。</p></div><Switch aria-label="启用个人记忆" aria-checked={settings.memory_enabled} disabled={busy||blocked} onClick={()=>void change(async()=>setSettings(await updatePersonalization({revision:settings.revision,memory_enabled:!settings.memory_enabled},ownerId)))} /></div>
      <button className="personalization-row personalization-entry" type="button" disabled={busy||blocked} onClick={()=>setMemories(true)}><span className="module-setting-row__icon" aria-hidden="true"><BookOpen size={16}/></span><span><strong>查看记忆</strong><small>{settings.memory_count?'查看记忆摘要和详细内容':'暂无个人记忆 · 查看说明'}</small></span><ChevronRight size={16}/></button>
      <div className="personalization-row"><span className="module-setting-row__icon" aria-hidden="true"><Trash2 size={16}/></span><div><strong>清除全部记忆</strong><p>清除已保存的记忆，保留历史会话。</p></div><button type="button" className="personalization-danger" disabled={busy||blocked||(!settings.memory_count&&!settings.legacy_memory_count)} onClick={()=>setClear(true)}>清除</button></div>
    </div>{!!settings.legacy_memory_count&&<p className="personalization-help">旧版记忆资料已保留，不再使用或提炼；清除全部记忆时一并清除。</p>}</section>
    <section><h3>自定义指令</h3><div className="personalization-card"><button className="personalization-row personalization-entry" type="button" disabled={busy||blocked} onClick={()=>setEditor(true)}><span className="module-setting-row__icon" aria-hidden="true"><FileText size={16}/></span><span><strong>个人指令 <small>AGENTS.md</small></strong><small>用于没有项目专用指令的工作</small></span><ChevronRight size={16}/></button></div><p className="personalization-help">普通聊天使用个人记忆，不加载自定义指令。修改从下一轮工作生效。</p></section>
    {editor&&<TextEditor title="个人指令" markdown description="定义 AI 的规则、工作流程、操作边界和个人偏好。支持 Markdown，用于独立工作及未设置专用指令的项目；不能扩大账号权限。" initial={record(settings)} onClose={()=>setEditor(false)} onReload={async()=>{const value=await fetchPersonalization(undefined,ownerId);setSettings(value);return record(value);}} onSave={async(instructions,revision)=>{const value=await updatePersonalization({revision,instructions},ownerId);setSettings(value);return record(value);}}/>}
    {memories&&<MemoryManager ownerId={ownerId} onClose={()=>{setMemories(false);setReload(value=>value+1);}}/>}
    {clear&&<DiscardChangesDialog title="清除全部个人记忆？" description="清除已保存的个人记忆及保留的旧版资料，不删除历史会话。之后再次讨论相同信息时，系统可能重新记住。" confirmLabel="清除全部记忆" cancelLabel="取消" disabled={busy} onCancel={()=>setClear(false)} onDiscard={()=>void change(async()=>{await clearPersonalMemories(ownerId);setSettings({...settings,memory_count:0,legacy_memory_count:0});setClear(false);})}/>}
    </>}
  </section>;
}

function MemoryManager({ownerId,onClose}:{ownerId:string;onClose:()=>void}){
  const [items,setItems]=useState<PersonalMemory[]|null>(null);const [error,setError]=useState('');const [blocked,setBlocked]=useState(false);const [retry,setRetry]=useState(0);
  useEffect(()=>{const controller=new AbortController();void fetchPersonalMemories(controller.signal,ownerId).then(value=>{if(!controller.signal.aborted){setItems(value.items);setError('');}}).catch(reason=>{if(!controller.signal.aborted){setError(failureText(reason));setBlocked(denied(reason));}});return()=>controller.abort();},[retry,ownerId]);
  return <Drawer title="个人记忆" className="personalization-editor personalization-instructions personalization-native-memory settings-dialog settings-dialog--admin" bodyClassName="personalization-editor__body" onClose={onClose}>
    <div className="personalization-editor__content">
      {error&&<PageState error>{error}{!blocked&&<button type="button" className="secondary-button" onClick={()=>setRetry(value=>value+1)}>重新读取</button>}</PageState>}
      {!items&&!error&&<PageState>正在读取个人记忆…</PageState>}
      {items?.length===0&&<EmptyState icon={Brain} className="task-rows-empty personalization-memory-empty" title="暂无个人记忆">符合闲置条件的历史会话，会在后续对话中尝试整理。</EmptyState>}
      {!!items?.length&&<div className="personalization-reader personalization-markdown" role="region" aria-label="个人记忆内容" tabIndex={0}><Suspense fallback={<PageState>正在准备预览…</PageState>}>{items.map(row=><section key={row.id}><h3>{row.id==='memory_summary.md'?'记忆摘要':'详细记忆'}</h3><p className="personalization-help">更新于 {dateText(row.updated_at)}</p><MessageBody content={row.content}/></section>)}</Suspense></div>}
    </div>
    <div className="personalization-editor__dock"><footer className="personalization-editor__footer"><span/><button type="button" className="secondary-button" onClick={onClose}>返回</button></footer></div>
  </Drawer>;
}

export function ProjectInstructionsEntry({projectId,ownerId}:{projectId:string;ownerId:string}){
  const [value,setValue]=useState<ProjectInstructions|null>(null);const [error,setError]=useState('');const [open,setOpen]=useState(false);const [retry,setRetry]=useState(0);
  useEffect(()=>{const controller=new AbortController();void fetchProjectInstructions(projectId,controller.signal,ownerId).then(row=>{if(!controller.signal.aborted){setValue(row);setError('');}}).catch(reason=>{if(!controller.signal.aborted)setError(failureText(reason));});return()=>controller.abort();},[projectId,retry,ownerId]);
  const record=(row:ProjectInstructions):TextRecord=>({content:row.content??row.effective_content,revision:row.revision,updated_at:row.updated_at});
  return <section className="personalization-project"><button type="button" className="personalization-row personalization-entry" disabled={!value} onClick={()=>setOpen(true)}><FileText size={17}/><span><strong>项目指令</strong><small>{value?(value.source==='project'?'使用项目专用指令':'使用个人指令'):'正在读取项目指令…'}</small></span><ChevronRight size={16}/></button>{error&&<PageState error>{error}<button type="button" className="secondary-button" onClick={()=>setRetry(number=>number+1)}>重新读取</button></PageState>}
    {open&&value&&<TextEditor title="项目指令" markdown description="定义本项目中 AI 应遵循的规则、工作流程、操作边界和偏好。专用指令替代个人指令，不扩大账号权限；支持 Markdown，修改从下一轮生效。" initial={record(value)} required allowUnchanged={value.source==='personal'} onClose={()=>setOpen(false)} onSave={async(content,revision)=>{const row=await updateProjectInstructions(projectId,{revision,content},ownerId);setValue(row);return record(row);}} onReload={async()=>{const row=await fetchProjectInstructions(projectId,undefined,ownerId);setValue(row);return record(row);}} onRestore={value.source==='project'?async()=>{setValue(await updateProjectInstructions(projectId,{revision:value.revision,content:null},ownerId));}:undefined}/>}
  </section>;
}
