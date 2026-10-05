import { useEffect, useRef, type ReactNode } from "react";
import { ArrowLeft, X } from "lucide-react";
import { useExitTransition } from "./Interaction";
import styles from "./WorkbenchSurface.module.css";

export function Drawer({ title, label, titleAction, children, onClose, onBack, backLabel, beforeClose, busy = false, className = "", bodyClassName = "", closeLabel = "关闭详情" }: {
  title: string; label?: string; titleAction?: ReactNode; children: ReactNode;
  onClose: () => void; onBack?: () => void; backLabel?: string; beforeClose?: () => boolean | Promise<boolean>; busy?: boolean;
  className?: string; bodyClassName?: string; closeLabel?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const previousFocus = useRef(document.activeElement as HTMLElement | null);
  const checking = useRef(false);
  const exitAction = useRef(onClose);
  const { closing, close: finishClose } = useExitTransition(() => exitAction.current());
  useEffect(() => {
    const previous = previousFocus.current;
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  const close = async (action = onClose) => {
    if (busy || checking.current || closing) return;
    checking.current = true;
    try { if (!beforeClose || await beforeClose()) { exitAction.current = action; finishClose(); } }
    finally { checking.current = false; }
  };
  const heading = <div>{label && <span>{label}</span>}<div className={styles.drawerTitle}><h2>{title}</h2>{titleAction}</div></div>;
  return <dialog ref={dialog} className={`${styles.drawer} ${styles.drawerDialog} ${className} ${closing ? styles.closing : ""}`} aria-label={title}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); void close(); }}
    onMouseDown={event => {
      if (event.target !== event.currentTarget) return;
      event.preventDefault();
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) void close();
    }}>
    <header inert={closing} className={styles.drawerHeader}>{backLabel ? <div className={styles.drawerHeadingWithBack}><button className="icon-button" type="button" aria-label={backLabel} title={backLabel} disabled={busy || closing} onClick={() => void close(onBack)}><ArrowLeft size={17}/></button>{heading}</div> : heading}<button autoFocus className="icon-button" type="button" aria-label={closeLabel} disabled={busy || closing} onClick={() => void close()}><X size={17}/></button></header>
    <div inert={closing} className={`${styles.drawerBody} ${bodyClassName}`}>{children}</div>
  </dialog>;
}
