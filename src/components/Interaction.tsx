import { useEffect, useLayoutEffect, useRef, useState, useId, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

export function useFadingScrollbars(container: { current: HTMLElement | null }) {
  useEffect(() => {
    const body = container.current;
    if (!body) return;
    const timers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
    const edgeSelector = ".admin-user-scroll,.personal-profile__scroll";
    const updateEdges = () => {
      body.querySelectorAll<HTMLElement>(edgeSelector).forEach(element => {
        element.style.setProperty("--scroll-fade-top", element.scrollTop > 1 ? "14px" : "0px");
        element.style.setProperty("--scroll-fade-bottom", element.scrollHeight - element.clientHeight - element.scrollTop > 1 ? "14px" : "0px");
        element.style.setProperty("--scroll-gutter", `${Math.max(0, element.offsetWidth - element.clientWidth)}px`);
      });
    };
    const observed = new Set<Element>();
    const resize = new ResizeObserver(updateEdges);
    const observeEdges = () => {
      const targets = new Set<Element>();
      body.querySelectorAll(edgeSelector).forEach(element => { targets.add(element); Array.from(element.children).forEach(child => targets.add(child)); });
      observed.forEach(element => { if (!targets.has(element)) { resize.unobserve(element); observed.delete(element); } });
      targets.forEach(element => { if (!observed.has(element)) { resize.observe(element); observed.add(element); } });
      updateEdges();
    };
    const contentChanges = new MutationObserver(observeEdges);
    contentChanges.observe(body, { childList: true, subtree: true, characterData: true });
    observeEdges();
    body.addEventListener("scroll", updateEdges, true);
    const reveal = (event: Event) => {
      let element = event.target instanceof HTMLElement ? event.target : null;
      while (element && element !== body) {
        if (element.scrollHeight > element.clientHeight && /auto|scroll/.test(getComputedStyle(element).overflowY)) {
          clearTimeout(timers.get(element));
          element.dataset.scrolling = "true";
          const target = element;
          timers.set(target, setTimeout(() => { delete target.dataset.scrolling; timers.delete(target); }, 3000));
          break;
        }
        element = element.parentElement;
      }
    };
    body.addEventListener("scroll", reveal, true);
    body.addEventListener("wheel", reveal, { capture: true, passive: true });
    return () => {
      body.removeEventListener("scroll", updateEdges, true);
      resize.disconnect();
      contentChanges.disconnect();
      body.removeEventListener("scroll", reveal, true);
      body.removeEventListener("wheel", reveal, true);
      timers.forEach((timer, element) => { clearTimeout(timer); delete element.dataset.scrolling; });
    };
  }, [container]);
}

export function DiscardChangesDialog({ onCancel, onDiscard, title = "放弃未保存的修改？", description = "继续后，本次操作涉及的未保存修改将不会保留。", cancelLabel = "继续编辑", confirmLabel = "放弃修改", disabled = false, confirmDisabled = false, children, intent = "danger" }: { onCancel: () => void; onDiscard: () => void; title?: string; description?: ReactNode; cancelLabel?: string; confirmLabel?: string; disabled?: boolean; confirmDisabled?: boolean; children?: ReactNode; intent?: "danger" | "primary" }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const previousFocus = useRef(document.activeElement as HTMLElement | null);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const previous = previousFocus.current;
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <dialog ref={dialog} className="settings-discard-dialog" role="alertdialog" aria-labelledby={titleId} aria-describedby={descriptionId}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!disabled) onCancel(); }}
    onKeyDown={event => { if (event.key === "Escape") event.stopPropagation(); }}>
    <h2 id={titleId}>{title}</h2>
    <p id={descriptionId}>{description}</p>{children}
    <div className="admin-form-actions"><button autoFocus type="button" className="secondary-button" disabled={disabled} onClick={onCancel}>{cancelLabel}</button><button type="button" className={intent === "primary" ? "primary-button" : "secondary-button settings-discard-action"} disabled={disabled || confirmDisabled} onClick={onDiscard}>{confirmLabel}</button></div>
  </dialog>;
}

export function SettingsGroup({ id, title, description, summary, children, defaultOpen = false, icon }: { id: string; title: string; description: string; summary: string; children: ReactNode; defaultOpen?: boolean; icon?: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  const [instant, setInstant] = useState(false);
  const { contentRef, height } = useMeasuredContent();
  return <section className="module-settings settings-group" data-open={open} data-instant={instant} aria-labelledby={id + "-title"}>
    <button type="button" id={id + "-title"} className="module-settings__heading settings-group-trigger" aria-label={title} aria-expanded={open} aria-controls={id + "-content"} onClick={event => { setInstant(event.detail === 0); setOpen(value => !value); }}>
      <span className="settings-group-copy"><strong>{icon && <span className="settings-group-icon" aria-hidden="true">{icon}</span>}{title}</strong><span>{description}</span></span>
      <span className="settings-group-summary">{summary}<ChevronRight size={15} /></span>
    </button>
    <div id={id + "-content"} className="settings-group-collapse" style={{ height: open ? height : 0 }} aria-hidden={!open} inert={!open}>
      <div ref={contentRef}>{children}</div>
    </div>
  </section>;
}

export function useUnsavedChanges(dirty: boolean, busy: boolean, description: string, eventName?: string) {
  const [pending, setPending] = useState(false);
  const resolver = useRef<((value: boolean) => void) | null>(null);
  const request = () => {
    if (busy || resolver.current) return Promise.resolve(false);
    if (!dirty) return Promise.resolve(true);
    setPending(true);
    return new Promise<boolean>(resolve => { resolver.current = resolve; });
  };
  const finish = (value: boolean) => { const resolve = resolver.current; resolver.current = null; setPending(false); resolve?.(value); };
  useEffect(() => () => { resolver.current?.(false); resolver.current = null; }, []);
  useEffect(() => {
    if (!eventName) return;
    const leave = (event: Event) => {
      if (!dirty && !busy) return;
      const waitUntil = (event as CustomEvent<{ waitUntil?: (promise: Promise<boolean>) => void }>).detail?.waitUntil;
      if (waitUntil) waitUntil(request()); else event.preventDefault();
    };
    const unload = (event: BeforeUnloadEvent) => { if (dirty || busy) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener(eventName, leave);
    window.addEventListener("beforeunload", unload);
    return () => { window.removeEventListener(eventName, leave); window.removeEventListener("beforeunload", unload); };
  }, [dirty, busy, eventName]);
  return { request, confirmation: pending && <DiscardChangesDialog description={description} disabled={busy} onCancel={() => finish(false)} onDiscard={() => finish(true)}/> };
}

export function useExitTransition(onClosed: () => void) {
  const [closing, setClosing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callback = useRef(onClosed);
  callback.current = onClosed;
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);
  const close = () => {
    if (timer.current !== null) return;
    setClosing(true);
    const duration = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 :
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--motion-exit")) || 140;
    timer.current = setTimeout(() => callback.current(), duration);
  };
  return { closing, close };
}

export function useMeasuredContent(active = true) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const element = contentRef.current;
    if (!active || !element) return;
    const measure = () => setHeight(element.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [active]);
  return { contentRef, height };
}
