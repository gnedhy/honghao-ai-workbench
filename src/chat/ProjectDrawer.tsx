import {ProjectInstructionsEntry} from '../personalization/Personalization';
import {useEffect,useRef,useState} from 'react';
import {createProject,fetchProjects,renameProject} from '../api';
import {createClientId} from '../clientId';
import {Drawer} from '../components/Drawer';
import {DiscardChangesDialog,useUnsavedChanges} from '../components/Interaction';
import {EmptyState, PageState} from '../components/WorkbenchLayout';
import {ProjectMark,projectIcons,projectColors} from '../components/ProjectMark';
import {MessageCircle,CheckCircle2,ChevronRight,CircleDot,CircleHelp,LoaderCircle,Search,Pencil,Plus} from 'lucide-react';
import {taskStatusLabel,taskTitle} from '../taskPresentation';
import type {Conversation,Project,ProjectIcon,ProjectColor,TaskItem} from '../types';

export function ProjectDrawer({project,owner,conversations,tasks,tasksReady=true,onSaved,onClose,onNewConversation,onConversation,onTask,onAccessLost}: {
  project:Project|null;owner:string;conversations:Conversation[];tasks:TaskItem[];tasksReady?:boolean;onSaved:(project:Project)=>void;onClose:()=>void;
  onNewConversation:(projectId:string)=>void;onConversation:(id:string)=>void;onTask:(task:TaskItem)=>void;onAccessLost:()=>void;
}) {
  const [baseline,setBaseline]=useState(project);
  const [name,setName]=useState(project?.title??'');
  const [icon,setIcon]=useState<ProjectIcon>(project?.icon??'folder');
  const [color,setColor]=useState<ProjectColor>(project?.color??'blue');
  const initiallyNew=useRef(!project);
  const nameInput=useRef<HTMLInputElement>(null);
  const saveButton=useRef<HTMLButtonElement>(null);
  const [iconQuery,setIconQuery]=useState('');
  const appearanceMenu=useRef<HTMLDetailsElement>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [unknown,setUnknown]=useState(false);
  const [confirmRemoval,setConfirmRemoval]=useState(false);
  const pending=useRef<{title:string;icon:ProjectIcon;color:ProjectColor;key:string}|null>(null);
  const writing=useRef(false);const live=useRef(true);const reading=useRef<AbortController|null>(null);
  const value=useRef({name,icon,color});value.current={name,icon,color};
  useEffect(()=>{
    live.current=true;
    if(initiallyNew.current&&appearanceMenu.current)appearanceMenu.current.open=true;
    const outside=(event:PointerEvent)=>{if(appearanceMenu.current&&!appearanceMenu.current.contains(event.target as Node))appearanceMenu.current.open=false;};
    document.addEventListener('pointerdown',outside);
    return()=>{live.current=false;reading.current?.abort();document.removeEventListener('pointerdown',outside);};
  },[]);
  const readonly=Boolean(baseline&&(baseline.owner_id!==owner||baseline.removed));
  const dirty=!readonly&&(name!==(baseline?.title??'')||icon!==(baseline?.icon??'folder')||color!==(baseline?.color??'blue')||unknown);
  const leave=useUnsavedChanges(dirty,busy,'项目设置尚未保存。放弃后只丢弃本次编辑，服务器已创建的项目会保留。','workbench-before-leave');
  const denied=(failure:unknown)=>{if([401,403].includes((failure as {status?:number}).status??0)){onAccessLost();return true;}return false;};
  const reload=async()=>{
    reading.current?.abort();const controller=new AbortController();reading.current=controller;
    const rows=await fetchProjects(controller.signal,owner);
    if(!live.current||controller.signal.aborted)return;
    const current=rows.find(row=>row.id===baseline?.id);
    if(current){setBaseline(current);onSaved(current);}
    return current;
  };
  const save=async(removing=false)=>{
    if(writing.current||readonly||(removing?!baseline:!pending.current&&!name.trim()))return;
    const focusedBeforeSave=document.activeElement as HTMLElement;
    writing.current=true;setBusy(true);setError('');
    const submitted=pending.current??{title:name.trim(),icon,color,key:createClientId()};
    if(!baseline)pending.current=submitted;
    try{
      const appearance={icon:submitted.icon,color:submitted.color};
      const saved=baseline?await renameProject(baseline,removing?baseline.title:submitted.title,removing?{removed:true}:appearance):await createProject(submitted.title,submitted.key,owner,appearance);
      if(!live.current)return;
      setBaseline(saved);onSaved(saved);pending.current=null;setUnknown(false);
      if(removing){onClose();return;}
      const unchanged=value.current.name.trim()===submitted.title&&value.current.icon===submitted.icon&&value.current.color===submitted.color;
      if(baseline&&unchanged&&(focusedBeforeSave===nameInput.current||focusedBeforeSave===saveButton.current)&&(document.activeElement===focusedBeforeSave||document.activeElement===document.body||document.activeElement?.tagName==='DIALOG')&&appearanceMenu.current){appearanceMenu.current.open=false;appearanceMenu.current.querySelector('summary')?.focus();}
      if(value.current.name.trim()===submitted.title)setName(saved.title);
      if(value.current.icon===submitted.icon)setIcon(saved.icon??'folder');
      if(value.current.color===submitted.color)setColor(saved.color??'blue');
      if(!baseline&&unchanged)onClose();
    }catch(failure){
      if(!live.current||denied(failure))return;
      const status=(failure as {status?:number}).status;
      if(baseline){
        try{const current=await reload();if(removing&&current?.removed){onClose();return;}setError('操作未确认或版本已变化，请核对后重试。');}
        catch(readFailure){if(!denied(readFailure))setError('当前项目读取失败，提议已保留；请重新读取。');}
      }else if(status&&status<500){pending.current=null;setError('创建未被接受，名称已保留，请核对后重试。');}
      else{setUnknown(true);setError('创建结果未确认。请重新确认原请求，避免重复创建项目。');}
    }finally{writing.current=false;if(live.current){setBusy(false);setConfirmRemoval(false);}}
  };
  const related=conversations.filter(row=>row.project_id===baseline?.id&&!row.archived);
  const relatedTasks=tasks.filter(row=>row.project_id===baseline?.id);
  const saveStatus=busy?'正在确认…':unknown?'创建结果待确认':dirty?'有未保存修改':baseline?'已保存':'设置确认后创建';
  const StatusIcon=busy?LoaderCircle:unknown?CircleHelp:dirty||!baseline?CircleDot:CheckCircle2;
  const matchingIcons=(Object.keys(projectIcons) as ProjectIcon[]).filter(key=>`${key} ${projectIcons[key].label}`.toLowerCase().includes(iconQuery.trim().toLowerCase()));
  return <>
    <Drawer title={baseline?'项目详情':'新建项目'} className="ai-project-drawer" bodyClassName="ai-project-drawer__body" onClose={onClose} beforeClose={leave.request} busy={busy} closeLabel="关闭项目详情">
      <div className="ai-project-identity">{readonly?<ProjectMark icon={icon} color={color} size={24}/>:<details className="ai-project-appearance" ref={appearanceMenu} onToggle={event=>{if(event.currentTarget.open){setIconQuery('');nameInput.current?.focus();}}} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget)&&(event.relatedTarget||!writing.current))event.currentTarget.open=false;}} onKeyDown={event=>{if(event.key==='Escape'&&event.currentTarget.open){event.preventDefault();event.stopPropagation();event.currentTarget.open=false;event.currentTarget.querySelector('summary')?.focus();}}}>
        <summary aria-label="编辑项目设置" title="编辑项目设置"><ProjectMark icon={icon} color={color} size={24}/><span className="ai-project-appearance-edit" aria-hidden="true"><Pencil size={17}/></span></summary>
        <form id="ai-project-settings" className="ai-project-appearance-panel" onSubmit={event=>{event.preventDefault();void save();}}>
          <strong>编辑项目</strong>
          <label className="ai-project-name-field">项目名称<input ref={nameInput} type="text" aria-label="项目名称" placeholder="为项目取个名称" maxLength={200} value={name} onChange={event=>setName(event.target.value)}/></label>
          <label className="ai-project-icon-search"><Search size={15}/><input type="search" aria-label="搜索项目图标" placeholder="搜索图标" value={iconQuery} onChange={event=>setIconQuery(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&!event.nativeEvent.isComposing)event.preventDefault();}}/></label>
          <fieldset><legend className="sr-only">颜色</legend><div className="ai-project-color-options">{(Object.keys(projectColors) as ProjectColor[]).map(key=><label className={`ai-project-color-option project-mark--${key}`} key={key} title={projectColors[key]}>
            <input type="radio" name="project-color" aria-label={projectColors[key]} checked={color===key} onChange={()=>setColor(key)}/><span aria-hidden="true"/>
          </label>)}</div></fieldset>
          <fieldset><legend className="sr-only">图标</legend><div className="ai-project-icon-options">{matchingIcons.map(key=><label className="ai-project-icon-option" key={key} title={projectIcons[key].label}>
            <input type="radio" name="project-icon" aria-label={`${projectIcons[key].label}图标`} checked={icon===key} onChange={()=>setIcon(key)}/><ProjectMark icon={key} color={color} size={20}/>
          </label>)}</div>{!matchingIcons.length&&<EmptyState compact icon={Search} title="没有匹配的图标"/>}</fieldset>
          {baseline&&name!==baseline.title&&<p className="ai-project-current">当前已保存名称：{baseline.title}</p>}
          <div className="ai-project-editor-actions"><button ref={saveButton} className="primary-button" type="submit" disabled={busy||(!unknown&&!dirty)||!name.trim()}>{unknown?'重新确认创建结果':baseline?'保存项目':'创建项目'}</button></div>
        </form>
      </details>}<div className="ai-project-identity-text"><h3>{name.trim()||'新建项目'}</h3><p>{readonly?'历史项目 · 只读':'个人项目 · 仅你可访问'}</p></div>
      {!readonly&&<span className="ai-project-save-status" data-state={busy?'saving':dirty||!baseline?'unsaved':'saved'} role="status" title={saveStatus} tabIndex={0}><StatusIcon size={18}/><span className="sr-only">{saveStatus}</span></span>}
      </div>
      {error&&<PageState error>{error}{baseline&&<button className="secondary-button" type="button" disabled={busy} onClick={()=>void reload().then(()=>setError('已重新读取当前设置，提议保留。')).catch(failure=>{if(!denied(failure))setError('读取失败，请重试。');})}>重新读取项目</button>}</PageState>}
      {baseline&&!readonly&&<ProjectInstructionsEntry key={baseline.id} projectId={baseline.id} ownerId={owner}/>}
      {baseline&&<div className="ai-project-content">
        <section><div className="ai-project-heading"><h3>项目会话</h3>{!readonly&&<button className="ai-project-new-conversation" type="button" aria-label="在项目中开启新会话" disabled={busy} onClick={async()=>{if(await leave.request()){onClose();onNewConversation(baseline.id);}}}><Plus size={14}/>新建会话</button>}</div>
        <div className="ai-project-links">{related.length?related.map(row=><button className="ai-project-link" type="button" key={row.id} title={row.title} onClick={async()=>{if(await leave.request()){onClose();onConversation(row.id);}}}><MessageCircle size={16}/><span><strong>{row.title}</strong></span><ChevronRight size={14}/></button>):<p>暂无项目会话</p>}</div></section>
        <section><div className="ai-project-heading"><h3>项目任务</h3></div>
        <div className="ai-project-links">{!tasksReady?<PageState>任务当前不可用，请稍后重试。</PageState>:relatedTasks.length?relatedTasks.map(row=><button className="ai-project-link" type="button" key={row.id} title={row.objective} onClick={async()=>{if(await leave.request()){onClose();onTask(row);}}}><CheckCircle2 size={16}/><span><strong>{taskTitle(row)}</strong><small className="ai-project-task-status" data-status={row.status}>{taskStatusLabel(row.status)}</small></span><ChevronRight size={14}/></button>):<p>暂无项目任务</p>}</div></section>
      </div>}
      {baseline&&!readonly&&<footer className="admin-form-actions"><button className="secondary-button" type="button" disabled={busy} onClick={()=>setConfirmRemoval(true)}>移除项目</button></footer>}
    </Drawer>{leave.confirmation}
    {confirmRemoval&&<DiscardChangesDialog title="移除项目？" description={`项目将从列表移除，会话、任务和原来源记录保留。${dirty?'未保存修改将放弃。':''}`} cancelLabel="取消" confirmLabel="移除项目" disabled={busy} onCancel={()=>setConfirmRemoval(false)} onDiscard={()=>void save(true)}/>}
  </>;
}
