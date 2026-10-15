import {CheckCircle2,Circle,CircleAlert,CirclePause,CircleX,ClipboardCheck,History,List,LoaderCircle} from 'lucide-react';
import type {TaskRun} from '../api';
import type {TaskItem,TaskStatus} from '../types';
import {EmptyState} from '../components/WorkbenchLayout';
import {taskDate,taskStatusLabel,taskTitle} from '../taskPresentation';

const statusIcons={created:Circle,queued:Circle,running:LoaderCircle,waiting:CirclePause,blocked:CircleAlert,failed:CircleX,stopped:CirclePause,review:ClipboardCheck,completed:CheckCircle2};
function Status({status,run=false}:{status:TaskStatus;run?:boolean}) {
  const Icon=statusIcons[status];
  return <span className={`task-status task-status--${status}`}><Icon size={14} aria-hidden="true"/>{run&&status==='completed'?'运行成功':taskStatusLabel(status)}</span>;
}
function EmptyRows({runs=false,children}:{runs?:boolean;children:string}) {
  const Icon=runs?History:List;
  return <EmptyState icon={Icon} title={children} className="task-rows-empty"/>;
}

export function TaskListRows({tasks,ownerId,project,conversation,selectedId,emptyText,onInspect,onOpenConversation,chatEnabled}:{
  tasks:TaskItem[];ownerId:string;project:(id:string|null)=>string;conversation:(task:TaskItem)=>string;selectedId?:string;emptyText:string|null;
  onInspect:(task:TaskItem)=>void;onOpenConversation:(task:TaskItem)=>void;chatEnabled:boolean;
}) {
  return <div className="task-table-wrap task-panel-rows fading-scrollbar" tabIndex={0} role="region" aria-label="任务列表">
    <table className="task-table task-list-table" aria-label="任务列表"><colgroup><col/><col/><col/><col/><col/></colgroup><thead><tr><th scope="col">任务</th><th scope="col">状态</th><th scope="col">项目</th><th scope="col">来源会话</th><th scope="col">创建时间</th></tr></thead>
      <tbody>{tasks.map(task=><tr key={task.id} className={selectedId===task.id?'is-active':undefined}>
        <td><button className="ai-task-open task-row-title" type="button" title={task.title??task.objective} aria-label={`查看任务：${taskTitle(task)}`} onClick={()=>onInspect(task)}>{taskTitle(task)}</button><small title={task.objective}>{task.owner_id!==ownerId?'历史只读':task.objective}</small></td>
        <td><Status status={task.status}/></td><td><span className="task-row-truncate" title={project(task.project_id)}>{project(task.project_id)}</span></td>
        <td><button className="ai-task-open task-row-truncate" type="button" title={conversation(task)} disabled={!chatEnabled||task.owner_id!==ownerId} onClick={()=>onOpenConversation(task)}>{conversation(task)}</button></td><td><time dateTime={task.created_at}>{taskDate(task.created_at)}</time></td>
      </tr>)}</tbody>
    </table>
    {!tasks.length&&emptyText&&<EmptyRows>{emptyText}</EmptyRows>}
  </div>;
}

export function TaskRunRows({runs,selectedId,emptyText,onInspect}:{runs:TaskRun[];selectedId?:string|null;emptyText:string|null;onInspect:(runId:string)=>void}) {
  return <div className="task-table-wrap task-panel-rows fading-scrollbar" tabIndex={0} role="region" aria-label="运行记录列表">
    <table className="task-table task-run-table" aria-label="运行记录"><colgroup><col/><col/><col/><col/><col/></colgroup><thead><tr><th scope="col">运行</th><th scope="col">运行状态</th><th scope="col">开始时间</th><th scope="col">结束时间</th><th scope="col">人工验收</th></tr></thead>
      <tbody>{[...runs].reverse().map((row,index)=><tr key={row.id} className={selectedId===row.id?'is-active':undefined}>
        <td><button className="ai-run-row" type="button" aria-label={`查看第 ${runs.length-index} 次运行`} onClick={()=>onInspect(row.id)}><History size={15} aria-hidden="true"/><span>第 {runs.length-index} 次运行</span></button></td>
        <td><Status status={row.status} run/></td><td><time dateTime={row.started_at??undefined}>{taskDate(row.started_at)}</time></td><td>{row.ended_at?<time dateTime={row.ended_at}>{taskDate(row.ended_at)}</time>:<span className="task-row-muted">—</span>}</td>
        <td><span className={row.accepted_at?'task-run-accepted':'task-row-muted'} title={row.accepted_at?`验收时间：${taskDate(row.accepted_at)}`:undefined}>{row.accepted_at?'已验收':row.status==='completed'?'未验收':'—'}</span></td>
      </tr>)}</tbody>
    </table>
    {!runs.length&&emptyText&&<EmptyRows runs>{emptyText}</EmptyRows>}
  </div>;
}
