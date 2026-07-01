import { useEffect, useRef, useState } from "react";
import type { Session } from "../types";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./TerminalTab.css";
import { isTouchDevice } from "../utils/device";

// Byte sequences for the mobile key-helper bar. Mirrors what a real terminal
// emulator sends for these keys since there's no physical keyboard to
// generate them on touch devices.
const KEY_SEQUENCES: Record<string, string> = {
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  esc: "\x1b",
  tab: "\t",
  "ctrl-c": "\x03",
};

interface TerminalTabProps {
  session: Session;
  /** Fired when the user invokes the reserved "leave terminal" chord
   *  (Ctrl/Cmd+Shift+T). The terminal swallows that key from the PTY and
   *  hands control back to the UI (typically: switch to the Chat tab). */
  onRequestExit?: () => void;
}

export default function TerminalTab({ session, onRequestExit }: TerminalTabProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [disabledReason, setDisabledReason] = useState<string | null>(null);
  const [busyReason, setBusyReason] = useState<string | null>(null);
  // Bumped by the "Try again" retry button to force the connection effect
  // below to re-run (it otherwise only depends on session.id).
  const [retryCount, setRetryCount] = useState(0);
  // Mobile key-helper bar: collapsed by default so it doesn't eat viewport.
  const [keybarOpen, setKeybarOpen] = useState(false);
  // One-shot "Ctrl" arm/disarm for the mobile key bar — mirrors the standard
  // mobile terminal app UX (tap Ctrl, then tap a letter to send its control
  // code). Kept in a ref (read synchronously inside term.onData) plus a
  // mirrored state value purely to drive the button's active styling.
  const ctrlArmedRef = useRef(false);
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const setCtrlArmedBoth = (armed: boolean) => {
    ctrlArmedRef.current = armed;
    setCtrlArmed(armed);
  };
  // Keep the latest exit callback in a ref so the one-time key handler
  // (registered inside the [session.id] effect) always calls the current one.
  const onRequestExitRef = useRef(onRequestExit);
  onRequestExitRef.current = onRequestExit;

  // Set synchronously (not via React state) the instant a graceful-rejection
  // error arrives, so the close handler — which can fire in the same tick,
  // before React has re-rendered to the busy/disabled banner — knows not to
  // write "[disconnected]" over what is about to become a banner view.
  const gracefulCloseRef = useRef(false);

  useEffect(() => {
    if (!containerRef.current) return;
    setDisabledReason(null);
    setBusyReason(null);
    gracefulCloseRef.current = false;

    const term = new Terminal({
      fontSize: 13,
      fontFamily: "var(--mono)",
      theme: {
        background: "#0f0f11",
        foreground: "#f3f4f6",
        cursor: "#6366f1",
        selectionBackground: "rgba(99, 102, 241, 0.3)",
        black: "#000000",
        red: "#ef4444",
        green: "#10b981",
        yellow: "#f59e0b",
        blue: "#3b82f6",
        magenta: "#8b5cf6",
        cyan: "#06b6d4",
        white: "#f3f4f6",
      },
      cursorBlink: true,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    termRef.current = term;

    // Reserved chord: Ctrl/Cmd+Shift+T leaves the terminal for the UI.
    // Returning false from this handler stops the key reaching the PTY;
    // every other key returns true and is forwarded to the shell unchanged.
    // See docs/KEYBOARD-CONTRACT.md §1.1.
    term.attachCustomKeyEventHandler((event) => {
      const isMod = event.ctrlKey || event.metaKey;
      if (isMod && event.shiftKey && (event.key === "T" || event.key === "t")) {
        onRequestExitRef.current?.();
        return false;
      }
      return true;
    });

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    // Append the dev-token as ?t= when present, mirroring the SSE streams
    // (clone/git), so the terminal WS authenticates in automated E2E / dev the
    // same way those do (the WS can't set the x-dev-token header).
    const devToken = localStorage.getItem("waynode-dev-token") || "";
    const ws = new WebSocket(
      `${proto}//${location.host}/ws/terminal?sessionId=${session.id}${devToken ? `&t=${encodeURIComponent(devToken)}` : ""}`
    );
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "output") {
          term.write(msg.data);
        } else if (msg.type === "exit") {
          term.write(`\r\n[pi exited with code ${msg.exitCode}]\r\n`);
        } else if (msg.type === "error") {
          // Distinguish the two known "graceful rejection" cases — sandboxed
          // mode (permanently unavailable) and agent-busy (temporary, agent
          // is mid-turn) — from a genuine unexpected error. Both are shown as
          // a dedicated banner rather than a raw line in a dead terminal.
          if (msg.agentBusy) {
            gracefulCloseRef.current = true;
            setBusyReason(msg.message);
          } else if (msg.terminalDisabled || /unavailable in sandboxed mode/i.test(msg.message)) {
            gracefulCloseRef.current = true;
            setDisabledReason(msg.message);
          } else {
            term.write(`\r\n[error: ${msg.message}]\r\n`);
          }
        }
      } catch {}
    };

    ws.onclose = () => {
      // The server closes the socket right after a graceful-rejection error
      // (agentBusy / terminalDisabled) — onmessage above already routed this
      // to the dedicated banner, so don't also stamp a raw "[disconnected]"
      // line into the terminal buffer underneath it.
      if (gracefulCloseRef.current) return;
      term.write("\r\n[disconnected]\r\n");
    };

    const inputDisposable = term.onData((data) => {
      let out = data;
      // One-shot Ctrl arm from the mobile key bar: a single a-z/A-Z char
      // becomes its control code (Ctrl+C -> \x03, etc); anything else while
      // armed still disarms (standard mobile terminal "one shot" UX).
      if (ctrlArmedRef.current) {
        if (/^[a-zA-Z]$/.test(data)) {
          out = String.fromCharCode(data.toLowerCase().charCodeAt(0) - 96);
        }
        setCtrlArmedBoth(false);
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data: out }));
      }
    });

    const resizeDisposable = term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    });

    const handleResize = () => {
      try {
        fitAddon.fit();
      } catch {}
    };
    window.addEventListener("resize", handleResize);

    return () => {
      inputDisposable.dispose();
      resizeDisposable.dispose();
      window.removeEventListener("resize", handleResize);
      ws.close();
      term.dispose();
      termRef.current = null;
      wsRef.current = null;
    };
  }, [session.id, retryCount]);

  // Sends a raw byte sequence to the PTY, mirroring the exact message shape
  // used by term.onData above. Used by the mobile key-helper bar buttons.
  const sendKey = (data: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "input", data }));
    }
  };

  const toggleCtrlArmed = () => setCtrlArmedBoth(!ctrlArmedRef.current);

  if (busyReason) {
    return (
      <div className="terminal-container" style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <div style={{ maxWidth: 480, textAlign: "center", color: "var(--text-dim)", fontSize: 13, lineHeight: 1.6 }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>⏳</div>
          <div style={{ fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>Agent is busy</div>
          <div>Agent is currently working on your last request — Terminal will be available once it finishes.</div>
          <button
            type="button"
            onClick={() => {
              setBusyReason(null);
              setRetryCount((c) => c + 1);
            }}
            style={{
              marginTop: 16,
              padding: "6px 14px",
              fontSize: 12,
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg-elevated, transparent)",
              color: "var(--text)",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (disabledReason) {
    return (
      <div className="terminal-container" style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <div style={{ maxWidth: 480, textAlign: "center", color: "var(--text-dim)", fontSize: 13, lineHeight: 1.6 }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>🔒</div>
          <div style={{ fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>Terminal unavailable</div>
          <div>{disabledReason}</div>
          <div style={{ marginTop: 16, fontSize: 12, color: "var(--text-faint)" }}>
            Agent chat still works — it runs in an isolated microVM. Use the Chat tab.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="terminal-container" ref={containerRef}>
      {isTouchDevice() && (
        <MobileKeyBar
          open={keybarOpen}
          onToggle={() => setKeybarOpen((o) => !o)}
          ctrlArmed={ctrlArmed}
          onToggleCtrl={toggleCtrlArmed}
          onKey={sendKey}
        />
      )}
    </div>
  );
}

interface MobileKeyBarProps {
  open: boolean;
  onToggle: () => void;
  ctrlArmed: boolean;
  onToggleCtrl: () => void;
  onKey: (data: string) => void;
}

// Collapsible key-helper bar for touch devices, where arrows/Esc/Tab/Ctrl
// have no physical key. Collapsed by default to a small handle so it doesn't
// eat vertical space out of the terminal viewport; tapping it reveals the
// button row, tapping again (or the handle) collapses it.
function MobileKeyBar({ open, onToggle, ctrlArmed, onToggleCtrl, onKey }: MobileKeyBarProps) {
  return (
    <div className="term-keybar">
      {open && (
        <div className="term-keybar-row">
          <button type="button" className="term-keybar-btn" onClick={() => onKey(KEY_SEQUENCES.left)}>←</button>
          <button type="button" className="term-keybar-btn" onClick={() => onKey(KEY_SEQUENCES.up)}>↑</button>
          <button type="button" className="term-keybar-btn" onClick={() => onKey(KEY_SEQUENCES.down)}>↓</button>
          <button type="button" className="term-keybar-btn" onClick={() => onKey(KEY_SEQUENCES.right)}>→</button>
          <button type="button" className="term-keybar-btn" onClick={() => onKey(KEY_SEQUENCES.esc)}>Esc</button>
          <button type="button" className="term-keybar-btn" onClick={() => onKey(KEY_SEQUENCES.tab)}>Tab</button>
          <button
            type="button"
            className={`term-keybar-btn ${ctrlArmed ? "armed" : ""}`}
            onClick={onToggleCtrl}
          >
            Ctrl
          </button>
          <button type="button" className="term-keybar-btn" onClick={() => onKey(KEY_SEQUENCES["ctrl-c"])}>^C</button>
        </div>
      )}
      <button type="button" className="term-keybar-handle" onClick={onToggle} title="Toggle key helper">
        {open ? "×" : "⌨"}
      </button>
    </div>
  );
}
