import { ArrowUp, ChevronDown, Plus } from "lucide-react";
import { useState } from "react";

type ComposerProps = {
  compact?: boolean;
  empty?: boolean;
  mode?: "聊天" | "工作";
  onSubmit?: (message: string) => void;
};

export function Composer({ compact = false, empty = false, mode = "工作", onSubmit }: ComposerProps) {
  const [message, setMessage] = useState("");

  const submit = () => {
    if (!message.trim()) return;
    onSubmit?.(message.trim());
    setMessage("");
  };

  if (compact) {
    return (
      <div className={`composer composer--compact${empty ? " composer--empty" : ""}`}>
        <div className="composer__compact-row">
          <button className="icon-button" type="button" aria-label="添加内容"><Plus size={18} /></button>
          <textarea
            aria-label="输入聊天消息"
            placeholder="向宏昊 AI 发送消息"
            rows={1}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <button className="composer__model" type="button">企业模型<ChevronDown size={13} /></button>
          <button className="round-action composer__submit" type="button" aria-label="发送消息" onClick={submit} disabled={!message.trim()}>
            <ArrowUp size={16} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`composer${empty ? " composer--empty composer--work-empty" : ""}`}>
      <textarea
        aria-label={mode === "工作" ? "输入工作要求" : "输入聊天消息"}
        placeholder={mode === "工作" ? "补充信息，或输入下一步要求…" : "向宏昊 AI 发送消息"}
        rows={2}
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
          <button className="icon-button" type="button" aria-label="添加内容"><Plus size={18} /></button>
        </div>
        <button className="round-action composer__submit" type="button" aria-label="交给智能体执行" onClick={submit} disabled={!message.trim()}>
          <ArrowUp size={16} />
        </button>
      </div>
    </div>
  );
}
