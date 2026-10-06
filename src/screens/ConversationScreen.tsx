import { CheckCircle2, MessageCircle } from "lucide-react";
import {useState} from "react";
import { Composer } from "../components/Composer";
import { SegmentedControl } from "../components/SegmentedControl";
import { TopBar, type ScreenChromeProps } from "../components/TopBar";
import type { ConversationMessage, ConversationView, Project } from "../types";
import {useConversationExecution} from "../chat/useConversationExecution";

type ConversationScreenProps = ScreenChromeProps & {
  view: ConversationView;
  conversationTitle: string;
  mode: "聊天" | "工作";
  onModeChange: (mode: "聊天" | "工作") => void;
  projects: Project[];
  projectSaving?: boolean;
  projectError?: string;
  onProjectRetry?: () => void;
  projectId: string | null;
  onProjectChange: (projectId: string | null) => void;
  messages: ConversationMessage[];
  messagesState: "loading" | "ready" | "error";
  onSubmit: (message: string, submissionKey: string) => Promise<boolean>;
  ownerId?: string;
  onExecutionSettled?: () => void | Promise<void>;
  onAccessLost?: () => void;
};

export function ConversationScreen({
  contextOpen,
  onOpenNavigation,
  onToggleContext,
  moduleMode,
  environment,
  view,
  conversationTitle,
  mode,
  onModeChange,
  projects,
  projectSaving = false,
  projectError,
  onProjectRetry,
  projectId,
  onProjectChange,
  messages,
  messagesState,
  onSubmit,
  ownerId,
  onExecutionSettled,
  onAccessLost,
}: ConversationScreenProps) {
  const [selectedInput, setSelectedInput] = useState<string | null>(null);
  const inputs = messages.filter(message => message.role !== "assistant" && message.role !== "tool");
  const input = inputs.find(message => message.id === selectedInput) ?? inputs.at(-1);
  const eligible = view === "existing" && Boolean(ownerId && input?.owner_id === ownerId);
  const execution = useConversationExecution(ownerId, eligible ? input?.conversation_id : undefined, eligible ? input?.id : undefined, onExecutionSettled, onAccessLost);
  const statusLabel = {running: "执行中", waiting: "等待补充", completed: "已完成", stopped: "已停止", failed: "执行失败", blocked: "执行受阻"} as const;
  return (
    <main className="app-main conversation-screen">
      <TopBar
        title={view === "new" ? "新聊天" : conversationTitle}
        subtitle={view === "new" ? (mode === "工作" ? "新工作" : "个人智能体") : mode === "工作" ? "工作会话" : "已有对话"}
        tabs={<SegmentedControl value={mode} options={["聊天", "工作"] as const} onChange={value => {if (!execution.active && !execution.busy) onModeChange(value);}} label="会话模式" />}
        minimal={view === "new"}
        contextOpen={contextOpen}
        onOpenNavigation={onOpenNavigation}
        onToggleContext={onToggleContext}
        moduleMode={moduleMode}
        environment={environment}
      />

      {projectError && <div className="conversation-state conversation-state--error" role="alert">{projectError}<button className="secondary-button" type="button" disabled={projectSaving} onClick={onProjectRetry}>重新读取项目归属</button></div>}
      {execution.denied ? <p className="conversation-state conversation-state--error" role="alert">访问授权已失效，请重新登录。</p> : view === "new" ? (
        <section key={mode} className={`new-conversation-empty new-conversation-empty--${mode === "工作" ? "work" : "chat"}`}>
          <div className="new-conversation-empty__content">
            <h1>{mode === "工作" ? "我们该处理什么工作？" : "随时可以开始。"}</h1>
            <Composer compact={mode === "聊天"} empty mode={mode} onSubmit={onSubmit} projects={projects} projectId={projectId} onProjectChange={onProjectChange} projectSaving={projectSaving} />
            {messagesState === "error" && (
              <p className="conversation-state conversation-state--error" role="alert">提交失败，内容已保留，请稍后重试。</p>
            )}
          </div>
        </section>
      ) : (
        <section className={mode === "聊天" ? "existing-chat-thread" : "work-thread"}>
          <div className={mode === "聊天" ? "existing-chat-thread__messages" : "work-thread__messages"}>
            {messagesState === "loading" && <p className="conversation-state">正在读取会话…</p>}
            {messagesState === "error" && <p className="conversation-state conversation-state--error">会话内容读取失败，请稍后重试。</p>}
            {messagesState === "ready" && messages.length === 0 && (
              <div className="conversation-empty-state"><MessageCircle size={18} /><p>这个会话还没有内容。</p></div>
            )}
            {messages.map((message) => (
              <div className="conversation-entry" key={message.id}>
                <div className={`chat-turn chat-turn--${message.role === "assistant" ? "assistant" : "user"}`}><p>{message.content}</p></div>
                {message.role === "user" && message.owner_id === ownerId && <button className="secondary-button" type="button" disabled={execution.active || execution.busy} onClick={() => setSelectedInput(message.id)} aria-pressed={message.id === input?.id}>查看本次执行</button>}
                {message.task_id && message.task_status === "created" && (
                  <div className="work-tool-event"><CheckCircle2 size={14} /><span>已接受工作请求 · 待执行</span></div>
                )}
              </div>
            ))}
            {execution.run?.output && !messages.some(message => message.run_id === execution.run?.id) && <div className="chat-turn chat-turn--assistant"><p>{execution.run.output}</p></div>}
            {eligible && input && <div className="conversation-state" aria-live="polite">
              {execution.run ? <span>{execution.run.stop_requested && execution.active ? "正在确认停止…" : execution.run.phase === "starting" ? "正在启动执行…" : statusLabel[execution.run.status]}</span> : <span>{execution.ready ? "已接受消息 · 待执行" : execution.availability}</span>}
              {!execution.run && execution.ready && <button className="secondary-button" type="button" disabled={execution.busy || !execution.confirmed} onClick={execution.start}>开始执行</button>}
              {execution.active && <button className="secondary-button" type="button" disabled={execution.busy || !execution.confirmed || Boolean(execution.run?.stop_requested)} onClick={execution.stop}>停止执行</button>}
              {execution.run?.phase === "ended" && execution.run.status !== "completed" && <span>本次执行已结束，已确认的正文保留；提交新消息可继续。</span>}
              {execution.error && <p role="alert">{execution.error}<button className="secondary-button" type="button" disabled={execution.busy} onClick={execution.reconcile}>重新读取执行状态</button></p>}
            </div>}
          </div>
          <Composer compact={mode === "聊天"} mode={mode} onSubmit={async (content, key) => {const accepted = await onSubmit(content, key); if (accepted) setSelectedInput(null); return accepted;}} projects={projects} projectId={projectId} onProjectChange={onProjectChange} projectSaving={projectSaving} executionActive={execution.active || execution.busy || (eligible && !execution.confirmed)} />
        </section>
      )}
    </main>
  );
}
