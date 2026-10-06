import {useEffect, useRef, useState} from "react";
import {fetchExecution, fetchJson, startExecution, stopExecution, type ConversationExecution} from "../api";
import {useUnsavedChanges} from "../components/Interaction";

const accessLost = (error: unknown) => [401,403,404].includes((error as {status?: number}).status ?? 0);

export function useConversationExecution(owner: string | undefined, conversation: string | undefined, message: string | undefined, onSettled?: () => void | Promise<void>, onAccessLost?: () => void) {
  const [run, setRun] = useState<ConversationExecution | null>(null);
  const [ready, setReady] = useState(false);
  const [availability, setAvailability] = useState("正在检查 AI 执行配置…");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [configError, setConfigError] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [denied, setDenied] = useState(false);
  const [retry, setRetry] = useState(0);
  const binding = `${owner}/${conversation}/${message}`;
  const bindingRef = useRef(binding); bindingRef.current = binding;
  const callbacks = useRef({onSettled, onAccessLost}); callbacks.current = {onSettled, onAccessLost};
  const operation = useRef(false);
  const settled = useRef(new Set<string>());
  const refreshing = useRef(new Set<string>());
  useUnsavedChanges(false, busy, "正在确认执行操作，请稍后再离开。", "workbench-before-leave");

  useEffect(() => {
    const controller = new AbortController();
    let stream: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let live = true;
    setRun(null); setReady(false); setAvailability("正在检查 AI 执行配置…"); setError(""); setConfigError(""); setConfirmed(false); setDenied(false);
    if (!conversation || !message) return () => {controller.abort();};
    const publish = (value: ConversationExecution | null) => {
      if (!live) return;
      setRun(value); setConfirmed(true); setError("");
      const stateKey = value ? `${value.id}/${value.status}` : null;
      if (value && stateKey && !settled.current.has(stateKey) && !refreshing.current.has(stateKey)) {
        refreshing.current.add(stateKey);
        void Promise.resolve().then(() => callbacks.current.onSettled?.()).then(() => {
          settled.current.add(stateKey);
        }).catch(failure => {
          if (!live) return;
          if (accessLost(failure)) {setDenied(true); setRun(null); callbacks.current.onAccessLost?.();}
          else setError("执行状态已确认，正文与任务读取失败，请重新读取。");
        })
          .finally(() => refreshing.current.delete(stateKey));
      }
    };
    const read = async () => {
      try {
        const value = await fetchExecution(conversation, message, controller.signal);
        if (!live) return;
        publish(value);
        if (!value || value.phase === "ended") return;
        let current = value;
        stream = new EventSource(`/api/conversations/${encodeURIComponent(conversation)}/executions/${encodeURIComponent(value.id)}/events?after=${value.event_seq}`);
        const event = (raw: MessageEvent, kind: "state" | "delta") => {
          if (!live) return;
          try {
            const payload = JSON.parse(raw.data) as {runId: string; seq: number; delta?: string; status?: ConversationExecution["status"]; phase?: ConversationExecution["phase"]; reason?: string | null};
            if (payload.runId !== current.id || !Number.isSafeInteger(payload.seq) || payload.seq <= current.event_seq) return;
            if (payload.seq !== current.event_seq + 1) throw new Error("Event position changed");
            current = {...current, event_seq: payload.seq, ...(kind === "delta" ? {output: current.output + (payload.delta ?? "")} : {status: payload.status ?? current.status, phase: payload.phase ?? current.phase, stop_reason: payload.reason ?? null})};
            if (kind === "delta") setRun(current);
            else publish(current);
            if (current.phase === "ended") stream?.close();
          } catch {stream?.close(); setConfirmed(false); timer = setTimeout(() => {void read();}, 1000);}
        };
        stream.addEventListener("state", raw => event(raw as MessageEvent, "state"));
        stream.addEventListener("delta", raw => event(raw as MessageEvent, "delta"));
        stream.onerror = () => {
          stream?.close();
          if (live && current.phase !== "ended") {setConfirmed(false); setError("连接已中断，正在确认执行状态…"); timer = setTimeout(() => {void read();}, 1000);}
        };
      } catch (failure) {
        if (!live) return;
        if (accessLost(failure)) {
          setDenied(true); setRun(null); callbacks.current.onAccessLost?.();
        } else {setError("执行状态读取失败，请重新读取。"); setConfirmed(false);}
      }
    };
    void fetchJson<{status: string; reason: string | null}>("/api/conversations/runtime-status", {signal: controller.signal})
      .then(value => {if (live) {setReady(value.status === "configured"); setAvailability(value.reason === "runtime_not_configured" ? "AI 执行尚未配置" : "AI 执行暂时不可用");}})
      .catch(failure => {if (live) {
        if (accessLost(failure)) {setDenied(true); setRun(null); callbacks.current.onAccessLost?.();}
        else setConfigError("AI 执行配置读取失败，请重新读取。");
      }});
    void read();
    return () => {live = false; controller.abort(); stream?.close(); clearTimeout(timer);};
  }, [binding, conversation, message, retry]);

  const action = async (stop: boolean) => {
    if (operation.current || !conversation || !message) return;
    operation.current = true; setBusy(true);
    const target = binding;
    try {
      if (stop && run) await stopExecution(conversation, run.id);
      else await startExecution(conversation, message);
      if (bindingRef.current === target) setRetry(value => value + 1);
    } catch (failure) {
      if (bindingRef.current === target) {
        if (accessLost(failure)) {setDenied(true); setRun(null); callbacks.current.onAccessLost?.();}
        else {setError("操作结果需要确认，请重新读取执行状态。"); setConfirmed(false);}
      }
    } finally {operation.current = false; if (bindingRef.current === target) setBusy(false);}
  };
  return {run, ready, availability, busy, error: error || configError, confirmed, denied, active: run?.phase !== "ended" && run !== null,
    start: () => {void action(false);}, stop: () => {void action(true);}, reconcile: () => setRetry(value => value + 1)};
}
