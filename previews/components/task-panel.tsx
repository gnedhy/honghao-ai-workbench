import {useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {createPortal} from 'react-dom';
import {CheckCircle2,Circle,CirclePause,ClipboardCheck,LoaderCircle,Search} from 'lucide-react';
import {TopBar} from '../../src/components/TopBar';
import {SegmentedControl} from '../../src/components/SegmentedControl';
import {WorkbenchOptionMenu} from '../../src/components/WorkbenchMenus';
import {ContextSidebar} from '../../src/components/ContextSidebar';
import {useFadingScrollbars} from '../../src/components/Interaction';
import MessageBody from '../../src/chat/MessageBody';
import {BoardColumn} from '../../src/tasks/BoardColumn';
import {TaskListRows,TaskRunRows} from '../../src/tasks/TaskPanelRows';
import {matchesTaskSearch,matchesTaskFilters} from '../../src/tasks/taskFilters';
import {taskTitle,taskStatusLabel,taskDate} from '../../src/taskPresentation';
import type {TaskItem,TaskStatus} from '../../src/types';
import type {TaskRun} from '../../src/api';
import '../../src/styles.css';

// Read-only fixtures: no fetch, persisted records, execution hook or model calls.
const owner='design-preview';
const names:Record<string,string>={daily:'日常工作',ai:'企业 AI 工作区',research:'研发五部'};
const examples:[string,TaskStatus,string|null,string][]=[
  ['整理本周供应商报价','created','daily','按材料和供应商整理报价差异，列出需要进一步核对的项目。'],
  ['更新 CRM 客户跟进汇总','running','daily','汇总本周客户活动，按负责人整理进展、问题和下次跟进安排。'],
  ['核对配方成本计算口径','waiting','research','核对不同成本口径下的配方差异，等待补充价格版本和有效日期。'],
  ['整理项目周报草稿','stopped','ai','整理功能进展与未决事项，保留草稿，稍后继续补充。'],
  ['分析采购行情变化','failed',null,'汇总主要材料的行情变化，保留已确认内容并核对缺失来源。'],
  ['编写采购与研发工作台上线测试说明并核对全部边界条件','review','ai','核对采购与研发工作台的操作流程、权限边界、未保存退出和异常提示，整理供人工验收的测试说明。'],
  ['汇总周会待办与责任人','completed','daily','整理会议中的待办、负责人和完成时间，形成可直接核对的清单。'],
  ['整理知识库资料目录','completed',null,'按资料来源和主题整理目录，保留原始文件，并注明待审核内容。'],
];
const tasks:TaskItem[]=examples.map(([title,status,project_id,objective],index)=>({id:`sample-task-${index}`,conversation_id:`sample-conversation-${index}`,owner_id:owner,revision:1,title,status,project_id,objective,created_at:`2026-10-08T01:${String(10+index).padStart(2,'0')}:00Z`,latest_run:status==='created'?null:`sample-run-sample-task-${index}-${status==='review'?4:1}`}));
const sampleRun=(task:TaskItem,number:number,status:TaskRun['status'],accepted=false):TaskRun=>({id:`sample-run-${task.id}-${number}`,task_id:task.id,owner_id:owner,input_message_id:`sample-input-${number}`,status,phase:status==='running'?'generating':'ended',started_at:`2026-10-08T02:${number*10}:00Z`,ended_at:status==='running'?null:`2026-10-08T02:${number*10}:45Z`,stop_reason:status==='stopped'?'user_requested':null,waiting_reason:null,runtime_version:'design-preview',output:status==='completed'?'## 样例结果\n\n1. 已整理操作流程与核对事项。\n2. 已标注需要人工确认的边界。\n3. 后续可继续补充和验收。':status==='running'?'样例进度：正在整理客户跟进记录。':'样例记录：已确认内容保留，后续可继续处理。',model_requests:0,reported_model_tokens:0,model_network_ms:0,accepted_at:accepted?'2026-10-08T02:11:00Z':null,accepted_by:accepted?owner:null});
const records=(task:TaskItem):TaskRun[]=>task.status==='created'?[]:task.status==='review'?[sampleRun(task,1,'completed',true),sampleRun(task,2,'stopped'),sampleRun(task,3,'failed'),sampleRun(task,4,'completed')]:[sampleRun(task,1,task.status==='completed'?'completed':task.status as TaskRun['status'],task.status==='completed')];
const groups=[{id:'pending',label:'待执行',statuses:['created'],icon:Circle},{id:'running',label:'处理中',statuses:['running'],icon:LoaderCircle},{id:'attention',label:'待跟进',statuses:['waiting','stopped','failed','blocked'],icon:CirclePause},{id:'review',label:'待验收',statuses:['review'],icon:ClipboardCheck},{id:'completed',label:'已完成',statuses:['completed'],icon:CheckCircle2}] satisfies {id:string;label:string;statuses:TaskStatus[];icon:typeof Circle}[];
const statuses:TaskStatus[]=['created','running','waiting','stopped','failed','blocked','review','completed'];

function Preview() {
  const scrolling=useRef<HTMLElement>(null);useFadingScrollbars(scrolling);
  const [view,setView]=useState<'状态分组'|'列表'|'运行记录'>('列表');
  const [query,setQuery]=useState('');const [projectFilter,setProjectFilter]=useState('all');const [statusFilter,setStatusFilter]=useState('all');
  const [empty,setEmpty]=useState(false);const [selected,setSelected]=useState(tasks[5]);const [runId,setRunId]=useState<string|null>(null);const [open,setOpen]=useState(false);const [container,setContainer]=useState<HTMLDivElement|null>(null);
  const project=(id:string|null)=>id?names[id]:'未关联项目';const conversation=(task:TaskItem)=>`${taskTitle(task)} · 样例会话`;
  const visible=(empty?[]:tasks).filter(task=>matchesTaskSearch(task,query,project(task.project_id)+' '+conversation(task))&&matchesTaskFilters(task,statusFilter==='all'?[]:[statusFilter as TaskStatus])&&(projectFilter==='all'||(projectFilter==='none'?task.project_id===null:task.project_id===projectFilter))).reverse();
  const chosen=visible.find(task=>task.id===selected.id);const runs=chosen?records(chosen):[];
  const inspect=(task:TaskItem,id?:string)=>{setSelected(task);setRunId(id??null);setOpen(true);};
  const shown=records(selected).find(row=>row.id===runId)??records(selected).at(-1);
  return <div className={`app-shell task-design-preview${open?' has-context':''}`}>
    <main ref={scrolling} className="app-main task-panel-screen fading-scrollbar"><TopBar title="任务面板" subtitle={`${empty?0:tasks.length} 个样例任务`} tabs={null} moduleMode="prototype" environment="test" contextOpen={open} onOpenNavigation={()=>{}} onToggleContext={()=>setOpen(!open)} action={<><button className="secondary-button" type="button" onClick={()=>{setEmpty(!empty);setOpen(false);}}>{empty?'查看样例内容':'查看空状态'}</button><a className="secondary-button" href="/">返回工作区</a></>}/>
      <section className="task-board task-panel">
        <div className="task-panel-toolbar"><SegmentedControl value={view} options={['状态分组','列表','运行记录'] as const} onChange={setView} label="任务面板视图"/><div className="task-panel-filters"><label className="search-field search-field--short"><Search size={15}/><input aria-label="搜索任务" placeholder="搜索任务、项目或会话" value={query} onChange={event=>setQuery(event.target.value)}/></label><WorkbenchOptionMenu label="筛选任务项目" className="task-panel-menu" value={projectFilter} options={[{value:'all',label:'全部项目'},{value:'none',label:'未关联项目'},...Object.entries(names).map(([value,label])=>({value,label}))]} onSelect={setProjectFilter}/><WorkbenchOptionMenu label="筛选任务状态" className="task-panel-menu" value={statusFilter} options={[{value:'all',label:'全部状态'},...statuses.map(value=>({value,label:taskStatusLabel(value)}))]} onSelect={setStatusFilter}/></div></div>
        {(query||projectFilter!=='all'||statusFilter!=='all')&&<div className="task-panel-caption"><span>{visible.length} / {empty?0:tasks.length} 个任务</span><button type="button" onClick={()=>{setQuery('');setProjectFilter('all');setStatusFilter('all');}}>清除筛选</button></div>}
        {view==='状态分组'&&<div className="task-panel-board">{groups.map(({id,label,statuses:values,icon:Icon})=><BoardColumn key={id} id={id} label={label} icon={<Icon size={15}/>} tasks={visible.filter(task=>matchesTaskFilters(task,values))} projectNames={names} ownerId={owner} chatEnabled={false} onOpenTask={task=>inspect(task)} onOpenConversation={task=>inspect(task)}/>)}</div>}
        {view==='列表'&&<TaskListRows tasks={visible} ownerId={owner} project={project} conversation={conversation} selectedId={open?selected.id:undefined} emptyText={empty?'暂无任务':'没有匹配任务，请调整筛选。'} onInspect={task=>inspect(task)} onOpenConversation={task=>inspect(task)} chatEnabled/>}
        {view==='运行记录'&&<>{visible.length>0&&<div className="task-panel-history-choice"><span>查看任务</span><WorkbenchOptionMenu label="选择运行记录任务" className="task-panel-menu task-panel-task-choice" value={chosen?.id??''} display={chosen?undefined:'选择任务'} options={visible.map(task=>({value:task.id,label:taskTitle(task)}))} onSelect={id=>{const task=tasks.find(row=>row.id===id);if(task){setSelected(task);setRunId(null);}}}/><small>{runs.length} 次运行</small></div>}<TaskRunRows runs={runs} selectedId={open?runId:undefined} emptyText={chosen?'这项任务尚未运行。':empty?'暂无运行记录':visible.length?'选择任务查看运行记录':'没有匹配任务，请调整筛选。'} onInspect={id=>{if(chosen)inspect(chosen,id);}}/></>}
      </section>
    </main>
    <ContextSidebar section="tasks" conversationTitle={conversation(selected)} conversationMode="工作" conversationView="existing" projectTitle={project(selected.project_id)} taskProjectTitle={project(selected.project_id)} automationTab="技能" open={open} closing={false} onClose={()=>setOpen(false)} taskContentRef={setContainer} knowledgeItem={{title:'',scope:'',updated:'',tags:[]}} skill={{title:'',version:'',status:'',description:'',runs:0}} workflow={{title:'',version:'',description:'',status:'',steps:[],runs:0,updated:'',owner:''}} task={selected} conversationTask={null}/>
    {open&&container&&createPortal(<div className="task-panel-detail"><div className="task-detail-status"><span className={`task-status task-status--${selected.status}`}>{taskStatusLabel(selected.status)}</span><small>{project(selected.project_id)}</small></div><p className="task-panel-run-note">样例详情，仅用于设计预览。</p><details className="task-detail-fold" open><summary>任务目标</summary><div className="task-detail-fold__body"><p>{selected.objective}</p></div></details><details className="task-detail-fold" open><summary>运行结果</summary><div className="task-detail-fold__body">{shown?<><p className="task-panel-run-note">{taskDate(shown.started_at)} · {shown.status==='completed'?'运行成功':taskStatusLabel(shown.status)}</p><MessageBody content={shown.output}/></>:<p>这项样例任务尚未运行。</p>}</div></details></div>,container)}
  </div>;
}
createRoot(document.getElementById('root')!).render(<Preview/>);
