import { useEffect, useRef, useState } from "react";
import styles from "./WorkbenchSurface.module.css";

export function useMoverPaging(pages: number, resetKey: string, blocked = false) {
  const [page, setPage] = useState(0);
  const [instant, setInstant] = useState(true);
  const [previousPage, setPreviousPage] = useState<number | null>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const keyboardInteraction = useRef(false);
  const [reduced, setReduced] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [hidden, setHidden] = useState(document.hidden);
  const rotating = pages > 1 && !blocked && !hovered && !focused && !reduced && !hidden;
  useEffect(() => { setPage(0); setPreviousPage(null); setInstant(true); }, [resetKey, pages]);
  useEffect(() => {
    const pointer = () => { keyboardInteraction.current = false; setFocused(false); };
    const keyboard = () => { keyboardInteraction.current = true; };
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("keydown", keyboard, true);
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const motion = () => setReduced(media.matches);
    const visibility = () => setHidden(document.hidden);
    media.addEventListener("change", motion);
    document.addEventListener("visibilitychange", visibility);
    return () => { media.removeEventListener("change", motion); document.removeEventListener("visibilitychange", visibility); document.removeEventListener("pointerdown", pointer, true); document.removeEventListener("keydown", keyboard, true); };
  }, []);
  const controls = pages > 1 && <div key={resetKey} className={styles.moverControls} aria-label="排行分页" data-paused={!rotating} data-reduced={reduced}>
    {Array.from({ length: pages }, (_, index) => <button key={index} type="button" className={styles.moverDot} aria-label={`查看排行第 ${index + 1} 页`} aria-current={page === index ? "page" : undefined} title="每 8 秒切换，悬停暂停" onClick={event => { if (index !== page) { setInstant(event.detail === 0); setPreviousPage(page); setPage(index); } }} onAnimationEnd={() => { if (page === index && rotating) { setInstant(false); setPreviousPage(index); setPage((index + 1) % pages); } }}><i /></button>)}
  </div>;
  const interaction = {
    onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false),
    onFocusCapture: () => setFocused(keyboardInteraction.current), onKeyDownCapture: () => setFocused(true),
    onBlurCapture: (event: React.FocusEvent<HTMLElement>) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); },
  };
  return { page, previousPage, instant, reduced, rotating, controls, interaction, setPage, setPreviousPage, setInstant };
}
