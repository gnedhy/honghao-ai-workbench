import {selectedSalesProducts} from "./salesReads";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchJson } from "../api";
import { createClientId as id } from "../clientId";
import { useUnsavedChanges } from "../components/Interaction";
import { base, type Product } from "./salesModel";
import { fingerprint, initialPanels, initialProduct, initialSource, incompleteStep, type Evaluation, type Panel, type Saved, type Source, type Step } from "./salesCalculatorModel";

const endpoint = base + "/calculator";
const request = <T,>(path: string, body: unknown) => fetchJson<T>(endpoint + path, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
type Workspace = { source: Source; panels: Panel[]; active: Saved | null; clean: string; epoch: number };
const fresh = (products: Product[], epoch = 0): Workspace => {
  const source = initialSource(products), panels = initialPanels(initialProduct(products)?.special_allocation);
  return { source, panels, active: null, clean: fingerprint(source, panels), epoch };
};

// Every input change invalidates both success and failure from the previous request.
function useCalculatorEvaluation(source: Source, panels: Panel[]) {
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [evaluationError, setEvaluationError] = useState("");
  const [evaluating, setEvaluating] = useState(false);
  useEffect(() => {
    let mounted = true;
    setEvaluation(null); setEvaluationError("");
    const readyPanels = panels.filter(panel => incompleteStep(panel) < 0);
    setEvaluating(readyPanels.length > 0);
    if (!readyPanels.length) return () => { mounted = false; };
    const timer = window.setTimeout(() => {
      void request<Evaluation>("/evaluate", { source, panels: readyPanels })
        .then(value => { if (mounted) { setEvaluation(value); setEvaluating(false); } })
        .catch(error => { if (mounted) {
          setEvaluationError(error instanceof Error && error.message.includes("Failed to fetch") ? "计算服务暂时无法连接，请稍后重试。" : "测算暂时无法完成，请检查输入后重试。");
          setEvaluating(false);
        } });
    }, 180);
    return () => { mounted = false; window.clearTimeout(timer); };
  }, [source, panels]);
  return { evaluation, evaluationError, evaluating };
}

export function useCalculatorWorkspace(products: Product[], accessLevel: number) {
  const [workspace, setWorkspace] = useState(() => fresh(products));
  const { source, panels, active, clean } = workspace;
  const [saved, setSaved] = useState<Saved[]>([]);
  const historyVersions=useRef({workspace:"",template:""});
  const [historyPage,setHistoryPage]=useState(1),[templatePage,setTemplatePage]=useState(1),[historyTotal,setHistoryTotal]=useState(0),[templateTotal,setTemplateTotal]=useState(0);
  const [savedError, setSavedError] = useState("");
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState("");
  const [historyRetry, setHistoryRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Saved | null>(null);
  const [panelDrafts, setPanelDrafts] = useState<Record<string, boolean>>({});
  const setPanelDraft = useCallback((key: string, dirty: boolean) => setPanelDrafts(rows => {
    if (!!rows[key] === dirty) return rows;
    const next = { ...rows }; if (dirty) next[key] = true; else delete next[key]; return next;
  }), []);
  const hasPanelDrafts = Object.values(panelDrafts).some(Boolean);
  const dirty = fingerprint(source, panels) !== clean || hasPanelDrafts;
  const guard = useUnsavedChanges(dirty, busy, "尚未保存的测算方案将被放弃。", "sales-before-leave");
  const pending = useRef(false);
  const mounted = useRef(true);
  const writes = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const retryHistory = () => setHistoryRetry(value => value + 1);
  useEffect(() => {
    let mounted = true;
    const version = writes.current;
    setHistoryLoading(true); setHistoryError("");
    void Promise.all([fetchJson<{saved:Saved[];total:number;page:number;version:string}>(endpoint+`/saved-page?kind=workspace&page=${historyPage}&token=${historyVersions.current.workspace}`),fetchJson<{saved:Saved[];total:number;page:number;version:string}>(endpoint+`/saved-page?kind=template&page=${templatePage}&token=${historyVersions.current.template}`)])
      .then(value => { if (mounted) {
        if (writes.current === version) {setSaved([...value[0].saved,...value[1].saved]);setHistoryTotal(value[0].total);setTemplateTotal(value[1].total);setHistoryPage(value[0].page);setTemplatePage(value[1].page);historyVersions.current={workspace:value[0].version,template:value[1].version};}
        else setHistoryRetry(value => value + 1);
      } })
      .catch(error => { if (mounted) setHistoryError(error instanceof Error ? error.message : "历史测算读取失败");if(error&&typeof error==="object"&&"status" in error&&(error.status===401||error.status===403))setSaved([]); })
      .finally(() => { if (mounted) setHistoryLoading(false); });
    return () => { mounted = false; };
  }, [historyRetry,historyPage,templatePage]);
  const evaluation = useCalculatorEvaluation(source, panels);
  const [selectedProduct,setSelectedProduct]=useState<Product|undefined>();
  useEffect(()=>{let active=true;setSelectedProduct(undefined);if(source.product_id)void selectedSalesProducts([source.product_id]).then(value=>{if(active)setSelectedProduct(value.products[0]);}).catch(error=>{if(active){setSelectedProduct(undefined);setSavedError(error instanceof Error?error.message:'产品成本读取失败');}});return()=>{active=false;};},[source.product_id]);
  const currentProduct=selectedProduct?.id===source.product_id?selectedProduct:undefined;
  const currentCost = currentProduct ? source.basis === "inventory" ? currentProduct.inventory_cost : currentProduct.latest_cost : null;
  const sourceCost = source.kind === "product" ? currentCost : source.cost;
  const costChanged = source.kind === "snapshot" && !!currentProduct && (source.cost !== currentCost || source.source_version !== (currentProduct.source_version || ""));
  const sourceSpecial = source.kind === "snapshot" ? !!source.special_allocation : source.kind === "product" && !!currentProduct?.special_allocation;
  const changePanel = (key: string, update: (panel: Panel) => Panel) => setWorkspace(state => ({ ...state, panels: state.panels.map(row => row.id === key ? update(row) : row) }));
  const changeStep = (panelId: string, stepId: string, update: (step: Step) => Step) => changePanel(panelId, panel => ({ ...panel, steps: panel.steps.map(step => step.id === stepId ? update(step) : step) }));
  const moveStep = (panelId: string, from: number, to: number) => changePanel(panelId, panel => {
    if (from === to || from < 0 || to < 0 || from >= panel.steps.length || to >= panel.steps.length) return panel;
    const steps = [...panel.steps]; steps.splice(to, 0, steps.splice(from, 1)[0]); return { ...panel, steps };
  });
  const resetWorkspace = async () => {
    if (pending.current || !await guard.request() || !mounted.current) return false;
    setWorkspace(state => fresh(products, state.epoch + 1)); setPanelDrafts({}); setDeleteTarget(null); setSavedError(""); return true;
  };
  const openWorkspace = async (row: Saved) => {
    if (pending.current || !await guard.request() || !mounted.current) return false;
    pending.current=true;setBusy(true);
    let loaded:Saved;
    try{loaded=await fetchJson<Saved>(endpoint+`/saved/${row.id}`);}catch(error){setSavedError(error instanceof Error?error.message:"读取测算失败");return false;}finally{pending.current=false;if(mounted.current)setBusy(false);}
    if(!mounted.current)return false;
    const payload = loaded.payload as { source: Source; panels: Panel[] };
    setWorkspace(state => ({ ...payload, active: loaded, clean: fingerprint(payload.source, payload.panels), epoch: state.epoch + 1 }));
    setPanelDrafts({}); setDeleteTarget(null); setSavedError(""); return true;
  };
  const beginWrite = () => {
    if (pending.current || accessLevel < 3 || !mounted.current) return false;
    pending.current = true; setBusy(true); setSavedError(""); return true;
  };
  const finishWrite = () => { pending.current = false; if (mounted.current) setBusy(false); };
  const saveWorkspace = async () => {
    if (hasPanelDrafts || panels.some(panel => incompleteStep(panel) >= 0) || !beginWrite()) return;
    const submitted = fingerprint(source, panels);
    try {
      const row = await request<Saved>("/saved", { kind: "workspace", payload: { source, panels } });
      if (!mounted.current) return;
      writes.current++; setHistoryPage(1);setTemplatePage(1);setHistoryRetry(value=>value+1);setSaved(rows => [row, ...rows.filter(saved => saved.id !== row.id)]);
      const payload = row.payload as { source: Source; panels: Panel[] };
      setWorkspace(current => ({ ...current,
        ...(fingerprint(current.source, current.panels) === submitted ? payload : {}),
        active: row, clean: fingerprint(payload.source, payload.panels),
      }));
    } catch (error) { if (mounted.current) setSavedError(error instanceof Error ? error.message : "保存失败"); }
    finally { finishWrite(); }
  };
  const saveTemplate = async (panel: Panel, name: string) => {
    if (!name.trim() || incompleteStep(panel) >= 0 || !beginWrite()) return false;
    try {
      const row = await request<Saved>("/saved", { kind: "template", name: name.trim(), payload: { mode: panel.mode, steps: panel.steps } });
      if (!mounted.current) return false;
      writes.current++; setHistoryPage(1);setTemplatePage(1);setHistoryRetry(value=>value+1);setSaved(rows => [row, ...rows.filter(saved => saved.id !== row.id)]); return true;
    } catch (error) { if (mounted.current) setSavedError(error instanceof Error ? error.message : "公式保存失败"); return false; }
    finally { finishWrite(); }
  };
  const deleteSaved = async () => {
    if (!deleteTarget || !beginWrite()) return;
    const key = deleteTarget.id;
    try {
      await fetchJson(endpoint + `/saved/${key}`, { method: "DELETE" });
      if (!mounted.current) return;
      writes.current++; setSaved(rows => rows.filter(row => row.id !== key));
      setWorkspace(state => state.active?.id === key ? { ...state, active: null, clean: "" } : state);
      setDeleteTarget(null);
    } catch (error) { if (mounted.current) setSavedError(error instanceof Error ? error.message : "删除失败"); }
    finally { finishWrite(); }
  };
  const ordinarySteps = (steps: Step[]) => steps.map(step => step.allocation_step && step.label === "特殊公摊" && step.value === "" ? { ...step, label: "公摊", automatic_allocation: true, value: null } : step);
  const selectProduct = (product: Product, basis: "latest" | "inventory") => setWorkspace(state => ({ ...state,
    source: { kind: "product", product_id: product.id, basis },
    panels: state.panels.map(panel => ({ ...panel, steps: product.special_allocation
      ? panel.steps.map(step => step.automatic_allocation ? { ...step, label: "特殊公摊", automatic_allocation: false, allocation_step: true, value: "" } : step)
      : ordinarySteps(panel.steps) })),
  }));
  const selectManual = () => setWorkspace(state => state.source.kind === "manual" ? state : { ...state, source: { kind: "manual", cost: "" }, panels: state.panels.map(panel => ({ ...panel, steps: ordinarySteps(panel.steps) })) });
  const setManualCost = (cost: string) => setWorkspace(state => ({ ...state, source: state.source.kind === "manual" ? { ...state.source, cost } : { kind: "manual", cost } }));
  const refreshSource = () => { if (currentProduct) selectProduct(currentProduct, source.basis ?? "latest"); };
  const copyPanel = (key: string) => setWorkspace(state => {
    if (state.panels.length >= 12) return state;
    const index = state.panels.findIndex(row => row.id === key); if (index < 0) return state;
    const copy = state.panels[index], next = { ...copy, id: id(), name: `面板 ${state.panels.length + 1}`, steps: copy.steps.map(step => ({ ...step, id: id() })) };
    return { ...state, panels: [...state.panels.slice(0, index + 1), next, ...state.panels.slice(index + 1)] };
  });
  const movePanel = (key: string, offset: number) => setWorkspace(state => {
    const from = state.panels.findIndex(row => row.id === key), to = from + offset;
    if (from < 0 || to < 0 || to >= state.panels.length) return state;
    const panels = [...state.panels]; panels.splice(to, 0, panels.splice(from, 1)[0]); return { ...state, panels };
  });
  const addPanel = () => { copyPanel(panels.at(-1)!.id); requestAnimationFrame(() => document.querySelector("[aria-label='公式方案对比'] article:last-of-type")?.scrollIntoView({ block: "nearest", inline: "end", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" })); };
  const deletePanel = (key: string) => setWorkspace(state => state.panels.length <= 1 ? state : { ...state, panels: state.panels.filter(row => row.id !== key) });
  const templateReads=useRef(new Map<string,number>());
  const loadTemplate = async (panelId: string, key: string) => {
    const chosen = saved.find(row => row.kind === "template" && row.id === key); if (!chosen) return;
    const generation=(templateReads.current.get(panelId)??0)+1;templateReads.current.set(panelId,generation);
    const epoch=workspace.epoch,sourceBaseline=JSON.stringify(source),baseline=JSON.stringify(panels.find(panel=>panel.id===panelId));
    let loaded:Saved;
    try{loaded=await fetchJson<Saved>(endpoint+`/saved/${key}`);}catch(error){if(mounted.current&&templateReads.current.get(panelId)===generation)setSavedError(error instanceof Error?error.message:"读取模板失败");return;}
    if(!mounted.current||templateReads.current.get(panelId)!==generation)return;
    const data = loaded.payload as { mode: Panel["mode"]; steps: Step[] };
    const steps=data.steps.map(step=>({...step,id:id()}));
    setWorkspace(state=>state.epoch!==epoch||JSON.stringify(state.source)!==sourceBaseline?state:{...state,panels:state.panels.map(panel=>panel.id===panelId&&JSON.stringify(panel)===baseline?{...panel,mode:data.mode,steps}:panel)});
  };
  return { ...workspace, ...evaluation, historyPage,templatePage,historyTotal,templateTotal,setHistoryPage,setTemplatePage, savedError, historyLoading, historyError, busy, dirty, hasPanelDrafts, guard, deleteTarget,
    templates: saved.filter(row => row.kind === "template"), workspaces: saved.filter(row => row.kind === "workspace"), currentProduct, sourceCost, costChanged, sourceSpecial,
    actions: { changePanel, changeStep, moveStep, movePanel, resetWorkspace, openWorkspace, saveWorkspace, saveTemplate, deleteSaved, selectProduct, selectManual, setManualCost, refreshSource, copyPanel, addPanel, deletePanel, loadTemplate, retryHistory, setDeleteTarget, setPanelDraft },
  };
}
export type CalculatorActions = ReturnType<typeof useCalculatorWorkspace>["actions"];
