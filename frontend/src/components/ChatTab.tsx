import { useState, useRef, useCallback, useEffect } from "react";
import type { Session, GoalStatus } from "../types";
import { api } from "../api/client";

interface ChatTabProps {
  session: Session;
}

interface DisplayMessage {
  role: "user" | "assistant" | "system";
  content: string;
  thinking?: string;
  isGoal?: boolean;
}

function getAuthHeaders(): Record<string, string> {
  const devToken = localStorage.getItem("waynode-dev-token");
  return devToken ? { "x-dev-token": devToken } : {};
}

export function ChatTab({ session }: ChatTabProps) {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [goal, setGoal] = useState<GoalStatus | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      if (messagesRef.current) messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    });
  }, []);

  useEffect(() => {
    api.sessions.getMessages(session.id).then((msgs) => {
      if (msgs.length > 0) {
        setMessages(msgs.map((m) => ({ role: m.role, content: m.content })));
        scrollToBottom();
      }
    }).catch(() => {});
  }, [session.id, scrollToBottom]);

  useEffect(() => {
    fetch(`/api/sessions/${session.id}/state`, { headers: getAuthHeaders() })
      .then(r => r.json())
      .then(state => { if (state.active) setStreaming(true); })
      .catch(() => {});
  }, [session.id]);

  // ── Parse Vercel AI SDK UI message stream ──
  const processStreamChunk = (rawData: string, assistantText: { content: string; thinking: string }) => {
    if (!rawData.startsWith("data: ")) return;
    const jsonStr = rawData.slice(6).trim();
    if (!jsonStr || jsonStr === "[DONE]") return;

    try {
      const data = JSON.parse(jsonStr);

      if (data.type === "start") {
        setMessages(prev => [...prev, { role: "assistant", content: "", thinking: "" }]);
        return;
      }

      if (data.type === "start-step") return;

      if (data.type === "text-start" && data.id?.startsWith("text")) return;

      if (data.type === "text-delta" && data.id?.startsWith("text")) {
        assistantText.content += data.textDelta || "";
        setMessages(prev => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.role === "assistant") next[next.length - 1] = { ...last, content: assistantText.content };
          return next;
        });
        scrollToBottom();
        return;
      }

      if (data.type === "reasoning-start") return;

      if (data.type === "reasoning-delta") {
        assistantText.thinking += data.textDelta || data.reasoningDelta || "";
        setMessages(prev => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.role === "assistant") next[next.length - 1] = { ...last, thinking: assistantText.thinking };
          return next;
        });
        return;
      }

      if (data.type === "error") {
        const errText = data.error || data.message || "Stream error";
        assistantText.content += `\n\n⚠ **Error:** ${errText}`;
        setMessages(prev => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.role === "assistant") next[next.length - 1] = { ...last, content: assistantText.content };
          return next;
        });
        return;
      }

      if (data.type === "finish") return;
      if (data.type === "finish-step") return;
    } catch {}
  };

  const sendMessage = async (isGoal: boolean) => {
    if (!input.trim() || streaming) return;

    const prompt = input.trim();
    setInput("");
    setShowDropdown(false);
    setStreaming(true);

    setMessages(prev => [...prev, { role: "user", content: prompt, isGoal }]);
    scrollToBottom();

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const res = await fetch(`/api/sessions/${session.id}/message`, {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, isGoal }),
        signal: ac.signal,
      });

      if (res.status === 503) {
        const body = await res.json();
        setMessages(prev => [...prev, { role: "system", content: `⚠ ${body.error}` }]);
        setStreaming(false);
        return;
      }

      if (!res.body) throw new Error("No response body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const assistantText = { content: "", thinking: "" };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(":")) continue;
          processStreamChunk(trimmed, assistantText);
        }
      }

      if (buffer.trim()) processStreamChunk(buffer.trim(), assistantText);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setMessages(prev => [...prev, { role: "system", content: `Connection error: ${(err as Error).message}` }]);
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
      if (isGoal) refreshGoal();
    }
  };

  const handleAbort = async () => {
    abortRef.current?.abort();
    await fetch(`/api/sessions/${session.id}/abort`, {
      method: "POST",
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
    });
    setStreaming(false);
    abortRef.current = null;
  };

  const handleQueue = async () => {
    if (!input.trim() || !streaming) return;
    const prompt = input.trim();
    setInput("");
    await fetch(`/api/sessions/${session.id}/queue`, {
      method: "POST",
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    setMessages(prev => [...prev, { role: "system", content: `📝 Queued: "${prompt.slice(0, 80)}..."` }]);
  };

  const refreshGoal = async () => {
    try {
      const { goal } = await api.sessions.getGoal(session.id);
      setGoal(goal);
    } catch {}
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (streaming) handleQueue();
      else sendMessage(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {goal && goal.status && (
        <div style={{ padding: "6px 16px", borderBottom: "1px solid var(--border)" }}>
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
        {messages.length === 0 && (
          <div className="empty-state">
            <div className="empty-state-icon">💬</div>
            <div className="empty-state-title">Start a conversation</div>
            <div className="empty-state-desc">Send a message or use Goal mode for autonomous execution</div>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className="chat-message">
            <div className="chat-message-role">{msg.isGoal ? "🎯 user (goal)" : msg.role}</div>
            {msg.thinking && (
              <details className="thinking-block">
                <summary>💭 Thinking...</summary>
                <div className="thinking-content">{msg.thinking}</div>
              </details>
            )}
            <div className="chat-message-content">
              {msg.content || (msg.role === "assistant" && streaming && i === messages.length - 1 ? "..." : "")}
            </div>
          </div>
        ))}
      </div>

      <div className="composer">
        <textarea
          className="composer-input"
          placeholder={streaming ? "Type to queue a follow-up... (Enter to queue)" : "Type a message... (Enter to send)"}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          style={{ height: "auto" }}
          onInput={(e) => {
            const el = e.target as HTMLTextAreaElement;
            el.style.height = "auto";
            el.style.height = Math.min(el.scrollHeight, 200) + "px";
          }}
        />
        <div className="send-button-group">
          {streaming ? (
            <button className="send-btn" style={{ background: "var(--red)" }} onClick={handleAbort}>⏹ Stop</button>
          ) : (
            <>
              <button className="send-btn" onClick={() => sendMessage(false)} disabled={!input.trim()}>Send ▸</button>
              <button className="send-dropdown-btn" onClick={() => setShowDropdown(!showDropdown)}>▾</button>
              {showDropdown && (
                <div className="send-dropdown">
                  <button className="send-dropdown-item" onClick={() => sendMessage(false)}>
                    <div>Send</div>
                    <div className="item-desc">Normal conversation</div>
                  </button>
                  <button className="send-dropdown-item" onClick={() => sendMessage(true)}>
                    <div>🎯 Send as Goal</div>
                    <div className="item-desc">Autonomous: creates goal, runs until complete</div>
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
