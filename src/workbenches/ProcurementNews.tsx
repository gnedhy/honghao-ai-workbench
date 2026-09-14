import { useEffect, useRef, useState, type RefObject } from 'react';
import { X, ChevronLeft, ChevronRight } from 'lucide-react';
import { fetchProcurementNews } from '../api';
import styles from '../components/WorkbenchSurface.module.css';
export type NewsItem = { title: string; source: string; url: string; published_at: string };
export type NewsData = { items: NewsItem[]; total: number; page: number; page_size: number; updated_at: string | null; delayed: boolean; sources: { name: string; status: 'ok' | 'pending' | 'delayed'; last_success: string | null }[] };
const updateTime = (value: string) => new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
function NewsRow({ item }: { item: NewsItem }) {
  const [day, clock] = item.published_at.split('T'); const [y,m,d] = day.split('-');
  return <li className={styles.newsRow}><time dateTime={item.published_at} className={styles.newsDate}>{Number(y)!==new Date().getFullYear()&&<small>{y}年</small>}<span>{m}月{d}日</span>{clock && <small>{clock.slice(0,5)}</small>}</time><div className={styles.newsText}><a href={item.url} target="_blank" rel="noopener noreferrer" title={item.title}>{item.title}</a><span>{item.source}</span></div></li>;
}
function NewsGroups({items}:{items:NewsItem[]}) {
  const days=[...new Set(items.map(item=>item.published_at.slice(0,10)))];
  return <div className={styles.newsGroups}>{days.map(day=><div className={styles.newsGroup} key={day}>
    <time className={styles.newsGroupDate} dateTime={day}><strong>{day.slice(5).replace('-','.')}</strong><span>{day.slice(0,4)}</span></time>
    <ul>{items.filter(item=>item.published_at.startsWith(day)).map(item=><li key={item.url}><div className={styles.newsText}><a href={item.url} target="_blank" rel="noopener noreferrer" title={item.title}>{item.title}</a></div><div className={styles.newsMeta}><span className={item.source==='隆众资讯'?styles.newsSourceLong:styles.newsSource}>{item.source}</span>{item.published_at.includes('T')&&<><span aria-hidden="true">·</span><time dateTime={item.published_at}>{item.published_at.split('T')[1].slice(0,5)}</time></>}</div></li>)}</ul>
  </div>)}</div>;
}
export function ProcurementNews({ cache }: { cache: RefObject<NewsData | null> }) {
  const [data, setData] = useState(cache.current), [failed, setFailed] = useState(false), [open, setOpen] = useState(false);
  const [page,setPage]=useState(0);
  const pages=Math.max(1,Math.ceil((data?.items.length??0)/5));
  const currentPage=Math.min(page,pages-1);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    const load = () => fetchProcurementNews('market', 1, controller.signal).then(next => { cache.current=next; setData(next); setFailed(false); }).catch(() => { if(!controller.signal.aborted) setFailed(true); });
    void load(); const timer=window.setInterval(()=>{if(!document.hidden)void load();},60000);
    return ()=>{controller.abort();clearInterval(timer);};
  },[cache]);
  return <section className={`${styles.dashboardPanel} ${styles.updateOverview}`} aria-label="采购资讯"><div className={styles.newsHeader}><h2 className={styles.newsHeading}>采购资讯</h2>{!!data?.items.length&&<div className={styles.newsPager} aria-label="资讯分页"><button type="button" aria-label="资讯上一页" disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}><ChevronLeft size={16}/></button><span aria-live="polite">{currentPage+1} / {pages}</span><button type="button" aria-label="资讯下一页" disabled={currentPage===pages-1} onClick={()=>setPage(currentPage+1)}><ChevronRight size={16}/></button></div>}</div>
    {data?.items.length ? <div className={styles.newsPages}>{Array.from({length:pages},(_,index)=><div key={index} className={`${styles.newsPage} ${index!==currentPage?styles.newsPageInactive:''}`} aria-hidden={index!==currentPage} inert={index!==currentPage}><NewsGroups items={data.items.slice(index*5,index*5+5)}/></div>)}</div> : <p className={styles.newsEmpty}>{failed?'资讯暂时无法读取':!data?'正在读取资讯':'最近30天暂无资讯'}</p>}
    {(failed||data?.delayed)&&<p className={styles.newsWarning}>{failed?'资讯读取延迟，稍后自动重试':'部分来源更新延迟'}</p>}
    <footer className={styles.newsFooter}><span title={data?.updated_at?updateTime(data.updated_at):undefined}>{data?.updated_at?`更新于 ${new Date(data.updated_at).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hour12:false})}`:'等待首次更新'}</span><button ref={button} type="button" onClick={()=>setOpen(true)}>查看全部 <ChevronRight size={14}/></button></footer>
    {open&&<NewsDrawer onClose={()=>{setOpen(false);requestAnimationFrame(()=>button.current?.focus({preventScroll:true}));}}/>}
  </section>;
}
function NewsDrawer({onClose}:{onClose:()=>void}){
  const dialog=useRef<HTMLDialogElement>(null);
  const [closing,setClosing]=useState(false);
  const closeTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const [source,setSource]=useState('all'),[page,setPage]=useState(1),[failed,setFailed]=useState(false),[retry,setRetry]=useState(0);
  const [result,setResult]=useState<{key:string;data:NewsData}|null>(null);const key=`${source}:${page}`;
  useEffect(()=>{const element=dialog.current;element?.showModal();return()=>{if(closeTimer.current)clearTimeout(closeTimer.current);element?.close();};},[]);
  const close=()=>{
    if(closeTimer.current)return;
    setClosing(true);
    closeTimer.current=setTimeout(onClose,window.matchMedia('(prefers-reduced-motion: reduce)').matches?0:140);
  };
  useEffect(()=>{const controller=new AbortController();setFailed(false);fetchProcurementNews(source,page,controller.signal).then(data=>setResult({key,data})).catch(()=>{if(!controller.signal.aborted)setFailed(true);});return()=>controller.abort();},[source,page,retry]);
  const data=result?.key===key?result.data:null;
  return <dialog ref={dialog} className={`${styles.newsDialog} ${closing?styles.closing:''}`} aria-labelledby="news-title" onCancel={event=>{if(event.target!==event.currentTarget)return;event.preventDefault();event.stopPropagation();close();}} onKeyDown={event=>{if(event.key==='Escape')event.stopPropagation();}} onMouseDown={event=>{
    if(event.target!==event.currentTarget)return;
    const rect=event.currentTarget.getBoundingClientRect();
    if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)close();
  }}>
    <header className={styles.drawerHeader}><h2 id="news-title">采购资讯</h2><button autoFocus type="button" className="icon-button" aria-label="关闭采购资讯" onClick={close}><X size={17}/></button></header>
    <div className={styles.newsFilters}><span>最近30天</span><label>信源 <select value={source} onChange={event=>{setSource(event.target.value);setPage(1);}}><option value="all">全部</option>{['生意社','隆众资讯','商务部'].map(name=><option key={name}>{name}</option>)}</select></label></div>
    <details className={styles.newsSources}><summary>来源更新状态</summary>{data?.sources.map(s=><p key={s.name}>{s.name} · {s.status==='ok'?'正常':s.status==='pending'?'等待首次更新':'更新延迟'}{s.last_success?` · ${updateTime(s.last_success)}`:''}</p>)}</details>
    <div className={styles.newsScroll}>{failed?<div className={styles.newsEmpty}>资讯读取失败 <button className="secondary-button" onClick={()=>setRetry(x=>x+1)}>重新加载</button></div>:!data?<p className={styles.newsEmpty}>正在读取资讯</p>:data.items.length?<ul className={styles.newsList}>{data.items.map(item=><NewsRow key={item.url} item={item}/>)}</ul>:<p className={styles.newsEmpty}>最近30天暂无资讯</p>}</div>
    <footer className={styles.newsPagination}><span>{data?`共 ${data.total} 条 · ${data.page} / ${Math.max(1,Math.ceil(data.total/20))}`:'每页20条'}</span><div><button className="secondary-button" disabled={!data||data.page<=1} onClick={()=>setPage((data?.page??1)-1)}>上一页</button><button className="secondary-button" disabled={!data||data.page*20>=data.total} onClick={()=>setPage((data?.page??1)+1)}>下一页</button></div></footer>
  </dialog>;
}
