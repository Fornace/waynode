import { useState, useRef, useEffect, useLayoutEffect, useCallback } from "react";
import type { Session, GoalStatus } from "../types";
import { MessageRow, StartingAgent } from "./ChatMessage";
import { ChatComposer } from "./ChatComposer";
import { api } from "../api/client";
import * as store from "../lib/sessionStore";

interface ChatTabProps {
  session: Session;
}

export function ChatTab({ session }: ChatTabProps) {
  const state = store.useSessionChat(session.id);
  const [input, setInput] = useState("");
  const [goal, setGoal] = useState<GoalStatus | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [showJump, setShowJump] = useState(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Acquire the session stream on mount; release on unmount. ──
  // The stream lives in the module-scoped store, so navigating away does NOT
  // kill an in-flight turn — it keeps running in the background.
  useEffect(() => store.acquire(session.id), [session.id]);

  // Insert a newline at the caret (mobile affordance): on touch devices the
  // soft keyboard has no Shift, so there's no way to get a newline without a
  // dedicated button. Enter stays bound to send; this ↵ button adds the line.
  const insertNewline = () => {
    const el = inputRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const next = input.slice(0, start) + "\n" + input.slice(end);
    setInput(next);
    // Restore the caret after React re-renders.
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = start + 1;
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 200) + "px";
    });
  };

  // ── Auto-scroll ──
  // Stick to bottom while new messages arrive, but if the user scrolled up to
  // read, don't yank them down. useLayoutEffect runs before paint so there's no
  // "scroll up then snap" flash (the previous rAF-after-paint approach is what
  // caused the view to jump when sending).
  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    const onScroll = () => {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickToBottom.current = dist < 120; // near bottom → keep pinned
      setShowJump(!stickToBottom.current);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useLayoutEffect(() => {
    if (stickToBottom.current && bottomRef.current) {
      bottomRef.current.scrollIntoView({ block: "end" });
    }
  }, [state.items]);

  // ── Goal status (pi-codex-goal plugin) ──
  const refreshGoal = useCallback(async () => {
    try {
      const { goal } = await api.sessions.getGoal(session.id);
      setGoal(goal);
    } catch {}
  }, [session.id]);

  useEffect(() => {
    refreshGoal();
  }, [refreshGoal, state.streaming]);

  useEffect(() => {
    if (state.failedDraft && !input.trim()) setInput(state.failedDraft.prompt);
  }, [state.failedDraft, input]);

  const streaming = state.streaming || ["sending", "starting", "running"].includes(state.activeStatus || "");

  const sendMessage = async (isGoal: boolean) => {
    if (!input.trim() || streaming) return;
    const prompt = input.trim();
    setInput("");
    // The user just sent — they want to watch the reply, so pin to bottom even
    // if they had scrolled up to read, and shrink the composer back to 1 row.
    stickToBottom.current = true;
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) { el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 200) + "px"; }
      bottomRef.current?.scrollIntoView({ block: "end" });
    });
    await store.send(session.id, prompt, isGoal);
    if (isGoal) refreshGoal();
  };

  const handleQueue = async () => {
    if (!input.trim() || !streaming) return;
    const prompt = input.trim();
    const accepted = await store.queue(session.id, prompt);
    if (accepted) setInput("");
  };

  const handleAbort = async () => {
    await store.abort(session.id);
  };

  const handleRetry = async () => {
    if (await store.retry(session.id)) setInput("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Desktop: Enter submits (send, or queue if streaming); Shift+Enter is a
    // newline. Mobile: Enter keeps submitting (the soft keyboard's primary
    // action); multi-line input is reached via the newline affordance on the
    // toolbar rather than by sacrificing the submit key. See
    // docs/KEYBOARD-CONTRACT.md §1.2.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (streaming) handleQueue();
      else sendMessage(false);
    }
  };

  const autosize = () => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  };

  const jumpToLatest = () => {
    stickToBottom.current = true;
    setShowJump(false);
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  };

  const quoteInReply = (markdown: string) => {
    const quote = markdown.split("\n").map((line) => `> ${line}`).join("\n");
    setInput((current) => `${current.trim() ? `${current.trim()}\n\n` : ""}${quote}\n\n`);
    requestAnimationFrame(() => { autosize(); inputRef.current?.focus(); });
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    
    setUploading(true);
    setUploadError("");
    try {
      const formData = new FormData();
      Array.from(files).forEach(f => formData.append("files", f));
      
      const headers: Record<string, string> = {};
      const devToken = localStorage.getItem("waynode-dev-token");
      if (devToken) headers["x-dev-token"] = devToken;

      const res = await fetch(`/api/spaces/${session.space_id}/upload`, {
        method: "POST",
        body: formData,
        credentials: "include",
        headers,
      });
      const data = await res.json();
      
      if (res.ok && data.success) {
        const fileNames = data.files.map((f: string) => f).join(", ");
        setInput(prev => {
          const sep = prev.trim() ? "\n" : "";
          return prev + sep + `[Uploaded files: ${fileNames}]\n`;
        });
        autosize();
      } else {
        setUploadError(data.err || "The files could not be uploaded.");
      }
    } catch {
      setUploadError("The files could not be uploaded. Your message draft is unchanged; try again.");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <div className="chat-tab">
      {goal && goal.status && (
        <div className="goal-banner" role="status" aria-live="polite">
          <span className={`goal-badge ${goal.status}`}>
            <span aria-hidden="true" /> Goal · {goal.status === "budgetLimited" ? "budget limited" : goal.status}
          </span>
        </div>
      )}

      {state.connection === "reconnecting" && (
        <div className="run-state-banner" role="status" aria-live="polite">
          <span className="run-state-line" aria-hidden="true" />
          <span>Reconnecting… Your conversation is preserved.</span>
        </div>
      )}
      {(state.error || state.connection === "disconnected") && (
        <div className="chat-recovery" role="alert">
          <div>
            <strong>{state.connection === "disconnected" ? "Disconnected. Check your network." : state.error}</strong>
            <span>Your transcript and draft are safe.</span>
          </div>
          <button type="button" onClick={handleRetry}>Retry</button>
        </div>
      )}
      {state.queuedCount > 0 && (
        <div className="queue-state" role="status">
          <strong>{state.queuedCount === 1 ? "Follow-up queued" : `${state.queuedCount} follow-ups queued`}</strong>
          <span>It will start when the current turn finishes.</span>
        </div>
      )}

      <div className="chat-messages" ref={messagesRef} aria-label="Session conversation" aria-busy={streaming}>
        <div className="chat-lane">
        {!state.loaded && !state.error && <div className="agent-preflight"><StartingAgent phase="Loading conversation…" /></div>}
        {state.loaded && state.items.length === 0 && !streaming && (
          <div className="chat-empty">
            <div className="chat-empty-title">Give the agent a concrete outcome.</div>
            <div className="chat-empty-desc">Start with what should change and how you’ll know it is done.</div>
            <div className="chat-starters" aria-label="Suggested prompts">
              {[
                "Explain this codebase",
                "Find and fix a bug",
                "Build a focused feature",
              ].map((prompt) => (
                <button key={prompt} onClick={() => { setInput(prompt); requestAnimationFrame(() => inputRef.current?.focus()); }}>
                  <b>{prompt}</b><i aria-hidden="true">→</i>
                </button>
              ))}
            </div>
          </div>
        )}

        {state.items.map((item, idx) => (
          <MessageRow
            key={item.id}
            item={item}
            // The stream flag is global to the session, not per-message — only
            // the very last item in the list can be the one currently being
            // generated. Without this guard, every historical assistant
            // message would re-show the active generation state
            // whenever ANY turn (even a later, unrelated one) is streaming.
            streaming={streaming && idx === state.items.length - 1}
            phase={state.status}
            onQuote={quoteInReply}
          />
        ))}
        {/* Between send and the server's `message_start`, there is no
            assistant item yet. Keep that first-token wait legible. */}
        {streaming && state.items[state.items.length - 1]?.role === "user" && (
          <div className="agent-preflight"><StartingAgent phase={state.status} /></div>
        )}
        <div ref={bottomRef} />
        </div>
      </div>

      {showJump && <button className="chat-jump" type="button" onClick={jumpToLatest}>Jump to latest ↓</button>}
      {uploadError && (
        <div className="composer-notice" role="alert">
          <span>{uploadError}</span>
          <button onClick={() => setUploadError("")} aria-label="Dismiss upload error">×</button>
        </div>
      )}

      <ChatComposer
        input={input}
        streaming={streaming}
        uploading={uploading}
        inputRef={inputRef}
        fileInputRef={fileInputRef}
        onInput={setInput}
        onAutosize={autosize}
        onKeyDown={handleKeyDown}
        onFileUpload={handleFileUpload}
        onInsertNewline={insertNewline}
        onAbort={handleAbort}
        onQueue={handleQueue}
        onSend={sendMessage}
      />
    </div>
  );
}
