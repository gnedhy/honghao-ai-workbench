import styles from "../components/WorkbenchSurface.module.css";
export function ChartEmpty({ title, detail }: { title: string; detail: string }) {
  return <div className={`${styles.chartEmpty} ${styles.compactEmpty}`}><strong>{title}</strong><span>{detail}</span></div>;
}
export function price(value?: string | null) { return value == null ? "—" : `¥${value}`; }

const priceFormatter = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function Price({ value }: { value?: string | null }) {
  return value == null ? "—" : !value.trim() || !Number.isFinite(Number(value)) ? <span title={value}>{value}</span> : <span title={price(value)}>¥{priceFormatter.format(Number(value))}</span>;
}
export function formatPriceDate(value: string) { return value.slice(0, 10).replaceAll("-", "."); }

export function shortDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(new Date(value)); }
