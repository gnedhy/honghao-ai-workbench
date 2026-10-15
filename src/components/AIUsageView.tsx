import type {AIUsage} from '../types';
import {useLayoutEffect,useRef} from 'react';

const count=(value:number)=>value.toLocaleString('zh-CN');
export function AIUsageView({usage}:{usage:AIUsage}) {
  const timeline=useRef<HTMLDivElement>(null);
  useLayoutEffect(()=>{
    const node=timeline.current;if(!node)return;
    const latest=()=>{node.scrollLeft=node.scrollWidth;};
    latest();const resize=new ResizeObserver(latest);resize.observe(node);
    return()=>resize.disconnect();
  },[]);
  const today=new Date(usage.today+'T00:00:00Z');
  const first=new Date(today);first.setUTCDate(first.getUTCDate()-364);
  const offset=first.getUTCDay();
  const records=new Map(usage.activity.map(day=>[day.date,day]));
  const peak=Math.max(1,...usage.activity.map(day=>day.runs));
  const months:{column:number;label:string}[]=[];
  const cells=Array.from({length:Math.ceil((offset+365)/7)*7},(_,index)=>{
    const date=new Date(first);date.setUTCDate(first.getUTCDate()+index-offset);
    const key=date.toISOString().slice(0,10),day=records.get(key);
    const visible=date>=first&&date<=today;
    if(visible&&date.getUTCDate()===1)months.push({column:Math.min(Math.floor(index/7)+1,50),label:`${date.getUTCMonth()+1}月`});
    const label=`${key}：${day?.runs??0} 次运行，${count(day?.tokens??0)} Token`;
    return <span key={key} role="img" aria-label={visible&&day?label:undefined} aria-hidden={!visible||!day} title={visible?label:undefined} data-outside={!visible||undefined} data-level={day?Math.ceil(day.runs/peak*4):0}/>;
  });
  return <>
    <dl className="ai-usage-metrics">{[
      ['聊天轮次',count(usage.chats)],['工作运行',count(usage.work)],
      ['已验收任务',count(usage.accepted_tasks)],['Token 用量',usage.tokens.toLocaleString('zh-CN',{notation:'compact',maximumFractionDigits:1})],
    ].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    <figure className="ai-usage-activity"><figcaption>近一年活动<span>按运行次数</span></figcaption><div ref={timeline} className="ai-usage-timeline" tabIndex={0} role="region" aria-label="近一年 AI 活动日历"><div className="ai-usage-calendar">{cells}</div><div className="ai-usage-months" aria-hidden="true">{months.map(month=><span key={month.column} style={{gridColumnStart:month.column}}>{month.label}</span>)}</div></div><div className="ai-usage-legend"><span>{first.toISOString().slice(0,7).replace('-','年')}月 — {usage.today.slice(0,7).replace('-','年')}月</span><span>少<i data-level="0"/><i data-level="1"/><i data-level="2"/><i data-level="3"/><i data-level="4"/>多</span></div></figure>
    <section className="ai-usage-results" aria-labelledby="ai-usage-results-title"><h3 id="ai-usage-results-title">运行情况</h3><dl className="ai-usage-outcomes">{[
      ['成功运行',count(usage.successful)],['失败／受阻',count(usage.failed)],['主动停止',count(usage.stopped)],['活跃天数',`${usage.active_days} 天`],
    ].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></section>
    {usage.accounting_since&&<p className="ai-usage-note"><span>预估费用 ¥{Number(usage.cost_cny??0).toFixed(4)}{Number(usage.pending_cny)>0?` · 待核算 ¥${Number(usage.pending_cny).toFixed(4)}`:''}</span><span>费用明细从 {new Date(usage.accounting_since).toLocaleDateString('zh-CN')} 起记录。</span></p>}
    <p className="ai-usage-note"><span>轮次按保留的会话统计；已记账的 Token 和费用不随删除会话清零。</span><span>旧记录缺少明细时不补造费用。</span></p>
  </>;
}
