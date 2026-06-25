import { useState, useRef, useEffect, useCallback } from "react";
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
  const messagesRef = useRef<HTMLDivElement>(null);
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

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      if (messagesRef.current) messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [state.items, scrollToBottom]);

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
        alert("Upload failed: " + (data.err || "Unknown error"));
      }
    } catch (err: any) {
      alert("Upload failed: " + err.message);
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
            <div className="chat-empty-icon">💬</div>
            <div className="chat-empty-title">Start a conversation</div>
            <div className="chat-empty-desc">Send a message, or use Goal mode for autonomous execution.</div>
          </div>
        )}

        {state.items.map((item) => (
          <MessageRow key={item.id} item={item} streaming={streaming} />
        ))}
      </div>

      {state.status && <div className="chat-status">{state.status}</div>}

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
            placeholder={
              streaming
                ? "Type a follow-up… (Enter to queue)"
                : "Message the agent… (Enter to send, Shift+Enter for newline)"
            }
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
              <button className="send-btn newline-btn" onClick={insertNewline} title="New line">↵</button>
            )}
            {streaming ? (
              <button className="send-btn send-stop" onClick={handleAbort} title="Stop">
                <StopIcon />
              </button>
            ) : (
              <>
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
  const isLast = false; // determined by parent via key; cursor handled below
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
