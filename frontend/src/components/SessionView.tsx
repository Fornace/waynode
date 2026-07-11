import { Suspense, lazy, useState, useEffect } from "react";
import type { Session, Space, GitSnapshot } from "../types";
import { ChatTab } from "./ChatTab";
import { api } from "../api/client";

const TerminalTab = lazy(() => import("./TerminalTab"));

interface SessionViewProps {
  session: Session;
  space: Space;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onOpenSettings: () => void;
  isAdmin: boolean;
  gitOpen?: boolean;
  onToggleGit?: () => void;
}

type Tab = "chat" | "terminal";

export function SessionView({ session, space, sidebarOpen, onToggleSidebar, onOpenSettings, isAdmin, gitOpen, onToggleGit }: SessionViewProps) {
  const [activeTab, setActiveTab] = useState<Tab>("chat");
  const [models, setModels] = useState<{ id: string; name: string }[]>([]);
  const [currentModel, setCurrentModel] = useState(session.model || "");
  const [gitSnapshot, setGitSnapshot] = useState<GitSnapshot | null>(null);

  // Global shortcut (Layer 3): Ctrl/Cmd+Shift+T toggles Chat <-> Terminal when
  // no input or modal is focused. Reserved chord per docs/KEYBOARD-CONTRACT.md.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const isMod = event.ctrlKey || event.metaKey;
      if (!(isMod && event.shiftKey && (event.key === "T" || event.key === "t"))) return;
      const target = event.target as HTMLElement | null;
      // If the user is typing in the terminal, the terminal's own handler owns
      // this chord (it has focus). Only handle it here when focus is NOT in an
      // input/textarea or the xterm terminal container.
      const tag = target?.tagName;
      const inInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      const inTerminal = target?.closest(".terminal-container");
      if (inInput || inTerminal) return;
      event.preventDefault();
      setActiveTab((prev) => (prev === "chat" ? "terminal" : "chat"));
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    fetch("/api/models", { credentials: "include" }).then(r => r.json()).then(d => setModels(d.models || [])).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.git.status(space.id).then((snapshot) => {
      if (!cancelled) setGitSnapshot(snapshot);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [space.id, session.id]);

  const handleModelChange = async (model: string) => {
    const prev = currentModel;
    setCurrentModel(model); // optimistic — reverts below if the live agent rejects it
    try {
      await api.sessions.setModel(session.id, model);
    } catch (err) {
      setCurrentModel(prev);
      console.error("[model] switch failed:", (err as Error).message);
    }
  };

  return (
    <div className="main-content">
      <div className="workspace-chrome">
      <div className="top-bar">
        {!sidebarOpen && (
          <button className="top-bar-menu-btn icon-btn" onClick={onToggleSidebar}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>
          </button>
        )}
        <div className="top-bar-title session-identity">
          <span className="session-repo-name">{space.repo_name}</span>
          <span className="session-title-name">{session.title}</span>
        </div>
        
        {/* Modern Model Selector */}
        <div style={{ position: "relative" }}>
          <select className="model-select" value={currentModel} onChange={(e) => handleModelChange(e.target.value)}>
            {models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <div style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", pointerEvents: "none", color: "var(--text-dim)" }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6"/></svg>
          </div>
        </div>

        <button className="icon-btn" onClick={onOpenSettings} title="Space settings">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
        </button>
      </div>
      <button className={`workspace-context ${gitOpen ? "active" : ""}`} onClick={onToggleGit} title="Open Git worktree">
        <span className="workspace-context-icon">⌘</span>
        <b>{gitSnapshot?.currentBranch || "Git worktree"}</b>
        <small>{gitSnapshot ? `${gitSnapshot.files.length} changed` : "Checking status…"}</small>
        <span className={`workspace-sync ${gitSnapshot && gitSnapshot.ahead === 0 && gitSnapshot.behind === 0 ? "synced" : ""}`}>
          {gitSnapshot && gitSnapshot.ahead === 0 && gitSnapshot.behind === 0 ? "● Synced" : gitSnapshot ? `↑${gitSnapshot.ahead} ↓${gitSnapshot.behind}` : ""}
        </span>
      </button>
      <div className="workspace-tabs" role="tablist" aria-label="Workspace views">
        <button className={activeTab === "chat" ? "active" : ""} onClick={() => setActiveTab("chat")}>Chat</button>
        <button className={gitOpen ? "active" : ""} onClick={onToggleGit}>Git {gitSnapshot && gitSnapshot.files.length > 0 ? gitSnapshot.files.length : ""}</button>
        <button className={activeTab === "terminal" ? "active" : ""} onClick={() => setActiveTab("terminal")}>Terminal</button>
      </div>
      </div>

      <div className="session-area">
        {activeTab === "chat" && <ChatTab key={session.id} session={session} />}
        {activeTab === "terminal" && (
          <Suspense fallback={<div className="empty-state">Loading terminal...</div>}>
            <TerminalTab key={session.id} session={session} onRequestExit={() => setActiveTab("chat")} />
          </Suspense>
        )}
      </div>
    </div>
  );
}
