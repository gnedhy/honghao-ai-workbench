import { ArrowUp, ChevronDown, Database, Paperclip, ShieldCheck, Sparkles } from "lucide-react";
import { useState } from "react";

type ComposerProps = {
  compact?: boolean;
  mode?: "聊天" | "工作";
  onSubmit?: (message: string) => void;
};

export function Composer({ compact = false, mode = "工作", onSubmit }: ComposerProps) {
  const [message, setMessage] = useState("");

  const submit = () => {
    if (!message.trim()) return;
    onSubmit?.(message.trim());
    setMessage("");
  };

  return (
    <div className={compact ? "composer composer--compact" : "composer"}>
      <textarea
        aria-label={mode === "工作" ? "输入工作要求" : "输入聊天消息"}
        placeholder={mode === "工作" ? "补充信息，或输入下一步要求…" : "向企业 AI 发送消息"}
        rows={compact ? 1 : 2}
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="composer__toolbar">
        <div className="composer__tools">
          <button className="icon-button" type="button" aria-label="添加附件"><Paperclip size={18} /></button>
          {mode === "工作" && <button className="composer-control" type="button"><Database size={16} /><span>知识范围</span><ChevronDown size={14} /></button>}
          {mode === "工作" && <button className="composer-control" type="button"><Sparkles size={16} /><span>企业模型</span><ChevronDown size={14} /></button>}
        </div>
        <button className={compact ? "round-action" : "primary-button composer__submit"} type="button" onClick={submit} disabled={!message.trim()}>
          {compact ? <ArrowUp size={18} /> : <><ArrowUp size={17} /><span>交给智能体执行</span></>}
        </button>
      </div>
      {mode === "工作" && !compact && (
        <div className="composer__footer"><span><Sparkles size={15} />工作</span><span><ShieldCheck size={15} />受控目录</span></div>
      )}
    </div>
  );
}
