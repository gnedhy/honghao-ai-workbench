import {useCallback,useEffect,useRef,useState} from 'react';
import {createConversationSubmission,fetchActiveExecution,fetchConversations,fetchMessages,fetchProjects,fetchTasks,startExecution,submitConversation,type ConversationExecution} from '../api';
import type {Conversation,ConversationMessage,ConversationView,Project,TaskItem} from '../types';
import {useConversationProject} from './useConversationProject';

type State='loading'|'ready'|'error';
export type Submission = {conversationId:string|null;projectId:string|null;mode:'chat'|'work';content:string;key:string;taskId?:string};
export type Acceptance={message:ConversationMessage;task:TaskItem|null;conversation?:Conversation};
const lost=(error:unknown)=>[401,403].includes((error as {status?:number}).status??0);
function merge<T extends {id:string;revision?:number}>(current:T[],incoming:T[]) {
  const rows=new Map(current.map(row=>[row.id,row]));
  for(const row of incoming)if((rows.get(row.id)?.revision??0)<=(row.revision??1))rows.set(row.id,row);
  return [...rows.values()];
}

export function useChatWorkspace(owner:string,chat:boolean,tasksEnabled:boolean,online:boolean,view:ConversationView,conversationId:string|null,onAccepted:(value:Acceptance)=>void,onAccessLost:()=>void) {
  const [projects,setProjects]=useState<Project[]>([]);
  const [conversations,setConversations]=useState<Conversation[]>([]);
  const [tasks,setTasks]=useState<TaskItem[]>([]);
  const [messages,setMessages]=useState<ConversationMessage[]>([]);
  const [state,setState]=useState<State>('loading');
  const [taskState,setTaskState]=useState<State>('loading');
  const [tasksAvailable,setTasksAvailable]=useState(true);
  const [messagesState,setMessagesState]=useState<State>('ready');
  const [active,setActive]=useState<ConversationExecution|null>(null);
  const [executionRevision,setExecutionRevision]=useState(0);
  const [startIssue,setStartIssue]=useState('');
  const [draftEpoch,setDraftEpoch]=useState(0);
  const [denied,setDenied]=useState(false);
  const mounted=useRef(true);
  const revoked=useRef(false);
  const callbacks=useRef({onAccepted,onAccessLost});callbacks.current={onAccepted,onAccessLost};
  const binding=useRef({owner,chat,tasksEnabled,view,conversationId});binding.current={owner,chat,tasksEnabled:tasksEnabled&&tasksAvailable,view,conversationId};
  const listsRead=useRef<AbortController|null>(null);
  const messageRead=useRef<AbortController|null>(null);
  const messageGeneration=useRef(0);
  const clear=useCallback(()=>{listsRead.current?.abort();messageRead.current?.abort();setProjects([]);setConversations([]);setTasks([]);setMessages([]);setActive(null);setDraftEpoch(value=>value+1);},[]);
  const handleLost=useCallback((error:unknown)=>{if(lost(error)){if(revoked.current)return true;revoked.current=true;setDenied(true);clear();callbacks.current.onAccessLost();return true;}return false;},[clear]);
  const handleTaskLost=useCallback((error:unknown)=>{
    if((error as {status?:number}).status===403){binding.current.tasksEnabled=false;setTasks([]);setTasksAvailable(false);setTaskState('error');return true;}
    return handleLost(error);
  },[handleLost]);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;listsRead.current?.abort();messageRead.current?.abort();};},[]);
  const projectSaved=useCallback((row:Project)=>{if(!revoked.current&&binding.current.chat)setProjects(current=>merge(current,[row]));},[]);
  const conversationSaved=useCallback((row:Conversation)=>{if(!revoked.current&&binding.current.chat)setConversations(current=>merge(current,[row]));},[]);
  const projectAssociation=useConversationProject(conversationSaved,values=>{if(!revoked.current&&binding.current.chat)setConversations(current=>merge(current,values));},handleLost,owner);

  const reload=useCallback(async()=>{
    listsRead.current?.abort();const controller=new AbortController();listsRead.current=controller;
    try {
      const [loadedProjects,loadedConversations,loadedTasks]=await Promise.allSettled([
        chat?fetchProjects(controller.signal,owner):Promise.resolve([]),
        chat?fetchConversations(controller.signal,owner):Promise.resolve([]),
        tasksEnabled?fetchTasks(controller.signal,owner):Promise.resolve([])]);
      if(controller.signal.aborted||!mounted.current||revoked.current)return;
      if(loadedTasks.status==='fulfilled'){
        setTasks(current=>merge(current,loadedTasks.value));setTaskState('ready');setTasksAvailable(true);
      }else{
        setTaskState('error');
        if(handleTaskLost(loadedTasks.reason)&&loadedTasks.reason?.status===401)throw loadedTasks.reason;
      }
      if(loadedProjects.status==='rejected')throw loadedProjects.reason;
      if(loadedConversations.status==='rejected')throw loadedConversations.reason;
      setProjects(current=>merge(current,loadedProjects.value));setConversations(current=>merge(current,loadedConversations.value));setState('ready');
      if(loadedTasks.status==='rejected'&&loadedTasks.reason?.status!==403)throw loadedTasks.reason;
    }catch(error){if(!controller.signal.aborted&&mounted.current){handleLost(error);setState('error');throw error;}}
  },[chat,tasksEnabled,owner,handleLost,handleTaskLost]);
  useEffect(()=>{
    if(!chat){setProjects([]);setConversations([]);setMessages([]);setActive(null);setDraftEpoch(value=>value+1);}
    if(!tasksEnabled)setTasks([]);
    if(!online){setState('error');return;}
    setState('loading');setTaskState('loading');void reload().catch(()=>{});
    const focus=()=>{if(document.visibilityState==='visible')void reload().catch(()=>{});};
    window.addEventListener('focus',focus);document.addEventListener('visibilitychange',focus);
    return()=>{listsRead.current?.abort();window.removeEventListener('focus',focus);document.removeEventListener('visibilitychange',focus);};
  },[chat,tasksEnabled,online,reload]);

  const owned=conversations.find(row=>row.id===conversationId)?.owner_id===owner;
  const readMessages=useCallback(async()=>{
    if(!chat||view!=='existing'||!conversationId)return;
    messageRead.current?.abort();const controller=new AbortController();messageRead.current=controller;
    const generation=messageGeneration.current;
    try {
      const [rows,running]=await Promise.all([fetchMessages(conversationId,controller.signal,owner),owned?fetchActiveExecution(conversationId,controller.signal,owner):Promise.resolve(null)]);
      if(controller.signal.aborted||!mounted.current||revoked.current||binding.current.conversationId!==conversationId)return;
      setMessages(current=>{
        const incoming=new Map(rows.map(row=>[row.id,row]));
        // A read begun before acceptance cannot erase a later accepted message.
        if(generation!==messageGeneration.current)for(const row of current)if(!incoming.has(row.id))incoming.set(row.id,row);
        return [...incoming.values()];
      });setActive(running);setMessagesState('ready');
    }catch(error){if(!controller.signal.aborted&&mounted.current){handleLost(error);setMessagesState('error');throw error;}}
  },[chat,view,conversationId,owned,owner,handleLost]);
  useEffect(()=>{
    setMessages([]);setActive(null);setStartIssue('');
    if(!online||!chat||view!=='existing'||!conversationId){setMessagesState('ready');return;}
    setMessagesState('loading');void readMessages().catch(()=>{});
    return()=>messageRead.current?.abort();
  },[online,readMessages,chat,view,conversationId]);

  const refreshExecution=useCallback(async()=>{await Promise.all([reload(),readMessages()]);},[reload,readMessages]);
  const accept=async(request:Submission)=>{
    await projectAssociation.wait();
    if(!mounted.current||revoked.current||!binding.current.chat||request.mode==='work'&&!binding.current.tasksEnabled)throw new Error('Workspace access changed');
    const receipt:Acceptance=request.conversationId
      ? await submitConversation(request.conversationId,request.mode,request.content,request.key,request.taskId,owner)
      : await createConversationSubmission(request.content.length>28?request.content.slice(0,28)+'…':request.content,request.projectId,request.mode,request.content,request.key,owner);
    if(!mounted.current||revoked.current||!binding.current.chat||request.mode==='work'&&!binding.current.tasksEnabled||binding.current.owner!==owner)return receipt;
    if(receipt.conversation)conversationSaved(receipt.conversation);
    if(receipt.task)setTasks(current=>merge(current,[receipt.task!]));
    messageGeneration.current++;
    if(binding.current.conversationId===request.conversationId)setMessages(current=>current.some(row=>row.id===receipt.message.id)?current:[...current,receipt.message]);
    callbacks.current.onAccepted(receipt);setMessagesState('ready');setStartIssue('');
    try{await startExecution(receipt.message.conversation_id,receipt.message.id);}
    catch(error){if(mounted.current&&!handleLost(error))setStartIssue('消息已接受，执行启动需要确认；请核对执行状态。');}
    finally{if(mounted.current)setExecutionRevision(value=>value+1);}
    return receipt;
  };
  return {projects:chat?projects:[],conversations:chat?conversations:[],tasks:tasksEnabled?tasks:[],messages,active,state,taskState,tasksAvailable:tasksEnabled&&tasksAvailable,messagesState,
    projectAssociation,projectSaved,reload,readMessages,refreshExecution,accept,executionRevision,startIssue,handleLost,handleTaskLost,denied,draftEpoch,discardDraft:()=>setDraftEpoch(value=>value+1)};
}
