import {useEffect,useRef,useState} from 'react';
import {MessageCircle} from 'lucide-react';
import {Composer} from '../components/Composer';
import {SegmentedControl} from '../components/SegmentedControl';
import {WorkbenchOptionMenu} from '../components/WorkbenchMenus';
import {PageState} from '../components/WorkbenchLayout';
import {TopBar,type ScreenChromeProps} from '../components/TopBar';
import {useConversationExecution} from '../chat/useConversationExecution';
import {useMessageDraft} from '../chat/useMessageDraft';
import type {useChatWorkspace} from '../chat/useChatWorkspace';
import type {ConversationView,Project,TaskItem} from '../types';
import {taskStatusLabel} from '../taskPresentation';

export function ConversationScreen({view,conversationId,conversationTitle,mode,onModeChange,onEntryMode,projects,projectId,onProjectChange,ownerId,workspace,task,tasks,tasksEnabled,onTaskChange,onAccessLost,...chrome}: ScreenChromeProps & {
  view:ConversationView;conversationId:string|null;conversationTitle:string;mode:'聊天'|'工作';onModeChange:(mode:'聊天'|'工作')=>void;onEntryMode:(mode:'聊天'|'工作')=>void;
  projects:Project[];projectId:string|null;onProjectChange:(id:string|null)=>void;ownerId:string;
  workspace:ReturnType<typeof useChatWorkspace>;task:TaskItem|null;tasks:TaskItem[];tasksEnabled:boolean;onTaskChange:(id:string)=>void;onAccessLost:()=>void;
}) {
  const {messages,messagesState,projectAssociation}=workspace;
  const [selectedInput,setSelectedInput]=useState<string|null>(null);
  const inputs=messages.filter(message=>message.role!=='assistant'&&message.role!=='tool');
  const input=inputs.find(message=>message.id===workspace.active?.input_message_id)??inputs.find(message=>message.id===selectedInput)??inputs.at(-1);
  const readonly=view==='existing'&&workspace.conversations.find(row=>row.id===conversationId)?.owner_id!==ownerId;
  const eligible=view==='existing'&&!readonly&&Boolean(input);
  const execution=useConversationExecution(ownerId,eligible?conversationId??undefined:undefined,eligible?input?.id:undefined,workspace.refreshExecution,onAccessLost,workspace.executionRevision);
  const draft=useMessageDraft(`${ownerId}/${view}/${conversationId}/${workspace.draftEpoch}`,{
    conversationId:view==='existing'?conversationId:null,projectId,mode:mode==='工作'?'work':'chat',taskId:mode==='工作'?task?.id:undefined
  },workspace.accept,workspace.handleLost);
  const changing=execution.active||execution.busy||draft.busy;
  const disabled=readonly||changing||messagesState!=='ready'||Boolean(eligible&&!execution.confirmed)||(mode==='工作'&&(!tasksEnabled||tasks.length>1&&!task));
  const entered=useRef<string|null>(null);
  const entryMode=useRef(onEntryMode);entryMode.current=onEntryMode;
  useEffect(()=>{
    if(view==='existing'&&conversationId&&entered.current!==conversationId&&messagesState==='ready'){
      entered.current=conversationId;const last=inputs.at(-1);
      if(last)entryMode.current(task?'工作':last.mode==='work'?'工作':'聊天');
    }
  },[conversationId,view,messagesState,inputs,task]);
  useEffect(()=>{setSelectedInput(null);},[conversationId]);
  const scroller=useRef<HTMLDivElement>(null);const follow=useRef(true);
  useEffect(()=>{if(follow.current&&scroller.current)scroller.current.scrollTop=scroller.current.scrollHeight;},[messages,execution.run?.output]);
  const projectTitle=projects.find(row=>row.id===projectId)?.title;
  const frozenTitle=projects.find(row=>row.id===task?.project_id)?.title;
  const submit=async()=>{await draft.submit();setSelectedInput(null);};
  const composer=<Composer readOnly={readonly} compact={mode==='聊天'} empty={view==='new'} mode={mode} value={draft.value} onChange={draft.setValue} onSubmit={()=>void submit()} projects={projects} projectId={projectId} onProjectChange={onProjectChange} projectSaving={readonly||projectAssociation.busy||changing} busy={draft.busy} disabled={disabled} />;
  const status=execution.run?execution.run.stop_requested&&execution.active?'正在确认停止…':execution.run.phase==='starting'?'正在启动执行…':taskStatusLabel(execution.run.status):execution.ready?'已接受消息 · 待执行':execution.availability;
  return <main className="app-main conversation-screen">
    <TopBar {...chrome} title={view==='new'?'新聊天':conversationTitle} subtitle={task?`任务：${task.objective}`:mode==='工作'?'新工作':'聊天问答'}
      tabs={<SegmentedControl value={mode} options={['聊天','工作'] as const} disabled={changing} onChange={onModeChange} label="会话模式"/>}/>
    {(task||projectTitle||tasks.length>1)&&<div className="ai-conversation-source">
      <span>会话项目：{projectTitle??'未关联'}</span>{task&&<span>任务归属：{frozenTitle??'未关联项目'} · {taskStatusLabel(task.status)}</span>}
      {tasks.length>1&&<WorkbenchOptionMenu label="选择继续任务" value={task?.id??''} options={tasks.map(row=>({value:row.id,label:row.objective,disabled:changing}))} onSelect={onTaskChange}/>}
    </div>}
    {projectAssociation.error&&<PageState error onRetry={projectAssociation.retry}>{projectAssociation.error}</PageState>}
    {readonly&&<PageState>这是无主历史会话，仅供只读查看。</PageState>}
    {mode==='工作'&&!tasksEnabled&&<PageState>任务模块当前不可用，请切换聊天问答。</PageState>}
    {tasks.length>1&&!task&&mode==='工作'&&<PageState>请选择要继续的任务；历史任务保持各自独立。</PageState>}
    {view==='new'?<section className={`new-conversation-empty new-conversation-empty--${mode==='工作'?'work':'chat'}`}><div className="new-conversation-empty__content"><h1>{mode==='工作'?'我们该处理什么工作？':'随时可以开始。'}</h1>{composer}{draft.error&&<PageState error>{draft.error}</PageState>}</div></section>:
      <section className="work-thread"><div className="work-thread__messages" ref={scroller} onScroll={event=>{const node=event.currentTarget;follow.current=node.scrollHeight-node.scrollTop-node.clientHeight<60;}}>
        {messagesState==='loading'&&<PageState>正在读取会话…</PageState>}
        {messagesState==='error'&&<PageState error onRetry={()=>void workspace.readMessages().catch(()=>{})}>会话内容读取失败，已确认正文保留。</PageState>}
        {messagesState==='ready'&&!messages.length&&<div className="conversation-empty-state"><MessageCircle size={18}/><p>这个会话还没有内容。</p></div>}
        {messages.map(message=><div className="conversation-entry" key={message.id}>
          <div className={`chat-turn chat-turn--${message.role==='assistant'?'assistant':'user'}`}><p>{message.content}</p></div>
          {message.role==='user'&&message.owner_id===ownerId&&<button className="ai-message-action" type="button" disabled={changing} aria-pressed={message.id===input?.id} onClick={()=>setSelectedInput(message.id)}>查看本次执行</button>}
          {message.id===input?.id&&eligible&&<div className="ai-run-state conversation-state" aria-live="polite"><span>{status}</span>
            {!execution.run&&execution.ready&&<button className="secondary-button" type="button" disabled={execution.busy||!execution.confirmed} onClick={execution.start}>开始执行</button>}
            {execution.active&&<button className="secondary-button" type="button" disabled={execution.busy||!execution.confirmed||Boolean(execution.run?.stop_requested)} onClick={execution.stop}>停止执行</button>}
          </div>}
          {message.id===input?.id&&execution.run?.output&&!messages.some(row=>row.run_id===execution.run?.id)&&<div className="chat-turn chat-turn--assistant"><p>{execution.run.output}</p></div>}
        </div>)}
        {execution.run?.phase==='ended'&&execution.run.status!=='completed'&&<p className="conversation-state">本次执行已结束，已确认正文保留；新消息可继续当前任务。</p>}
        {execution.error&&<PageState error>{execution.error}<button className="secondary-button" type="button" onClick={execution.reconcile}>重新读取执行状态</button></PageState>}
        {workspace.startIssue&&!execution.active&&!execution.run&&<PageState error onRetry={execution.reconcile}>{workspace.startIssue}</PageState>}
        {draft.error&&<PageState error onRetry={()=>void draft.submit()}>{draft.error}</PageState>}
      </div>{composer}</section>}
    {draft.unknown&&view==='new'&&<PageState error onRetry={()=>void draft.submit()}>重新确认原提交结果</PageState>}
    {draft.confirmation}
  </main>;
}
