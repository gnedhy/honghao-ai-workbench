import { ChevronLeft, ChevronRight } from "lucide-react";
import styles from "../workbenches/ProcurementWorkbench.module.css";

export function LedgerPagination({ total, page, pageSize, onPageChange }: { total: number; page: number; pageSize: number; onPageChange: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.max(1, Math.min(page, pages));
  return <div className={styles.paginationBar} aria-label="台账分页"><span>{total ? (current - 1) * pageSize + 1 : 0}–{Math.min(current * pageSize, total)} / {total} 条</span><button type="button" className="icon-button" aria-label="上一页" disabled={current === 1} onClick={() => onPageChange(current - 1)}><ChevronLeft size={15}/></button><span className={styles.pageNumber}>第 {current} / {pages} 页</span><button type="button" className="icon-button" aria-label="下一页" disabled={current === pages} onClick={() => onPageChange(current + 1)}><ChevronRight size={15}/></button></div>;
}
