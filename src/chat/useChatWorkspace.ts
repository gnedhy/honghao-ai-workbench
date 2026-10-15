import {useCallback,useEffect,useRef,useState} from 'react';
import {createConversationSubmission,deleteConversation,fetchActiveExecution,fetchConversations,fetchMessages,fetchProjects,fetchTasks,startExecution,submitConversation,updateConversation,type ConversationUpdate,type ConversationExecution} from '../api';
import type {Conversation,ConversationMessage,ConversationView,Project,TaskItem} from '../types';
import {useConversationProject} from './useConversationProject';

type State='loading'|'ready'|'error';
export type Submission = {conversationId:string|null;projectId:string|null;mode:'chat'|'work';content:string;key:string;selection?:{model:string;effort:string};taskId?:string};
export type Acceptance={message:ConversationMessage;task:TaskItem|null;conversation?:Conversation};
const lost=(error:unknown)=>[401,403].includes((error as {status?:number}).status??0);
function merge<T extends {id:string;revision?:number}>(current:T[],incoming:T[]) {
  const rows=new Map(current.map(row=>[row.id,row]));
  for(const row of incoming)if((rows.get(row.id)?.revision??0)<=(row.revision??1))rows.set(row.id,row);
  return [...rows.values()];
}
function mergeConversations(current:Conversation[],incoming:Conversation[],replace=false) {
  const previous=new Map(current.map(row=>[row.id,row]));
  const ids=new Set(incoming.map(row=>row.id));
  return merge(replace?current.filter(row=>ids.has(row.id)):current,incoming.map(row=>({...row,pinned:row.pinned??previous.get(row.id)?.pinned,archived:row.archived??previous.get(row.id)?.archived,mode:previous.get(row.id)?.mode==='work'?'work':row.mode??previous.get(row.id)?.mode??'chat'})));
}
function mergeTasks(current:TaskItem[],incoming:TaskItem[],replace=false) {
  const titles=new Map(current.map(row=>[row.id,row.title]));
  const ids=new Set(incoming.map(row=>row.id));
  return merge(replace?current.filter(row=>ids.has(row.id)):current,incoming.map(row=>({...row,title:row.title??titles.get(row.id)})));
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
  const executionTasksRead=useRef<AbortController|null>(null);
  const taskReadGeneration=useRef(0);
  const clear=useCallback(()=>{listsRead.current?.abort();messageRead.current?.abort();executionTasksRead.current?.abort();taskReadGeneration.current++;setProjects([]);setConversations([]);setTasks([]);setMessages([]);setActive(null);setDraftEpoch(value=>value+1);},[]);
  const handleLost=useCallback((error:unknown)=>{if(lost(error)){if(revoked.current)return true;revoked.current=true;setDenied(true);clear();callbacks.current.onAccessLost();return true;}return false;},[clear]);
  const handleTaskLost=useCallback((error:unknown,collection=false)=>{
    if((error as {status?:number}).status===403||(collection&&(error as {status?:number}).status===404)){executionTasksRead.current?.abort();taskReadGeneration.current++;binding.current.tasksEnabled=false;setTasks([]);setTasksAvailable(false);setTaskState('error');return true;}
    return handleLost(error);
  },[handleLost]);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;listsRead.current?.abort();messageRead.current?.abort();executionTasksRead.current?.abort();};},[]);
  const projectSaved=useCallback((row:Project)=>{if(!revoked.current&&binding.current.chat)setProjects(current=>merge(current,[row]));},[]);
  const conversationSaved=useCallback((row:Conversation)=>{if(!revoked.current&&binding.current.chat)setConversations(current=>mergeConversations(current,[row]));},[]);
  const taskSaved=useCallback((row:TaskItem)=>{
    if(!mounted.current||revoked.current||!binding.current.tasksEnabled||binding.current.owner!==row.owner_id)return;
    taskReadGeneration.current++;setTasks(current=>mergeTasks(current,[row]));
  },[]);
  const projectAssociation=useConversationProject(conversationSaved,values=>{if(!revoked.current&&binding.current.chat)setConversations(current=>mergeConversations(current,values));},handleLost,owner);

  const reload=useCallback(async()=>{
    executionTasksRead.current?.abort();const taskGeneration=++taskReadGeneration.current;
    listsRead.current?.abort();const controller=new AbortController();listsRead.current=controller;
    try {
      const [loadedProjects,loadedConversations,loadedTasks]=await Promise.allSettled([
        chat?fetchProjects(controller.signal,owner):Promise.resolve([]),
        chat?fetchConversations(controller.signal,owner):Promise.resolve([]),
        tasksEnabled?fetchTasks(controller.signal,owner):Promise.resolve([])]);
      if(controller.signal.aborted||!mounted.current||revoked.current)return;
      if(taskGeneration===taskReadGeneration.current&&loadedTasks.status==='fulfilled'){
        setTasks(current=>mergeTasks(current,loadedTasks.value,true));setTaskState('ready');setTasksAvailable(true);
      }else if(taskGeneration===taskReadGeneration.current&&loadedTasks.status==='rejected'){
        setTaskState('error');
        if(handleTaskLost(loadedTasks.reason,true)&&loadedTasks.reason?.status===401)throw loadedTasks.reason;
      }
      if(loadedProjects.status==='rejected')throw loadedProjects.reason;
      if(loadedConversations.status==='rejected')throw loadedConversations.reason;
      setProjects(current=>merge(current,loadedProjects.value));setConversations(current=>mergeConversations(current,loadedConversations.value,true));setState('ready');
      if(loadedTasks.status==='rejected'&&![403,404].includes(loadedTasks.reason?.status))throw loadedTasks.reason;
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
    setMessages(current=>current.filter(row=>row.conversation_id===conversationId));setActive(null);setStartIssue('');
    if(!online||!chat||view!=='existing'||!conversationId){setMessagesState('ready');return;}
    setMessagesState('loading');void readMessages().catch(()=>{});
    return()=>messageRead.current?.abort();
  },[online,readMessages,chat,view,conversationId]);

  const refreshExecution=useCallback(async(run?:ConversationExecution)=>{
    if(run?.conversation&&mounted.current&&!revoked.current&&binding.current.chat&&binding.current.owner===owner&&binding.current.view==='existing'&&binding.current.conversationId===run.conversation_id&&run.conversation.id===run.conversation_id&&run.conversation.owner_id===owner)conversationSaved(run.conversation);
    const readTasks=async()=>{
      if(!run?.task_id||!binding.current.tasksEnabled)return;
      executionTasksRead.current?.abort();const controller=new AbortController();executionTasksRead.current=controller;const generation=++taskReadGeneration.current;
      const current=()=>!controller.signal.aborted&&generation===taskReadGeneration.current&&mounted.current&&!revoked.current&&binding.current.owner===owner&&binding.current.tasksEnabled;
      try{const rows=await fetchTasks(controller.signal,owner);if(current()){setTasks(values=>mergeTasks(values,rows,true));setTaskState('ready');}}
      catch(error){if(current()){setTaskState('error');if(!handleTaskLost(error,true))throw error;}}
    };
    await Promise.all([readTasks(),readMessages()]);
  },[readMessages,owner,handleTaskLost,conversationSaved]);
  const changeConversation=async(row:Conversation,changes:ConversationUpdate)=>{
    if(revoked.current||!binding.current.chat)throw new Error('Workspace access changed');
    try{const saved=await updateConversation(row,changes,owner);if(mounted.current)conversationSaved(saved);if(row.archived&&!saved.archived)await reload();return saved;}
    catch(error){if(mounted.current&&!handleLost(error))await reload().catch(()=>{});throw error;}
  };
  const removeConversation=async(row:Conversation)=>{
    if(revoked.current||!binding.current.chat)throw new Error('Workspace access changed');
    listsRead.current?.abort();executionTasksRead.current?.abort();taskReadGeneration.current++;
    try{
      await deleteConversation(row,owner);
      if(mounted.current&&!revoked.current){setConversations(current=>current.filter(value=>value.id!==row.id));setTasks(current=>current.filter(value=>value.conversation_id!==row.id));}
    }catch(error){
      if(mounted.current&&!handleLost(error)){
        try{
          const rows=await fetchConversations(undefined,owner);
          if(mounted.current&&!revoked.current&&binding.current.chat&&binding.current.owner===owner){
            setConversations(current=>mergeConversations(current,rows,true));
            if(!rows.some(value=>value.id===row.id)){setTasks(current=>current.filter(value=>value.conversation_id!==row.id));return;}
          }
        }catch(readError){handleLost(readError);}
      }
      throw error;
    }
  };
  const accept=async(request:Submission)=>{
    await projectAssociation.wait();
    if(!mounted.current||revoked.current||!binding.current.chat||request.mode==='work'&&!binding.current.tasksEnabled)throw new Error('Workspace access changed');
    const receipt:Acceptance=request.conversationId
      ? await submitConversation(request.conversationId,request.mode,request.content,request.key,request.taskId,owner)
      : await createConversationSubmission(request.content.length>28?request.content.slice(0,28)+'…':request.content,request.projectId,request.mode,request.content,request.key,owner);
    if(!mounted.current||revoked.current||!binding.current.chat||request.mode==='work'&&!binding.current.tasksEnabled||binding.current.owner!==owner)return receipt;
    if(request.conversationId&&binding.current.conversationId!==request.conversationId)return receipt;
    if(receipt.conversation){listsRead.current?.abort();conversationSaved({...receipt.conversation,mode:receipt.message.mode});}
    else if(receipt.message.mode==='work')setConversations(current=>current.map(row=>row.id===receipt.message.conversation_id?{...row,mode:'work'}:row));
    if(receipt.task){taskReadGeneration.current++;setTasks(current=>mergeTasks(current,[receipt.task!]));}
    messageGeneration.current++;
    if(binding.current.conversationId===request.conversationId)setMessages(current=>current.some(row=>row.id===receipt.message.id)?current:[...current,receipt.message]);
    callbacks.current.onAccepted(receipt);setMessagesState('ready');setStartIssue('');
    try{await startExecution(receipt.message.conversation_id,receipt.message.id,owner,request.selection);}
    catch(error){if(mounted.current&&!handleLost(error))setStartIssue([402,429].includes((error as {status?:number}).status??0)?(error as Error).message:'消息已接受，执行启动需要确认；请核对执行状态。');}
    finally{if(mounted.current)setExecutionRevision(value=>value+1);}
    return receipt;
  };
  const archivedIds=new Set(conversations.filter(row=>row.archived).map(row=>row.id));
  const visibleTasks=tasks.filter(row=>!archivedIds.has(row.conversation_id));
  const projectSummaries=Object.fromEntries(projects.map(project=>{
    const relatedTasks=visibleTasks.filter(task=>task.project_id===project.id);
    const taskReady=tasksEnabled&&tasksAvailable&&taskState==='ready';
    return [project.id,{conversationCount:state==='ready'?conversations.filter(row=>row.project_id===project.id&&!row.archived).length:null,
      taskCount:taskReady?relatedTasks.length:null,runningCount:taskReady?relatedTasks.filter(task=>task.status==='running').length:null}];
  }));
  return {projects:chat?projects:[],conversations:chat?conversations:[],tasks:tasksEnabled?visibleTasks:[],projectSummaries,messages,active,state,taskState,tasksAvailable:tasksEnabled&&tasksAvailable,messagesState,
    projectAssociation,projectSaved,taskSaved,changeConversation,removeConversation,reload,readMessages,refreshExecution,accept,executionRevision,startIssue,handleLost,handleTaskLost,denied,draftEpoch,discardDraft:()=>setDraftEpoch(value=>value+1)};
}
