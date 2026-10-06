import {useEffect,useRef,useState} from 'react';
import {createProject,fetchProjects,renameProject} from '../api';
import {createClientId} from '../clientId';
import {Drawer} from '../components/Drawer';
import {useUnsavedChanges} from '../components/Interaction';
import {FormFooter,PageState} from '../components/WorkbenchLayout';
import type {Conversation,Project,TaskItem} from '../types';

export function ProjectDrawer({project,owner,conversations,tasks,onSaved,onClose,onNewConversation,onConversation,onTask,onAccessLost}: {
  project:Project|null;owner:string;conversations:Conversation[];tasks:TaskItem[];onSaved:(project:Project)=>void;onClose:()=>void;
  onNewConversation:(projectId:string)=>void;onConversation:(id:string)=>void;onTask:(task:TaskItem)=>void;onAccessLost:()=>void;
}) {
  const [baseline,setBaseline]=useState(project);
  const [name,setName]=useState(project?.title??'');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [unknown,setUnknown]=useState(false);
  const pending=useRef<{title:string;key:string}|null>(null);
  const writing=useRef(false);const live=useRef(true);const reading=useRef<AbortController|null>(null);
  const value=useRef(name);value.current=name;
  useEffect(()=>{live.current=true;return()=>{live.current=false;reading.current?.abort();};},[]);
  const readonly=Boolean(baseline&&baseline.owner_id!==owner);
  const dirty=!readonly&&(name!==(baseline?.title??'')||unknown);
  const leave=useUnsavedChanges(dirty,busy,'项目名称尚未保存。放弃后只丢弃本次编辑，服务器已创建的项目会保留。','workbench-before-leave');
  const denied=(failure:unknown)=>{if([401,403].includes((failure as {status?:number}).status??0)){onAccessLost();return true;}return false;};
  const reload=async()=>{
    reading.current?.abort();const controller=new AbortController();reading.current=controller;
    const rows=await fetchProjects(controller.signal,owner);
    if(!live.current||controller.signal.aborted)return;
    const current=rows.find(row=>row.id===baseline?.id);
    if(current){setBaseline(current);onSaved(current);}
  };
  const save=async()=>{
    if(writing.current||readonly||(!pending.current&&!name.trim()))return;
    writing.current=true;setBusy(true);setError('');
    const submitted=pending.current??{title:name.trim(),key:createClientId()};
    if(!baseline)pending.current=submitted;
    try{
      const saved=baseline?await renameProject(baseline,submitted.title):await createProject(submitted.title,submitted.key,owner);
      if(!live.current)return;
      setBaseline(saved);onSaved(saved);pending.current=null;setUnknown(false);
      if(value.current.trim()===submitted.title)setName(saved.title);
      if(!baseline&&value.current.trim()===submitted.title)onClose();
    }catch(failure){
      if(!live.current||denied(failure))return;
      const status=(failure as {status?:number}).status;
      if(baseline){
        try{await reload();setError('保存未确认或版本已变化，提议已保留；请核对当前名称后明确保存。');}
        catch(readFailure){if(!denied(readFailure))setError('当前项目读取失败，提议已保留；请重新读取。');}
      }else if(status&&status<500){pending.current=null;setError('创建未被接受，名称已保留，请核对后重试。');}
      else{setUnknown(true);setError('创建结果未确认。请重新确认原请求，避免重复创建项目。');}
    }finally{writing.current=false;if(live.current)setBusy(false);}
  };
  const related=conversations.filter(row=>row.project_id===baseline?.id);
  const relatedTasks=tasks.filter(row=>row.project_id===baseline?.id);
  return <>
    <Drawer title={baseline?'项目详情':'新建项目'} onClose={onClose} beforeClose={leave.request} busy={busy} closeLabel="关闭项目详情">
      {readonly?<PageState>历史项目仅供只读查看。</PageState>:<form className="ai-project-form" onSubmit={event=>{event.preventDefault();void save();}}>
        <label>项目名称<input autoFocus aria-label="项目名称" maxLength={200} value={name} onChange={event=>setName(event.target.value)} /></label>
        {baseline&&name!==baseline.title&&<p className="ai-project-current">当前已保存名称：{baseline.title}</p>}
        {error&&<PageState error>{error}{baseline&&<button className="secondary-button" type="button" disabled={busy} onClick={()=>void reload().then(()=>setError('已重新读取当前名称，提议保留。')).catch(failure=>{if(!denied(failure))setError('读取失败，请重试。');})}>重新读取项目</button>}</PageState>}
        <FormFooter status={busy?'正在确认保存…':unknown?'创建结果待确认':dirty?'有未保存修改':baseline?'已保存':'名称确认后创建'}><button className="primary-button" type="submit" disabled={busy||(!unknown&&!dirty)||!name.trim()}>{unknown?'重新确认创建结果':baseline?'保存名称':'创建项目'}</button></FormFooter>
      </form>}
      {baseline&&<section className="ai-project-content">
        <div className="ai-project-heading"><h3>项目会话</h3>{!readonly&&<button className="secondary-button" type="button" disabled={busy} onClick={async()=>{if(await leave.request()){onClose();onNewConversation(baseline.id);}}}>在项目中开启新会话</button>}</div>
        {related.length?related.map(row=><button className="ai-project-link" type="button" key={row.id} onClick={async()=>{if(await leave.request()){onClose();onConversation(row.id);}}}>{row.title}</button>):<p>尚无关联会话；新会话可从本项目开始。</p>}
        <h3>项目任务</h3>
        {relatedTasks.length?relatedTasks.map(row=><button className="ai-project-link" type="button" key={row.id} onClick={async()=>{if(await leave.request()){onClose();onTask(row);}}}>{row.objective}</button>):<p>首次提交工作后，任务会在这里出现。</p>}
      </section>}
    </Drawer>{leave.confirmation}
  </>;
}
