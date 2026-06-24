import { useState, useRef, useCallback, useEffect } from "react";
import type { Session, ChatMessage, GoalStatus } from "../types";
import { api } from "../api/client";

interface ChatTabProps {
  session: Session;
}

export function ChatTab({ session }: ChatTabProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [goal, setGoal] = useState<GoalStatus | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      if (messagesRef.current) {
        messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
      }
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

  const sendMessage = async (isGoal: boolean) => {
    if (!input.trim() || streaming) return;

    const prompt = input.trim();
    setInput("");
    setShowDropdown(false);
    setStreaming(true);

    setMessages((prev) => [...prev, { role: "user", content: prompt }]);
    scrollToBottom();

    let assistantText = "";

    try {
      const res = await api.sendMessagePOST(session.id, prompt, isGoal);
      if (!res.body) throw new Error("No response body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const data = line.replace(/^data: /, "").trim();
          if (!data) continue;

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
            } else if (event.type === "stderr" && event.text) {
              assistantText += event.text;
              setMessages((prev) => {
                const next = [...prev];
                next[next.length - 1] = { role: "assistant", content: assistantText };
                return next;
              });
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
      setMessages((prev) => [
        ...prev,
        { role: "system", content: `Connection error: ${(err as Error).message}` },
      ]);
    } finally {
      setStreaming(false);
      if (isGoal) refreshGoal();
    }
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
      sendMessage(false);
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
            <div className="chat-message-role">{msg.role}</div>
            <div className="chat-message-content">{msg.content || "..."}</div>
          </div>
        ))}
      </div>

      <div className="composer">
        <textarea
          className="composer-input"
          placeholder="Type a message... (Enter to send, Shift+Enter for newline)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={streaming}
          rows={1}
          style={{ height: "auto" }}
          onInput={(e) => {
            const el = e.target as HTMLTextAreaElement;
            el.style.height = "auto";
            el.style.height = Math.min(el.scrollHeight, 200) + "px";
          }}
        />
        <div className="send-button-group">
          <button
            className="send-btn"
            onClick={() => sendMessage(false)}
            disabled={streaming || !input.trim()}
          >
            {streaming ? "..." : "Send ▸"}
          </button>
          <button
            className="send-dropdown-btn"
            onClick={() => setShowDropdown(!showDropdown)}
            disabled={streaming}
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
        </div>
      </div>
    </div>
  );
}
