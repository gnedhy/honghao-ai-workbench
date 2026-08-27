import { Clock3, MoreHorizontal, Search } from "lucide-react";
import { useState } from "react";
import { SegmentedControl } from "../components/SegmentedControl";
import { TopBar, type ScreenChromeProps } from "../components/TopBar";
import { taskStatusLabel } from "../taskPresentation";
import type { Conversation, Project, TaskItem } from "../types";

type TaskBoardScreenProps = ScreenChromeProps & {
  tasks: TaskItem[];
  projects: Project[];
  conversations: Conversation[];
  dataState: "loading" | "ready" | "error";
  selectedTask: TaskItem | null;
  onSelectedTaskChange: (task: TaskItem) => void;
};

export function TaskBoardScreen({ contextOpen, onOpenNavigation, onToggleContext, moduleMode, environment, tasks, projects, conversations, dataState, selectedTask, onSelectedTaskChange }: TaskBoardScreenProps) {
  const [tab, setTab] = useState<"任务管理" | "运行记录">("任务管理");
  const [query, setQuery] = useState("");
  const visibleTasks = tasks.filter((task) => task.objective.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <main className="app-main">
      <TopBar
        title="任务看板"
        subtitle={tab === "任务管理" ? `${tasks.length} 个任务` : "真实运行历史"}
        tabs={<SegmentedControl value={tab} options={["任务管理", "运行记录"] as const} onChange={setTab} label="任务看板类型" />}
        contextOpen={contextOpen}
        onOpenNavigation={onOpenNavigation}
        onToggleContext={onToggleContext}
        moduleMode={moduleMode}
        environment={environment}
      />
      {tab === "任务管理" ? (
        <section className="task-board">
          <div className="task-board__toolbar"><div><h1>任务管理</h1><p>由工作提交产生的持久执行对象</p></div><label className="search-field search-field--short"><Search size={16} /><input aria-label="搜索任务" placeholder="搜索任务" value={query} onChange={(event) => setQuery(event.target.value)} /></label></div>
          {dataState === "loading" && <p className="board-state">正在读取任务…</p>}
          {dataState === "error" && <p className="board-state board-state--error">任务读取失败，请检查本地服务后重试。</p>}
          {dataState === "ready" && visibleTasks.length === 0 && <div className="board-empty"><Clock3 size={20} /><h2>{tasks.length === 0 ? "还没有任务" : "没有匹配的任务"}</h2><p>{tasks.length === 0 ? "在会话中切换到工作并提交内容后，任务会出现在这里。" : "换一个关键词试试。"}</p></div>}
          {visibleTasks.length > 0 && (
            <div className="task-table-wrap">
              <table className="task-table">
                <thead><tr><th>任务</th><th>状态</th><th>项目</th><th>最近运行</th><th>创建时间</th><th><span className="sr-only">操作</span></th></tr></thead>
                <tbody>{visibleTasks.map((task) => {
                  const conversation = conversations.find((item) => item.id === task.conversation_id);
                  const project = projects.find((item) => item.id === task.project_id);
                  return <tr className={selectedTask?.id === task.id ? "is-active" : ""} key={task.id} onClick={() => onSelectedTaskChange(task)}><td><strong>{task.objective}</strong><small>来自会话：{conversation?.title ?? "会话不可用"}</small></td><td><span className="task-status task-status--waiting"><Clock3 size={14} />{taskStatusLabel(task.status)}</span></td><td>{project?.title ?? "未关联"}</td><td>{task.latest_run ?? "尚未运行"}</td><td>{formatDate(task.created_at)}</td><td><button className="icon-button" type="button" aria-label={`${task.objective}更多操作`}><MoreHorizontal size={17} /></button></td></tr>;
                })}</tbody>
              </table>
            </div>
          )}
        </section>
      ) : (
        <section className="run-log-screen">
          <div className="run-log-screen__heading"><div><h1>运行记录</h1><p>执行、暂停、恢复与审批历史</p></div></div>
          <div className="board-empty"><Clock3 size={20} /><h2>尚无运行记录</h2><p>任务将在接入受控执行环境后产生真实运行记录。</p></div>
        </section>
      )}
    </main>
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}
