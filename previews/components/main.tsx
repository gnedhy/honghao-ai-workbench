import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { Drawer } from "../../src/components/Drawer";
import { DiscardChangesDialog, SettingsGroup, useUnsavedChanges } from "../../src/components/Interaction";
import { Switch } from "../../src/components/Switch";
import { DecimalInput } from "../../src/components/DecimalInput";
import { LedgerPagination } from "../../src/components/LedgerPagination";
import { TrendMaterialMenu, PriceDateRangeMenu } from "../../src/components/WorkbenchMenus";
import { FormFooter, DashboardPanel, PageState } from "../../src/components/WorkbenchLayout";
import { PriceMovement } from "../../src/components/PriceMovement";
import "../../src/styles.css";
import "./preview.css";

function Examples() {
  const [drawer, setDrawer] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [value, setValue] = useState("12.3400");
  const [enabled, setEnabled] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [state, setState] = useState("正常");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState("示例产品");
  const [period, setPeriod] = useState<"14d" | "1m" | "3m" | {start:string;end:string}>("14d");
  const [reduced,setReduced] = useState(false);
  useEffect(()=>{const media=matchMedia("(prefers-reduced-motion: reduce)"); const update=()=>setReduced(media.matches); update(); media.addEventListener("change",update);return()=>media.removeEventListener("change",update);},[]);
  const unsaved = useUnsavedChanges(dirty, state === "加载", "关闭将放弃当前输入；取消后完整保留填写。");
  return <main className="component-preview"><h1>组件与动效验收</h1><p>隔离示例，不访问业务数据。当前系统：{reduced ? "减少动态效果" : "标准动态效果"}。减少动态效果跟随系统设置。</p>
    <div className="preview-actions">{["正常","禁用","加载","失败"].map(item=><button type="button" className="secondary-button" aria-pressed={state===item} onClick={()=>setState(item)} key={item}>{item}</button>)}</div>
    <DashboardPanel><h2>输入、选择与开关</h2><div className="preview-actions"><label>金额 <DecimalInput aria-label="示例金额" value={value} disabled={state==="禁用"||state==="加载"} onChange={e=>setValue(e.target.value)}/> 元/kg</label><Switch aria-label="示例授权" aria-checked={enabled} disabled={state==="禁用"} busy={state==="加载"} onClick={()=>setConfirm(true)}/><span>{enabled?"已授权":"未授权"}</span><button type="button" className="secondary-button" onClick={()=>setDrawer(true)}>打开编辑抽屉</button></div>
      <div className="preview-actions"><TrendMaterialMenu label="示例产品" materials={[{id:"1",code:"示例产品"},{id:"2",code:"长产品名称用于检查窄屏换行和定位稳定性"}]} selected={selected} onSelect={setSelected}/><PriceDateRangeMenu period={period} range={{start:"2026-09-01",end:"2026-09-14"}} onChange={setPeriod}/><PriceMovement value={2.7}/><PriceMovement value={null}/></div>
      {state==="加载"&&<PageState>正在核验，已有金额保留：{value}</PageState>}{state==="失败"&&<PageState error onRetry={()=>setState("正常")}>模拟请求失败，输入保留。</PageState>}
    </DashboardPanel>
    <SettingsGroup id="example-records" title="记录" description="展开、收起与键盘操作" summary="11 条" defaultOpen><p>长文案会自然换行，收起后内部按钮不可聚焦。</p><button type="button" className="secondary-button">记录操作</button><LedgerPagination total={11} page={page} pageSize={10} onPageChange={setPage}/></SettingsGroup>
    {confirm&&<DiscardChangesDialog title={enabled?"取消授权？":"确认授权？"} description="确认后才改变实际状态。失败时保留当前状态，可以重试或放弃。长文案完整展示，弹窗内容不会被省略。" confirmLabel={enabled?"取消授权":"确认授权"} cancelLabel="放弃操作" intent={enabled?"danger":"primary"} onCancel={()=>setConfirm(false)} onDiscard={()=>{if(state!=="失败"){setEnabled(!enabled);setConfirm(false);}}}>{state==="失败"&&<p role="alert">模拟请求失败，请放弃操作后选择正常状态重试。</p>}</DiscardChangesDialog>}
    {drawer&&<Drawer title="编辑示例 · 长名称自然换行" label="仅用于组件验收" beforeClose={unsaved.request} onClose={()=>{setDrawer(false);setDirty(false);}} busy={state==="加载"}>{unsaved.confirmation}<label>编辑内容<input aria-label="抽屉填写内容" onChange={()=>setDirty(true)}/></label><p>修改后，通过关闭按钮、Esc 或外部点击检查拦截。</p><FormFooter status={<span role="status">{dirty?"有未保存修改":"尚未修改"}</span>}><button type="button" className="primary-button" onClick={()=>setDirty(false)}>保存示例</button></FormFooter></Drawer>}
  </main>;
}
createRoot(document.getElementById("root")!).render(<Examples/>);
