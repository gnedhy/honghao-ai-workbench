import {useEffect,useRef,useState} from 'react';
import {fetchTaskRuns,type TaskRun} from '../api';

export function useTaskRuns(taskId:string|undefined,onAccessLost:(error:unknown)=>void,owner:string) {
  const [rows,setRows]=useState<TaskRun[]>([]);
  const [state,setState]=useState<'loading'|'ready'|'error'>('ready');
  const [retry,setRetry]=useState(0);
  const lost=useRef(onAccessLost);lost.current=onAccessLost;
  const previous=useRef(taskId);
  useEffect(()=>{
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    if(previous.current!==taskId){previous.current=taskId;setRows([]);}if(!taskId){setState('ready');return;}
    setState('loading');
    const read=async()=>{
      try{
        const values=await fetchTaskRuns(taskId,controller.signal,owner);
        if(controller.signal.aborted)return;
        setRows(values);setState('ready');
        if(values.some(row=>row.phase!=='ended'))timer=setTimeout(()=>void read(),1500);
      }catch(error){if(controller.signal.aborted)return;if([401,403].includes((error as {status?:number}).status??0)){setRows([]);lost.current(error);}setState('error');}
    };
    void read();return()=>{controller.abort();clearTimeout(timer);};
  },[taskId,retry,owner]);
  return {rows,state,reload:()=>setRetry(value=>value+1)};
}
