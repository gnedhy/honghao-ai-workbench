import {useEffect,useRef,useState} from 'react';
import {createClientId} from '../clientId';
import {useUnsavedChanges} from '../components/Interaction';
import type {Submission,Acceptance} from './useChatWorkspace';

export function useMessageDraft(binding:string,request:Omit<Submission,'content'|'key'>,accept:(value:Submission)=>Promise<Acceptance>,onAccessLost:(error:unknown)=>boolean) {
  const [value,setValue]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [unknown,setUnknown]=useState(false);
  const pending=useRef<Submission|null>(null);
  const running=useRef(false);
  const live=useRef(true);
  const current=useRef({binding,value});current.current={binding,value};
  const previous=useRef(binding);
  useEffect(()=>{if(previous.current!==binding){
    previous.current=binding;
    const acceptedNew=running.current&&pending.current?.conversationId===null&&request.conversationId!==null;
    const submitted=pending.current?.content;
    setValue(current=>acceptedNew&&current.trim()!==submitted?current:'');
    setError('');setUnknown(false);pending.current=null;
  }},[binding,request.conversationId]);
  useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  const leave=useUnsavedChanges(Boolean(value.trim())||unknown,busy,'本次消息尚未确认提交。放弃后将离开当前草稿，服务器已接受的记录会保留。','workbench-before-leave');
  const submit=async()=>{
    if(running.current||(!pending.current&&!value.trim()))return;
    running.current=true;setBusy(true);setError('');
    const target=binding;
    const snapshot=pending.current??{...request,content:value.trim(),key:createClientId()};pending.current=snapshot;
    try{
      await accept(snapshot);
      if(!live.current||current.current.binding!==target)return;
      if(current.current.value.trim()===snapshot.content)setValue('');
      pending.current=null;setUnknown(false);
    }catch(failure){
      if(!live.current||current.current.binding!==target)return;
      if(onAccessLost(failure)){setValue('');pending.current=null;setUnknown(false);return;}
      const status=(failure as {status?:number}).status;
      if(status&&status<500){pending.current=null;setUnknown(false);setError('提交未被接受，输入已保留；请核对当前任务和项目后重试。');}
      else{setUnknown(true);setError('提交结果尚未确认。请用原请求重新确认，后续编辑会保留。');}
    }finally{running.current=false;if(live.current){setBusy(false);}}
  };
  const discard=()=>{setValue('');setError('');setUnknown(false);pending.current=null;};
  return {value,setValue,busy,error,unknown,submit,discard,confirmation:leave.confirmation};
}
