import { useState, useRef, useEffect, useLayoutEffect, useCallback } from "react";
import type { Session, GoalStatus, ComposerMode, HammersmithCapability } from "../types";
import { MessageRow, StartingAgent } from "./ChatMessage";
import { ChatComposer } from "./ChatComposer";
import { api } from "../api/client";
import * as store from "../lib/sessionStore";
import * as drafts from "../lib/sessionDrafts";
import { ComposerModePersistence } from "../lib/composerModePersistence";

interface ChatTabProps {
  session: Session;
}

export function ChatTab({ session }: ChatTabProps) {
  const state = store.useSessionChat(session.id);
  const [input, setInput] = useState(() => drafts.get(session.id) || "");
  const initialMode = ["message", "goal", "hammersmith"].includes(session.composer_mode || "") ? session.composer_mode as ComposerMode : "message";
  const [composerMode, setComposerMode] = useState<ComposerMode>(initialMode);
  const [modeError, setModeError] = useState("");
  const [hammersmithCapability, setHammersmithCapability] = useState<HammersmithCapability | null>(null);
  const [capabilityError, setCapabilityError] = useState(false);
  const [goal, setGoal] = useState<GoalStatus | null>(null);
  const [goalError, setGoalError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [showJump, setShowJump] = useState(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modeSaveRef = useRef(new ComposerModePersistence());
  const submitInFlight = useRef(false);
  const restoredDraftId = useRef<string | null>(null);
  const userPickedMode = useRef(false);

  // ── Acquire the session stream on mount; release on unmount. ──
  // The stream lives in the module-scoped store, so navigating away does NOT
  // kill an in-flight turn — it keeps running in the background.
  useEffect(() => store.acquire(session.id), [session.id]);

  const refreshHammersmithCapability = useCallback(async () => {
    try {
      const capability = (await api.hammersmith.settings()).capability;
      setHammersmithCapability(capability || null);
      setCapabilityError(false);
      if (capability && !capability.available && capability.state === "unsupported" && composerMode === "hammersmith") {
        setComposerMode("message");
        setModeError("Hammersmith is unsupported in this environment. Mode returned to Message.");
        void api.sessions.patch(session.id, { composer_mode: "message" });
      }
    } catch {
      setCapabilityError(true);
    }
  }, [composerMode, session.id]);

  useEffect(() => { void refreshHammersmithCapability(); }, [refreshHammersmithCapability]);

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
      setGoalError("");
    } catch {
      setGoalError("Goal status could not be refreshed. The last known status may be stale; the session and run are unchanged.");
    }
  }, [session.id]);

  useEffect(() => {
    refreshGoal();
  }, [refreshGoal, state.streaming]);

  useEffect(() => {
    const failed = state.failedDraft;
    if (!failed) { restoredDraftId.current = null; return; }
    if (restoredDraftId.current === failed.id) return;
    restoredDraftId.current = failed.id;
    setInput(failed.prompt);
    setComposerMode(failed.mode ?? (failed.isGoal ? "goal" : "message"));
  }, [state.failedDraft]);

  useEffect(() => { drafts.set(session.id, input); }, [session.id, input]);

  useEffect(() => {
    if (userPickedMode.current) { userPickedMode.current = false; return; }
    const next = ["message", "goal", "hammersmith"].includes(session.composer_mode || "") ? session.composer_mode as ComposerMode : "message";
    setComposerMode(next);
  }, [session.composer_mode]);

  const contentStreaming = state.streaming;
  const runActive = contentStreaming || ["sending", "starting", "running"].includes(state.activeStatus || "");

  const sendMessage = async (mode: ComposerMode) => {
    if (submitInFlight.current || !input.trim() || runActive) return;
    const prompt = input.trim();
    submitInFlight.current = true;
    setInput("");
    drafts.clear(session.id);
    // The user just sent — they want to watch the reply, so pin to bottom even
    // if they had scrolled up to read, and shrink the composer back to 1 row.
    stickToBottom.current = true;
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) { el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 200) + "px"; }
      bottomRef.current?.scrollIntoView({ block: "end" });
    });
    try {
      await modeSaveRef.current.beforeSubmit();
      const accepted = await store.send(session.id, prompt, mode);
      if (!accepted) return;
      if (mode !== "message") setComposerMode("message");
      if (mode === "goal") refreshGoal();
    } finally {
      submitInFlight.current = false;
    }
  };

  const handleQueue = async () => {
    if (submitInFlight.current || !input.trim() || !runActive) return;
    const prompt = input.trim();
    submitInFlight.current = true;
    setInput("");
    drafts.clear(session.id);
    try {
      const accepted = await store.queue(session.id, prompt);
      if (!accepted) return;
    } finally {
      submitInFlight.current = false;
    }
  };

  const handleAbort = async () => {
    await store.abort(session.id);
  };

  const handleRetry = async () => {
    if (await store.retry(session.id)) { setInput(""); drafts.clear(session.id); }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") { e.preventDefault(); inputRef.current?.blur(); return; }
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    // Desktop: Enter submits (send, or queue if streaming); Shift+Enter is a
    // newline. Mobile: Enter keeps submitting (the soft keyboard's primary
    // action); multi-line input is reached via the newline affordance on the
    // toolbar rather than by sacrificing the submit key. See
    // docs/KEYBOARD-CONTRACT.md §1.2.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (runActive) handleQueue();
      else sendMessage(composerMode);
    }
  };

  const autosize = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, []);

  const jumpToLatest = () => {
    stickToBottom.current = true;
    setShowJump(false);
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  };

  const quoteInReply = useCallback((markdown: string) => {
    const quote = markdown.split("\n").map((line) => `> ${line}`).join("\n");
    setInput((current) => `${current.trim() ? `${current.trim()}\n\n` : ""}${quote}\n\n`);
    requestAnimationFrame(() => { autosize(); inputRef.current?.focus(); });
  }, [autosize]);

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

  const changeComposerMode = (mode: ComposerMode) => {
    userPickedMode.current = true;
    const previous = composerMode;
    setComposerMode(mode);
    setModeError("");
    const save = modeSaveRef.current.save(() => api.sessions.patch(session.id, { composer_mode: mode }));
    save.catch(() => {
      userPickedMode.current = false;
      setComposerMode((current) => current === mode ? previous : current);
      setModeError("The send mode could not be saved. Try again.");
    });
  };

  const hammersmithState = capabilityError ? "unavailable"
    : !hammersmithCapability ? "checking"
      : hammersmithCapability.available ? "ready"
        : hammersmithCapability.state === "unsupported" ? "unsupported" : "setup";

  return (
    <div className="chat-tab">
      {goal && goal.status && (
        <div className="goal-banner" role="status" aria-live="polite">
          <span className={`goal-badge ${goal.status}`}>
            <span aria-hidden="true" /> Goal · {goal.status === "budgetLimited" ? "budget limited" : goal.status}
          </span>
        </div>
      )}
      {goalError && (
        <div className="goal-recovery" role="alert">
          <span>{goalError}</span>
          <button type="button" onClick={refreshGoal}>Retry status</button>
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

      <div className="chat-messages" ref={messagesRef} role="log" aria-label="Session conversation" aria-live="polite" aria-busy={contentStreaming}>
        <div className="chat-lane">
        {!state.loaded && !state.error && <div className="agent-preflight"><StartingAgent phase="Loading conversation…" /></div>}
        {state.loaded && state.items.length === 0 && !runActive && (
          <div className="chat-empty">
            <div className="chat-empty-title">Start from the worktree, not a blank chat.</div>
            <div className="chat-empty-desc">Ask for an outcome you can verify in this repository and branch.</div>
            <div className="chat-starters" aria-label="Suggested prompts">
              {[
                "Map this worktree before changing it",
                "Find a bug and open the diff",
                "Build a focused change and verify it",
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
            streaming={contentStreaming && idx === state.items.length - 1}
            phase={contentStreaming && idx === state.items.length - 1 ? state.status : null}
            onQuote={quoteInReply}
          />
        ))}
        {/* Between send and the server's `message_start`, there is no
            assistant item yet. Keep that first-token wait legible. */}
        {runActive && state.items[state.items.length - 1]?.role === "user" && (
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
      {modeError && <div className="composer-notice form-error" role="alert">{modeError}</div>}

      <ChatComposer
        input={input}
        mode={composerMode}
        streaming={runActive}
        uploading={uploading}
        hammersmithState={hammersmithState}
        inputRef={inputRef}
        fileInputRef={fileInputRef}
        onInput={setInput}
        onAutosize={autosize}
        onKeyDown={handleKeyDown}
        onFileUpload={handleFileUpload}
        onInsertNewline={insertNewline}
        onAbort={handleAbort}
        onQueue={handleQueue}
        onModeChange={changeComposerMode}
        onSend={sendMessage}
      />
    </div>
  );
}
