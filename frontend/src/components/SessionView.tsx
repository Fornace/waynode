import { Suspense, lazy, useState, useEffect, useRef } from "react";
import type { Session, Space } from "../types";
import { ChatTab } from "./ChatTab";

const TerminalTab = lazy(() => import("./TerminalTab"));

interface SessionViewProps {
  session: Session;
  space: Space;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onOpenSettings: () => void;
}

type Tab = "chat" | "terminal";

export function SessionView({ session, space, sidebarOpen, onToggleSidebar, onOpenSettings }: SessionViewProps) {
  const [activeTab, setActiveTab] = useState<Tab>("chat");

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
        <button className="tab-btn" onClick={onOpenSettings} title="Space settings">⚙</button>
        <div className="tabs">
          <button
            className={`tab-btn ${activeTab === "chat" ? "active" : ""}`}
            onClick={() => setActiveTab("chat")}
          >
            Chat
          </button>
          <button
            className={`tab-btn ${activeTab === "terminal" ? "active" : ""}`}
            onClick={() => setActiveTab("terminal")}
          >
            Terminal
          </button>
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
