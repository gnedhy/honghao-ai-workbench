// Adapted from chuspeeism/dashi-taskboard BoardColumn.tsx and TaskCard.tsx (Apache-2.0).
// Our AI execution states replace issue states; cards expose existing detail/conversation actions.
import type {ReactNode} from 'react';
import {ArrowUpRight,BadgeCheck,Eye,FileCheck2,Inbox,MessageCircle,Play,RefreshCw,Square} from 'lucide-react';
import type {TaskDetailAction} from './TaskDetails';
import {taskTitle,taskStatusLabel} from '../taskPresentation';
import type {TaskItem} from '../types';
import {EmptyState} from '../components/WorkbenchLayout';

type Props={
  id:string;label:string;icon:ReactNode;tasks:TaskItem[];projectNames:Record<string,string>;
  ownerId:string;chatEnabled:boolean;onOpenTask:(task:TaskItem,action?:TaskDetailAction)=>void;onOpenConversation:(task:TaskItem)=>void;
};
const emptyIcons:Record<string,typeof Inbox>={pending:Inbox,running:RefreshCw,attention:MessageCircle,review:FileCheck2,completed:BadgeCheck};

export function BoardColumn({id,label,icon,tasks,projectNames,...actions}:Props) {
  const EmptyIcon=emptyIcons[id]??Inbox;
  return <section className={`board-column status-${id}`} aria-labelledby={`column-${id}`}>
    <header className="column-header"><div className="column-heading">{icon}<h2 id={`column-${id}`}>{label}</h2><span>{tasks.length}</span></div></header>
    <div className="column-list fading-scrollbar" tabIndex={0} role="region" aria-label={`${label}任务列表`}>
      {tasks.map(task=><TaskCard key={task.id} task={task} projectName={task.project_id?projectNames[task.project_id]??'项目暂不可读':'未关联项目'} {...actions}/>)}
      {!tasks.length&&<EmptyState icon={EmptyIcon} className="column-empty" title={`暂无${label}任务`}/>}
    </div>
  </section>;
}

function TaskCard({task,projectName,ownerId,chatEnabled,onOpenTask,onOpenConversation}:Omit<Props,'id'|'label'|'icon'|'tasks'|'projectNames'>&{task:TaskItem;projectName:string}) {
  const readonly=task.owner_id!==ownerId;
  return <article className={`task-card status-${task.status}`}>
    <button className="task-card-open" type="button" aria-label={`查看任务：${taskTitle(task)}`} onClick={()=>onOpenTask(task)}>
      <div className="card-topline"><span className={`task-status task-status--${task.status}`}>{taskStatusLabel(task.status)}</span><time dateTime={task.created_at}>{new Intl.DateTimeFormat('zh-CN',{month:'numeric',day:'numeric'}).format(new Date(task.created_at))}</time></div>
      <h3>{taskTitle(task)}</h3><p className="task-card-body">{task.objective}</p><small title={projectName}>{projectName}{readonly?' · 历史只读':''}</small>
    </button>
    <footer>
      {readonly?<button type="button" onClick={()=>onOpenTask(task)}><Eye size={14}/>查看详情</button>:
      task.status==='created'?<button type="button" disabled={!chatEnabled} onClick={()=>onOpenTask(task,'start')}><Play size={14}/>开始任务</button>:
      task.status==='running'?<><button type="button" onClick={()=>onOpenTask(task,'progress')}><Eye size={14}/>查看进度</button><button type="button" disabled={!chatEnabled} onClick={()=>onOpenTask(task,'stop')}><Square size={14}/>停止任务</button></>:
      task.status==='review'?<><button type="button" onClick={()=>onOpenTask(task,'result')}><Eye size={14}/>查看并验收</button><button type="button" disabled={!chatEnabled} onClick={()=>onOpenConversation(task)}><MessageCircle size={14}/>继续修改</button></>:
      task.status==='completed'?<><button type="button" onClick={()=>onOpenTask(task,'result')}><Eye size={14}/>查看结果</button><button type="button" disabled={!chatEnabled} onClick={()=>onOpenConversation(task)}><ArrowUpRight size={14}/>延伸任务</button></>:
      <button type="button" disabled={!chatEnabled} onClick={()=>onOpenConversation(task)}><MessageCircle size={14}/>继续处理</button>}
    </footer>
  </article>;
}
