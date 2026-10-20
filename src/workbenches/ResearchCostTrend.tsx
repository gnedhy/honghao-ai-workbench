import {useMemo, useState} from "react";
import {CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis} from "recharts";
import {HelpHint} from "../components/HelpHint";
import {PriceDateRangeMenu} from "../components/WorkbenchMenus";
import {focusedTrendAxis, moverDateRange} from "./procurementAnalytics";
import {dailyCostRecords, priceCents} from "./researchAnalytics";
import {type RecordRow, date, recordDate} from "./researchModel";
import {Money} from "./ResearchProductView";
import p from "../components/WorkbenchSurface.module.css";
import s from "./ResearchWorkbench.module.css";

type Period = "14d" | "1m" | "3m" | {start:string;end:string};
export function ResearchCostTrend({history, policy}: {history:RecordRow[];policy:"latest"|"inventory"}) {
  const [period, setPeriod] = useState<Period>("3m");
  const days = useMemo(()=>dailyCostRecords(history),[history]);
  const end = days.at(-1) ? recordDate(days.at(-1)!) : new Date().toISOString().slice(0,10);
  const range = typeof period === "string" ? moverDateRange(end,period) : period;
  const label = policy === "latest" ? "行情优先" : "库存优先";
  const points = days.filter(row=>recordDate(row)>=range.start&&recordDate(row)<=range.end).map(row=>{
    const raw = policy === "latest" ? row.latest_cost : row.inventory_cost;
    const cents = priceCents(raw);
    return {...row,day:recordDate(row),raw,value:cents==null?null:cents/100};
  });
  const valid = points.filter(point=>point.value!=null);
  const axis = focusedTrendAxis([{values:points.map(point=>point.value)}]);
  const caption = policy==="inventory"&&points.some(point=>point.record_type==="backfill") ? "单位：元/kg · 回算库存为固定参考" : "单位：元/kg · 按价格所属日期";
  const missingText = (point: typeof points[number]) => point.missing_materials?.length ? `缺价原料：${point.missing_materials.join("、")}` : "该期未形成完整成本记录";
  return <section className={s.detailTrend} aria-label={`产品成本走势 · ${label}`}>
    <div className={s.sectionHeading}><div className={s.detailTrendTitle}><h3>产品成本走势 · {label}</h3><HelpHint detail="按价格所属日期绘制；同日优先正式核算记录，再取最近生成的一条。全部条目仍保留在成本历史中。历史回算采用冻结配方和参考价格，不代表当时实际成本。"/></div><PriceDateRangeMenu label="产品详情走势日期范围" period={period} range={range} onChange={setPeriod}/></div>
    <div key={policy} className={p.materialPricePanel}>
      <div className={p.detailChart}>
        {valid.length<2 ? <div className={s.chartEmpty}><strong>暂无走势</strong><span>{valid.length===1?"当前范围仅有一期有效成本记录。":"当前范围没有有效成本记录。"}</span><span>可调整日期范围查看。</span></div> : <ResponsiveContainer width="100%" height="100%"><LineChart data={points} accessibilityLayer margin={{top:12,right:16,bottom:8,left:0}}>
          <CartesianGrid stroke="#edf0f1" vertical={false}/><XAxis dataKey="day" tickFormatter={value=>String(value).slice(5).replace("-","/")} tick={{fill:"#69747d",fontSize:11}} axisLine={false} tickLine={false} minTickGap={24}/>
          <YAxis domain={axis.domain} ticks={axis.ticks} tickFormatter={value=>Number(value).toFixed(2)} tick={{fill:"#69747d",fontSize:11}} width={52} axisLine={false} tickLine={false}/>
          <Tooltip filterNull={false} content={({active,payload})=>{
            const point=payload?.[0]?.payload as typeof points[number] | undefined;
            return active&&point ? <div className={s.chartTooltip}><strong>{point.day} · {point.record_type==="backfill"?"历史回算":"正式成本"}{point.purchase_version!=null&&` · 采购 v${point.purchase_version}`}</strong><span>{label} <Money value={point.raw}/></span><small>{point.reason||"成本核算"}</small><small>记录时间：{date(point.recorded_at)}</small>{point.value==null&&<small>{missingText(point)}；曲线保留断点。</small>}</div> : null;
          }}/>
          <Line dataKey="value" name={`${label}（元/kg）`} type="monotone" stroke={policy==="latest"?"#2f3337":"#708ba4"} strokeWidth={2} dot={{r:2.5,fill:"#fff"}} activeDot={{r:4}} connectNulls={false} isAnimationActive={false}/>
          <Line dataKey={point=>point.value==null?axis.domain[0]:null} stroke="none" activeDot={false} isAnimationActive={false} dot={({cx,cy,payload})=>payload.value!=null?<g/>:<g className={s.gapMarker} role="img" tabIndex={0} aria-label={`${payload.day} ${missingText(payload)}`}><title>{`${payload.day} ${missingText(payload)}`}</title><circle cx={cx} cy={cy} r={6}/><text x={cx} y={cy} dy=".35em" textAnchor="middle">!</text></g>}/>
        </LineChart></ResponsiveContainer>}
      </div>
      <p className={s.trendCaption}>{caption}{valid.length>=2&&points.some(point=>point.value==null)&&<span className={s.gapHint}> · 缺失成本已标记，悬停可查看原因。</span>}</p>
    </div>
  </section>;
}
