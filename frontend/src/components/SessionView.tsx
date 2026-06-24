import { Suspense, lazy, useState, useEffect } from "react";
import type { Session, Space } from "../types";
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
}

type Tab = "chat" | "terminal";

export function SessionView({ session, space, sidebarOpen, onToggleSidebar, onOpenSettings, isAdmin }: SessionViewProps) {
  const [activeTab, setActiveTab] = useState<Tab>("chat");
  const [models, setModels] = useState<{ id: string; name: string }[]>([]);
  const [currentModel, setCurrentModel] = useState(session.model || "");

  useEffect(() => {
    fetch("/api/models", { credentials: "include" }).then(r => r.json()).then(d => setModels(d.models || [])).catch(() => {});
  }, []);

  const handleModelChange = async (model: string) => {
    setCurrentModel(model);
    try {
      await api.sessions.patch(session.id, { model } as any);
    } catch {}
  };

  return (
    <div className="main-content">
      <div className="top-bar">
        {!sidebarOpen && (
          <button className="top-bar-menu-btn" onClick={onToggleSidebar}>
            ☰
          </button>
        )}
        <div className="top-bar-title">
          {space.repo_name} / {session.title}
        </div>
        <select className="model-select" value={currentModel} onChange={(e) => handleModelChange(e.target.value)}>
          {models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <button className="tab-btn" onClick={onOpenSettings} title="Space settings">⚙</button>
        <div className="tabs">
          <button className={`tab-btn ${activeTab === "chat" ? "active" : ""}`} onClick={() => setActiveTab("chat")}>Chat</button>
          <button className={`tab-btn ${activeTab === "terminal" ? "active" : ""}`} onClick={() => setActiveTab("terminal")}>Terminal</button>
        </div>
      </div>

      <div className="session-area">
        {activeTab === "chat" && <ChatTab key={session.id} session={session} />}
        {activeTab === "terminal" && (
          <Suspense fallback={<div className="empty-state">Loading terminal...</div>}>
            <TerminalTab key={session.id} session={session} />
          </Suspense>
        )}
      </div>
    </div>
  );
}
