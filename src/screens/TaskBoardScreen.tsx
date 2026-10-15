import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {CheckCircle2,ClipboardCheck,Circle,CirclePause,FilterX,LoaderCircle,Plus,RotateCw,Search} from 'lucide-react';
import {SegmentedControl} from '../components/SegmentedControl';
import {WorkbenchOptionMenu} from '../components/WorkbenchMenus';
import {PageState} from '../components/WorkbenchLayout';
import {useFadingScrollbars} from '../components/Interaction';
import {TopBar,type ScreenChromeProps} from '../components/TopBar';
import {useTaskRuns} from '../chat/useTaskRuns';
import {taskStatusLabel,taskTitle} from '../taskPresentation';
import {BoardColumn} from '../tasks/BoardColumn';
import {TaskDetails,type TaskDetailAction} from '../tasks/TaskDetails';
import {TaskListRows,TaskRunRows} from '../tasks/TaskPanelRows';
import {matchesTaskFilters,matchesTaskSearch} from '../tasks/taskFilters';
import type {Conversation,Project,TaskItem,TaskStatus} from '../types';

const groups=[
  {id:'pending',label:'待执行',statuses:['created','queued'],icon:Circle},
  {id:'running',label:'处理中',statuses:['running'],icon:LoaderCircle},
  {id:'attention',label:'待跟进',statuses:['waiting','failed','blocked','stopped'],icon:CirclePause},
  {id:'review',label:'待验收',statuses:['review'],icon:ClipboardCheck},
  {id:'completed',label:'已完成',statuses:['completed'],icon:CheckCircle2},
] satisfies {id:string;label:string;statuses:TaskStatus[];icon:typeof Circle}[];
const statuses:TaskStatus[]=['created','queued','running','waiting','failed','blocked','stopped','review','completed'];

export function TaskBoardScreen({ownerId,tasks,projects,conversations,dataState,selectedTask,detailContainer,runId,onRunChange,onSelectedTaskChange,onTaskInspect,onTaskOpen,onTaskSaved,onNewTask,chatEnabled,onDataRetry,onAccessLost,...chrome}:ScreenChromeProps & {
  ownerId:string;tasks:TaskItem[];projects:Project[];conversations:Conversation[];dataState:'loading'|'ready'|'error';selectedTask:TaskItem|null;
  detailContainer:HTMLDivElement|null;runId:string|null;onRunChange:(id:string)=>void;
  onSelectedTaskChange:(task:TaskItem)=>void;onTaskInspect:(task:TaskItem,runId?:string)=>Promise<boolean>;onTaskOpen:(task:TaskItem)=>void;onNewTask:(projectId:string|null)=>void;chatEnabled:boolean;onDataRetry:()=>void;onAccessLost:(error:unknown)=>void;
  onTaskSaved:(task:TaskItem)=>void;
}) {
  const scrolling=useRef<HTMLElement>(null);useFadingScrollbars(scrolling);
  const [view,setView]=useState<'状态分组'|'列表'|'运行记录'>('状态分组');
  const [query,setQuery]=useState('');const [projectFilter,setProjectFilter]=useState('all');const [statusFilter,setStatusFilter]=useState('all');
  const [detailAction,setDetailAction]=useState<{taskId:string;kind:TaskDetailAction}|null>(null);
  const inspect=async(task:TaskItem,runId?:string,kind?:TaskDetailAction)=>{
    if(await onTaskInspect(task,runId))setDetailAction(kind?{taskId:task.id,kind}:null);
  };
  const selected=selectedTask;
  const projectNames=Object.fromEntries(projects.map(row=>[row.id,row.title]));
  const project=(id:string|null)=>id?projectNames[id]??'项目暂不可读':'未关联项目';
  const conversation=(task:TaskItem)=>conversations.find(row=>row.id===task.conversation_id)?.title??'会话暂不可读';
  const reload=useRef(onDataRetry);reload.current=onDataRetry;
  const active=tasks.some(task=>task.status==='queued'||task.status==='running'||task.status==='waiting');
  useEffect(()=>{if(!active)return;const timer=setInterval(()=>reload.current(),1500);return()=>clearInterval(timer);},[active]);
  const history=useTaskRuns(view==='运行记录'||chrome.contextOpen?selected?.id:undefined,onAccessLost,ownerId);
  const runs=history.rows.filter(row=>row.task_id===selected?.id);
  const filtered=tasks.filter(task=>
    matchesTaskSearch(task,query,project(task.project_id)+' '+conversation(task))&&
    matchesTaskFilters(task,statusFilter==='all'?[]:[statusFilter as TaskStatus])&&
    (projectFilter==='all'||(projectFilter==='none'?task.project_id===null:task.project_id===projectFilter))
  );
  const visible=[...filtered].reverse();
  const changeView=(next:typeof view)=>{setView(next);};
  const clear=()=>{setQuery('');setProjectFilter('all');setStatusFilter('all');};
  const filtering=Boolean(query.trim()||projectFilter!=='all'||statusFilter!=='all');
  return <main ref={scrolling} className="app-main task-panel-screen fading-scrollbar"><TopBar {...chrome} title="任务面板" subtitle={`${filtering?`${visible.length} / `:''}${tasks.length} 个任务`} tabs={null} action={<button className="secondary-button task-panel-new" type="button" disabled={!chatEnabled} title={!chatEnabled?'聊天模块当前不可用':undefined} onClick={()=>onNewTask(projectFilter==='all'||projectFilter==='none'?null:projectFilter)}><Plus size={15}/>创建任务</button>}/>
    <section className="task-board task-panel">
      <div className="task-panel-toolbar">
        <SegmentedControl value={view} options={['状态分组','列表','运行记录'] as const} onChange={changeView} label="任务面板视图"/>
        <div className="task-panel-filters">
          <label className="search-field search-field--short"><Search size={15}/><input aria-label="搜索任务" placeholder="搜索任务、项目或会话" value={query} onChange={event=>setQuery(event.target.value)}/></label>
          <WorkbenchOptionMenu label="筛选任务项目" value={projectFilter} className="task-panel-menu" options={[{value:'all',label:'全部项目'},{value:'none',label:'未关联项目'},...projects.map(row=>({value:row.id,label:row.title}))]} onSelect={setProjectFilter}/>
          <WorkbenchOptionMenu label="筛选任务状态" value={statusFilter} className="task-panel-menu" options={[{value:'all',label:'全部状态'},...statuses.map(status=>({value:status,label:taskStatusLabel(status)}))]} onSelect={setStatusFilter}/>
          <button className="icon-button" type="button" aria-label="清除筛选" title="清除筛选" disabled={!filtering} onClick={clear}><FilterX size={15}/></button>
          <button className="icon-button" type="button" aria-label="刷新任务面板" onClick={onDataRetry}><RotateCw size={15}/></button>
        </div>
      </div>
      {dataState==='loading'&&!tasks.length&&<PageState>正在读取任务…</PageState>}
      {dataState==='error'&&<PageState error onRetry={onDataRetry}>任务刷新失败，已确认记录保留。</PageState>}
      {view==='状态分组'&&(dataState==='ready'||visible.length>0)&&<div className="task-panel-board">{groups.map(({id,label,statuses:groupStatuses,icon:Icon})=><BoardColumn key={id} id={id} label={label} icon={<Icon size={15}/>} tasks={visible.filter(task=>matchesTaskFilters(task,groupStatuses))} projectNames={projectNames} ownerId={ownerId} chatEnabled={chatEnabled} onOpenTask={(task,action)=>void inspect(task,undefined,action)} onOpenConversation={onTaskOpen}/>)}</div>}
      {view==='列表'&&(dataState==='ready'||visible.length>0)&&<TaskListRows tasks={visible} ownerId={ownerId} project={project} conversation={conversation} selectedId={chrome.contextOpen?selected?.id:undefined} emptyText={dataState==='ready'?(filtering?'没有匹配任务，请调整筛选。':'暂无任务'):null} onInspect={task=>void inspect(task)} onOpenConversation={onTaskOpen} chatEnabled={chatEnabled}/>}
      {view==='运行记录'&&<>
        <div className="task-panel-history-choice" aria-busy={history.state==='loading'}>{visible.length>0&&<><span>查看任务</span><WorkbenchOptionMenu label="选择运行记录任务" side="right" className="task-panel-menu task-panel-task-choice" value={visible.some(task=>task.id===selected?.id)?selected?.id??'':''} display={visible.some(task=>task.id===selected?.id)?undefined:'选择任务'} options={visible.map(task=>({value:task.id,label:taskTitle(task)}))} onSelect={id=>{const task=tasks.find(row=>row.id===id);if(task){onSelectedTaskChange(task);}}}/>{selected&&visible.some(task=>task.id===selected.id)&&<small role="status">{history.state==='loading'?'正在读取…':`${runs.length} 次运行`}</small>}</>}</div>
        {(!selected||!visible.some(task=>task.id===selected.id))?(dataState==='ready'&&<TaskRunRows runs={[]} emptyText={visible.length?'选择任务查看运行记录':filtering?'没有匹配任务，请调整筛选。':'暂无运行记录'} onInspect={()=>{}}/>):<>
          {history.state==='error'&&<PageState error onRetry={history.reload}>运行记录读取失败，已确认记录保留。</PageState>}
          <TaskRunRows runs={runs} selectedId={chrome.contextOpen?runId:undefined} emptyText={history.state==='loading'?'正在读取运行记录…':history.state==='ready'?'这项任务尚未运行。':null} onInspect={id=>void inspect(selected,id)}/>
        </>}
      </>}
    </section>
    {chrome.contextOpen&&detailContainer&&selected&&createPortal(<TaskDetails key={selected.id} task={selected} ownerId={ownerId} projectTitle={project(selected.project_id)} conversationTitle={conversation(selected)}
      history={history} action={detailAction?.taskId===selected.id?detailAction:null} onActionHandled={()=>setDetailAction(current=>current?.taskId===selected.id?{...current,kind:'progress'}:current)} chatEnabled={chatEnabled} runId={runId} onRunChange={onRunChange} onTaskOpen={onTaskOpen} onTaskSaved={onTaskSaved} onDataRetry={onDataRetry} onAccessLost={onAccessLost}/>,detailContainer)}
  </main>;
}
