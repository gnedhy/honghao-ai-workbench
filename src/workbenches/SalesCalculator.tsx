import { useEffect, useRef } from "react";
import { ChevronDown, Plus, RotateCcw, Trash2 } from "lucide-react";
import { DecimalInput } from "../components/DecimalInput";
import { DiscardChangesDialog } from "../components/Interaction";
import { PageState } from "../components/WorkbenchLayout";
import { type Product } from "./salesModel";
import { basisLabel, dateLabel, format, initialProduct, incompleteStep, type Saved, type Source, type Panel } from "./salesCalculatorModel";
import { useCalculatorWorkspace } from "./salesCalculatorWorkspace";
import { SalesCalculatorPanel } from "./SalesCalculatorPanel";
import { SalesProductPicker } from "./SalesProductPicker";
import c from "./SalesCalculator.module.css";

export function SalesCalculator({ products, accessLevel }: { products: Product[]; accessLevel: number }) {
  const workspace = useCalculatorWorkspace(products, accessLevel);
  const { source, panels, active, savedError, historyLoading, historyError, evaluationError, evaluation, evaluating, busy, dirty, epoch, hasPanelDrafts,
    templates, workspaces, currentProduct, sourceCost, costChanged, sourceSpecial, guard, deleteTarget, actions } = workspace;
  const { selectProduct, selectManual, setManualCost, refreshSource, resetWorkspace, openWorkspace, saveWorkspace, deleteSaved, addPanel, retryHistory, setDeleteTarget } = actions;
  const historyMenu = useRef<HTMLDetailsElement>(null);
  const referenceMenu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => { if (referenceMenu.current && !referenceMenu.current.contains(event.target as Node)) referenceMenu.current.open = false; };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  const forwardPanelNames = panels.flatMap((panel, index) => panel.direction === "forward" ? [`面板 ${index + 1}`] : []);
  const allReverse = forwardPanelNames.length === 0;
  const hasReverse = forwardPanelNames.length < panels.length;
  const forwardScope = forwardPanelNames.length > 2 ? `${forwardPanelNames.length} 个面板` : forwardPanelNames.join("、");
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
        selectManual();
      }}>手工成本</button>
    </div>
    {source.kind === "manual"
      ? <label className={c.manualCost}>产品成本 <DecimalInput aria-label="手工产品成本" value={source.cost ?? ""} placeholder="输入金额" onChange={event => setManualCost(event.target.value)} /><small>元/kg</small></label>
      : <SalesProductPicker products={products} selected={currentProduct} basis={source.basis} cost={sourceCost} onSelect={selectProduct} />}
    {source.kind === "snapshot" && <span className={c.snapshot}>
      {costChanged ? "正式成本已变化" : "保存时成本快照"}
      <button className="secondary-button" type="button" disabled={!currentProduct} onClick={() =>
        refreshSource()}>刷新正式成本</button>
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
            <button type="button" className={c.resetAction} onClick={() => void resetWorkspace().then(opened => { if (opened && historyMenu.current) historyMenu.current.open = false; })}><RotateCcw size={13} />重置测算</button>
            <strong>已保存的对比</strong>
            {workspaces.map(row => <div className={c.historyRow} key={row.id}>
              <button type="button" onClick={() => void openWorkspace(row).then(opened => { if (opened && historyMenu.current) historyMenu.current.open = false; })}>
                <b>{dateLabel(row.created_at)}</b><small>{historyDetails(row)}</small>
              </button>
              {accessLevel >= 3 && <button type="button" aria-label={`删除 ${dateLabel(row.created_at)} 的测算`} title="删除历史测算" onClick={() => setDeleteTarget(row)}><Trash2 size={14} /></button>}
            </div>)}
            {historyLoading ? <PageState>正在读取历史测算</PageState> : historyError ? <PageState error className={c.error} onRetry={() => retryHistory()}>{historyError}</PageState> : !workspaces.length && <small>暂无历史测算</small>}
          </div>
        </details>
        {accessLevel >= 3 && <button className="primary-button" type="button" disabled={busy || hasPanelDrafts || panels.some(panel => incompleteStep(panel) >= 0)} onClick={() => void saveWorkspace()}>{busy ? "保存中…" : "保存对比"}</button>}
      </div>
    </div>
    {hasPanelDrafts && <p className={c.note}>请先应用或取消正在编辑的分档、名称或模板。</p>}
    {(savedError || evaluationError) && <p className={c.error} role="alert">{savedError || evaluationError}</p>}
    <p className={c.note}>独立试算 · 不生成正式客户报价。{active
      ? dirty ? "修改尚未保存；再次保存会新增历史记录。" : "已保存到历史测算。"
      : "当前测算尚未保存。"}</p>

    <div className={c.panelTrack} aria-label="公式方案对比">
      {panels.map((panel, index) => <SalesCalculatorPanel key={`${epoch}-${panel.id}`} panel={panel} index={index} panels={panels}
        evaluation={evaluation} evaluating={evaluating} evaluationError={evaluationError} sourceCost={sourceCost} sourceSpecial={sourceSpecial}
        templates={templates} accessLevel={accessLevel} busy={busy} actions={actions} />)}
      <button className={c.addPanel} type="button" disabled={panels.length >= 12} onClick={addPanel}><Plus size={18} />新增对比面板</button>
    </div>
    {guard.confirmation}
    {deleteTarget && <DiscardChangesDialog title={deleteTarget.kind === "template" ? "删除公式模板？" : "删除历史测算？"}
      description={`删除“${deleteTarget.name}”后无法恢复，当前页面中的测算仍会保留。`}
      cancelLabel="取消" confirmLabel="删除" disabled={busy} onCancel={() => setDeleteTarget(null)} onDiscard={() => void deleteSaved()} />}
  </section>;
}
