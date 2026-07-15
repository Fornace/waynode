import { Suspense, lazy, useEffect, useRef, useState } from "react";
import type { Session, Space, GitSnapshot } from "../types";
import { ChatTab } from "./ChatTab";
import { api } from "../api/client";
import * as store from "../lib/sessionStore";
import { StateSurface } from "./StateSurface";
import { terminalAffordance, type TerminalCapabilityState } from "../lib/terminalCapability";

const TerminalTab = lazy(() => import("./TerminalTab"));

interface SessionViewProps {
  session: Session;
  space: Space;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onOpenSettings: () => void;
  isAdmin: boolean;
  terminalCapability: TerminalCapabilityState;
  gitOpen?: boolean;
  onToggleGit?: () => void;
}

type Mode = "chat" | "terminal";

export function SessionView(props: SessionViewProps) {
  const { session, space, sidebarOpen, onToggleSidebar, onOpenSettings, gitOpen, onToggleGit } = props;
  const chat = store.useSessionChat(session.id);
  const [mode, setMode] = useState<Mode>("chat");
  const [models, setModels] = useState<{ id: string; name: string; provider: string }[]>([]);
  const [currentModel, setCurrentModel] = useState(session.model || "");
  const [gitSnapshot, setGitSnapshot] = useState<GitSnapshot | null>(null);
  const [gitError, setGitError] = useState(false);
  const [modelError, setModelError] = useState("");
  const [terminalDenied, setTerminalDenied] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const effectiveTerminalCapability: TerminalCapabilityState = terminalDenied ? "unsupported" : props.terminalCapability;
  const terminalControl = terminalAffordance(effectiveTerminalCapability);

  useEffect(() => {
    setTerminalDenied(false);
    setMode("chat");
    setCurrentModel(session.model || "");
  }, [session.id, session.model]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const isMod = event.ctrlKey || event.metaKey;
      if (!(isMod && event.shiftKey && event.key.toLowerCase() === "t")) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.closest(".terminal-container")) return;
      event.preventDefault();
      setMode((current) => current === "chat" && effectiveTerminalCapability === "supported" ? "terminal" : "chat");
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [effectiveTerminalCapability]);

  useEffect(() => {
    if (effectiveTerminalCapability !== "supported") setMode("chat");
  }, [effectiveTerminalCapability]);

  useEffect(() => {
    fetch("/api/models", { credentials: "include" }).then((response) => response.json()).then((data) => setModels(data.models || [])).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    const accept = (snapshot: GitSnapshot) => { if (!cancelled) { setGitSnapshot(snapshot); setGitError(false); } };
    api.git.status(space.id).then(accept).catch(() => !cancelled && setGitError(true));
    const stream = api.git.stream(space.id);
    stream.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === "snapshot") accept(message.data);
      } catch {}
    };
    stream.onerror = () => { if (!cancelled) setGitError(true); };
    return () => { cancelled = true; stream.close(); };
  }, [space.id]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setMenuOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", escape); };
  }, [menuOpen]);

  const handleModelChange = async (model: string) => {
    const previous = currentModel;
    setModelError("");
    setCurrentModel(model);
    try {
      const provider = models.find((option) => option.id === model)?.provider;
      await api.sessions.setModel(session.id, model, provider);
    } catch {
      setCurrentModel(previous);
      setModelError("The model could not be changed. Your current model is unchanged.");
    }
  };

  const branch = gitSnapshot?.currentBranch || space.branch || "Checking branch…";
  const changedCount = gitSnapshot?.files.length;
  const runState = getRunState(chat);

  return (
    <main className="main-content">
      <header className="workspace-chrome">
        <div className="top-bar">
          {!sidebarOpen && <button className="top-bar-menu-btn icon-btn" onClick={onToggleSidebar} aria-label="Open worktree navigation"><MenuIcon /></button>}
          <div className="top-bar-title session-identity">
            <span className="session-worktree-line"><b>{space.repo_name}</b><i aria-hidden="true">/</i><code>{branch}</code></span>
            <span className="session-title-name">{session.title}</span>
          </div>
          <span className={`session-run-state is-${runState.tone}`} role="status">{runState.label}</span>
          <button className={`review-button ${gitOpen ? "active" : ""}`} type="button" onClick={onToggleGit} aria-expanded={gitOpen} aria-controls="git-review-panel">
            <span>Review</span>
            {typeof changedCount === "number" && changedCount > 0 && <b>{changedCount}</b>}
            {gitError && <i aria-label="Git status unavailable">!</i>}
          </button>
          <div className="session-menu-wrap" ref={menuRef}>
            <button className="icon-btn" type="button" onClick={() => setMenuOpen((open) => !open)} aria-label="Session menu" aria-expanded={menuOpen} aria-haspopup="menu">•••</button>
            {menuOpen && (
              <div className="session-command-menu" role="menu">
                <label>Model<select value={currentModel} onChange={(event) => handleModelChange(event.target.value)}>{models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label>
                {terminalControl === "shown" && <button type="button" role="menuitem" onClick={() => { setMode(mode === "terminal" ? "chat" : "terminal"); setMenuOpen(false); }}>{mode === "terminal" ? "Return to chat" : "Open terminal"}<kbd>⌘⇧T</kbd></button>}
                {terminalControl === "disabled" && <button type="button" role="menuitem" disabled>{effectiveTerminalCapability === "checking" ? "Checking terminal availability…" : "Terminal availability unavailable"}</button>}
                <button type="button" role="menuitem" onClick={() => { onOpenSettings(); setMenuOpen(false); }}>Worktree settings</button>
              </div>
            )}
          </div>
        </div>
        {modelError && <div className="workspace-notice" role="alert"><span>{modelError}</span><button onClick={() => setModelError("")} aria-label="Dismiss model error">×</button></div>}
        {mode === "terminal" && <div className="session-mode-bar"><strong>Terminal</strong><span>Self-hosted worktree shell</span><button type="button" onClick={() => setMode("chat")}>Return to chat</button></div>}
      </header>

      <div className="session-area">
        {mode === "chat" && <ChatTab key={session.id} session={session} />}
        {mode === "terminal" && (
          <Suspense fallback={<StateSurface title="Loading terminal" description="Preparing the interactive terminal interface." busy />}>
            <TerminalTab key={session.id} session={session} onRequestExit={() => setMode("chat")} onUnsupported={() => { setTerminalDenied(true); setMode("chat"); }} />
          </Suspense>
        )}
      </div>
    </main>
  );
}

function getRunState(chat: ReturnType<typeof store.useSessionChat>) {
  if (chat.connection === "disconnected") return { label: "Disconnected", tone: "error" };
  if (chat.connection === "reconnecting") return { label: "Reconnecting…", tone: "attention" };
  if (chat.connection === "connecting") return { label: "Connecting…", tone: "quiet" };
  if (chat.activeStatus === "sending") return { label: "Sending…", tone: "quiet" };
  if (chat.activeStatus === "starting") return { label: "Starting…", tone: "active" };
  if (chat.activeStatus === "running" || chat.streaming) return { label: chat.status || "Agent working", tone: "active" };
  if (chat.queuedCount > 0) return { label: "Queued", tone: "attention" };
  return { label: "Ready", tone: "quiet" };
}

function MenuIcon() {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18" /></svg>;
}
