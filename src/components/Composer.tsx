import {ArrowUp,FolderClosed} from 'lucide-react';
import {WorkbenchOptionMenu} from './WorkbenchMenus';
import type {Project} from '../types';

export function Composer({compact=false,empty=false,mode='工作',value,onChange,onSubmit,projects=[],projectId=null,onProjectChange,busy=false,disabled=false,readOnly=false,projectSaving=false}: {
  compact?:boolean;empty?:boolean;mode?:'聊天'|'工作';value:string;onChange:(value:string)=>void;onSubmit:()=>void;
  projects?:Project[];projectId?:string|null;onProjectChange?:(id:string|null)=>void;busy?:boolean;disabled?:boolean;readOnly?:boolean;projectSaving?:boolean;
}) {
  return <div className={`composer${compact?' composer--compact':''}${empty?' composer--empty':''}`}>
    <textarea aria-label={mode==='工作'?'输入工作要求':'输入聊天消息'} placeholder={mode==='工作'?'描述目标，或继续修改当前任务…':'向宏昊 AI 发送消息'} rows={compact?2:3}
      value={value} readOnly={readOnly} maxLength={10000} onChange={event=>onChange(event.target.value)} onKeyDown={event=>{
        if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();if(!busy&&!disabled&&value.trim())onSubmit();}
      }} />
    <div className="composer__toolbar"><div className="composer__tools"><FolderClosed size={15}/>
      <WorkbenchOptionMenu label="选择项目" value={projectId??''} display={projects.find(project=>project.id===projectId)?.title??'未关联项目'}
        options={[{value:'',label:'不关联项目',disabled:projectSaving},...projects.map(project=>({value:project.id,label:project.title,disabled:projectSaving}))]}
        onSelect={id=>{if(!projectSaving)onProjectChange?.(id||null);}} />
    </div><button className="round-action composer__submit" type="button" aria-label={mode==='工作'?'交给智能体执行':'发送消息'} aria-busy={busy}
      disabled={busy||disabled||projectSaving||!value.trim()} onClick={onSubmit}><ArrowUp size={16}/></button></div>
  </div>;
}
