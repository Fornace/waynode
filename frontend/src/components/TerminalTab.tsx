import { useEffect, useRef } from "react";
import type { Session } from "../types";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

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
  // Keep the latest exit callback in a ref so the one-time key handler
  // (registered inside the [session.id] effect) always calls the current one.
  const onRequestExitRef = useRef(onRequestExit);
  onRequestExitRef.current = onRequestExit;

  useEffect(() => {
    if (!containerRef.current) return;

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
          term.write(`\r\n[error: ${msg.message}]\r\n`);
        }
      } catch {}
    };

    ws.onclose = () => {
      term.write("\r\n[disconnected]\r\n");
    };

    const inputDisposable = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data }));
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
  }, [session.id]);

  return <div className="terminal-container" ref={containerRef} />;
}
