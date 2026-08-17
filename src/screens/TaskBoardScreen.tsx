import { ArrowUpRight, CheckCircle2, CircleDot, Clock3, MoreHorizontal, PauseCircle, RotateCcw, Search } from "lucide-react";
import { useState } from "react";
import { SegmentedControl } from "../components/SegmentedControl";
import { tasks } from "../data";

export function TaskBoardScreen() {
  const [tab, setTab] = useState<"任务管理" | "运行记录">("任务管理");
  const [activeTask, setActiveTask] = useState(tasks[0]);

  return (
    <main className="app-main">
      <header className="screen-header screen-header--centered-tabs">
        <SegmentedControl value={tab} options={["任务管理", "运行记录"] as const} onChange={setTab} label="任务看板类型" />
      </header>
      {tab === "任务管理" ? (
        <section className="task-board">
          <div className="task-board__toolbar"><div><h1>任务管理</h1><p>由工作模式产生的持久执行对象</p></div><label className="search-field search-field--short"><Search size={16} /><input aria-label="搜索任务" placeholder="搜索任务" /></label></div>
          <div className="task-table-wrap">
            <table className="task-table">
              <thead><tr><th>任务</th><th>状态</th><th>进度</th><th>负责人</th><th>更新时间</th><th><span className="sr-only">操作</span></th></tr></thead>
              <tbody>{tasks.map((task) => <tr className={activeTask.title === task.title ? "is-active" : ""} key={task.title} onClick={() => setActiveTask(task)}><td><strong>{task.title}</strong><small>来自会话：{task.title}</small></td><td><TaskStatus status={task.status} /></td><td>{task.progress}</td><td>{task.owner}</td><td>{task.updated}</td><td><button className="icon-button" type="button" aria-label={`${task.title}更多操作`}><MoreHorizontal size={17} /></button></td></tr>)}</tbody>
            </table>
          </div>
          <aside className="task-detail-panel">
            <div className="task-detail-panel__header"><div><TaskStatus status={activeTask.status} /><h2>{activeTask.title}</h2><p>任务 ID：TASK-20250520-001</p></div><button className="secondary-button" type="button"><ArrowUpRight size={16} />返回来源会话</button></div>
            <div className="task-detail-grid"><div><span>当前运行</span><strong>RUN-003</strong></div><div><span>使用 Skill</span><strong>需求诊断 v1.0</strong></div><div><span>检查点</span><strong>等待 ChangeSet</strong></div><div><span>工作目录</span><strong>受控目录</strong></div></div>
          </aside>
        </section>
      ) : (
        <section className="run-log-screen">
          <div className="run-log-screen__heading"><div><h1>运行记录</h1><p>任务的执行、暂停、恢复与审批历史</p></div><button className="secondary-button" type="button"><RotateCcw size={16} />恢复运行</button></div>
          <div className="run-log-list">
            <RunLog icon={<PauseCircle size={17} />} title="等待人工确认" detail="ChangeSet 已生成，运行暂停在审批节点。" time="10:15:02" />
            <RunLog icon={<CheckCircle2 size={17} />} title="生成需求诊断卡" detail="结构化输出校验通过。" time="10:14:58" />
            <RunLog icon={<CheckCircle2 size={17} />} title="调用需求诊断 Skill v1.0" detail="运行完成，共引用 18 条知识。" time="10:14:36" />
            <RunLog icon={<Clock3 size={17} />} title="任务创建" detail="从会话“跨部门 AI 需求诊断”进入工作模式。" time="10:12:01" />
          </div>
        </section>
      )}
    </main>
  );
}

function TaskStatus({ status }: { status: string }) {
  const icon = status === "已完成" ? <CheckCircle2 size={14} /> : status === "运行中" ? <CircleDot size={14} /> : <PauseCircle size={14} />;
  return <span className={`task-status task-status--${status === "已完成" ? "done" : status === "运行中" ? "active" : "waiting"}`}>{icon}{status}</span>;
}

function RunLog({ icon, title, detail, time }: { icon: React.ReactNode; title: string; detail: string; time: string }) {
  return <article className="run-log"><span className="run-log__icon">{icon}</span><div><strong>{title}</strong><p>{detail}</p></div><time>{time}</time></article>;
}
