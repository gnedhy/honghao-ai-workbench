import {useEffect,useRef,useState} from 'react';
import {Search} from 'lucide-react';
import {SegmentedControl} from '../components/SegmentedControl';
import {WorkbenchOptionMenu} from '../components/WorkbenchMenus';
import {PageState} from '../components/WorkbenchLayout';
import {Drawer} from '../components/Drawer';
import {TopBar,type ScreenChromeProps} from '../components/TopBar';
import {useTaskRuns} from '../chat/useTaskRuns';
import {taskStatusLabel} from '../taskPresentation';
import type {Conversation,Project,TaskItem} from '../types';

export function TaskBoardScreen({ownerId,tasks,projects,conversations,dataState,selectedTask,onSelectedTaskChange,onTaskOpen,chatEnabled,onDataRetry,onAccessLost,...chrome}:ScreenChromeProps & {
  ownerId:string;tasks:TaskItem[];projects:Project[];conversations:Conversation[];dataState:'loading'|'ready'|'error';selectedTask:TaskItem|null;
  onSelectedTaskChange:(task:TaskItem)=>void;onTaskOpen:(task:TaskItem)=>void;chatEnabled:boolean;onDataRetry:()=>void;onAccessLost:(error:unknown)=>void;
}) {
  const [tab,setTab]=useState<'任务管理'|'运行记录'>('任务管理');const [query,setQuery]=useState('');const [runId,setRunId]=useState<string|null>(null);
  const selected=selectedTask??(tasks.length===1?tasks[0]:null);
  const reload=useRef(onDataRetry);reload.current=onDataRetry;
  const active=tasks.some(task=>['starting','running','stopping'].includes(task.status));
  useEffect(()=>{if(!active)return;const timer=setInterval(()=>reload.current(),1500);return()=>clearInterval(timer);},[active]);
  const history=useTaskRuns(tab==='运行记录'?selected?.id:undefined,onAccessLost,ownerId);
  const run=history.rows.find(row=>row.id===runId);
  const visible=tasks.filter(task=>task.objective.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const project=(id:string|null)=>projects.find(row=>row.id===id)?.title??'未关联项目';
  return <main className="app-main"><TopBar {...chrome} title="任务看板" subtitle={tab==='任务管理'?`${tasks.length} 个任务`:'本人的真实运行记录'} tabs={<SegmentedControl value={tab} options={['任务管理','运行记录'] as const} onChange={value=>{setTab(value);setRunId(null);}} label="任务看板类型"/>}/>
    <section className="task-board"><div className="task-board__toolbar"><div><h1>{tab==='任务管理'?'任务管理':'运行记录'}</h1><p>{tab==='任务管理'?'同一目标持续沟通，补充与修改沿用原任务':'选择任务查看各轮运行'}</p></div>
      {tab==='任务管理'?<label className="search-field search-field--short"><Search size={16}/><input aria-label="搜索任务" placeholder="搜索任务" value={query} onChange={event=>setQuery(event.target.value)}/></label>:<WorkbenchOptionMenu label="选择运行记录任务" value={selected?.id??''} options={tasks.map(task=>({value:task.id,label:task.objective}))} onSelect={id=>{const task=tasks.find(row=>row.id===id);if(task){onSelectedTaskChange(task);setRunId(null);}}}/>}</div>
      {dataState==='loading'&&<PageState>正在读取任务…</PageState>}
      {dataState==='error'&&<PageState error onRetry={onDataRetry}>任务刷新失败，已确认记录保留。</PageState>}
      {tab==='任务管理'?(visible.length?<div className="task-table-wrap"><table className="task-table"><thead><tr><th>任务</th><th>状态</th><th>项目</th><th>最近运行</th><th>创建时间</th></tr></thead><tbody>{visible.map(task=><tr key={task.id}>
        <td><button className="ai-task-open" type="button" disabled={!chatEnabled} onClick={()=>onTaskOpen(task)}>{task.objective}</button><small>来自会话：{conversations.find(row=>row.id===task.conversation_id)?.title??'会话暂不可读'}{task.owner_id!==ownerId?' · 历史只读':''}</small></td>
        <td><span className={`task-status task-status--${task.status}`}>{taskStatusLabel(task.status)}</span></td><td>{project(task.project_id)}</td><td>{task.latest_run?'已有运行':'尚未运行'}</td><td>{date(task.created_at)}</td>
      </tr>)}</tbody></table></div>:dataState==='ready'&&<PageState>{query?'没有匹配任务，请更换关键词。':'尚无任务；在新会话中提交工作后会出现在这里。'}</PageState>):<>
        {!selected&&<PageState>请选择要查看的任务。</PageState>}
        {history.state==='loading'&&<PageState>正在读取运行记录…</PageState>}
        {history.state==='error'&&<PageState error onRetry={history.reload}>运行记录读取失败，已确认记录保留。</PageState>}
        {selected&&history.state==='ready'&&!history.rows.length&&<PageState>这项任务尚未运行，接受消息不等于已完成执行。</PageState>}
        <div className="ai-run-list">{[...history.rows].reverse().map((row,index)=><button type="button" key={row.id} className="ai-run-row" onClick={()=>setRunId(row.id)}><span>第 {history.rows.length-index} 次运行</span><strong>{taskStatusLabel(row.status)}</strong><small>{date(row.started_at)}</small></button>)}</div>
      </>}
    </section>
    {run&&<Drawer title="运行详情" onClose={()=>setRunId(null)}><dl className="ai-run-properties"><dt>状态</dt><dd>{taskStatusLabel(run.status)}</dd><dt>开始</dt><dd>{date(run.started_at)}</dd><dt>结束</dt><dd>{run.ended_at?date(run.ended_at):'尚未确认结束'}</dd><dt>内核版本</dt><dd>{run.runtime_version}</dd><dt>已报告用量</dt><dd>{run.reported_model_tokens>0?`${run.reported_model_tokens} tokens`:'尚无已确认用量'}</dd></dl>
      {run.stop_reason&&<PageState>{reason(run.stop_reason)}</PageState>}<h3>本次正文</h3>{run.output?<div className="ai-run-output">{run.output}</div>:<p>没有已保存的正文。</p>}
    </Drawer>}
  </main>;
}
function date(value:string){return new Intl.DateTimeFormat('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date(value));}
function reason(value:string){return ({user_stop:'用户已停止本次运行。',controller_restart:'服务重启后本次运行已中断，可提交新消息继续。',permission_changed:'授权已变化，本次运行已受阻。',time_budget:'运行达到时间预算，请缩小目标后继续。',model_budget:'运行达到模型预算，请核对后继续。',model_failed:'模型回复未完成，请检查服务后继续。',runtime_recovery:'执行清理尚未确认，请联系维护者。'} as Record<string,string>)[value]??'本次运行未完成；已确认记录保留，请核对执行环境后继续。';}
