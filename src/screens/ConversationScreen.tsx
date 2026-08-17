import { Check, Circle, ExternalLink, Info, MoreHorizontal, Sparkles } from "lucide-react";
import { useState } from "react";
import { Composer } from "../components/Composer";
import { SegmentedControl } from "../components/SegmentedControl";
import { runSteps } from "../data";
import type { WorkApproval } from "../types";

export function ConversationScreen() {
  const [mode, setMode] = useState<"聊天" | "工作">("工作");
  const [approval, setApproval] = useState<WorkApproval>("pending");
  const [lastMessage, setLastMessage] = useState("");

  return (
    <main className="app-main conversation-screen">
      <header className="screen-header screen-header--centered-tabs">
        <SegmentedControl value={mode} options={["聊天", "工作"] as const} onChange={setMode} label="会话模式" />
        {mode === "工作" && <button className="secondary-button header-action" type="button"><ExternalLink size={16} />打开到任务看板</button>}
      </header>

      {mode === "聊天" ? (
        <section className="chat-empty-state">
          <div>
            <h1>今天想聊点什么？</h1>
            <p>我会结合你的个人知识和允许访问的企业知识回答。</p>
            {lastMessage && <div className="chat-preview"><strong>你</strong><span>{lastMessage}</span></div>}
            <Composer compact mode="聊天" onSubmit={setLastMessage} />
          </div>
        </section>
      ) : (
        <section className="work-thread">
          <div className="work-thread__title-row">
            <h1>跨部门 AI 需求诊断</h1>
            <button className="icon-button" type="button" aria-label="更多操作"><MoreHorizontal size={18} /></button>
          </div>

          <div className="message-row message-row--user">
            <span className="avatar avatar--blue">张</span>
            <div className="message-bubble">请根据访谈材料整理 AI 需求诊断卡，并生成项目卡草案。</div>
          </div>

          <div className="message-row message-row--assistant">
            <span className="assistant-avatar"><Sparkles size={16} /></span>
            <div className="assistant-response">
              <p>好的，我已基于访谈材料与企业知识进行分析，正在按流程执行需求诊断。完成后会生成需求诊断卡（草案），并准备项目卡草案。等你的确认。</p>
              <div className="run-summary">
                <strong>正在执行 · 4/5</strong>
                <ol className="run-steps">
                  {runSteps.map((step) => (
                    <li className={`run-step run-step--${step.state}`} key={step.label}>
                      <span className="run-step__marker" aria-hidden="true">
                        {step.state === "done" ? <Check size={11} /> : <Circle size={9} />}
                      </span>
                      <span>{step.label}</span>
                      <time>{step.time}</time>
                      <span className="run-step__detail">{step.detail}</span>
                    </li>
                  ))}
                </ol>
              </div>

              <article className="diagnosis-document">
                <h2>需求诊断卡（草案）</h2>
                <ul>
                  <li><strong>已确认事实：</strong>业务目标明确，需构建统一的 AI 咨询助手，覆盖人力、财务、行政、法务四部门，优先场景为制度查询与流程指引。</li>
                  <li><strong>初步判断：</strong>知识资产可支撑，建议采用 RAG + 权限过滤方案；预计可减少 40% 的重复咨询工单。</li>
                  <li><strong>缺失信息与风险：</strong>部分历史制度文档缺少结构化标签；权限边界需进一步明确，存在越权访问风险。</li>
                  <li><strong>建议下一步：</strong>完成授权范围与 A/B 测试方案设计；补充 OCR 与结构化处理规则；确认验收指标与里程碑计划。</li>
                </ul>
                <p className="citation-line">引用：个人知识 3 条 · 公共知识 15 条 · 需求诊断 Skill v1.0 · Workflow v1.0</p>
              </article>

              <article className={`changeset changeset--${approval}`}>
                <div className="changeset__header">
                  <div>
                    <h2>{approval === "pending" ? "ChangeSet 等待你的确认" : approval === "approved" ? "ChangeSet 已批准" : "ChangeSet 已拒绝"}</h2>
                    <p>将创建项目卡文件（Markdown）：knowledge/diagnosis_cards/20250520_cross_dept.md</p>
                  </div>
                  <button className="icon-button" type="button" aria-label="ChangeSet 更多操作"><MoreHorizontal size={17} /></button>
                </div>
                <div className="diff-view" aria-label="文件差异预览">
                  <span className="diff-view__line-number">1</span><code>@@ -0,0 +1,12 @@</code>
                  <span className="diff-view__line-number">2</span><code>+ # 跨部门 AI 需求诊断卡</code>
                  <span className="diff-view__line-number">3</span><code>+ 版本：v0.1（草案）</code>
                  <span className="diff-view__line-number">4</span><code>+ 生成时间：2025-05-20 10:14:36</code>
                  <span className="diff-view__line-number">5</span><code>+ 生成者：企业 AI（需求诊断 Skill v1.0）</code>
                  <span className="diff-view__line-number">6</span><code>+ 状态：待人工确认</code>
                </div>
                <div className="changeset__footer">
                  <p><Info size={16} />批准前不会写入项目卡或公共知识库。</p>
                  {approval === "pending" ? (
                    <div className="changeset__actions">
                      <button className="secondary-button" type="button" onClick={() => setApproval("rejected")}>拒绝</button>
                      <button className="primary-button" type="button" onClick={() => setApproval("approved")}>批准并应用</button>
                    </div>
                  ) : (
                    <button className="secondary-button" type="button" onClick={() => setApproval("pending")}>恢复待确认</button>
                  )}
                </div>
              </article>
            </div>
          </div>

          <Composer mode="工作" onSubmit={setLastMessage} />
        </section>
      )}
    </main>
  );
}
