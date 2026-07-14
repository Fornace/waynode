import { useEffect, useRef, useState } from "react";
import type { Session } from "../types";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./TerminalTab.css";
import { isTouchDevice } from "../utils/device";

const KEY_SEQUENCES: Record<string, string> = {
  up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D",
  esc: "\x1b", tab: "\t", "ctrl-c": "\x03",
};

type TerminalState = {
  kind: "connecting" | "connected" | "busy" | "billing" | "unsupported" | "disconnected" | "exited" | "failed";
  message?: string;
};

interface TerminalTabProps {
  session: Session;
  onRequestExit?: () => void;
  onUnsupported?: () => void;
}

export default function TerminalTab({ session, onRequestExit, onUnsupported }: TerminalTabProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [connection, setConnection] = useState<TerminalState>({ kind: "connecting" });
  const [retryCount, setRetryCount] = useState(0);
  const [keybarOpen, setKeybarOpen] = useState(false);
  const ctrlArmedRef = useRef(false);
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const exitRef = useRef(onRequestExit);
  const unsupportedRef = useRef(onUnsupported);
  exitRef.current = onRequestExit;
  unsupportedRef.current = onUnsupported;

  const setCtrlArmedBoth = (armed: boolean) => {
    ctrlArmedRef.current = armed;
    setCtrlArmed(armed);
  };

  useEffect(() => {
    if (!surfaceRef.current) return;
    setConnection({ kind: "connecting" });
    let handledClose = false;

    const term = new Terminal({
      fontSize: 13,
      fontFamily: "var(--mono)",
      theme: {
        background: "#0f0f11", foreground: "#f3f4f6", cursor: "#6366f1",
        selectionBackground: "rgba(99, 102, 241, 0.3)", black: "#000000",
        red: "#ef4444", green: "#10b981", yellow: "#f59e0b", blue: "#3b82f6",
        magenta: "#8b5cf6", cyan: "#06b6d4", white: "#f3f4f6",
      },
      cursorBlink: true,
      allowProposedApi: true,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(surfaceRef.current);
    fitAddon.fit();

    term.attachCustomKeyEventHandler((event) => {
      const isMod = event.ctrlKey || event.metaKey;
      if (isMod && event.shiftKey && (event.key === "T" || event.key === "t")) {
        exitRef.current?.();
        return false;
      }
      return true;
    });

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const devToken = localStorage.getItem("waynode-dev-token") || "";
    const ws = new WebSocket(`${proto}//${location.host}/ws/terminal?sessionId=${session.id}${devToken ? `&t=${encodeURIComponent(devToken)}` : ""}`);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnection({ kind: "connected" });
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      term.focus();
    };
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "output") term.write(msg.data);
        else if (msg.type === "exit") {
          handledClose = true;
          term.write(`\r\n[process exited with code ${msg.exitCode}]\r\n`);
          setConnection({ kind: "exited", message: `The terminal process exited with code ${msg.exitCode}. Your scrollback is preserved.` });
        } else if (msg.type === "error") {
          handledClose = true;
          if (msg.billingBlocked) setConnection({ kind: "billing", message: msg.message });
          else if (msg.agentBusy) setConnection({ kind: "busy", message: msg.message });
          else if (msg.terminalDisabled) {
            setConnection({ kind: "unsupported", message: msg.message });
            unsupportedRef.current?.();
          } else setConnection({ kind: "failed", message: msg.message || "The terminal could not continue." });
        }
      } catch {
        handledClose = true;
        setConnection({ kind: "failed", message: "Waynode received an invalid terminal response. Your session and files are unchanged." });
      }
    };
    ws.onerror = () => {
      if (handledClose) return;
      handledClose = true;
      setConnection({ kind: "failed", message: "Waynode could not establish a terminal connection. Chat and your worktree remain available." });
    };
    ws.onclose = () => {
      if (!handledClose) setConnection({ kind: "disconnected", message: "The terminal connection ended. Your visible scrollback is preserved." });
    };

    const inputDisposable = term.onData((data) => {
      let out = data;
      if (ctrlArmedRef.current) {
        if (/^[a-zA-Z]$/.test(data)) out = String.fromCharCode(data.toLowerCase().charCodeAt(0) - 96);
        setCtrlArmedBoth(false);
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", data: out }));
    });
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols, rows }));
    });
    const handleResize = () => { try { fitAddon.fit(); } catch { /* xterm may be between layouts */ } };
    window.addEventListener("resize", handleResize);

    return () => {
      handledClose = true;
      inputDisposable.dispose();
      resizeDisposable.dispose();
      window.removeEventListener("resize", handleResize);
      ws.close();
      term.dispose();
      wsRef.current = null;
    };
  }, [session.id, retryCount]);

  const retry = () => {
    setConnection({ kind: "connecting" });
    setRetryCount((count) => count + 1);
  };
  const sendKey = (data: string) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", data }));
  };

  return (
    <div className="terminal-container" role="region" aria-label="Session terminal">
      <div className="terminal-surface" ref={surfaceRef} />
      {connection.kind !== "connected" && <TerminalOverlay state={connection} onRetry={retry} onReturn={onRequestExit} />}
      {isTouchDevice() && connection.kind === "connected" && (
        <MobileKeyBar
          open={keybarOpen}
          onToggle={() => setKeybarOpen((open) => !open)}
          ctrlArmed={ctrlArmed}
          onToggleCtrl={() => setCtrlArmedBoth(!ctrlArmedRef.current)}
          onKey={sendKey}
        />
      )}
    </div>
  );
}

function TerminalOverlay({ state, onRetry, onReturn }: { state: TerminalState; onRetry: () => void; onReturn?: () => void }) {
  const content = {
    connecting: ["Connecting to terminal", "Opening this session’s persistent terminal."],
    busy: ["Terminal locked while the agent writes", state.message || "Wait for the active agent turn to finish, then try again."],
    billing: ["Terminal unavailable for this plan", state.message || "Update the organization’s plan or usage limit before opening a terminal."],
    unsupported: ["Terminal unavailable", state.message || "This server does not support an interactive terminal."],
    disconnected: ["Terminal disconnected", state.message || "The connection ended, but your worktree is unchanged."],
    exited: ["Terminal process exited", state.message || "Restart it when you’re ready."],
    failed: ["Terminal could not connect", state.message || "Your worktree and chat remain available."],
    connected: ["Terminal connected", ""],
  }[state.kind];
  const canRetry = state.kind === "busy" || state.kind === "disconnected" || state.kind === "exited" || state.kind === "failed";

  return (
    <section className={`terminal-state is-${state.kind}`} role={["failed", "billing", "unsupported"].includes(state.kind) ? "alert" : "status"} aria-live={["failed", "billing", "unsupported"].includes(state.kind) ? "assertive" : "polite"} aria-busy={state.kind === "connecting"}>
      {state.kind === "connecting" && <span className="state-progress" aria-hidden="true" />}
      <h2>{content[0]}</h2>
      <p>{content[1]}</p>
      <div className="terminal-state-actions">
        {canRetry && <button type="button" className="terminal-state-primary" onClick={onRetry}>{state.kind === "exited" ? "Restart terminal" : "Try again"}</button>}
        {onReturn && state.kind !== "connecting" && <button type="button" onClick={onReturn}>Return to chat</button>}
      </div>
    </section>
  );
}

interface MobileKeyBarProps {
  open: boolean;
  onToggle: () => void;
  ctrlArmed: boolean;
  onToggleCtrl: () => void;
  onKey: (data: string) => void;
}

function MobileKeyBar({ open, onToggle, ctrlArmed, onToggleCtrl, onKey }: MobileKeyBarProps) {
  const keys = [["left", "←", "Left"], ["up", "↑", "Up"], ["down", "↓", "Down"], ["right", "→", "Right"], ["esc", "Esc", "Escape"], ["tab", "Tab", "Tab"]];
  return (
    <div className="term-keybar">
      {open && <div className="term-keybar-row" aria-label="Terminal key helper">
        {keys.map(([key, label, name]) => <button type="button" key={key} className="term-keybar-btn" onClick={() => onKey(KEY_SEQUENCES[key])} aria-label={`Send ${name} key`}>{label}</button>)}
        <button type="button" className={`term-keybar-btn ${ctrlArmed ? "armed" : ""}`} onClick={onToggleCtrl} aria-pressed={ctrlArmed}>Ctrl</button>
        <button type="button" className="term-keybar-btn" onClick={() => onKey(KEY_SEQUENCES["ctrl-c"])} aria-label="Send Control C">^C</button>
      </div>}
      <button type="button" className="term-keybar-handle" onClick={onToggle} aria-label={open ? "Hide terminal key helper" : "Show terminal key helper"} aria-expanded={open}>
        {open ? <CloseIcon /> : <KeyboardIcon />}
      </button>
    </div>
  );
}

function KeyboardIcon() { return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M7 9h.01M11 9h.01M15 9h.01M7 13h.01M11 13h6M7 16h10" /></svg>; }
function CloseIcon() { return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>; }
