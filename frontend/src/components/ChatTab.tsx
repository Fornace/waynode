import { useState, useRef, useEffect, useLayoutEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import type { Session, GoalStatus, ChatItem, Block } from "../types";
import { api } from "../api/client";
import * as store from "../lib/sessionStore";
import { isTouchDevice } from "../utils/device";

interface ChatTabProps {
  session: Session;
}

export function ChatTab({ session }: ChatTabProps) {
  const state = store.useSessionChat(session.id);
  const [input, setInput] = useState("");
  const [goal, setGoal] = useState<GoalStatus | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
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

  const streaming = state.streaming;

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
    setShowDropdown(false);
    await store.send(session.id, prompt, isGoal);
    if (isGoal) refreshGoal();
  };

  const handleQueue = async () => {
    if (!input.trim() || !streaming) return;
    const prompt = input.trim();
    setInput("");
    await store.queue(session.id, prompt);
  };

  const handleAbort = async () => {
    await store.abort(session.id);
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
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "The files could not be uploaded.");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <div className="chat-tab">
      {goal && goal.status && (
        <div className="goal-banner">
          <span className={`goal-badge ${goal.status}`}>
            {goal.status === "active" && "●"}
            {goal.status === "paused" && "⏸"}
            {goal.status === "complete" && "✓"}
            {goal.status === "budgetLimited" && "⚠"}
            {" "}Goal: {goal.status}
          </span>
        </div>
      )}

      <div className="chat-messages" ref={messagesRef}>
        {state.items.length === 0 && !streaming && (
          <div className="chat-empty">
            <div className="chat-empty-mark" aria-hidden="true">✦</div>
            <div className="chat-empty-title">What should we do in {session.title || "this workspace"}?</div>
            <div className="chat-empty-desc">The agent can inspect the repository, make changes, run checks, and leave the worktree ready for review.</div>
            <div className="chat-starters" aria-label="Suggested prompts">
              {[
                ["⌕", "Explain this codebase"],
                ["◇", "Find and fix a bug"],
                ["＋", "Build a focused feature"],
              ].map(([icon, prompt]) => (
                <button key={prompt} onClick={() => { setInput(prompt); requestAnimationFrame(() => inputRef.current?.focus()); }}>
                  <span aria-hidden="true">{icon}</span><b>{prompt}</b><i>→</i>
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
            // message would re-show the typing dots / blinking cursor
            // whenever ANY turn (even a later, unrelated one) is streaming.
            streaming={streaming && idx === state.items.length - 1}
          />
        ))}
        {/* Between sending and the server's `message_start` event, the last
            item is still the user's own just-sent message (no assistant item
            exists yet to host the dots inside MessageRow). Without this,
            there's a multi-second window — agent boot + model latency —
            where NOTHING indicates the app is working. Render the same
            three-dot affordance as a standalone placeholder in that gap. */}
        {streaming && state.items[state.items.length - 1]?.role === "user" && (
          <div className="msg msg-assistant">
            <div className="msg-avatar">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 8V4H8"/><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>
            </div>
            <div className="msg-body">
              <div className="msg-typing"><span /><span /><span /></div>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {state.status && <div className="chat-status" role="status">{state.status}</div>}
      {uploadError && (
        <div className="composer-notice" role="alert">
          <span>{uploadError}</span>
          <button onClick={() => setUploadError("")} aria-label="Dismiss upload error">×</button>
        </div>
      )}

      <div className="composer">
        <div className="composer-inner">
          <input 
            type="file" 
            multiple 
            ref={fileInputRef} 
            onChange={handleFileUpload} 
            style={{ display: "none" }} 
          />
          <button 
            className="attach-btn" 
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading || streaming}
            title="Upload files"
          >
            {uploading ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="spin"><line x1="12" y1="2" x2="12" y2="6"></line><line x1="12" y1="18" x2="12" y2="22"></line><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line><line x1="2" y1="12" x2="6" y2="12"></line><line x1="18" y1="12" x2="22" y2="12"></line><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"></line></svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg>
            )}
          </button>
          
          <textarea
            ref={inputRef}
            className="composer-input"
            placeholder={streaming ? "Type a follow-up…" : "Message the agent…"}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              autosize();
            }}
            onKeyDown={handleKeyDown}
            rows={1}
          />
          <div className="send-group">
            {isTouchDevice() && !streaming && (
              <button className="newline-btn" onClick={insertNewline} title="New line">
                <NewlineIcon />
              </button>
            )}
            {streaming ? (
              <button className="send-btn send-stop" onClick={handleAbort} title="Stop">
                <StopIcon />
              </button>
            ) : (
              <>
                <div className="send-split">
                  <button
                    className="send-btn"
                    onClick={() => sendMessage(false)}
                    disabled={!input.trim()}
                    title="Send"
                  >
                    <SendIcon />
                  </button>
                  <button
                    className="send-caret"
                    onClick={() => setShowDropdown((v) => !v)}
                    title="More options"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6"/></svg>
                  </button>
                </div>
                {showDropdown && (
                  <div className="send-menu">
                    <button className="send-menu-item" onClick={() => sendMessage(false)}>
                      <span className="send-menu-label">Send</span>
                      <span className="send-menu-desc">Normal conversation</span>
                    </button>
                    <button className="send-menu-item goal" onClick={() => sendMessage(true)}>
                      <span className="send-menu-label">🎯 Send as Goal</span>
                      <span className="send-menu-desc">Autonomous: creates goal, runs until complete</span>
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Message rendering ──

function MessageRow({ item, streaming }: { item: ChatItem; streaming: boolean }) {
  if (item.role === "system") {
    return (
      <div className="msg msg-system">
        <div className="msg-bubble msg-bubble-system">{item.content}</div>
      </div>
    );
  }

  if (item.role === "user") {
    // Parse out [Uploaded files: ...] for nice UI rendering
    const parts = item.content.split(/(\[Uploaded files?: .*?\])/g);
    
    return (
      <div className="msg msg-user">
        <div className="msg-bubble msg-bubble-user">
          {item.isGoal && <span className="msg-tag">🎯 Goal</span>}
          {parts.map((part, i) => {
            if (part.startsWith("[Uploaded file")) {
              const match = part.match(/\[Uploaded files?: (.*?)\]/);
              if (match) {
                const files = match[1].split(",").map(f => f.trim());
                return (
                  <div key={i} className="msg-attachments">
                    {files.map((f, j) => (
                      <span key={j} className="msg-attachment-pill">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg>
                        {f}
                      </span>
                    ))}
                  </div>
                );
              }
            }
            return <span key={i}>{part}</span>;
          })}
        </div>
      </div>
    );
  }

  // assistant
  return (
    <div className="msg msg-assistant">
      <div className="msg-avatar">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 8V4H8"/><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>
      </div>
      <div className="msg-body">
        {item.blocks.map((b, i) => (
          <BlockView key={i} block={b} streaming={streaming} isLastBlock={i === item.blocks.length - 1} />
        ))}
        {streaming && item.blocks.length === 0 && (
          <div className="msg-typing"><span /><span /><span /></div>
        )}
      </div>
    </div>
  );
}

function BlockView({
  block,
  streaming,
  isLastBlock,
}: {
  block: Block;
  streaming: boolean;
  isLastBlock: boolean;
}) {
  if (block.type === "text") {
    const showCursor = streaming && isLastBlock;
    return (
      <div className="msg-text">
        <ReactMarkdown>{block.text || ""}</ReactMarkdown>
        {showCursor && <span className="stream-cursor" />}
      </div>
    );
  }

  if (block.type === "thinking") {
    return (
      <details className="msg-thinking">
        <summary>💭 Reasoning</summary>
        <div className="msg-thinking-body">{block.text}</div>
      </details>
    );
  }

  // tool
  return <ToolCard block={block} />;
}

function ToolCard({ block }: { block: Extract<Block, { type: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const arg = block.args;
  const preview =
    block.name === "bash" || block.name === "ctx_shell" || block.name === "shell"
      ? arg?.command
      : block.name === "edit" || block.name === "ctx_edit"
      ? arg?.path || arg?.file
      : block.name === "read" || block.name === "ctx_read"
      ? arg?.path
      : block.name === "write"
      ? arg?.path
      : JSON.stringify(arg)?.slice(0, 80);

  const statusIcon = 
    block.status === "running" ? (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
    ) : block.status === "error" ? (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
    ) : (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
    );

  return (
    <div className={`tool-card tool-${block.status}`} onClick={() => setOpen((v) => !v)}>
      <div className="tool-card-head">
        <span className="tool-icon">{statusIcon}</span>
        <span className="tool-name">{block.name}</span>
        {preview && <span className="tool-preview">{preview}</span>}
      </div>
      {open && block.output && (
        <pre className="tool-output">{block.output}</pre>
      )}
    </div>
  );
}

// ── Inline SVG icons ──

function SendIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
      <rect x="5" y="5" width="14" height="14" rx="2" />
    </svg>
  );
}

function NewlineIcon() {
  // Standard "return/newline" glyph (corner-down-left arrow), distinct from
  // the send paper-plane so it doesn't read as a second submit action.
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 10 4 15 9 20" />
      <path d="M20 4v7a4 4 0 0 1-4 4H4" />
    </svg>
  );
}
