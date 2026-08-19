import { CheckCircle2, MessageCircle } from "lucide-react";
import { Composer } from "../components/Composer";
import { SegmentedControl } from "../components/SegmentedControl";
import { TopBar, type ScreenChromeProps } from "../components/TopBar";
import type { ConversationMessage, ConversationView, Project } from "../types";

type ConversationScreenProps = ScreenChromeProps & {
  view: ConversationView;
  conversationTitle: string;
  mode: "聊天" | "工作";
  onModeChange: (mode: "聊天" | "工作") => void;
  projects: Project[];
  projectId: string | null;
  onProjectChange: (projectId: string | null) => void;
  messages: ConversationMessage[];
  messagesState: "loading" | "ready" | "error";
  onSubmit: (message: string, submissionKey: string) => Promise<boolean>;
};

export function ConversationScreen({
  contextOpen,
  onOpenNavigation,
  onToggleContext,
  view,
  conversationTitle,
  mode,
  onModeChange,
  projects,
  projectId,
  onProjectChange,
  messages,
  messagesState,
  onSubmit,
}: ConversationScreenProps) {
  return (
    <main className="app-main conversation-screen">
      <TopBar
        title={view === "new" ? "新聊天" : conversationTitle}
        subtitle={view === "new" ? (mode === "工作" ? "新工作" : "个人智能体") : mode === "工作" ? "工作会话" : "已有对话"}
        tabs={<SegmentedControl value={mode} options={["聊天", "工作"] as const} onChange={onModeChange} label="会话模式" />}
        minimal={view === "new"}
        contextOpen={contextOpen}
        onOpenNavigation={onOpenNavigation}
        onToggleContext={onToggleContext}
      />

      {view === "new" ? (
        <section key={mode} className={`new-conversation-empty new-conversation-empty--${mode === "工作" ? "work" : "chat"}`}>
          <div className="new-conversation-empty__content">
            <h1>{mode === "工作" ? "我们该处理什么工作？" : "随时可以开始。"}</h1>
            <Composer compact={mode === "聊天"} empty mode={mode} onSubmit={onSubmit} projects={projects} projectId={projectId} onProjectChange={onProjectChange} />
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
                <div className="chat-turn chat-turn--user"><p>{message.content}</p></div>
                {message.task_id && message.task_status === "created" && (
                  <div className="work-tool-event"><CheckCircle2 size={14} /><span>已创建持久任务 · 待执行</span></div>
                )}
              </div>
            ))}
          </div>
          <Composer compact={mode === "聊天"} mode={mode} onSubmit={onSubmit} projects={projects} projectId={projectId} onProjectChange={onProjectChange} />
        </section>
      )}
    </main>
  );
}
