import { AlertTriangle, Check, FileUp, PackageCheck, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { confirmProcurementImport, fetchProcurementOverview, fetchProcurementPriceHistory, previewProcurementImport, publishProcurementBatch, reviewProcurementIssue, submitProcurementPrices } from "../api";
import type { ProcurementImportPreview, ProcurementOverview, ProcurementPriceHistory } from "../types";
import styles from "./ProcurementWorkbench.module.css";

type Tab = "overview" | "materials" | "history" | "issues" | "batches";

export function ProcurementWorkbench({ accessLevel }: { accessLevel: number }) {
  const [data, setData] = useState<ProcurementOverview | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [tab, setTab] = useState<Tab>("overview");
  const [importOpen, setImportOpen] = useState(false);
  const [notice, setNotice] = useState("");

  const load = useCallback((signal?: AbortSignal) => {
    setState("loading");
    return fetchProcurementOverview(signal)
      .then((overview) => { setData(overview); setState("ready"); })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) setState("error");
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (state === "loading") return <ModuleState title="正在读取采购数据" />;
  if (state === "error" || !data) return <ModuleState title="采购工作台暂时不可用" retry={() => void load()} />;

  const openIssues = data.issues.filter((issue) => issue.status === "open");
  return (
    <article className={`workbench-detail ${styles.root}`}>
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>采购部 · 已启用</span>
          <h1>原料成本管理</h1>
          <p>归集采购价格，复核异常后发布可追溯的原料成本基线。</p>
        </div>
        <div className={styles.actions}>
          {accessLevel >= 3 && <button className="secondary-button" type="button" onClick={() => setImportOpen(true)}><FileUp size={15} />导入价格</button>}
          {accessLevel >= 3 && data.working_state.status !== "submitted" && <button className="secondary-button" type="button" disabled={openIssues.length > 0 || data.materials.length === 0} onClick={() => void submit(setData, setNotice)}>提交确认</button>}
          {accessLevel >= 4 && <button className="primary-button" type="button" disabled={data.working_state.status !== "submitted"} onClick={() => void publish(data, setData, setNotice)}><PackageCheck size={15} />发布价格批次</button>}
        </div>
      </header>

      {notice && <div className={styles.notice}><Check size={14} />{notice}<button type="button" aria-label="关闭提示" onClick={() => setNotice("")}><X size={13} /></button></div>}

      <nav className={styles.tabs} aria-label="采购工作台视图">
        {([['overview', '概览'], ['materials', '原料台账'], ['history', '询价历史'], ['issues', `待处理 ${openIssues.length || ''}`], ['batches', '价格批次']] as const).map(([id, label]) => (
          <button type="button" key={id} className={tab === id ? styles.activeTab : ""} onClick={() => setTab(id)}>{label}</button>
        ))}
      </nav>

      {tab === "overview" && <Overview data={data} onOpenIssues={() => setTab("issues")} />}
      {tab === "materials" && <Materials data={data} />}
      {tab === "history" && <PriceHistory />}
      {tab === "issues" && <Issues data={data} canManage={accessLevel >= 4} onUpdated={setData} onNotice={setNotice} />}
      {tab === "batches" && <Batches data={data} />}
      {importOpen && <ImportPanel onClose={() => setImportOpen(false)} onImported={(overview) => { setData(overview); setImportOpen(false); setNotice("价格数据已导入，异常项已进入待处理列表。"); }} />}
    </article>
  );
}

function ModuleState({ title, retry }: { title: string; retry?: () => void }) {
  return <article className="workbench-detail workspace-detail-empty"><RefreshCw size={22} /><strong>{title}</strong>{retry && <button className="secondary-button" type="button" onClick={retry}>重新加载</button>}</article>;
}

function Overview({ data, onOpenIssues }: { data: ProcurementOverview; onOpenIssues: () => void }) {
  const metrics = [
    ["原料数量", data.metrics.material_count, "已纳入当前台账"],
    ["待处理", data.metrics.open_issue_count, data.metrics.open_issue_count ? "发布前需要完成复核" : "当前数据可发布"],
    ["已发布批次", data.metrics.published_batch_count, "历史版本不会被覆盖"],
  ] as const;
  return <>
    <div className="workbench-metrics">{metrics.map(([label, value, note]) => <div key={label}><small>{label}</small><strong>{value}</strong><span>{note}</span></div>)}</div>
    <section className={styles.section}>
      <div className={styles.sectionHeading}><div><span>当前状态</span><h2>最近原料价格</h2></div>{data.metrics.open_issue_count > 0 && <button type="button" onClick={onOpenIssues}>查看待处理</button>}</div>
      <MaterialTable materials={data.materials.slice(0, 6)} />
    </section>
  </>;
}

function Materials({ data }: { data: ProcurementOverview }) {
  return <section className={styles.section}><div className={styles.sectionHeading}><div><span>价格台账</span><h2>全部原料</h2></div><small>{data.materials.length} 条</small></div><MaterialTable materials={data.materials} /></section>;
}

function MaterialTable({ materials }: { materials: ProcurementOverview["materials"] }) {
  if (!materials.length) return <Empty title="还没有原料数据" detail="使用“导入价格”加入第一批采购价格。" />;
  return <div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>编号 / 原料</th><th>单位</th><th>最新价</th><th>在途价</th><th>库存价</th><th>建议价</th></tr></thead><tbody>{materials.map((item) => <tr key={item.id}><td><strong>{item.code}</strong><span>{item.name}</span></td><td>{item.unit}</td><td>{price(item.latest_price)}</td><td>{price(item.in_transit_price)}</td><td>{price(item.inventory_price)}</td><td className={styles.suggested}>{price(item.suggested_price)}</td></tr>)}</tbody></table></div>;
}

function Issues({ data, canManage, onUpdated, onNotice }: { data: ProcurementOverview; canManage: boolean; onUpdated: (data: ProcurementOverview) => void; onNotice: (message: string) => void }) {
  const issues = data.issues.filter((issue) => issue.status !== "resolved");
  if (!issues.length) return <Empty title="没有待处理问题" detail="当前原料数据已通过发布前检查。" />;
  return <section className={styles.section}><div className={styles.sectionHeading}><div><span>异常复核</span><h2>发布前待处理</h2></div><small>{issues.length} 项</small></div><div className={styles.issueList}>{issues.map((issue) => <div key={issue.id}><AlertTriangle size={16} /><span><strong>{issue.material_code} · {issue.material_name}</strong><small>{issue.label}{issue.kind === "missing_price" ? "，请重新导入补充价格" : "，需负责人确认"}</small></span><em className={issue.status === "reviewed" ? styles.reviewed : ""}>{issue.status === "reviewed" ? "已复核" : "待处理"}</em>{canManage && issue.kind === "price_spike" && issue.status === "open" && <button className="secondary-button" type="button" onClick={() => void review(issue.id, onUpdated, onNotice)}>确认波动</button>}</div>)}</div></section>;
}

function PriceHistory() {
  const [rows, setRows] = useState<ProcurementPriceHistory[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetchProcurementPriceHistory(controller.signal).then(setRows).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) setFailed(true);
    });
    return () => controller.abort();
  }, []);
  if (failed) return <Empty title="询价历史暂时不可用" detail="请稍后重新进入该页面。" />;
  if (rows === null) return <Empty title="正在读取询价历史" detail="正在整理价格来源记录。" />;
  if (!rows.length) return <Empty title="还没有询价历史" detail="每次确认导入后，系统会保留原料价格记录。" />;
  return <section className={styles.section}><div className={styles.sectionHeading}><div><span>来源记录</span><h2>询价历史</h2></div><small>{rows.length} 条</small></div><div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>编号 / 原料</th><th>来源</th><th>最新价</th><th>在途价</th><th>库存价</th><th>记录时间</th></tr></thead><tbody>{rows.map((item) => <tr key={item.id}><td><strong>{item.material_code}</strong><span>{item.material_name}</span></td><td>{item.source_name}</td><td>{price(item.latest_price)}</td><td>{price(item.in_transit_price)}</td><td>{price(item.inventory_price)}</td><td>{formatDate(item.recorded_at)}</td></tr>)}</tbody></table></div></section>;
}

function Batches({ data }: { data: ProcurementOverview }) {
  if (!data.batches.length) return <Empty title="还没有已发布批次" detail="解决全部异常后，可由管理权限用户发布第一个价格版本。" />;
  return <section className={styles.section}><div className={styles.sectionHeading}><div><span>确认版本</span><h2>价格批次</h2></div><small>{data.batches.length} 个版本</small></div><div className={styles.batchList}>{data.batches.map((batch) => <div key={batch.id}><PackageCheck size={17} /><span><strong>价格基线 v{batch.version}</strong><small>{formatDate(batch.published_at)} · {batch.item_count} 项原料</small></span><em>已发布</em></div>)}</div></section>;
}

function ImportPanel({ onClose, onImported }: { onClose: () => void; onImported: (data: ProcurementOverview) => void }) {
  const [source, setSource] = useState("采购价格导入");
  const [content, setContent] = useState("");
  const [preview, setPreview] = useState<ProcurementImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = async (confirm: boolean) => {
    setBusy(true); setError("");
    try {
      if (confirm) {
        await confirmProcurementImport(source, content);
        onImported(await fetchProcurementOverview());
      } else {
        setPreview(await previewProcurementImport(source, content));
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "导入失败");
    } finally { setBusy(false); }
  };

  return <div className={styles.importPanel}>
    <div className={styles.importHeading}><div><span>价格导入</span><h2>预览后再写入台账</h2></div><button className="icon-button" type="button" aria-label="关闭导入" onClick={onClose}><X size={17} /></button></div>
    <label>来源名称<input value={source} onChange={(event) => setSource(event.target.value)} /></label>
    <label className={styles.filePicker}><FileUp size={14} />选择 CSV 或 TXT<input type="file" accept=".csv,.txt,text/csv,text/plain" onChange={(event) => { const file = event.target.files?.[0]; if (!file) return; setSource(file.name); void file.text().then((text) => { setContent(text); setPreview(null); }); }} /></label>
    <label>CSV、TXT 或粘贴表格<textarea rows={8} value={content} onChange={(event) => { setContent(event.target.value); setPreview(null); }} placeholder={'编号,名称,单位,最新价,库存价,在途价\nCF004,示例原料,kg,12.2,13,12.4'} /></label>
    {error && <p className={styles.error}>{error}</p>}
    {preview && <><div className={styles.preview}><strong>{preview.received_count} 行 · {preview.importable_count} 行可导入 · {preview.skipped_count} 行跳过</strong><span>{preview.rows.filter((row) => row.issues.length).length} 行需要后续复核</span></div><div className={styles.previewRows}>{preview.rows.slice(0, 8).map((row) => <div key={`${row.code}-${row.name}`}><span><strong>{row.code}</strong>{row.name}</span><em>{row.issues.length ? row.issues.map(importIssueLabel).join("、") : "可导入"}</em></div>)}</div></>}
    <div className={styles.importActions}><button className="secondary-button" type="button" disabled={busy || !content.trim()} onClick={() => void run(false)}>检查数据</button><button className="primary-button" type="button" disabled={busy || !preview || preview.importable_count === 0} onClick={() => void run(true)}>确认写入</button></div>
  </div>;
}

function Empty({ title, detail }: { title: string; detail: string }) {
  return <div className={styles.empty}><PackageCheck size={21} /><strong>{title}</strong><p>{detail}</p></div>;
}

async function review(issueId: string, onUpdated: (data: ProcurementOverview) => void, onNotice: (message: string) => void) {
  await reviewProcurementIssue(issueId);
  onUpdated(await fetchProcurementOverview());
  onNotice("价格波动已确认，可以继续发布检查。");
}

async function submit(onUpdated: (data: ProcurementOverview) => void, onNotice: (message: string) => void) {
  try {
    await submitProcurementPrices();
    onUpdated(await fetchProcurementOverview());
    onNotice("价格工作稿已提交，请由另一位负责人复核发布。");
  } catch (reason) {
    onNotice(reason instanceof Error ? reason.message : "提交失败");
  }
}

async function publish(data: ProcurementOverview, onUpdated: (data: ProcurementOverview) => void, onNotice: (message: string) => void) {
  try {
    const batch = await publishProcurementBatch();
    onUpdated(await fetchProcurementOverview());
    onNotice(`价格基线 v${batch.version} 已发布，历史版本已保留。`);
  } catch (reason) {
    onNotice(reason instanceof Error ? reason.message : "发布失败");
    onUpdated(data);
  }
}

function price(value?: string | null) { return value == null ? "—" : `¥${value}`; }
function formatDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function importIssueLabel(issue: string) { return ({ missing_price: "缺价", duplicate_code: "重复编码", unit_conflict: "单位冲突", price_spike: "价格波动" } as Record<string, string>)[issue] ?? issue; }
