import { useEffect, useState } from "react";
import { previewPriceAdjustments, type PricePreview } from "../api";
import { PriceMovement as Movement } from "../components/PriceMovement";
import { PRICE_REASONS, type ReasonSelection } from "./procurementReasons";
import { price } from "./ProcurementMaterialView";
import styles from "../components/WorkbenchSurface.module.css";

export function usePricePreview(enabled: boolean, date: string, items: Array<{ material_id: string; price: string }>) {
  const key = enabled && date && items.length && items.every(item => /^\d+(\.\d+)?$/.test(item.price)) ? JSON.stringify({ date, items }) : "";
  const [result, setResult] = useState<{ key: string; data?: PricePreview; error?: string }>({ key: "" });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const input = JSON.parse(key) as { date: string; items: Array<{ material_id: string; price: string }> };
      previewPriceAdjustments(input.date, input.items, controller.signal).then(data => { if (!controller.signal.aborted) setResult({ key, data }); }).catch(error => { if (!controller.signal.aborted) setResult({ key, error: error.message }); });
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [key, revision]);
  return { data: key && result.key === key ? result.data : undefined, error: result.key === key ? result.error : undefined, refresh: () => { setResult({ key: "" }); setRevision(value => value + 1); } };
}

export function PriceReview({ preview }: { preview: PricePreview }) {
  const sameBasis = new Set(preview.rows.map(row => row.comparison_basis)).size === 1;
  const basis = preview.rows[0]?.comparison_basis === "published" ? "最新价格" : "上期询价";
  return <div className={styles.priceReview}><div className={styles.priceReviewHeading}><strong>价格核对</strong><span>{preview.rows.filter(row => row.high_risk).length} 项高波动</span></div><div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>原料</th><th>{sameBasis ? basis : "参考价"}</th><th>新价格</th><th>价格变化</th><th>提示</th></tr></thead><tbody>{preview.rows.map(row => <tr key={row.material_id}><td>{row.code}</td><td>{price(row.reference_price)}{!sameBasis && <span>{row.comparison_basis === "published" ? "最新价格" : "上期询价"}</span>}</td><td>{price(row.price)}</td><td><Movement value={row.change == null ? null : row.change * 100} /></td><td>{row.high_risk ? <span className={styles.riskText}>高波动</span> : "—"}</td></tr>)}</tbody></table></div></div>;
}

export function ReasonSelect({ label, options, placeholder, value = { selected: "", custom: "" }, disabled, onChange }: { label: string; options: string[]; placeholder: string; value?: ReasonSelection; disabled: boolean; onChange: (value: ReasonSelection) => void }) {
  const otherLabel = options === PRICE_REASONS ? "其他说明" : "其他原因";
  return <div className={styles.reasonSelect}>
    <select aria-label={label} disabled={disabled} value={value.selected} onChange={(event) => onChange({ ...value, selected: event.target.value })}>
      <option value="" disabled>{placeholder}</option>
      {options.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
      <option value="other">{otherLabel}</option>
    </select>
    {value.selected === "other" && <input aria-label={`${label}${otherLabel}`} disabled={disabled} minLength={4} maxLength={200} value={value.custom} onChange={(event) => onChange({ ...value, custom: event.target.value })} placeholder={`请填写${otherLabel}（4–200 字）`} />}
  </div>;
}
