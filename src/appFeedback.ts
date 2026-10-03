import {useEffect,useState} from "react";
import {emptyFeedbackDraft} from "./components/FeedbackDialog";

// Owned by the user-keyed AppShell; drafts survive ordinary dialog close within one login.
export function useAppFeedback(userId:string) {
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackDraft, setFeedbackDraft] = useState(emptyFeedbackDraft);
  const [feedbackUnread, setFeedbackUnread] = useState<number | null>(null);
  const [feedbackRevision, setFeedbackRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;
    const refresh = async () => {
      if (document.hidden || inFlight) return;
      inFlight = true;
      try {
        const response = await fetch("/api/feedback/unread", { signal: controller.signal });
        if (!response.ok) throw new Error("Unread unavailable");
        const data = await response.json() as { count: number };
        if (!controller.signal.aborted) setFeedbackUnread(data.count);
      } catch { if (!controller.signal.aborted) setFeedbackUnread(null); }
      finally { inFlight = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [userId, feedbackRevision]);

  return {feedbackOpen,feedbackDraft,feedbackUnread,openFeedback:()=>setFeedbackOpen(true),closeFeedback:()=>setFeedbackOpen(false),setFeedbackDraft,refreshUnread:()=>setFeedbackRevision(value=>value+1)};
}
