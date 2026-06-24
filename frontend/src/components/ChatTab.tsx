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
  const [abortController, setAbortController] = useState<AbortController | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      if (messagesRef.current) {
        messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
      }
    });
  }, []);

  // Load persisted messages on mount
  useEffect(() => {
    api.sessions.getMessages(session.id).then((msgs) => {
      if (msgs.length > 0) {
        setMessages(msgs.map((m) => ({ role: m.role, content: m.content })));
        scrollToBottom();
      }
    }).catch(() => {});
  }, [session.id, scrollToBottom]);

  // Check if there's an active chat to resume
  useEffect(() => {
    fetch(`/api/sessions/${session.id}/state`, { headers: getAuthHeaders() })
      .then((r) => r.json())
      .then((state) => {
        if (state.active) {
          resumeStream();
        }
      })
      .catch(() => {});
  }, [session.id]);

  const resumeStream = useCallback(async () => {
    setStreaming(true);

    let assistantText = "";
    setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

    try {
      const res = await fetch(`/api/sessions/${session.id}/resume`, {
        headers: getAuthHeaders(),
      });

      if (!res.body) throw new Error("No response body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const data = line.replace(/^data: /, "").trim();
          if (!data || data === "[DONE]" || data.startsWith(":")) continue;

          try {
            const event = JSON.parse(data);
            if (event.type === "delta" && event.text) {
              assistantText += event.text;
              setMessages((prev) => {
                const next = [...prev];
                next[next.length - 1] = { role: "assistant", content: assistantText };
                return next;
              });
              scrollToBottom();
            } else if (event.type === "done") {
              setStreaming(false);
            }
          } catch {}
        }
      }
    } catch {
      setStreaming(false);
    }
  }, [session.id, scrollToBottom]);

  const sendMessage = async (isGoal: boolean) => {
    if (!input.trim() || streaming) return;

    const prompt = input.trim();
    setInput("");
    setShowDropdown(false);
    setStreaming(true);

    setMessages((prev) => [...prev, { role: "user", content: prompt, isGoal }]);
    scrollToBottom();

    const ac = new AbortController();
    setAbortController(ac);

    let assistantText = "";

    try {
      const res = await api.sendMessagePOST(session.id, prompt, isGoal);

      if (res.status === 503) {
        const body = await res.json();
        setMessages((prev) => [
          ...prev,
          { role: "system", content: `⚠ ${body.error}. ${body.hint || ""}` },
        ]);
        setStreaming(false);
        return;
      }

      if (!res.body) throw new Error("No response body");

      setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const data = line.replace(/^data: /, "").trim();
          if (!data || data === "[DONE]" || data.startsWith(":")) continue;

          try {
            const event = JSON.parse(data);
            if (event.type === "delta" && event.text) {
              assistantText += event.text;
              setMessages((prev) => {
                const next = [...prev];
                next[next.length - 1] = { role: "assistant", content: assistantText };
                return next;
              });
              scrollToBottom();
            } else if (event.type === "done") {
              if (isGoal) refreshGoal();
            } else if (event.type === "error") {
              assistantText += `\n\n**Error:** ${event.message}`;
              setMessages((prev) => {
                const next = [...prev];
                next[next.length - 1] = { role: "assistant", content: assistantText };
                return next;
              });
            }
          } catch {}
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setMessages((prev) => [
          ...prev,
          { role: "system", content: `Connection error: ${(err as Error).message}` },
        ]);
      }
    } finally {
      setStreaming(false);
      setAbortController(null);
      if (isGoal) refreshGoal();
    }
  };

  const handleAbort = async () => {
    abortController?.abort();
    await fetch(`/api/sessions/${session.id}/abort`, {
      method: "POST",
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
    });
    setStreaming(false);
    setAbortController(null);
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
    setMessages((prev) => [...prev, { role: "system", content: `📝 Queued: "${prompt.slice(0, 80)}..."` }]);
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
      if (streaming) {
        handleQueue();
      } else {
        sendMessage(false);
      }
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
            {" "}
            Goal: {goal.status}
            {goal.tokenUsage ? ` (${goal.tokenUsage.toLocaleString()} tokens)` : ""}
            {goal.elapsedMs ? ` · ${Math.round(goal.elapsedMs / 1000)}s` : ""}
          </span>
        </div>
      )}

      <div className="chat-messages" ref={messagesRef}>
        {messages.length === 0 && (
          <div className="empty-state">
            <div className="empty-state-icon">💬</div>
            <div className="empty-state-title">Start a conversation</div>
            <div className="empty-state-desc">
              Send a message or use Goal mode for autonomous execution
            </div>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className="chat-message">
            <div className="chat-message-role">
              {msg.isGoal ? "🎯 user (goal)" : msg.role}
            </div>
            <div className="chat-message-content">
              {msg.content || (msg.role === "assistant" && streaming && i === messages.length - 1 ? "Thinking..." : "...")}
            </div>
          </div>
        ))}
      </div>

      <div className="composer">
        <textarea
          className="composer-input"
          placeholder={streaming ? "Type to queue a follow-up... (Enter to queue)" : "Type a message... (Enter to send, Shift+Enter for newline)"}
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
            <button
              className="send-btn"
              style={{ background: "var(--red)" }}
              onClick={handleAbort}
            >
              ⏹ Stop
            </button>
          ) : (
            <>
              <button
                className="send-btn"
                onClick={() => sendMessage(false)}
                disabled={!input.trim()}
              >
                Send ▸
              </button>
              <button
                className="send-dropdown-btn"
                onClick={() => setShowDropdown(!showDropdown)}
              >
                ▾
              </button>
              {showDropdown && (
                <div className="send-dropdown">
                  <button
                    className="send-dropdown-item"
                    onClick={() => sendMessage(false)}
                  >
                    <div>Send</div>
                    <div className="item-desc">Normal pi conversation</div>
                  </button>
                  <button
                    className="send-dropdown-item"
                    onClick={() => sendMessage(true)}
                  >
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
