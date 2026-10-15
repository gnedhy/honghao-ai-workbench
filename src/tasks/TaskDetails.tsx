import {lazy,Suspense,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {ArrowLeft,CheckCircle2,ChevronRight,Play,Square} from 'lucide-react';
import {acceptTask,fetchJson,fetchMessages,workspaceHeaders} from '../api';
import {useUnsavedChanges} from '../components/Interaction';
import {WorkbenchOptionMenu} from '../components/WorkbenchMenus';
import {PageState} from '../components/WorkbenchLayout';
import type {useTaskRuns} from '../chat/useTaskRuns';
import {useConversationExecution} from '../chat/useConversationExecution';
import {taskStatusLabel,taskTitle,taskDate} from '../taskPresentation';
import type {TaskItem} from '../types';

const MessageBody=lazy(()=>import('../chat/MessageBody'));
export type TaskDetailAction='start'|'stop'|'progress'|'result';

export function TaskDetails({task,ownerId,projectTitle,conversationTitle,chatEnabled,history,action,onActionHandled,runId,onRunChange,onTaskOpen,onTaskSaved,onDataRetry,onAccessLost}:{
  task:TaskItem;ownerId:string;projectTitle:string;conversationTitle:string;chatEnabled:boolean;runId:string|null;
  action:{kind:TaskDetailAction}|null;
  onActionHandled:()=>void;
  history:ReturnType<typeof useTaskRuns>;
  onRunChange:(id:string)=>void;onTaskOpen:(task:TaskItem)=>void;onTaskSaved:(task:TaskItem)=>void;onDataRetry:()=>void;onAccessLost:(error:unknown)=>void;
}) {
  const title=useRef<HTMLHeadingElement>(null);
  const previousFocus=useRef(document.activeElement as HTMLElement|null);
  useLayoutEffect(()=>{
    const previous=previousFocus.current;const panel=title.current?.closest('.context-sidebar');
    title.current?.closest('.context-sidebar__body')?.scrollTo({top:0});title.current?.focus({preventScroll:true});
    return()=>{if(previous?.isConnected&&(document.activeElement===document.body||panel?.contains(document.activeElement)))previous.focus({preventScroll:true});};
  },[]);
  const runs=history.rows.filter(row=>row.task_id===task.id);
  const latest=runs.find(row=>row.phase!=='ended')??runs.at(-1);
  const writable=chatEnabled&&task.owner_id===ownerId;
  const [input,setInput]=useState<string>();const [inputError,setInputError]=useState('');const [inputRetry,setInputRetry]=useState(0);
  const lost=useRef(onAccessLost);lost.current=onAccessLost;
  useEffect(()=>{
    if(!writable||task.status!=='created'||history.state!=='ready'||latest||input)return;
    const controller=new AbortController();setInputError('');
    void fetchMessages(task.conversation_id,controller.signal,ownerId).then(rows=>{
      if(controller.signal.aborted)return;
      const accepted=rows.find(row=>row.task_id===task.id&&row.role==='user'&&row.mode==='work'&&!row.execution_status);
      if(accepted)setInput(accepted.id);else setInputError('没有可开始的工作输入，请刷新任务。');
    }).catch(error=>{
      if(controller.signal.aborted)return;
      if([401,403,404].includes((error as {status?:number}).status??0))lost.current(error);
      else setInputError('工作输入读取失败，请重新读取。');
    });
    return()=>controller.abort();
  },[writable,task.id,task.conversation_id,task.status,history.state,latest,ownerId,input,inputRetry]);
  const execution=useConversationExecution(ownerId,writable?task.conversation_id:undefined,writable?latest?.input_message_id??input:undefined,
    ()=>{onDataRetry();history.reload();},onAccessLost);
  const run=runs.find(row=>row.id===runId)??latest;
  const shownRun=run&&execution.run?.id===run.id?{...run,...execution.run}:run;
  const [reviewBusy,setReviewBusy]=useState(false);const [reviewIssue,setReviewIssue]=useState('');const [unconfirmed,setUnconfirmed]=useState(false);
  const reviewOperation=useRef(false);const reviewTarget=useRef<string|null>(null);const live=useRef(true);
  useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  useUnsavedChanges(false,reviewBusy,'正在确认验收操作，请稍后再离开。','workbench-before-leave');
  const reconcileReview=async()=>{
    try{
      const saved=await fetchJson<TaskItem>(`/api/tasks/${task.id}`,{headers:workspaceHeaders(ownerId)});
      if(!live.current)return;
      onTaskSaved(saved);setUnconfirmed(false);history.reload();
      setReviewIssue(saved.status==='completed'&&saved.latest_run===reviewTarget.current?'':'任务状态已更新，请查看最新结果后验收。');
    }catch(error){if(!live.current)return;if([401,403,404].includes((error as {status?:number}).status??0)){lost.current(error);onDataRetry();}setReviewIssue('验收结果未确认，请重新读取。');}
  };
  const review=async()=>{
    if(reviewOperation.current||execution.busy)return;
    reviewOperation.current=true;setReviewBusy(true);
    try{
      if(unconfirmed){await reconcileReview();return;}
      if(task.status!=='review'||!latest||latest.id!==shownRun?.id||latest.status!=='completed'||latest.phase!=='ended'||history.state!=='ready')return;
      reviewTarget.current=latest.id;
      try{const saved=await acceptTask(task,latest.id,ownerId);if(live.current){onTaskSaved(saved);history.reload();setReviewIssue('');}}
      catch(error){if(!live.current)return;if([401,403,404].includes((error as {status?:number}).status??0)){lost.current(error);onDataRetry();setReviewIssue('当前任务不可验收，请刷新。');}else{setUnconfirmed(true);await reconcileReview();}}
    }finally{reviewOperation.current=false;if(live.current)setReviewBusy(false);}
  };
  const performed=useRef<typeof action>(null);const revealed=useRef<typeof action>(null);
  const progress=useRef<HTMLDetailsElement>(null);const result=useRef<HTMLDetailsElement>(null);
  useEffect(()=>{
    if(!action||performed.current===action||!writable||!execution.confirmed||execution.busy)return;
    if(action.kind==='start'&&task.status==='created'&&execution.ready&&!execution.run){performed.current=action;onActionHandled();execution.start();}
    if(action.kind==='stop'&&execution.active&&!execution.run?.stop_requested){performed.current=action;onActionHandled();execution.stop();}
  },[action,writable,task.status,execution,onActionHandled]);
  useLayoutEffect(()=>{
    if(!action||revealed.current===action)return;
    const fold=action.kind==='result'?result.current:progress.current;
    if(fold){fold.open=true;revealed.current=action;}
  },[action,shownRun?.id]);
  const conversationAction=task.owner_id!==ownerId?'查看来源会话':task.status==='completed'?'延伸任务':task.status==='review'?'继续修改':task.status==='created'?'查看来源会话':task.status==='running'?'查看对话':'继续处理';
  return <section className="task-panel-detail">
    <h2 className="sr-only" ref={title} tabIndex={-1}>{taskTitle(task)}</h2>
    <div className="task-detail-status"><span className={`task-status task-status--${task.status}`}>{taskStatusLabel(task.status)}</span><small title={projectTitle}>{projectTitle}</small></div>
    <div className="task-panel-detail-actions">
      {task.owner_id===ownerId&&(task.status==='review'||unconfirmed)&&<button className="tool-action" type="button" disabled={reviewBusy||execution.busy||(!unconfirmed&&(history.state!=='ready'||latest?.id!==shownRun?.id||latest?.status!=='completed'||latest?.phase!=='ended'))} onClick={()=>void review()}><CheckCircle2 size={16}/><span><strong>{reviewBusy?'正在确认验收…':unconfirmed?'重新读取验收结果':'验收通过'}</strong></span></button>}
      {writable&&task.status==='created'&&!latest&&<button className="tool-action" type="button" disabled={!input||!execution.ready||!execution.confirmed||execution.busy} onClick={execution.start}><Play size={16}/><span><strong>{execution.busy?'正在开始…':'开始任务'}</strong></span></button>}
      <button className="tool-action" type="button" disabled={!chatEnabled||execution.busy||reviewBusy||unconfirmed} onClick={()=>onTaskOpen(task)}><ArrowLeft size={16}/><span><strong>{conversationAction}</strong></span></button>
      {writable&&execution.active&&<button className="tool-action" type="button" disabled={execution.busy||!execution.confirmed||Boolean(execution.run?.stop_requested)} onClick={execution.stop}><Square size={16}/><span><strong>{execution.busy||execution.run?.stop_requested?'正在停止…':'停止任务'}</strong></span></button>}
    </div>
    {reviewIssue&&<PageState error>{reviewIssue}</PageState>}
    {task.status==='review'&&<p className="task-panel-caption">查看最新结果后验收；需要调整可继续修改。</p>}
    {inputError&&<PageState error onRetry={()=>setInputRetry(value=>value+1)}>{inputError}</PageState>}
    {writable&&task.status==='created'&&input&&!execution.ready&&!execution.error&&<p className="task-panel-caption">{execution.availability}</p>}
    {!chatEnabled&&<p className="task-panel-caption">聊天模块当前不可用，任务详情仍可查看。</p>}
    {execution.error&&<PageState error onRetry={execution.reconcile}>{execution.error}</PageState>}
    <details className="task-detail-fold">
      <summary aria-label="任务信息"><span>任务信息</span><ChevronRight size={14}/></summary>
      <dl className="ai-run-properties"><dt>项目</dt><dd>{projectTitle}</dd><dt>来源会话</dt><dd>{conversationTitle}</dd><dt>创建时间</dt><dd>{taskDate(task.created_at)}</dd></dl>
      <h3>任务目标</h3><Suspense fallback={<PageState>正在加载内容…</PageState>}><MessageBody content={task.objective}/></Suspense>
    </details>
    {history.state==='loading'&&!runs.length&&<PageState>正在读取运行记录…</PageState>}
    {history.state==='error'&&<PageState error onRetry={history.reload}>运行记录读取失败，已确认记录保留。</PageState>}
    {history.state==='ready'&&!runs.length&&<p>这项任务尚未运行。</p>}
    {runs.length>1&&<WorkbenchOptionMenu label="查看任务运行" className="task-detail-run-menu" value={shownRun?.id??''} options={[...runs].reverse().map((row,index)=>({value:row.id,label:`第 ${runs.length-index} 次 · ${taskStatusLabel(row.status)} · ${taskDate(row.started_at)}`}))} onSelect={onRunChange}/>}
    {shownRun&&<>
      <details className="task-detail-fold" ref={progress}>
        <summary aria-label="运行详情"><span>运行详情</span><small>{taskStatusLabel(shownRun.status)}</small><ChevronRight size={14}/></summary>
        <dl className="ai-run-properties"><dt>本次状态</dt><dd>{taskStatusLabel(shownRun.status)}</dd><dt>开始</dt><dd>{taskDate(shownRun.started_at)}</dd><dt>结束</dt><dd>{shownRun.ended_at?taskDate(shownRun.ended_at):'执行中'}</dd></dl>
        {shownRun.accepted_at&&<p className="task-panel-run-note">本人验收通过 · {taskDate(shownRun.accepted_at)}</p>}
        {shownRun.stop_reason&&<p className="task-panel-run-note">{reason(shownRun.stop_reason)}</p>}
      </details>
      <details className="task-detail-fold" ref={result}>
        <summary aria-label="本次回复"><span>本次回复</span><small>{shownRun.phase!=='ended'?shownRun.output?'正在回复…':'准备回复…':shownRun.output?'已保存回复':'没有正文'}</small><ChevronRight size={14}/></summary>
        {shownRun.output?<Suspense fallback={<PageState>正在加载回复…</PageState>}><MessageBody content={shownRun.output} pending={shownRun.phase!=='ended'}/></Suspense>:<p>{shownRun.phase==='ended'?'没有已保存的正文。':'正在准备回复…'}</p>}
      </details>
    </>}
  </section>;
}
function reason(value:string){return ({queue_expired:'等待已超时，请重新提交。',budget_exhausted:'本月 AI 预算已用完，请联系管理员调整额度。',configuration_changed:'所选模型或推理档位已停止开放，请重新选择后继续。',user_stop:'本次运行已停止，可以在会话中继续补充。',controller_restart:'服务重启后本次运行已中断，可在会话中继续。',permission_changed:'授权已变化，本次运行已受阻。',time_budget:'运行达到时间预算，请缩小目标后继续。',model_budget:'运行达到模型预算，请核对后继续。',model_failed:'模型回复未完成，可在会话中继续。',runtime_recovery:'执行清理尚未确认，请联系维护者。'} as Record<string,string>)[value]??'本次运行未完成；已确认记录保留，可在会话中继续。';}
