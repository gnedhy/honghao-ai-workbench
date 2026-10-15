import {memo,useRef,useState} from 'react';
import {Check,Copy} from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const plugins=[remarkGfm];
export default memo(function MessageBody({content,pending=false}:{content:string;pending?:boolean}) {
  const body=useRef<HTMLDivElement>(null);const [feedback,setFeedback]=useState('');
  const copy=async()=>{
    try {
      if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(content);setFeedback('已复制');}
      else if(body.current){const range=document.createRange();range.selectNodeContents(body.current);const selection=window.getSelection();selection?.removeAllRanges();selection?.addRange(range);setFeedback('已选中文本，可使用系统复制操作。');}
    }catch{setFeedback('复制未完成，可选中文本复制。');}
  };
  return <div className="message-body">
    <div className="message-body__text" ref={body}><Markdown remarkPlugins={plugins} components={{
      table:({children})=><div className="message-body__table" role="region" aria-label="回复表格" tabIndex={0}><table>{children}</table></div>,
      a:({children,href})=>href?<a href={href} target={href.startsWith('#')?undefined:'_blank'} rel="noreferrer noopener">{children}</a>:<span>{children}</span>,
      img:({alt})=><span className="message-body__image-caption">{alt?`图片：${alt}`:'图片内容待文件能力提供。'}</span>
    }}>{content}</Markdown></div>
    {!pending&&<div className="message-body__actions"><button className="icon-button message-body__copy" type="button" aria-label="复制回复" title={feedback||'复制回复'} onClick={()=>void copy()}>{feedback==='已复制'?<Check size={14}/>:<Copy size={14}/>}</button><span className="sr-only" role="status">{feedback}</span></div>}
  </div>;
});
