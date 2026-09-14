import { ArrowUp, ArrowDown, Minus } from "lucide-react";
import styles from "./WorkbenchSurface.module.css";
export function PriceMovement({ value }: { value: number | null }) {
  if (value === null || !Number.isFinite(value)) return <span className={`${styles.priceChange} ${styles.movementMuted}`}>暂无对比</span>;
  const Icon = value > 0 ? ArrowUp : value < 0 ? ArrowDown : Minus;
  const className = value >= 10 ? `${styles.movementUp} ${styles.movementSurge}` : value > 0 ? styles.movementUp : value < 0 ? styles.movementDown : styles.movementStable;
  return <span className={`${styles.priceChange} ${className}`}><Icon size={12} />{`${value > 0 ? "+" : ""}${value.toFixed(1)}%`}</span>;
}
