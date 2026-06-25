import { useState, useEffect, useCallback, useMemo } from "react";
import { useParams, useNavigate, Routes, Route } from "react-router-dom";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { LoginPage } from "./pages/LoginPage";
import { Sidebar } from "./components/Sidebar";
import { SessionView } from "./components/SessionView";
import { SpaceSettings } from "./components/SpaceSettings";
import { AdminPanel } from "./components/AdminPanel";
import { OrgSettings } from "./components/OrgSettings";
import { GitSidebar } from "./components/GitSidebar";
import { api } from "./api/client";
import * as store from "./lib/sessionStore";
import { slugWithId, parseSlugSegment } from "./lib/slugs";
import type { Space, Session, Org } from "./types";

function getAuthHeaders(): Record<string, string> {
  const devToken = localStorage.getItem("waynode-dev-token");
  return devToken ? { "x-dev-token": devToken } : {};
}

function AppContent() {
  const { user, loading } = useAuth();
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  // Pretty URLs: "/<spaceSlug>-<shortId>/<sessionSlug>-<shortId>".
  // The short id (last 8 hex) is authoritative; the slug is cosmetic.
  const { spaceSeg, sessionSeg } = useParams<{ spaceSeg?: string; sessionSeg?: string }>();
  const urlSpaceShort = parseSlugSegment(spaceSeg);
  const urlSessionShort = parseSlugSegment(sessionSeg);
  const navigate = useNavigate();
  const sidebarOpenInitial = useMemo(() => window.innerWidth >= 768, []);
  const [sidebarOpen, setSidebarOpen] = useState(sidebarOpenInitial);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [orgSettingsOpen, setOrgSettingsOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [gitSidebarOpen, setGitSidebarOpen] = useState(false);
  const [githubConnected, setGithubConnected] = useState(false);
  const [gitlabConnected, setGitlabConnected] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    if (user) {
      fetch("/api/repos/status", { headers: getAuthHeaders(), credentials: "include" })
        .then((r) => r.json())
        .then((d) => { setGithubConnected(d.github); setGitlabConnected(d.gitlab); })
        .catch(() => {});
      fetch("/api/auth/me", { headers: getAuthHeaders(), credentials: "include" })
        .then((r) => r.json())
        .then((d) => { if (d.user?.role === "admin") setIsAdmin(true); })
        .catch(() => {});
      fetch("/api/orgs", { headers: getAuthHeaders(), credentials: "include" })
        .then((r) => r.json())
        .then((data: Org[]) => {
          setOrgs(data);
          if (data.length > 0 && !activeOrgId) setActiveOrgId(data[0].id);
        })
        .catch(() => {});
    }
  }, [user]);

  const loadSpaces = useCallback(async () => {
    if (!activeOrgId) return;
    try {
      const res = await fetch(`/api/spaces?orgId=${activeOrgId}`, { headers: getAuthHeaders(), credentials: "include" });
      const data = await res.json();
      setSpaces(data);
    } catch {}
  }, [activeOrgId]);

  useEffect(() => {
    if (user && activeOrgId) loadSpaces();
  }, [user, activeOrgId, loadSpaces]);

  const refreshRepoStatus = () => {
    fetch("/api/repos/status", { headers: getAuthHeaders(), credentials: "include" })
      .then((r) => r.json())
      .then((d) => { setGithubConnected(d.github); setGitlabConnected(d.gitlab); })
      .catch(() => {});
  };

  const handleSelectSession = (session: Session, spaceArg?: Space) => {
    // Prefer the explicitly-passed space (avoids stale-closure lookups when the
    // space was just created and isn't in `spaces` yet — e.g. right after clone).
    const space = spaceArg || spaces.find((s) => s.id === session.space_id);
    const spacePart = space ? slugWithId(space.repo_name, space.id) : session.space_id;
    navigate(`/${spacePart}/${slugWithId(session.title || "session", session.id)}`);
    if (window.innerWidth < 768) setSidebarOpen(false);
  };

  const handleSessionCreated = (session: Session) => {
    setSessions((prev) => prev.some((s) => s.id === session.id) ? prev : [...prev, session]);
  };

  // ── Auto-generated session titles arrive over the live stream. ──
  useEffect(() => {
    if (!user) return;
    return store.onRename((sessionId, title) => {
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, title } : s))
      );
    });
  }, [user]);

  // ── Resolve the active space/session from the pretty URL. ──
  // 1. Match against already-loaded lists by short id (cheap, no fetch).
  // 2. Otherwise hit /api/resolve for deep links; also rewrites stale slugs.
  const [resolvedSpace, setResolvedSpace] = useState<Space | null>(null);
  const [resolvedSession, setResolvedSession] = useState<Session | null>(null);

  const activeSpace = useMemo(() => {
    if (!urlSpaceShort) return null;
    return (
      spaces.find((s) => parseSlugSegment(slugWithId(s.repo_name, s.id)) === urlSpaceShort) ||
      (resolvedSpace && parseSlugSegment(slugWithId(resolvedSpace.repo_name, resolvedSpace.id)) === urlSpaceShort ? resolvedSpace : null)
    );
  }, [urlSpaceShort, spaces, resolvedSpace]);

  const activeSession = useMemo(() => {
    if (!urlSessionShort) return null;
    return (
      sessions.find((s) => parseSlugSegment(slugWithId(s.title || "session", s.id)) === urlSessionShort) ||
      (resolvedSession && parseSlugSegment(slugWithId(resolvedSession.title || "session", resolvedSession.id)) === urlSessionShort ? resolvedSession : null)
    );
  }, [urlSessionShort, sessions, resolvedSession]);

  const activeSpaceId = activeSpace?.id ?? activeSession?.space_id ?? null;

  useEffect(() => {
    if (!user || !urlSpaceShort) { setResolvedSpace(null); setResolvedSession(null); return; }
    // Already resolvable from loaded data — no fetch needed.
    const spaceKnown = spaces.some((s) => parseSlugSegment(slugWithId(s.repo_name, s.id)) === urlSpaceShort);
    const sessionKnown = !urlSessionShort || sessions.some((s) => parseSlugSegment(slugWithId(s.title || "session", s.id)) === urlSessionShort);
    if (spaceKnown && sessionKnown) { setResolvedSpace(null); setResolvedSession(null); return; }

    let cancelled = false;
    api.resolve(urlSpaceShort, urlSessionShort || undefined)
      .then(({ space, session, spaceSlug, sessionSlug }) => {
        if (cancelled) return;
        setResolvedSpace(space);
        setResolvedSession(session);
        // Inject into the loaded lists so downstream components see them.
        setSpaces((prev) => prev.some((s) => s.id === space.id) ? prev : [...prev, space]);
        if (session) setSessions((prev) => prev.some((s) => s.id === session.id) ? prev : [...prev, session]);
        // Rewrite a stale/mismatched slug silently (replace, not push).
        const wantSession = sessionSlug && urlSessionShort;
        if ((spaceSeg && spaceSeg !== spaceSlug) || (wantSession && sessionSeg !== sessionSlug)) {
          navigate(`/${spaceSlug}${wantSession ? `/${sessionSlug}` : ""}`, { replace: true });
        }
      })
      .catch(() => { if (!cancelled) { setResolvedSpace(null); setResolvedSession(null); } });
    return () => { cancelled = true; };
  }, [user, urlSpaceShort, urlSessionShort, spaceSeg, sessionSeg, spaces, sessions, navigate]);

  // ── Keep the URL slug fresh when the active session/space gets renamed ──
  // (e.g. the AI auto-generates a title mid-conversation). The resolver matches
  // on the ID suffix so a stale slug still works; this just keeps it pretty.
  useEffect(() => {
    if (!activeSession || !urlSessionShort) return;
    const canonical = slugWithId(activeSession.title || "session", activeSession.id);
    const canonicalShort = parseSlugSegment(canonical);
    if (canonicalShort !== urlSessionShort || sessionSeg !== canonical) {
      const spaceCanonical = activeSpace
        ? slugWithId(activeSpace.repo_name, activeSpace.id)
        : activeSession.space_id;
      navigate(`/${spaceCanonical}/${canonical}`, { replace: true });
    }
  }, [activeSession, activeSpace, urlSessionShort, sessionSeg, navigate]);

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

  const activeOrg = orgs.find((o) => o.id === activeOrgId);

  if (loading) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">⏳</div>
        <div>Loading...</div>
      </div>
    );
  }

  if (!user) return <LoginPage />;

  if (adminOpen && isAdmin) {
    return (
      <div className="app-layout">
        <AdminPanel onClose={() => setAdminOpen(false)} />
      </div>
    );
  }

  if (orgSettingsOpen && activeOrg) {
    return (
      <div className="app-layout">
        <OrgSettings org={activeOrg} onClose={() => setOrgSettingsOpen(false)} />
      </div>
    );
  }


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
        onSpaceCreated={(space) => { setSpaces((prev) => prev.some((s) => s.id === space.id) ? prev : [...prev, space]); refreshRepoStatus(); }}
        onSessionCreated={handleSessionCreated}
        onSpaceExpand={handleSpaceExpand}
        githubConnected={githubConnected}
        gitlabConnected={gitlabConnected}
        isAdmin={isAdmin}
        onOpenAdmin={() => setAdminOpen(true)}
        onOpenOrgSettings={() => setOrgSettingsOpen(true)}
        user={user}
        orgs={orgs}
        activeOrgId={activeOrgId}
        onSelectOrg={(id) => { setActiveOrgId(id); setSessions([]); navigate("/"); }}
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
            gitOpen={gitSidebarOpen}
            onToggleGit={() => setGitSidebarOpen((v) => !v)}
          />
          {settingsOpen && (
            <SpaceSettings space={activeSpace} onClose={() => setSettingsOpen(false)} />
          )}
          <GitSidebar space={activeSpace} sessionId={activeSession.id} open={gitSidebarOpen} onClose={() => setGitSidebarOpen(false)} />
        </>
      ) : (
        <div className="main-content">
          {!sidebarOpen && (
            <div className="top-bar">
              <button className="top-bar-menu-btn" onClick={handleToggleSidebar}>☰</button>
              {isAdmin && <button className="tab-btn" onClick={() => setAdminOpen(true)}>Admin</button>}
            </div>
          )}
          <div className="empty-state">
            <div className="empty-state-icon">🚀</div>
            <div className="empty-state-title">{activeOrg ? activeOrg.name : "Waynode AI"}</div>
            <div className="empty-state-desc">Clone a repository and create a session to get started</div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/" element={<AppContent />} />
        <Route path="/:spaceSeg" element={<AppContent />} />
        <Route path="/:spaceSeg/:sessionSeg" element={<AppContent />} />
      </Routes>
    </AuthProvider>
  );
}
