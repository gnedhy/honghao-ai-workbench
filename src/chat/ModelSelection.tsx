import {useEffect,useRef,useState} from 'react';
import {fetchJson,workspaceHeaders} from '../api';
import {Bot} from 'lucide-react';
import {WorkbenchOptionMenu} from '../components/WorkbenchMenus';

type Catalog={models:{id:string;name:string}[];allowed_efforts:string[];default_model:string;default_effort:string;quota:{warning:boolean;blocked:boolean;company_exhausted:boolean}};
export function useModelSelection(owner:string,onAccessLost:()=>void) {
  const accessLost=useRef(onAccessLost);accessLost.current=onAccessLost;
  const [catalog,setCatalog]=useState<Catalog|null>(null);
  const [selection,setSelection]=useState<{model:string;effort:string}|undefined>();
  const [error,setError]=useState('');
  const [retry,setRetry]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();setCatalog(null);setSelection(undefined);setError('');
    const read=()=>fetchJson<Catalog>('/api/me/ai-models',{signal:controller.signal,headers:workspaceHeaders(owner)}).then(value=>{
      if(controller.signal.aborted)return;
      setCatalog(value);setError('');setSelection(previous=>previous&&value.models.some(model=>model.id===previous.model)&&value.allowed_efforts.includes(previous.effort)?previous:{model:value.default_model,effort:value.default_effort});
    }).catch(failure=>{
      if(controller.signal.aborted)return;
      if([401,403].includes(failure.status))accessLost.current();else setError('模型配置读取失败，请重试。');
    });
    void read();
    const focus=()=>{if(document.visibilityState==='visible')void read();};
    window.addEventListener('focus',focus);
    return()=>{controller.abort();window.removeEventListener('focus',focus);};
  },[owner,retry]);
  const control=(disabled:boolean)=><div className="conversation-model-controls">
    {catalog&&selection?<>
      {catalog.models.length===1?<span className="conversation-model-name" aria-label="当前模型">{catalog.models[0].name}</span>:<WorkbenchOptionMenu label="选择模型" value={selection.model} options={catalog.models.map(model=>({value:model.id,label:model.name,disabled}))} onSelect={model=>setSelection(current=>current?{...current,model}:current)}/>}
      <WorkbenchOptionMenu className="conversation-reasoning-menu" label="推理档位" value={selection.effort} header={<div className="conversation-reasoning-header"><span>当前模型</span><strong><Bot size={15} aria-hidden="true"/><span>{catalog.models.find(model=>model.id===selection.model)?.name??selection.model}</span></strong><span>推理等级</span></div>} options={catalog.allowed_efforts.map(effort=>({value:effort,label:`${({low:'低',high:'高',max:'最高'} as Record<string,string>)[effort]??effort}`,disabled}))} onSelect={effort=>setSelection(current=>current?{...current,effort}:current)}/>
      {catalog.quota.blocked||catalog.quota.company_exhausted?<span role="status">本月预算已用完</span>:catalog.quota.warning?<span role="status">本月额度已使用超过 80%</span>:null}
    </>:error?<button className="text-button" type="button" onClick={()=>setRetry(value=>value+1)}>{error}</button>:<span role="status">正在读取模型…</span>}
  </div>;
  return {selection,control,ready:!!catalog&&!!selection};
}
