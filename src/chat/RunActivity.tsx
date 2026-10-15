import {lazy,Suspense,useEffect,useRef,useState} from 'react';
import {ChevronRight,FileText,LoaderCircle,Sparkles} from 'lucide-react';
import {fetchExecution,type ConversationExecution} from '../api';
import type {ConversationMessage} from '../types';
import {taskStatusLabel} from '../taskPresentation';

const MessageBody=lazy(()=>import('./MessageBody'));
export function RunActivity({ownerId,message,liveRun,onAccessLost}:{ownerId:string;message:ConversationMessage;liveRun:ConversationExecution|null;onAccessLost:()=>void}) {
  const [loaded,setLoaded]=useState<ConversationExecution|null>(null);const [loading,setLoading]=useState(false);const [error,setError]=useState('');
  const read=useRef<AbortController|null>(null);const mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;read.current?.abort();};},[]);
  if(liveRun?.phase==='ended'&&loaded?.event_seq!==liveRun.event_seq)setLoaded(liveRun);
  const run=liveRun??loaded;const status=run?.status??message.execution_status;
  const started=run?.started_at??message.execution_started_at;const ended=run?.ended_at??message.execution_ended_at;
  const duration=started&&ended?Date.parse(ended)-Date.parse(started):NaN;
  const seconds=Number.isFinite(duration)?Math.max(0,Math.round(duration/1000)):null;
  const active=status==='queued'||status==='running'||status==='waiting';
  const elapsed=seconds===null?'':seconds<1?' 不到 1 秒':seconds<60?` ${seconds} 秒`:` ${Math.floor(seconds/60)} 分 ${seconds%60} 秒`;
  const compacting=active&&message.mode==='work'&&run?.context_compacting&&!run.stop_requested;
  const label=status==='queued'?'排队中，可取消等待':active&&run?.stop_requested?'正在停止回复':status==='completed'?`已处理${elapsed}`:status==='waiting'?'等待补充':active?run?.output?'正在回复':run?.thinking_started?'正在思考':run?.phase==='starting'?'准备回复':'正在处理':status?taskStatusLabel(status):'处理记录';
  const load=async()=>{
    read.current?.abort();const controller=new AbortController();read.current=controller;setLoading(true);setError('');
    try{const value=await fetchExecution(message.conversation_id,message.id,controller.signal,ownerId);if(mounted.current&&!controller.signal.aborted){setLoaded(current=>current&&value&&current.event_seq>value.event_seq?current:value);if(!value)setError('该消息没有可读取的处理记录。');}}
    catch(failure){if(mounted.current&&!controller.signal.aborted){if([401,403,404].includes((failure as {status?:number}).status??0))onAccessLost();else setError('处理记录读取失败，请重试。');}}
    finally{if(mounted.current&&read.current===controller)setLoading(false);}
  };
  if(compacting)return <div className="conversation-retry conversation-compaction" role="status"><span><FileText size={14} aria-hidden="true"/>正在精简上下文</span></div>;
  return <details className="run-activity" onToggle={event=>{if(event.currentTarget.open){if(!run&&!loading)void load();}else read.current?.abort();}}>
    <summary>{active?<LoaderCircle size={14} className="run-activity__spinner" aria-hidden="true"/>:<Sparkles size={14} aria-hidden="true"/>}<span>{label}</span><ChevronRight size={13} className="run-activity__chevron" aria-hidden="true"/></summary>
    <div className="run-activity__content">
      {loading&&!run&&<p role="status">正在读取处理记录…</p>}
      {error&&<p role="alert">{error}<button className="secondary-button" type="button" onClick={()=>void load()}>重试读取</button></p>}
      {run&&<><ol>{(run.activity??[]).map(step=><li key={step.seq}><span>{step.status==='queued'?'进入队列':step.thinking?'开始思考':step.model_stream_started?'收到模型响应':step.phase==='starting'?'准备回复':step.phase==='generating'?'开始处理':taskStatusLabel(step.status)}</span>{step.at&&<time dateTime={step.at}>{new Date(step.at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}</time>}</li>)}</ol>
        {run.thinking_summary?<section aria-label="思考摘要"><h3>思考摘要</h3><Suspense fallback={<p>{run.thinking_summary}</p>}><MessageBody content={run.thinking_summary} pending/></Suspense></section>:<p className="run-activity__note">模型未提供可展示的思考摘要。</p>}
        {run.stop_reason&&<p>{taskStatusLabel(run.status)}，已生成的内容保留。</p>}
        {message.mode==='work'&&run.context_compacting===false&&<p className="run-activity__note">已自动整理上下文，继续当前任务。</p>}
      </>}
    </div>
  </details>;
}
