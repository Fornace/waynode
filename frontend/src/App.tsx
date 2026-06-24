import { useState, useEffect, useCallback } from "react";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { LoginPage } from "./pages/LoginPage";
import { Sidebar } from "./components/Sidebar";
import { SessionView } from "./components/SessionView";
import { SpaceSettings } from "./components/SpaceSettings";
import { AdminPanel } from "./components/AdminPanel";
import { api } from "./api/client";
import type { Space, Session } from "./types";

function getAuthHeaders(): Record<string, string> {
  const devToken = localStorage.getItem("waynode-dev-token");
  return devToken ? { "x-dev-token": devToken } : {};
}

function AppContent() {
  const { user, loading } = useAuth();
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [activeSpaceId, setActiveSpaceId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(window.innerWidth >= 768);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [githubConnected, setGithubConnected] = useState(false);
  const [gitlabConnected, setGitlabConnected] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    if (user) {
      fetch("/api/repos/status", { headers: getAuthHeaders() })
        .then((r) => r.json())
        .then((d) => {
          setGithubConnected(d.github);
          setGitlabConnected(d.gitlab);
        })
        .catch(() => {});
      fetch("/api/auth/me", { headers: getAuthHeaders() })
        .then((r) => r.json())
        .then((d) => {
          if (d.user?.role === "admin") setIsAdmin(true);
        })
        .catch(() => {});
    }
  }, [user]);

  const refreshRepoStatus = () => {
    fetch("/api/repos/status", { headers: getAuthHeaders() })
      .then((r) => r.json())
      .then((d) => {
        setGithubConnected(d.github);
        setGitlabConnected(d.gitlab);
      })
      .catch(() => {});
  };

  const loadSpaces = useCallback(async () => {
    try {
      const data = await api.spaces.list();
      setSpaces(data);
    } catch {}
  }, []);

  useEffect(() => {
    if (user) loadSpaces();
  }, [user, loadSpaces]);

  const handleSelectSession = async (session: Session) => {
    setActiveSession(session);
    setActiveSpaceId(session.space_id);
    if (window.innerWidth < 768) setSidebarOpen(false);
  };

  const handleSessionCreated = (session: Session) => {
    setSessions((prev) =>
      prev.some((s) => s.id === session.id) ? prev : [...prev, session]
    );
  };

  const handleSpaceCreated = () => {
    loadSpaces();
  };

  const handleSpaceExpand = async (spaceId: string) => {
    const alreadyLoaded = sessions.some((s) => s.space_id === spaceId);
    if (alreadyLoaded) return;
    try {
      const spaceSessions = await api.sessions.list(spaceId);
      setSessions((prev) => {
        const existingIds = new Set(prev.map((s) => s.id));
        return [...prev, ...spaceSessions.filter((s) => !existingIds.has(s.id))];
      });
    } catch {}
  };

  const handleToggleSidebar = () => setSidebarOpen((v) => !v);

  if (loading) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">⏳</div>
        <div>Loading...</div>
      </div>
    );
  }

  if (!user) {
    return <LoginPage />;
  }

  if (adminOpen && isAdmin) {
    return (
      <div className="app-layout">
        <AdminPanel onClose={() => setAdminOpen(false)} />
      </div>
    );
  }

  const activeSpace = spaces.find((s) => s.id === activeSpaceId);

  return (
    <div className={`app-layout ${sidebarOpen ? "sidebar-open" : ""}`}>
      <div className="sidebar-overlay" onClick={handleToggleSidebar} />
      <Sidebar
        spaces={spaces}
        sessions={sessions}
        activeSessionId={activeSession?.id || null}
        activeSpaceId={activeSpaceId}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={handleToggleSidebar}
        onSelectSession={handleSelectSession}
        onSpaceCreated={() => { loadSpaces(); refreshRepoStatus(); }}
        onSessionCreated={handleSessionCreated}
        onSpaceExpand={handleSpaceExpand}
        githubConnected={githubConnected}
        gitlabConnected={gitlabConnected}
        isAdmin={isAdmin}
        onOpenAdmin={() => setAdminOpen(true)}
        user={user}
      />
      {activeSession && activeSpace ? (
        <>
          <SessionView
            session={activeSession}
            space={activeSpace}
            sidebarOpen={sidebarOpen}
            onToggleSidebar={handleToggleSidebar}
            onOpenSettings={() => setSettingsOpen(true)}
            isAdmin={isAdmin}
          />
          {settingsOpen && (
            <SpaceSettings space={activeSpace} onClose={() => setSettingsOpen(false)} />
          )}
        </>
      ) : (
        <div className="main-content">
          {!sidebarOpen && (
            <div className="top-bar">
              <button className="top-bar-menu-btn" onClick={handleToggleSidebar}>
                ☰
              </button>
              {isAdmin && (
                <button className="tab-btn" onClick={() => setAdminOpen(true)}>Admin</button>
              )}
            </div>
          )}
          <div className="empty-state">
            <div className="empty-state-icon">🚀</div>
            <div className="empty-state-title">Welcome to Waynode AI</div>
            <div className="empty-state-desc">
              Clone a repository and create a session to get started
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}
