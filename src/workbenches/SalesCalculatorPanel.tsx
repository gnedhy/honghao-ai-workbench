import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ChevronDown, Copy, GripVertical, Info, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import { createClientId as id } from "../clientId";
import { DecimalInput } from "../components/DecimalInput";
import { WorkbenchOptionMenu } from "../components/WorkbenchMenus";
import { modes, type Mode } from "./salesModel";
import { defaults, format, incompleteStep, isAllocation, operationLabel, tierError, tierRows, type Evaluation, type Panel, type Operation, type Saved, type Tier, type TierDraft } from "./salesCalculatorModel";
import type { CalculatorActions } from "./salesCalculatorWorkspace";
import c from "./SalesCalculator.module.css";

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

export function SalesCalculatorPanel({ panel, index, panels, evaluation, evaluating, evaluationError, sourceCost, sourceSpecial, templates, accessLevel, busy, actions }: {
  panel: Panel; index: number; panels: Panel[]; evaluation: Evaluation | null; evaluating: boolean; evaluationError: string;
  sourceCost?: string | null; sourceSpecial: boolean; templates: Saved[]; accessLevel: number; busy: boolean; actions: CalculatorActions;
}) {
  const { changePanel, changeStep, moveStep, movePanel, copyPanel, deletePanel, loadTemplate, saveTemplate, setDeleteTarget, setPanelDraft } = actions;
  const [tierDraft, setTierDraft] = useState<TierDraft | null>(null);
  const [editingPanel, setEditingPanel] = useState<{ id: string; name: string } | null>(null);
  const [templatePanel, setTemplatePanel] = useState<string | null>(null);
  const [templateName, setTemplateName] = useState("");
  const [expandedTrails, setExpandedTrails] = useState<string[]>([]);
  const [dropTarget, setDropTarget] = useState<{ panelId: string; index: number } | null>(null);
  const drag = useRef<{ panelId: string; from: number; to: number } | null>(null);
  const tierInitial = useRef("");
  const localDirty = (!!tierDraft && JSON.stringify(tierDraft.rows) !== tierInitial.current)
    || (!!editingPanel && editingPanel.name !== panel.name)
    || (templatePanel !== null && templateName !== `面板 ${index + 1}公式`);
  useEffect(() => { setPanelDraft(panel.id, localDirty); return () => setPanelDraft(panel.id, false); }, [panel.id, localDirty, setPanelDraft]);
  useEffect(() => {
    if (tierDraft && !panel.steps.some(step => step.id === tierDraft.stepId && step.automatic_allocation)) setTierDraft(null);
  }, [panel.steps, tierDraft]);
  const openTierEditor = (panelId: string, stepId: string, step: Panel["steps"][number]) => {
    const rows = step.tiers ?? evaluation?.default_allocation_tiers;
    if (!rows) return;
    const normalized = rows.map(row => ({ upper: row.upper?.replace(/^\./, "0.") ?? null, amount: row.amount.replace(/^\./, "0.") }));
    tierInitial.current = JSON.stringify(normalized);
    setTierDraft({ panelId, stepId, rows: normalized, error: "" });
  };
  const applyTiers = () => {
    if (!tierDraft) return;
    const error = tierError(tierDraft.rows);
    if (error) { setTierDraft({ ...tierDraft, error }); return; }
    const rows = tierDraft.rows.map(row => ({ upper: row.upper?.trim() ?? null, amount: row.amount.trim() }));
    changeStep(tierDraft.panelId, tierDraft.stepId, step => ({ ...step, allocation_step: true, automatic_allocation: true, value: null, tiers: rows }));
    setTierDraft(null);
  };
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
              <button type="button" className={c.iconButton} disabled={index === 0} title="向前移动面板" aria-label={`前移${panelLabel}`} onClick={() => movePanel(panel.id, -1)}><ArrowLeft size={15} /></button>
              <button type="button" className={c.iconButton} disabled={index === panels.length - 1} title="向后移动面板" aria-label={`后移${panelLabel}`} onClick={() => movePanel(panel.id, 1)}><ArrowRight size={15} /></button>
              <button type="button" className={c.iconButton} disabled={panels.length >= 12} title="复制面板" aria-label={`复制${panelLabel}`} onClick={() => copyPanel(panel.id)}><Copy size={15} /></button>
              <button type="button" className={c.iconButton} disabled={panels.length <= 1} title="删除面板" aria-label={`删除${panelLabel}`} onClick={() => deletePanel(panel.id)}><Trash2 size={15} /></button>
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
            </> : <p role="status">{evaluationError ? "本次测算未完成" : "等待输入"}</p>}
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
              options={templates.map(row => ({ value: row.id, label: row.name }))} onSelect={value => loadTemplate(panel.id, value)} onDelete={accessLevel >= 3 ? value => setDeleteTarget(templates.find(row => row.id === value) ?? null) : undefined} />
            {accessLevel >= 3 && <div className={c.templateSaveWrap}
              onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget) && !busy && templateName === `${panelLabel}公式`) setTemplatePanel(null); }}
              onKeyDown={event => { if (!busy && event.key === "Escape" && templatePanel === panel.id) {
                event.preventDefault(); event.stopPropagation(); setTemplatePanel(null);
                event.currentTarget.querySelector<HTMLButtonElement>("[data-save-template]")?.focus();
              } }}>
              <button type="button" className="secondary-button" data-save-template aria-expanded={templatePanel === panel.id}
                disabled={busy || missingIndex >= 0} onClick={() => {
                  setTemplatePanel(templatePanel === panel.id ? null : panel.id);
                  setTemplateName(`${panelLabel}公式`);
                }}>保存公式模板</button>
              {templatePanel === panel.id && <form className={c.templateSavePopover} onSubmit={event => { event.preventDefault(); void saveTemplate(panel, templateName).then(saved => { if (saved) { setTemplatePanel(null); setTemplateName(""); requestAnimationFrame(() => document.getElementById(`calculator-${panel.id}`)?.querySelector<HTMLButtonElement>("[data-save-template]")?.focus()); } }); }}>
                <label>模板名称<input autoFocus disabled={busy} aria-label="公式模板名称" maxLength={120} value={templateName}
                  onChange={event => setTemplateName(event.target.value)} /></label>
                <div><button className="secondary-button" type="button" disabled={busy} onClick={() => {
                  setTemplatePanel(null);
                  document.getElementById(`calculator-${panel.id}`)?.querySelector<HTMLButtonElement>("[data-save-template]")?.focus();
                }}>取消</button>
                  <button className="primary-button" type="submit" disabled={busy || !templateName.trim()}>保存模板</button></div>
              </form>}
            </div>}
          </div>
        </article>;

}
