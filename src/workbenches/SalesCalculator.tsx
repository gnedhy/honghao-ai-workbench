import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Copy, GripVertical, Info, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";

import { fetchJson } from "../api";
import { DecimalInput } from "../components/DecimalInput";
import { DiscardChangesDialog, useUnsavedChanges } from "../components/Interaction";
import { WorkbenchOptionMenu } from "../components/WorkbenchMenus";
import p from "../components/WorkbenchSurface.module.css";
import { base, modes, type Mode, type Product } from "./salesModel";
import { SalesProductPicker } from "./SalesProductPicker";
import c from "./SalesCalculator.module.css";

type Operation = "+" | "-" | "*" | "/";
type Tier = { upper: string | null; amount: string };
type Step = {
  id: string;
  label: string;
  operation: Operation;
  value: string | null;
  automatic_allocation: boolean;
  fee: boolean;
  allocation_step?: boolean;
  tiers?: Tier[] | null;
};
type Panel = {
  id: string;
  name: string;
  mode: Mode;
  direction: "forward" | "reverse";
  target_price: string;
  steps: Step[];
};
type Source = {
  kind: "manual" | "product" | "snapshot";
  product_id?: string | null;
  basis?: "latest" | "inventory";
  cost?: string | null;
  special_allocation?: boolean;
  product_code?: string;
  source_version?: string;
};
type Result = {
  price: string;
  target_cost: string | null;
  cost_gap: string | null;
  allocation_amount?: string;
  trail: { id: string; value: string }[];
};
type Evaluation = {
  source: Source;
  results: { id: string; result: Result | null; error: string | null }[];
  default_allocation_tiers: Tier[];
};
type Saved = {
  id: string;
  kind: "template" | "workspace";
  name: string;
  revision: number;
  payload: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};
type TierDraft = { panelId: string; stepId: string; rows: Tier[]; error: string };

const endpoint = base + "/calculator";
const request = <T,>(path: string, body: unknown, method = "POST") =>
  fetchJson<T>(endpoint + path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const id = () => crypto.randomUUID();
const format = (value: string | number | null | undefined) =>
  value == null || value === "" || !Number.isFinite(Number(value))
    ? "—"
    : Number(value).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dateLabel = (value: string) =>
  new Date(value).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const basisLabel = (basis?: Source["basis"]) => basis === "inventory" ? "库存优先" : "最新优先";
const operationLabel: Record<Operation, string> = { "+": "+", "-": "−", "*": "×", "/": "÷" };

function defaults(mode: Mode, special = false): Step[] {
  const row = (label: string, operation: Operation, value: string | null, fee = false, automatic_allocation = false, allocation_step = false): Step =>
    ({ id: id(), label, operation, value, fee, automatic_allocation, allocation_step });
  if (mode.startsWith("export")) return [
    row("外贸加项一", "+", "0.75", true),
    row("外贸加项二", "+", "1.65", true),
    row("外贸系数", "*", "1.15"),
  ];
  return [
    row(special ? "特殊公摊" : "公摊", "+", special ? "" : null, true, !special, true),
    row("运费", "+", "0.3", true),
    row("桶费", "+", "0.5", true),
    row("税提成系数", "*", mode === "domestic_direct" ? "1.11" : "1.09"),
    row("利润系数", "*", "1.1"),
    row("反推核算比例", "*", mode === "domestic_direct" ? "1.07" : "1.04"),
  ];
}

const makePanel = (name: string, special = false, mode: Mode = "domestic_direct"): Panel =>
  ({ id: id(), name, mode, direction: "forward", target_price: "", steps: defaults(mode, special) });
const initialProduct = (products: Product[]) =>
  products.find(row => !row.special_allocation && row.latest_cost != null)
  ?? products.find(row => !row.special_allocation && row.inventory_cost != null)
  ?? products[0];
const initialSource = (products: Product[]): Source => {
  const product = initialProduct(products);
  return product
    ? { kind: "product", product_id: product.id, basis: product.latest_cost != null ? "latest" : "inventory" }
    : { kind: "manual", cost: "" };
};
const initialPanels = (special = false) => [makePanel("面板 1", special), makePanel("面板 2", special)];
const fingerprint = (source: Source, panels: Panel[]) => JSON.stringify({ source, panels });
const isAllocation = (step: Step) =>
  !!(step.allocation_step || step.automatic_allocation || step.tiers || step.label.includes("公摊"));
const incompleteStep = (panel: Panel) => panel.steps.findIndex(step =>
  !step.label.trim() || (!step.automatic_allocation && !step.value?.trim()));

function scaledDecimal(value: string): bigint | null {
  const text = value.trim();
  if (!/^(?:\d+(?:\.\d{1,18})?|\.\d{1,18})$/.test(text)) return null;
  const [whole = "0", fraction = ""] = text.split(".");
  const amount = BigInt(whole || "0") * 10n ** 18n + BigInt(fraction.padEnd(18, "0") || "0");
  return amount <= 1_000_000_000n * 10n ** 18n ? amount : null;
}

function tierError(rows: Tier[]): string {
  if (!rows.length) return "至少保留一档公摊";
  let lower = 0n;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (scaledDecimal(row.amount) == null) return `第 ${index + 1} 档公摊金额无效`;
    if (index === rows.length - 1) {
      if (row.upper !== null) return "最后一档须为无上限";
      continue;
    }
    const upper = row.upper == null ? null : scaledDecimal(row.upper);
    if (upper == null || upper <= lower) return `第 ${index + 1} 档成本上限须高于前一档`;
    lower = upper;
  }
  return "";
}

function tierRows(rows: Tier[], cost?: string | null) {
  let lower = 0n;
  let lowerLabel = "0";
  const currentCost = scaledDecimal(cost ?? "");
  return rows.map(row => {
    const upper = row.upper == null ? null : scaledDecimal(row.upper);
    const active = currentCost != null && currentCost >= lower && (upper == null || currentCost < upper);
    const tier = { lower: lowerLabel, upper: row.upper ?? "无上限", bounded: row.upper != null, amount: format(row.amount), active };
    if (upper != null) { lower = upper; lowerLabel = row.upper!; }
    return tier;
  });
}

function TierEditor({ rows, error, onRows, onApply, onCancel }: {
  rows: Tier[];
  error: string;
  onRows: (rows: Tier[]) => void;
  onApply: () => void;
  onCancel: () => void;
}) {
  const change = (index: number, patch: Partial<Tier>) =>
    onRows(rows.map((row, current) => current === index ? { ...row, ...patch } : row));
  return <div className={c.tierEditor}>
    <div className={c.tierEditorHead}><strong>编辑公摊分档</strong><span>按产品成本划档，末档无上限 · 元/kg</span></div>
    <div className={c.tierTableWrap}><table className={c.tierEditorTable} aria-label="编辑公摊分档">
      <colgroup><col /><col /><col /><col /><col /></colgroup>
      <thead><tr><th colSpan={3} scope="colgroup">产品成本区间</th><th scope="col">公摊金额</th><th scope="col" aria-label="删除" /></tr></thead>
      <tbody>{rows.map((row, index) => <tr key={index}>
        {index === rows.length - 1 ? <td colSpan={3} className={c.tierUnbounded}>成本 ≥ {index === 0 ? "0" : rows[index - 1].upper ?? "—"}</td> : <>
          <td className={c.tierLower}>{index === 0 ? "0" : rows[index - 1].upper ?? "—"}</td>
          <td className={c.tierOperator}>≤ 成本 &lt;</td>
          <td className={c.tierUpper}><DecimalInput aria-label={`第 ${index + 1} 档成本上限`} value={row.upper ?? ""} onChange={event => change(index, { upper: event.target.value })} /></td>
        </>}
        <td className={c.tierAmount}><DecimalInput aria-label={`第 ${index + 1} 档公摊金额`} value={row.amount} onChange={event => change(index, { amount: event.target.value })} /></td>
        <td className={c.tierDelete}><button type="button" aria-label={`删除第 ${index + 1} 档`} title="删除分档" disabled={rows.length <= 1} onClick={() => {
          const next = rows.filter((_, current) => current !== index);
          next[next.length - 1] = { ...next[next.length - 1], upper: null };
          onRows(next);
        }}><Trash2 size={13} /></button></td>
      </tr>)}</tbody>
    </table></div>
    {error && <p className={c.tierError} role="alert">{error}</p>}
    <div className={c.tierFooter}>
      <button className={c.addTier} type="button" disabled={rows.length >= 20} onClick={() =>
        onRows([...rows.slice(0, -1), { upper: "", amount: "" }, rows[rows.length - 1]])}><Plus size={13} />增加分档</button>
      <div className={c.tierActions}><button type="button" className="secondary-button" onClick={onCancel}>取消</button><button type="button" className="primary-button" onClick={onApply}>应用分档</button></div>
    </div>
  </div>;
}

export function SalesCalculator({ products, accessLevel }: { products: Product[]; accessLevel: number }) {
  const [initial] = useState(() => ({ source: initialSource(products), panels: initialPanels(initialProduct(products)?.special_allocation) }));
  const [source, setSource] = useState<Source>(initial.source);
  const [panels, setPanels] = useState<Panel[]>(initial.panels);
  const [active, setActive] = useState<Saved | null>(null);
  const [saved, setSaved] = useState<Saved[]>([]);
  const [savedError, setSavedError] = useState("");
  const [evaluationError, setEvaluationError] = useState("");
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [templatePanel, setTemplatePanel] = useState<string | null>(null);
  const [templateName, setTemplateName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Saved | null>(null);
  const [tierDraft, setTierDraft] = useState<TierDraft | null>(null);
  const [editingPanel, setEditingPanel] = useState<{ id: string; name: string } | null>(null);
  const [expandedTrails, setExpandedTrails] = useState<string[]>([]);
  const [dropTarget, setDropTarget] = useState<{ panelId: string; index: number } | null>(null);
  const drag = useRef<{ panelId: string; from: number; to: number } | null>(null);
  const referenceMenu = useRef<HTMLDetailsElement>(null);
  const historyMenu = useRef<HTMLDetailsElement>(null);
  const [clean, setClean] = useState(() => fingerprint(initial.source, initial.panels));
  const dirty = fingerprint(source, panels) !== clean;
  const guard = useUnsavedChanges(dirty, busy, "尚未保存的测算方案将被放弃。", "sales-before-leave");
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (referenceMenu.current && !referenceMenu.current.contains(event.target as Node)) referenceMenu.current.open = false;
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  const currentProduct = products.find(row => row.id === source.product_id);
  const currentCost = currentProduct
    ? source.basis === "inventory" ? currentProduct.inventory_cost : currentProduct.latest_cost
    : null;
  const sourceCost = source.kind === "product" ? currentCost : source.cost;
  const costChanged = source.kind === "snapshot" && !!currentProduct
    && (source.cost !== currentCost || source.source_version !== (currentProduct.source_version || ""));
  const sourceSpecial = source.kind === "snapshot"
    ? !!source.special_allocation
    : source.kind === "product" && !!currentProduct?.special_allocation;
  const forwardPanelNames = panels.flatMap((panel, index) => panel.direction === "forward" ? [`面板 ${index + 1}`] : []);
  const allReverse = forwardPanelNames.length === 0;
  const hasReverse = forwardPanelNames.length < panels.length;
  const forwardScope = forwardPanelNames.length > 2 ? `${forwardPanelNames.length} 个面板` : forwardPanelNames.join("、");
  const templates = useMemo(() => saved.filter(row => row.kind === "template"), [saved]);
  const workspaces = useMemo(() => saved.filter(row => row.kind === "workspace"), [saved]);

  useEffect(() => {
    let mounted = true;
    void fetchJson<{ saved: Saved[] }>(endpoint + "/saved")
      .then(value => { if (mounted) setSaved(value.saved); })
      .catch(error => { if (mounted) setSavedError(error instanceof Error ? error.message : "历史测算读取失败"); });
    return () => { mounted = false; };
  }, []);
  useEffect(() => {
    let mounted = true;
    setEvaluation(null);
    setEvaluationError("");
    const readyPanels = panels.filter(panel => incompleteStep(panel) < 0);
    setEvaluating(readyPanels.length > 0);
    if (!readyPanels.length) return () => { mounted = false; };
    const timer = window.setTimeout(() => {
      void request<Evaluation>("/evaluate", { source, panels: readyPanels })
        .then(value => { if (mounted) { setEvaluation(value); setEvaluating(false); } })
        .catch(error => {
          if (mounted) {
            setEvaluationError(error instanceof Error && error.message.includes("Failed to fetch") ? "计算服务暂时无法连接，请稍后重试。" : "测算暂时无法完成，请检查输入后重试。");
            setEvaluating(false);
          }
        });
    }, 180);
    return () => { mounted = false; window.clearTimeout(timer); };
  }, [source, panels]);

  const changePanel = (key: string, update: (panel: Panel) => Panel) =>
    setPanels(rows => rows.map(row => row.id === key ? update(row) : row));
  const changeStep = (panelId: string, stepId: string, update: (step: Step) => Step) =>
    changePanel(panelId, panel => ({ ...panel, steps: panel.steps.map(step => step.id === stepId ? update(step) : step) }));
  const moveStep = (panelId: string, from: number, to: number) => {
    if (from === to || to < 0) return;
    changePanel(panelId, panel => {
      if (to >= panel.steps.length) return panel;
      const steps = [...panel.steps];
      steps.splice(to, 0, steps.splice(from, 1)[0]);
      return { ...panel, steps };
    });
  };
  const resetWorkspace = async () => {
    if (!await guard.request()) return;
    const nextSource = initialSource(products);
    const nextPanels = initialPanels(initialProduct(products)?.special_allocation);
    setSource(nextSource);
    setPanels(nextPanels);
    setActive(null);
    setClean(fingerprint(nextSource, nextPanels));
    setTierDraft(null);
    setSavedError("");
    historyMenu.current!.open = false;
  };
  const openWorkspace = async (row: Saved) => {
    if (!await guard.request()) return;
    const payload = row.payload as { source: Source; panels: Panel[] };
    setSource(payload.source);
    setPanels(payload.panels);
    setActive(row);
    setClean(fingerprint(payload.source, payload.panels));
    setTierDraft(null);
    setSavedError("");
    historyMenu.current!.open = false;
  };
  const saveWorkspace = async () => {
    if (busy) return;
    setBusy(true);
    setSavedError("");
    try {
      const row = await request<Saved>("/saved", { kind: "workspace", payload: { source, panels } });
      const payload = row.payload as { source: Source; panels: Panel[] };
      setActive(row);
      setSaved(rows => [row, ...rows]);
      setSource(payload.source);
      setPanels(payload.panels);
      setClean(fingerprint(payload.source, payload.panels));
    } catch (error) {
      setSavedError(error instanceof Error ? error.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };
  const saveTemplate = async (panel: Panel) => {
    if (!templateName.trim() || busy) return;
    setBusy(true);
    setSavedError("");
    try {
      const row = await request<Saved>("/saved", {
        kind: "template", name: templateName.trim(), payload: { mode: panel.mode, steps: panel.steps },
      });
      setSaved(rows => [row, ...rows]);
      setTemplatePanel(null);
      setTemplateName("");
      requestAnimationFrame(() => document.getElementById(`calculator-${panel.id}`)?.querySelector<HTMLButtonElement>("[data-save-template]")?.focus());
    } catch (error) {
      setSavedError(error instanceof Error ? error.message : "公式保存失败");
    } finally {
      setBusy(false);
    }
  };
  const deleteSaved = async () => {
    if (!deleteTarget || busy) return;
    setBusy(true);
    setSavedError("");
    try {
      await fetchJson(endpoint + `/saved/${deleteTarget.id}`, { method: "DELETE" });
      setSaved(rows => rows.filter(row => row.id !== deleteTarget.id));
      if (active?.id === deleteTarget.id) {
        setActive(null);
        setClean("");
      }
      setDeleteTarget(null);
    } catch (error) {
      setSavedError(error instanceof Error ? error.message : "删除失败");
    } finally {
      setBusy(false);
    }
  };
  const selectProduct = (product: Product, basis: "latest" | "inventory") => {
    setSource({ kind: "product", product_id: product.id, basis });
    setPanels(rows => rows.map(panel => ({
      ...panel,
      steps: panel.steps.map(step => product.special_allocation && step.automatic_allocation
        ? { ...step, label: "特殊公摊", automatic_allocation: false, allocation_step: true, value: "" }
        : !product.special_allocation && step.allocation_step && step.label === "特殊公摊" && step.value === ""
          ? { ...step, label: "公摊", automatic_allocation: true, value: null }
          : step),
    })));
  };
  const addPanel = () => {
    if (panels.length >= 12) return;
    const copy = panels.at(-1)!;
    const next = { ...copy, id: id(), name: `面板 ${panels.length + 1}`, steps: copy.steps.map(step => ({ ...step, id: id() })) };
    setPanels(rows => [...rows, next]);
    requestAnimationFrame(() => document.getElementById(`calculator-${next.id}`)?.scrollIntoView({
      block: "nearest", inline: "end",
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    }));
  };
  const openTierEditor = (panelId: string, stepId: string, step: Step) => {
    const rows = step.tiers ?? evaluation?.default_allocation_tiers;
    if (!rows) return;
    setTierDraft({ panelId, stepId, rows: rows.map(row => ({
      upper: row.upper?.replace(/^\./, "0.") ?? null,
      amount: row.amount.replace(/^\./, "0."),
    })), error: "" });
  };
  const applyTiers = () => {
    if (!tierDraft) return;
    const error = tierError(tierDraft.rows);
    if (error) { setTierDraft({ ...tierDraft, error }); return; }
    const rows = tierDraft.rows.map(row => ({ upper: row.upper?.trim() ?? null, amount: row.amount.trim() }));
    changeStep(tierDraft.panelId, tierDraft.stepId, step => ({
      ...step, allocation_step: true, automatic_allocation: true, value: null, tiers: rows,
    }));
    setTierDraft(null);
  };
  const historyDetails = (row: Saved) => {
    const payload = row.payload as { source?: Source; panels?: Panel[] };
    const savedSource = payload.source;
    const label = savedSource?.kind === "manual" ? "手工成本" : savedSource?.product_code || "产品成本";
    return `${label}${savedSource?.kind === "manual" ? "" : ` · ${basisLabel(savedSource?.basis)}`} · ${payload.panels?.length ?? 0} 个面板`;
  };
  const sourceLabel = source.kind === "manual" ? "手工成本"
    : `${currentProduct?.code || source.product_code || "产品"} · ${basisLabel(source.basis)}`;
  const sourceSummary = `${sourceLabel} · ${sourceCost == null || sourceCost === "" ? "未填写" : `${format(sourceCost)} 元/kg`}`;
  const sourceControls = <>
    <div className={c.sourceChoice} role="group" aria-label="成本来源">
      <button type="button" aria-pressed={source.kind !== "manual"} onClick={() => {
        if (source.kind === "manual") {
          const product = initialProduct(products);
          if (product) selectProduct(product, product.latest_cost != null ? "latest" : "inventory");
        }
      }}>选择产品</button>
      <button type="button" aria-pressed={source.kind === "manual"} onClick={() => {
        if (source.kind !== "manual") {
          setSource({ kind: "manual", cost: "" });
          setPanels(rows => rows.map(panel => ({ ...panel, steps: panel.steps.map(step =>
            step.allocation_step && step.label === "特殊公摊" && step.value === ""
              ? { ...step, label: "公摊", automatic_allocation: true, value: null } : step) })));
        }
      }}>手工成本</button>
    </div>
    {source.kind === "manual"
      ? <label className={c.manualCost}>产品成本 <DecimalInput aria-label="手工产品成本" value={source.cost ?? ""} placeholder="输入金额" onChange={event => setSource({ ...source, cost: event.target.value })} /><small>元/kg</small></label>
      : <SalesProductPicker products={products} selected={currentProduct} basis={source.basis} cost={sourceCost} onSelect={selectProduct} />}
    {source.kind === "snapshot" && <span className={c.snapshot}>
      {costChanged ? "正式成本已变化" : "保存时成本快照"}
      <button className="secondary-button" type="button" disabled={!currentProduct} onClick={() =>
        setSource({ kind: "product", product_id: source.product_id, basis: source.basis })}>刷新正式成本</button>
    </span>}
  </>;

  return <section className={c.tool} aria-label="测算工具">
    <div className={c.toolbar}>
      {hasReverse ? <details className={c.referenceSource} ref={referenceMenu} onKeyDown={event => {
        if (event.key === "Escape" && event.target instanceof Element && event.target.closest("details") === event.currentTarget) {
          event.preventDefault();
          event.currentTarget.open = false;
          event.currentTarget.querySelector("summary")?.focus();
        }
      }}>
        <summary><strong>{allReverse ? "反推参考（成本不参与推算）" : `常规测算成本（${forwardScope}）`}</strong><span title={sourceSummary}>{sourceSummary}</span><ChevronDown size={14} /></summary>
        <div className={c.referenceFields}>
          <strong className={c.referenceTitle}>{allReverse ? "调整反推参照" : "调整常规测算成本"}</strong>
          {sourceControls}
          <small>反推金额不使用此处成本数值；所选产品的特殊公摊规则仍适用。成本差额可在计算过程中查看。</small>
        </div>
      </details> : <><span className={c.sourceCaption}>常规测算成本</span>{sourceControls}</>}
      <div className={c.workspaceActions}>
        <details className={c.savedMenu} ref={historyMenu} onKeyDown={event => {
          if (event.key === "Escape") { event.preventDefault(); historyMenu.current!.open = false; historyMenu.current?.querySelector("summary")?.focus(); }
        }}>
          <summary>历史测算 <ChevronDown size={14} /></summary>
          <div>
            <button type="button" className={c.resetAction} onClick={() => void resetWorkspace()}><RotateCcw size={13} />重置测算</button>
            <strong>已保存的对比</strong>
            {workspaces.map(row => <div className={c.historyRow} key={row.id}>
              <button type="button" onClick={() => void openWorkspace(row)}>
                <b>{dateLabel(row.created_at)}</b><small>{historyDetails(row)}</small>
              </button>
              {accessLevel >= 3 && <button type="button" aria-label={`删除 ${dateLabel(row.created_at)} 的测算`} title="删除历史测算" onClick={() => setDeleteTarget(row)}><Trash2 size={14} /></button>}
            </div>)}
            {!workspaces.length && <small>暂无历史测算</small>}
          </div>
        </details>
        {accessLevel >= 3 && <button className="primary-button" type="button" disabled={busy || panels.some(panel => incompleteStep(panel) >= 0)} onClick={() => void saveWorkspace()}>{busy ? "保存中…" : "保存对比"}</button>}
      </div>
    </div>
    {(savedError || evaluationError) && <p className={c.error} role="alert">{savedError || evaluationError}</p>}
    <p className={c.note}>独立试算 · 不生成正式客户报价。{active
      ? dirty ? "修改尚未保存；再次保存会新增历史记录。" : "已保存到历史测算。"
      : "当前测算尚未保存。"}</p>

    <div className={c.panelTrack} aria-label="公式方案对比">
      {panels.map((panel, index) => {
        const panelLabel = `面板 ${index + 1}`;
        const displayName = panel.name?.trim() || panelLabel;
        const state = evaluation?.results.find(row => row.id === panel.id);
        const result = state?.result;
        const missingIndex = incompleteStep(panel);
        const baseline = panels.find(row => row.direction === panel.direction)!;
        const firstResult = baseline.id !== panel.id
          ? evaluation?.results.find(row => row.id === baseline.id)?.result : null;
        const difference = result && firstResult ? Number(panel.direction === "forward" ? result.price : result.target_cost)
          - Number(panel.direction === "forward" ? firstResult.price : firstResult.target_cost) : null;
        const showCostGap = result?.cost_gap != null && Math.abs(Number(result.cost_gap)) >= 0.005;
        const showDifference = difference != null && Math.abs(difference) >= 0.005;
        return <article className={c.panel} id={`calculator-${panel.id}`} key={panel.id} aria-label={panelLabel}>
          <div className={c.panelHead}>
            <div className={c.panelName}>
              {editingPanel?.id === panel.id ? <input autoFocus aria-label={`${panelLabel}名称`} maxLength={60} value={editingPanel.name}
                onChange={event => setEditingPanel({ id: panel.id, name: event.target.value })}
                onBlur={event => {
                  const name = event.currentTarget.value.trim();
                  if (name) changePanel(panel.id, row => ({ ...row, name }));
                  setEditingPanel(null);
                }}
                onKeyDown={event => {
                  if (event.key === "Enter") {
                    event.currentTarget.blur();
                    requestAnimationFrame(() => document.getElementById(`calculator-${panel.id}`)?.querySelector<HTMLButtonElement>("[data-rename-panel]")?.focus());
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.currentTarget.value = panel.name;
                    setEditingPanel(null);
                    requestAnimationFrame(() => document.getElementById(`calculator-${panel.id}`)?.querySelector<HTMLButtonElement>("[data-rename-panel]")?.focus());
                  }
                }} /> : <strong title={displayName}>{displayName}</strong>}
              {editingPanel?.id !== panel.id && <button type="button" className={c.renamePanel} data-rename-panel title="编辑面板名称" aria-label={`编辑${panelLabel}名称`}
                onClick={() => setEditingPanel({ id: panel.id, name: displayName })}><Pencil size={13} /></button>}
            </div>
            <div>
              <button type="button" className={c.iconButton} disabled={panels.length >= 12} title="复制面板" aria-label={`复制${panelLabel}`} onClick={() => {
                const next = { ...panel, id: id(), name: `面板 ${panels.length + 1}`, steps: panel.steps.map(step => ({ ...step, id: id() })) };
                setPanels(rows => [...rows.slice(0, index + 1), next, ...rows.slice(index + 1)]);
              }}><Copy size={15} /></button>
              <button type="button" className={c.iconButton} disabled={panels.length <= 1} title="删除面板" aria-label={`删除${panelLabel}`} onClick={() =>
                setPanels(rows => rows.filter(row => row.id !== panel.id))}><Trash2 size={15} /></button>
            </div>
          </div>
          <div className={c.panelOptions}>
            <div className={c.customerType}><span>客户类型</span><WorkbenchOptionMenu label={`${panelLabel}客户类型`} value={panel.mode}
              options={Object.entries(modes).map(([value, label]) => ({ value, label }))} className={c.customerMenu}
              onSelect={value => changePanel(panel.id, row => ({ ...row, mode: value as Mode, steps: defaults(value as Mode, sourceSpecial) }))} /></div>
            <div role="group" aria-label={`${panelLabel}测算方向`} className={c.direction}>
              <button type="button" aria-pressed={panel.direction === "forward"} onClick={() =>
                changePanel(panel.id, row => ({ ...row, direction: "forward" }))}>常规测算</button>
              <button type="button" aria-pressed={panel.direction === "reverse"} onClick={() =>
                changePanel(panel.id, row => ({ ...row, direction: "reverse" }))}>反推测算</button>
            </div>
          </div>
          {panel.direction === "reverse" && <label className={c.target}>意向报价（元/kg）
            <DecimalInput value={panel.target_price} aria-label={`${panelLabel}意向报价`} placeholder="输入目标价格" onChange={event =>
              changePanel(panel.id, row => ({ ...row, target_price: event.target.value }))} />
          </label>}
          <div className={c.result} aria-live="polite">
            <div className={c.resultHead}>
              <span>{panel.direction === "forward" ? "测算报价" : "产品成本上限"}</span>
              {result && <button type="button" aria-expanded={expandedTrails.includes(panel.id)} aria-controls={`calculator-trail-${panel.id}`}
                onClick={() => setExpandedTrails(rows => rows.includes(panel.id) ? rows.filter(id => id !== panel.id) : [...rows, panel.id])}>
                计算过程 <ChevronDown size={13} />
              </button>}
            </div>
            {missingIndex >= 0 ? <p role="status">请完成第 {missingIndex + 1} 个计算系数</p> : evaluating ? <strong>计算中…</strong> : state?.error ? <p role="status">{state.error}</p> : result ? <>
              <div className={c.resultValueRow}>
                <strong>{format(panel.direction === "forward" ? result.price : result.target_cost)} <small>元/kg</small></strong>
                {showDifference && <span className={c.resultDifference}><span>与{baseline.name?.trim() || "首个同向面板"}差额</span><b>{format(difference)}</b></span>}
              </div>
              <div className={c.processDetail} id={`calculator-trail-${panel.id}`} hidden={!expandedTrails.includes(panel.id)}>
                <div className={c.processStart}><span>{panel.direction === "reverse" ? "反推产品成本" : "产品成本"}</span><strong>{format(panel.direction === "reverse" ? result.target_cost : evaluation?.source.cost)} 元/kg</strong></div>
                <ol className={c.resultTrail}>{result.trail.map(item => {
                  const step = panel.steps.find(row => row.id === item.id);
                  return <li key={item.id}><span><b>{step?.label}</b><small>{step?.automatic_allocation ? "自动分档 · " : ""}{operationLabel[step?.operation ?? "+"]} {step?.automatic_allocation ? format(result.allocation_amount) : step?.value}{step?.operation === "+" || step?.operation === "-" ? " 元/kg" : ""}</small></span><strong>{format(item.value)}</strong></li>;
                })}</ol>
                {panel.direction === "reverse" && <p>意向报价 {format(panel.target_price)} 元/kg · 复算报价 {format(result.trail.at(-1)?.value)} 元/kg</p>}
                {panel.direction === "reverse" && showCostGap && <p>与参考成本 {format(sourceCost)} 元/kg 的差额：{Number(result.cost_gap) > 0 ? "+" : ""}{format(result.cost_gap)} 元/kg（仅供对照）</p>}
                <small>过程金额显示两位小数，计算保留原始精度。</small>
              </div>
            </> : <p role="status">等待输入</p>}
          </div>
          <div className={c.formulaHeading}><strong>计算步骤</strong><button type="button" onClick={() =>
            changePanel(panel.id, row => ({ ...row, steps: defaults(row.mode, sourceSpecial) }))}><RotateCcw size={13} />恢复现行公式</button></div>
          <div className={c.steps} data-panel-id={panel.id}>
            {panel.steps.map((step, stepIndex) => {
              const allocationStep = isAllocation(step);
              const autoAvailable = !sourceSpecial && step.operation === "+";
              const effectiveTiers = step.tiers ?? evaluation?.default_allocation_tiers ?? [];
              const editing = tierDraft?.panelId === panel.id && tierDraft.stepId === step.id;
              return <div className={`${c.stepBlock} ${dropTarget?.panelId === panel.id && dropTarget.index === stepIndex && drag.current?.from !== stepIndex ? c.dropStep : ""}`} data-step-index={stepIndex} key={step.id}>
                <div className={c.step}>
                  <button type="button" className={c.dragHandle} aria-label={`拖动${panelLabel}第 ${stepIndex + 1} 步排序`} title="拖动调整顺序，也可用上下方向键移动"
                    onKeyDown={event => {
                      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                        event.preventDefault();
                        moveStep(panel.id, stepIndex, stepIndex + (event.key === "ArrowUp" ? -1 : 1));
                      }
                    }}
                    onPointerDown={event => {
                      if (event.button !== 0) return;
                      event.currentTarget.setPointerCapture(event.pointerId);
                      drag.current = { panelId: panel.id, from: stepIndex, to: stepIndex };
                      setDropTarget({ panelId: panel.id, index: stepIndex });
                    }}
                    onPointerMove={event => {
                      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-step-index]");
                      if (target && event.currentTarget.closest("[data-panel-id]")?.contains(target)) {
                        const next = Number(target.dataset.stepIndex);
                        if (drag.current) drag.current.to = next;
                        setDropTarget({ panelId: panel.id, index: next });
                      }
                    }}
                    onPointerUp={event => {
                      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
                      const moving = drag.current;
                      drag.current = null;
                      setDropTarget(null);
                      if (moving?.panelId === panel.id) moveStep(panel.id, moving.from, moving.to);
                    }}
                    onPointerCancel={() => { drag.current = null; setDropTarget(null); }}>
                    <GripVertical size={14} /><span>{stepIndex + 1}</span>
                  </button>
                  <input aria-label={`${panelLabel}第 ${stepIndex + 1} 步名称`} aria-invalid={!step.label.trim()} maxLength={40} value={step.label} onChange={event =>
                    changeStep(panel.id, step.id, row => ({ ...row, label: event.target.value }))} />
                  <WorkbenchOptionMenu label={`${panelLabel}${step.label}算法`} value={step.operation} className={c.operationMenu}
                    options={(["+", "-", "*", "/"] as Operation[]).map(value => ({ value, label: operationLabel[value] }))} onSelect={value =>
                    changeStep(panel.id, step.id, row => ({
                      ...row, operation: value as Operation,
                      automatic_allocation: false, value: row.value ?? "",
                      fee: ["+", "-"].includes(value) ? row.fee : false,
                    }))} />
                  <div className={c.stepValue}>
                    {allocationStep && <WorkbenchOptionMenu label={`${panelLabel}${step.label}模式`}
                      value={step.automatic_allocation ? "auto" : "fixed"} display={step.automatic_allocation ? "自动" : "固定"}
                      className={c.modeMenu} options={[
                        { value: "auto", label: "自动分档", disabled: !autoAvailable, title: !autoAvailable ? "自动分档仅用于普通产品的公摊加项" : undefined },
                        { value: "fixed", label: "固定数值" },
                      ]} onSelect={value => {
                        const automatic = value === "auto";
                        changeStep(panel.id, step.id, row => ({
                          ...row, allocation_step: true, automatic_allocation: automatic,
                          value: automatic ? null : result?.allocation_amount ?? "", fee: automatic ? true : row.fee,
                        }));
                      }} />}
                    {step.automatic_allocation ? <details className={`${c.allocationControl} ${editing ? c.allocationEditing : ""}`}>
                      <summary aria-label={`${panelLabel}${step.label}当前分档 ${format(result?.allocation_amount)} 元/kg，查看或编辑分档`}>
                        <strong>{format(result?.allocation_amount)}</strong><Info size={14} />
                      </summary>
                      <div className={c.allocationPopover}>
                        <div className={c.allocationPopoverHead}><strong>公摊分档</strong><small>元/kg</small></div>
                        {effectiveTiers.length ? <table className={c.allocationTiers} aria-label="公摊分档">
                          <colgroup><col /><col /><col /><col /></colgroup>
                          <thead><tr><th colSpan={3} scope="colgroup">产品成本区间</th><th scope="col">公摊金额</th></tr></thead>
                          <tbody>{tierRows(effectiveTiers, panel.direction === "reverse" ? result?.target_cost : evaluation?.source.cost).map((tier, tierIndex) =>
                            <tr key={tierIndex} className={tier.active ? c.activeTier : ""} aria-current={tier.active ? "true" : undefined}>
                              {tier.bounded ? <><td className={c.tierLower}>{tier.lower}</td><td className={c.tierOperator}>≤ 成本 &lt;</td><td className={c.tierUpper}>{tier.upper}</td></> :
                                <td colSpan={3} className={c.tierUnbounded}>成本 ≥ {tier.lower}</td>}
                              <td>{tier.amount}</td>
                            </tr>)}</tbody>
                        </table> : <span>分档读取中…</span>}
                        <div className={c.allocationActions}>
                          <button type="button" disabled={!effectiveTiers.length} onClick={event => {
                            event.currentTarget.closest("details")?.removeAttribute("open");
                            openTierEditor(panel.id, step.id, step);
                          }}>编辑分档</button>
                        </div>
                      </div>
                    </details> : <DecimalInput aria-label={`${panelLabel}${step.label}数值`} value={step.value ?? ""} placeholder="数值" onChange={event =>
                      changeStep(panel.id, step.id, row => ({ ...row, value: event.target.value }))} />}
                  </div>
                  <button type="button" className={c.deleteStep} aria-label={`删除${panelLabel}${step.label}`} title="删除步骤" onClick={() =>
                    changePanel(panel.id, row => ({ ...row, steps: row.steps.filter(item => item.id !== step.id) }))}><Trash2 size={14} /></button>
                </div>
                {(!step.label.trim() || (!step.automatic_allocation && !step.value?.trim())) && <small className={c.stepError} role="status">{!step.label.trim() ? "请填写系数名称" : "请填写系数数值"}</small>}
                {editing && <TierEditor rows={tierDraft.rows} error={tierDraft.error}
                  onRows={rows => setTierDraft({ ...tierDraft, rows, error: "" })}
                  onApply={applyTiers} onCancel={() => setTierDraft(null)} />}
              </div>;
            })}
          </div>
          <button className={c.addStep} type="button" disabled={panel.steps.length >= 24} onClick={() =>
            changePanel(panel.id, row => ({
              ...row, steps: [...row.steps, { id: id(), label: "新步骤", operation: "+", value: "0", automatic_allocation: false, fee: false }],
            }))}><Plus size={14} />增加系数</button>
          <div className={c.templateActions}>
            <WorkbenchOptionMenu label={`${panelLabel}载入公式模板`} value="" display="载入已存公式" className={c.templateMenu}
              options={templates.map(row => ({ value: row.id, label: row.name }))} onSelect={value => {
              const chosen = templates.find(row => row.id === value);
              if (chosen) {
                const data = chosen.payload as { mode: Mode; steps: Step[] };
                changePanel(panel.id, row => ({ ...row, mode: data.mode, steps: data.steps.map(step => ({ ...step, id: id() })) }));
              }
            }} onDelete={accessLevel >= 3 ? value => setDeleteTarget(templates.find(row => row.id === value) ?? null) : undefined} />
            {accessLevel >= 3 && <div className={c.templateSaveWrap}
              onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget) && !busy) setTemplatePanel(null); }}
              onKeyDown={event => { if (event.key === "Escape" && templatePanel === panel.id) {
                event.preventDefault(); event.stopPropagation(); setTemplatePanel(null);
                event.currentTarget.querySelector<HTMLButtonElement>("[data-save-template]")?.focus();
              } }}>
              <button type="button" className="secondary-button" data-save-template aria-expanded={templatePanel === panel.id}
                disabled={missingIndex >= 0} onClick={() => {
                  setTemplatePanel(templatePanel === panel.id ? null : panel.id);
                  setTemplateName(`${panelLabel}公式`);
                }}>保存公式模板</button>
              {templatePanel === panel.id && <form className={c.templateSavePopover} onSubmit={event => { event.preventDefault(); void saveTemplate(panel); }}>
                <label>模板名称<input autoFocus aria-label="公式模板名称" maxLength={120} value={templateName}
                  onChange={event => setTemplateName(event.target.value)} /></label>
                <div><button className="secondary-button" type="button" onClick={() => {
                  setTemplatePanel(null);
                  document.getElementById(`calculator-${panel.id}`)?.querySelector<HTMLButtonElement>("[data-save-template]")?.focus();
                }}>取消</button>
                  <button className="primary-button" type="submit" disabled={busy || !templateName.trim()}>保存模板</button></div>
              </form>}
            </div>}
          </div>
        </article>;
      })}
      <button className={c.addPanel} type="button" disabled={panels.length >= 12} onClick={addPanel}><Plus size={18} />新增对比面板</button>
    </div>
    {guard.confirmation}
    {deleteTarget && <DiscardChangesDialog title={deleteTarget.kind === "template" ? "删除公式模板？" : "删除历史测算？"}
      description={`删除“${deleteTarget.name}”后无法恢复，当前页面中的测算仍会保留。`}
      cancelLabel="取消" confirmLabel="删除" disabled={busy} onCancel={() => setDeleteTarget(null)} onDiscard={() => void deleteSaved()} />}
  </section>;
}
