// Isolated integration example. No production registry or business API imports.
import { useEffect, useState } from "react";
import { useUnsavedChanges } from "../../src/components/Interaction";
import { PageState, WorkbenchLoading } from "../../src/components/WorkbenchLayout";

export function StaticWorkbenchExample({ accessLevel, view, onEnter, read }: {
  accessLevel: number;
  view: "preview" | "full";
  onEnter: () => void;
  read: (signal: AbortSignal) => Promise<string>;
}) {
  const [data, setData] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const unsaved = useUnsavedChanges(!!draft, busy, "示例输入尚未保存。", "workbench-before-leave");
  useEffect(() => {
    if (accessLevel < 2) return;
    const controller = new AbortController();
    setError("");
    void read(controller.signal).then(value => { if (!controller.signal.aborted) setData(value); })
      .catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [accessLevel, read, retry]);
  if (accessLevel < 2) return <PageState>暂无示例查看权限</PageState>;
  if (error) return <PageState error onRetry={() => setRetry(value => value + 1)}>{error}</PageState>;
  if (data === null) return <WorkbenchLoading title="正在加载隔离示例"/>;
  return <article className="workbench-detail">
    <h1>静态工作台接入示例</h1><p>{data || "示例数据为空"}</p>
    {view === "preview" ? <button onClick={onEnter}>进入示例</button> : <>
      <label>示例输入<input value={draft} disabled={accessLevel < 3 || busy} onChange={event => setDraft(event.target.value)}/></label>
      <button onClick={() => setBusy(value => !value)}>切换示例忙碌状态</button>
      <p role="status">{busy ? "示例正在处理" : "示例可编辑"}</p>
    </>}
    {unsaved.confirmation}
  </article>;
}
