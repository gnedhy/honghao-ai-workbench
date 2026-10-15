import {ArrowUp,FolderClosed,LoaderCircle,Square,X} from 'lucide-react';
import {WorkbenchOptionMenu} from './WorkbenchMenus';
import {ProjectMark} from './ProjectMark';
import type {Project} from '../types';
import type {ReactNode} from 'react';

export function Composer({compact=false,empty=false,mode='工作',value,onChange,onSubmit,onStop,stopDisabled=false,projects=[],projectId=null,onProjectChange,busy=false,disabled=false,readOnly=false,projectSaving=false,contextInfo,modelControl}: {
  compact?:boolean;empty?:boolean;mode?:'聊天'|'工作';value:string;onChange:(value:string)=>void;onSubmit:()=>void;
  onStop?:()=>void;stopDisabled?:boolean;projects?:Project[];projectId?:string|null;onProjectChange?:(id:string|null)=>void;busy?:boolean;disabled?:boolean;readOnly?:boolean;projectSaving?:boolean;
  contextInfo?:ReactNode;
  modelControl?:ReactNode;
}) {
  const projectIndex=projects.findIndex(project=>project.id===projectId);
  const project=projects[projectIndex];
  const availableProjects=projects.filter(project=>!project.removed);
  const projectControl=project?<button className="composer__project composer__project--selected" type="button"
    disabled={projectSaving} aria-busy={projectSaving} aria-label={`移除项目：${project.title}`} title="移除项目" onClick={()=>onProjectChange?.(null)}>
    <span className="composer__project-icon" aria-hidden="true">
      <span className="composer__project-icon-default"><ProjectMark icon={project.icon} color={project.color}/></span>
      <span className="composer__project-icon-remove"><X size={10}/></span>
    </span><span>{project.title}</span>
  </button>:<WorkbenchOptionMenu className="composer__project-picker" label="选择项目" value=""
    display={<><FolderClosed size={14}/><span>选择项目</span></>}
    options={availableProjects.length?availableProjects.map(project=>({value:project.id,label:project.title,disabled:projectSaving})):[{value:'',label:'暂无可选项目',disabled:true}]}
    onSelect={id=>{if(!projectSaving)onProjectChange?.(id);}}/>;
  const input=<textarea aria-label={mode==='工作'?'输入工作要求':'输入聊天消息'} placeholder={mode==='工作'?empty?'描述任务目标和交付要求…':'补充信息，或输入下一步要求…':'向宏昊 AI 发送消息'} rows={compact?1:2}
      value={value} readOnly={readOnly} maxLength={10000} onChange={event=>onChange(event.target.value)} onKeyDown={event=>{
        if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();if(!onStop&&!busy&&!disabled&&value.trim())onSubmit();}
      }} />;
  const submit=onStop?<button className="round-action composer__submit" type="button" aria-label="停止执行" title={busy?'正在确认停止…':'停止回复'} aria-busy={busy}
    disabled={readOnly||busy||stopDisabled} onClick={onStop}>{busy?<LoaderCircle size={16} className="composer__busy"/>:<Square size={12} fill="currentColor"/>}</button>:<button className="round-action composer__submit" type="button" aria-label={mode==='工作'?'交给智能体执行':'发送消息'} aria-busy={busy}
    disabled={busy||disabled||projectSaving||!value.trim()} onClick={onSubmit}>{busy?<LoaderCircle size={16} className="composer__busy"/>:<ArrowUp size={16}/>}</button>;
  return <div className={`conversation-composer${empty?' conversation-composer--empty':''}`}>
    <div className={`composer${compact?' composer--compact':''}`}>
      {compact?<div className="composer__compact-row">{input}{modelControl}{submit}</div>:<>{input}<div className="composer__toolbar">{modelControl}{submit}</div></>}
    </div>
    {mode==='工作'&&<div className="conversation-composer__context">{projectControl}{contextInfo}</div>}
  </div>;
}
