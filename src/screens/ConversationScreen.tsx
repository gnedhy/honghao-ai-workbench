import {lazy,Suspense,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {MessageCircle,RotateCw} from 'lucide-react';
import {createClientId} from '../clientId';
import {Composer} from '../components/Composer';
import {SegmentedControl} from '../components/SegmentedControl';
import {WorkbenchOptionMenu} from '../components/WorkbenchMenus';
import {PageState} from '../components/WorkbenchLayout';
import {TopBar,type ScreenChromeProps} from '../components/TopBar';
import {useConversationExecution} from '../chat/useConversationExecution';
import {useMessageDraft} from '../chat/useMessageDraft';
import type {useChatWorkspace} from '../chat/useChatWorkspace';
import type {ConversationView,Project,TaskItem} from '../types';
import {taskStatusLabel,taskTitle} from '../taskPresentation';
import {RunActivity} from '../chat/RunActivity';
import {useModelSelection} from '../chat/ModelSelection';

const MessageBody=lazy(()=>import('../chat/MessageBody'));
const contextTokens=(value:number)=>`${Number((value/1000).toPrecision(3))}K`;

export function ConversationScreen({view,conversationId,conversationTitle,mode,onModeChange,onEntryMode,projects,projectId,onProjectChange,ownerId,workspace,task,tasks,tasksEnabled,onTaskChange,onAccessLost,...chrome}: ScreenChromeProps & {
  view:ConversationView;conversationId:string|null;conversationTitle:string;mode:'聊天'|'工作';onModeChange:(mode:'聊天'|'工作')=>void;onEntryMode:(mode:'聊天'|'工作')=>void;
  projects:Project[];projectId:string|null;onProjectChange:(id:string|null)=>void;ownerId:string;
  workspace:ReturnType<typeof useChatWorkspace>;task:TaskItem|null;tasks:TaskItem[];tasksEnabled:boolean;onTaskChange:(id:string)=>void;onAccessLost:()=>void;
}) {
  const {messagesState,projectAssociation}=workspace;
  const messages=workspace.messages.filter(message=>message.conversation_id===conversationId);
  const [selectedInput,setSelectedInput]=useState<string|null>(null);
  const [retrying,setRetrying]=useState(false);const [retryError,setRetryError]=useState('');
  const retryRequest=useRef<{messageId:string;key:string}|null>(null);const retryBusy=useRef(false);
  const inputs=messages.filter(message=>message.role!=='assistant'&&message.role!=='tool');
  const input=inputs.find(message=>message.id===workspace.active?.input_message_id)??inputs.find(message=>message.id===selectedInput)??inputs.at(-1);
  const inputIndex=messages.findIndex(message=>message.id===input?.id);
  const nextInput=messages.findIndex((message,index)=>index>inputIndex&&message.role==='user');
  const hasReply=inputIndex>=0&&messages.slice(inputIndex+1,nextInput<0?undefined:nextInput).some(message=>message.role==='assistant');
  const readonly=view==='existing'&&workspace.conversations.find(row=>row.id===conversationId)?.owner_id!==ownerId;
  const eligible=view==='existing'&&!readonly&&Boolean(input);
  const modelSelection=useModelSelection(ownerId,onAccessLost);
  const execution=useConversationExecution(ownerId,eligible?conversationId??undefined:undefined,eligible?input?.id:undefined,workspace.refreshExecution,onAccessLost,workspace.executionRevision,modelSelection.selection);
  const draft=useMessageDraft(`${ownerId}/${view}/${conversationId}/${workspace.draftEpoch}`,{
    conversationId:view==='existing'?conversationId:null,projectId:mode==='工作'?projectId:null,mode:mode==='工作'?'work':'chat',taskId:mode==='工作'?task?.id:undefined,selection:modelSelection.selection
  },workspace.accept,workspace.handleLost);
  const changing=execution.active||execution.busy||draft.busy||retrying;
  const disabled=readonly||changing||!modelSelection.ready||messagesState!=='ready'||Boolean(eligible&&!execution.confirmed)||(mode==='工作'&&(!tasksEnabled||tasks.length>1&&!task));
  const entered=useRef<string|null>(null);
  const entryMode=useRef(onEntryMode);entryMode.current=onEntryMode;
  useEffect(()=>{
    if(view==='new'){entered.current=null;return;}
    if(view==='existing'&&conversationId&&entered.current!==conversationId&&messagesState==='ready'){
      const last=inputs.filter(message=>message.conversation_id===conversationId).at(-1);
      if(last){entered.current=conversationId;entryMode.current(task?'工作':last.mode==='work'?'工作':'聊天');}
    }
  },[conversationId,view,messagesState,inputs,task]);
  useEffect(()=>{setSelectedInput(null);},[conversationId]);
  const scroller=useRef<HTMLDivElement>(null);const follow=useRef(true);
  const [visibleInput,setVisibleInput]=useState<string|null>(null);
  const [mapPreview,setMapPreview]=useState<{id:string;text:string;top:number}|null>(null);
  const preview=(node:HTMLButtonElement,row:typeof inputs[number])=>{const top=node.getBoundingClientRect().top-(node.closest('.conversation-screen')?.getBoundingClientRect().top??0);setMapPreview({id:row.id,text:row.content,top:top+10});};
  useLayoutEffect(()=>{if(follow.current&&scroller.current)scroller.current.scrollTop=scroller.current.scrollHeight;},[messages,execution.run?.output]);
  const projectTitle=projects.find(row=>row.id===projectId)?.title;
  const frozenTitle=projects.find(row=>row.id===task?.project_id)?.title;
  const submit=async()=>{await draft.submit();setSelectedInput(null);};
  const failed=execution.run?.phase==='ended'&&['failed','blocked'].includes(execution.run.status)&&input?.id===inputs.at(-1)?.id;
  const retry=async()=>{
    if(!failed||!input||!eligible||changing||retryBusy.current)return;
    retryBusy.current=true;setRetrying(true);setRetryError('');
    if(retryRequest.current?.messageId!==input.id)retryRequest.current={messageId:input.id,key:createClientId()};
    try{await workspace.accept({conversationId:conversationId!,projectId:mode==='工作'?projectId:null,mode:input.mode,taskId:input.task_id??undefined,content:input.content,key:retryRequest.current.key,selection:modelSelection.selection});retryRequest.current=null;setSelectedInput(null);}
    catch(error){if(!workspace.handleLost(error))setRetryError('重试结果尚未确认，请再次重试。');}
    finally{retryBusy.current=false;setRetrying(false);}
  };
  const context=execution.run?.context_usage;
  const usedPercent=context?Math.min(100,Math.max(0,Math.round(context.used_tokens/context.window_tokens*1000)/10)):0;
  const contextInfo=context&&<details className="conversation-context-window"
    onPointerEnter={event=>{if(event.pointerType==='mouse')event.currentTarget.open=true;}}
    onPointerLeave={event=>{if(event.pointerType==='mouse')event.currentTarget.open=false;}}
    onBlur={event=>{event.currentTarget.open=false;}}
    onKeyDown={event=>{if(event.key==='Escape')event.currentTarget.open=false;}}>
    <summary aria-label={`背景信息窗口：${usedPercent}% 已用`} aria-describedby="context-window-info" onClick={event=>{
      if('pointerType' in event.nativeEvent?event.nativeEvent.pointerType==='mouse':event.detail>0&&window.matchMedia('(hover: hover)').matches)event.preventDefault();
    }}>
      <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="2" opacity=".25"/><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="2" pathLength="100" strokeDasharray={`${usedPercent} 100`} transform="rotate(-90 10 10)"/></svg>
    </summary>
    <div id="context-window-info" role="tooltip"><strong>背景信息窗口：</strong><span>{usedPercent}% 已用</span><span>已用 {contextTokens(context.used_tokens)} 标记，共 {contextTokens(context.window_tokens)}</span></div>
  </details>;
  const composer=<Composer modelControl={modelSelection.control(changing||readonly)} contextInfo={contextInfo} readOnly={readonly} compact={mode==='聊天'} empty={view==='new'} mode={mode} value={draft.value} onChange={draft.setValue} onSubmit={()=>void submit()} onStop={execution.active?execution.stop:undefined} stopDisabled={!execution.confirmed||Boolean(execution.run?.stop_requested)} projects={projects} projectId={projectId} onProjectChange={onProjectChange} projectSaving={readonly||projectAssociation.busy||changing} busy={draft.busy||execution.busy} disabled={disabled} />;
  const status=execution.run?execution.run.stop_requested&&execution.active?'正在确认停止…':execution.run.phase==='starting'?'正在启动执行…':taskStatusLabel(execution.run.status):execution.ready?'已接受消息 · 待执行':execution.availability;
  return <main className="app-main conversation-screen">
    <TopBar {...chrome} title={view==='new'?'新聊天':conversationTitle} subtitle={mode==='工作'&&task?`任务：${taskTitle(task)}`:mode==='工作'?'新工作':'聊天问答'}
      tabs={view==='new'?<SegmentedControl value={mode} options={['聊天','工作'] as const} disabled={changing||messagesState!=='ready'} onChange={onModeChange} label="会话模式"/>:undefined}/>
    {mode==='工作'&&(Boolean(task&&task.project_id!==projectId)||tasks.length>1)&&<div className="ai-conversation-source">
      {task&&task.project_id!==projectId&&<span>当前任务归属：{frozenTitle??'未关联项目'} · {taskStatusLabel(task.status)}</span>}
      {tasks.length>1&&<WorkbenchOptionMenu label="选择继续任务" value={task?.id??''} options={tasks.map(row=>({value:row.id,label:taskTitle(row),disabled:changing}))} onSelect={onTaskChange}/>}
    </div>}
    {projectAssociation.error&&<PageState error onRetry={projectAssociation.retry}>{projectAssociation.error}</PageState>}
    {readonly&&<PageState>这是无主历史会话，仅供只读查看。</PageState>}
    {mode==='工作'&&!tasksEnabled&&<PageState>任务模块当前不可用；可以新建聊天会话。</PageState>}
    {tasks.length>1&&!task&&mode==='工作'&&<PageState>请选择要继续的任务；历史任务保持各自独立。</PageState>}
    {view==='new'?<section className={`new-conversation-empty new-conversation-empty--${mode==='工作'?'work':'chat'}`}>
      <div className="new-conversation-empty__content"><MessageCircle size={32} aria-hidden="true"/><h1>{mode==='工作'?projectTitle?`你想在 ${projectTitle} 中处理什么工作？`:'我们该处理什么工作？':'随时可以开始。'}</h1></div>
      <div className="new-conversation-empty__input">{composer}{draft.error&&<PageState error>{draft.error}</PageState>}</div></section>:
      <>
        {inputs.length>1&&<nav className="conversation-map" aria-label="会话消息定位" onScroll={()=>setMapPreview(null)}>{inputs.map(row=><button type="button" key={row.id} aria-label={`定位到：${row.content}`} aria-describedby={mapPreview?.id===row.id?'conversation-map-preview':undefined} aria-current={visibleInput===row.id?'location':undefined} onMouseEnter={event=>preview(event.currentTarget,row)} onMouseLeave={()=>setMapPreview(null)} onFocus={event=>preview(event.currentTarget,row)} onBlur={()=>setMapPreview(null)} onClick={()=>{follow.current=false;document.getElementById(`message-${row.id}`)?.scrollIntoView({block:'start',behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});}}><span className="conversation-map__tick"/></button>)}</nav>}
        {mapPreview&&<span id="conversation-map-preview" className="conversation-map__label" role="tooltip" style={{top:mapPreview.top}}>{mapPreview.text}</span>}
      <section className="work-thread">
        <div className="work-thread__messages" ref={scroller} tabIndex={0} aria-label="对话内容" onScroll={event=>{const node=event.currentTarget;follow.current=node.scrollHeight-node.scrollTop-node.clientHeight<60;const visible=[...inputs].reverse().find(row=>(document.getElementById(`message-${row.id}`)?.offsetTop??Infinity)<=node.scrollTop+80);setVisibleInput(visible?.id??inputs[0]?.id??null);}}>
        {messagesState==='loading'&&!messages.length&&<PageState>正在读取会话…</PageState>}
        {messagesState==='error'&&<PageState error onRetry={()=>void workspace.readMessages().catch(()=>{})}>会话内容读取失败，已确认正文保留。</PageState>}
        {messagesState==='ready'&&!messages.length&&<div className="conversation-empty-state"><MessageCircle size={18}/><p>这个会话还没有内容。</p></div>}
        {messages.map(message=><div className={`conversation-entry conversation-entry--${message.role==='assistant'?'assistant':'user'}`} key={message.id} id={`message-${message.id}`}>
          <div className={`chat-turn chat-turn--${message.role==='assistant'?'assistant':'user'}`}>{message.role==='assistant'?<Suspense fallback={<p>{message.content}</p>}><MessageBody content={message.content}/></Suspense>:<p>{message.content}</p>}</div>
          {message.role==='user'&&((message.id===input?.id&&execution.run)||message.execution_status)&&!readonly&&<RunActivity ownerId={ownerId} key={`${ownerId}/${message.id}`} message={message} liveRun={message.id===input?.id?execution.run:null} onAccessLost={onAccessLost}/>}
          {message.id===input?.id&&execution.run?.output&&!messages.some(row=>row.run_id===execution.run?.id)&&<div className="chat-turn chat-turn--assistant"><Suspense fallback={<p>{execution.run.output}</p>}><MessageBody content={execution.run.output} pending={execution.active}/></Suspense></div>}
        </div>)}
        {eligible&&(!hasReply||execution.run||execution.confirmed)&&<div className={`ai-run-state conversation-state${!execution.run&&execution.confirmed&&!changing&&messagesState==='ready'?'':' sr-only'}`} aria-live="polite">
          <span>{execution.run?.phase==='ended'?status:execution.active?execution.run?.stop_requested?'正在停止回复…':execution.run?.output?'正在回复…':'正在准备回复…':execution.confirmed?execution.ready?'消息已接受，回复尚未开始。':execution.availability:'正在读取回复状态…'}</span>
          {!execution.run&&execution.confirmed&&!changing&&messagesState==='ready'&&!execution.ready&&!execution.error&&<button className="secondary-button" type="button" onClick={execution.reconcile}>重新读取执行状态</button>}
        </div>}
        {eligible&&execution.confirmed&&!changing&&inputs.length>1&&((!execution.run&&execution.ready)||selectedInput!==null)&&<WorkbenchOptionMenu label="选择待执行消息" value={input?.id??''} options={inputs.map(row=>({value:row.id,label:row.content,disabled:changing}))} onSelect={setSelectedInput}/>}
        {execution.run?.phase==='ended'&&execution.run.status!=='completed'&&<p className="conversation-state">{execution.run.status==='stopped'?'回复已停止。':'本次回复未完成。'}{execution.run.output?'已生成的内容已保留。':'你的消息已保留。'}{task?'可以继续补充当前任务。':'可以继续发送消息。'}</p>}
        {eligible&&execution.confirmed&&(failed||!execution.run&&execution.ready&&!changing)&&<div className="conversation-retry"><button type="button" className="secondary-button" disabled={changing} aria-busy={retrying||execution.busy} onClick={failed?()=>void retry():execution.start}><RotateCw size={14}/>{retrying?'正在重试…':'重试'}</button></div>}
        {retryError&&failed&&<p className="conversation-state" role="alert">{retryError}</p>}
        {execution.error&&<PageState error>{execution.error}<button className="secondary-button" type="button" onClick={execution.reconcile}>重新读取执行状态</button></PageState>}
        {workspace.startIssue&&!execution.active&&!execution.run&&<PageState error onRetry={execution.reconcile}>{workspace.startIssue}</PageState>}
        {draft.error&&<PageState error onRetry={()=>void draft.submit()}>{draft.error}</PageState>}
      </div>{composer}</section></>}
    {draft.unknown&&view==='new'&&<PageState error onRetry={()=>void draft.submit()}>重新确认原提交结果</PageState>}
    {draft.confirmation}
  </main>;
}
