import {useEffect, useRef, useState} from 'react';
import {fetchConversations, setConversationProject} from '../api';
import {useUnsavedChanges} from '../components/Interaction';
import type {Conversation} from '../types';

export function useConversationProject(onSaved: (value: Conversation) => void, onReloaded: (values: Conversation[]) => void, onAccessLost: (error:unknown)=>boolean, owner:string) {
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const active=useRef(true);
  const running=useRef(false);
  const operation=useRef(Promise.resolve(true));
  const reading=useRef<AbortController | null>(null);
  useUnsavedChanges(false,busy,'项目关联正在保存，请稍后再离开。','workbench-before-leave');
  useEffect(()=>{active.current=true;return()=>{active.current=false;reading.current?.abort();};},[]);
  const reconcile=async()=>{
    const controller=new AbortController();reading.current=controller;
    try {
      const values=await fetchConversations(controller.signal,owner);
      if (!active.current) return false;
      onReloaded(values);return true;
    } catch(error) {if(active.current)onAccessLost(error);return false;}
    finally {if (reading.current===controller) reading.current=null;}
  };
  const change=(conversation: Conversation,projectId: string | null)=>{
    if (running.current) return;
    running.current=true;setBusy(true);setError('');
    operation.current=(async()=>{
      try {
        const saved=await setConversationProject(conversation.id,projectId,conversation.revision,owner);
        if (active.current) onSaved(saved);
        return active.current;
      } catch(error) {
        if (!active.current) return false;
        if(onAccessLost(error))return false;
        const confirmed=await reconcile();
        if (active.current) setError(confirmed ? '已重新读取当前项目归属，请核对后继续。' : '项目关联结果尚未确认，请重新读取后再发送。');
        return confirmed;
      } finally {running.current=false;if(active.current)setBusy(false);}
    })();
  };
  const retry=()=>{
    if(running.current)return;
    running.current=true;setBusy(true);
    operation.current=reconcile().then(confirmed=>{if(active.current){setBusy(false);setError(confirmed?'':'项目关联结果尚未确认，请重新读取后再发送。');}running.current=false;return confirmed;});
  };
  return {busy,error,change,retry,wait:async()=>{if(!await operation.current)throw new Error('Project association is unconfirmed');}};
}
