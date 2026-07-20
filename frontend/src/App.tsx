import { useState, useEffect, useCallback, useMemo } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "./context/AuthContext";
import { LandingPage } from "./pages/LandingPage";
import { Sidebar } from "./components/Sidebar";
import { SessionView } from "./components/SessionView";
import { SpaceSettings } from "./components/SpaceSettings";
import { AdminPanel } from "./components/AdminPanel";
import { OrgSettings } from "./components/OrgSettings";
import { GitSidebar } from "./components/GitSidebar";
import { AppMainState } from "./components/AppMainState";
import { AccountSettings } from "./components/AccountSettings";
import { RedirectOutcome } from "./components/RedirectOutcome";
import { StateSurface } from "./components/StateSurface";
import { LoginPage } from "./pages/LoginPage";
import { api } from "./api/client";
import * as store from "./lib/sessionStore";
import { slugWithId, parseSlugSegment } from "./lib/slugs";
import type { Space, Session, Org } from "./types";
function getAuthHeaders(): Record<string, string> {
  const devToken = localStorage.getItem("waynode-dev-token");
  return devToken ? { "x-dev-token": devToken } : {};
}
export function AppContent() {
  const { user, availableProviders, terminalCapability, loading, error: authError, retry: retryAuth, logout } = useAuth();
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [orgsLoading, setOrgsLoading] = useState(true);
  const [spacesLoading, setSpacesLoading] = useState(true);
  const { spaceSeg, sessionSeg } = useParams<{ spaceSeg?: string; sessionSeg?: string }>();
  const urlSpaceShort = parseSlugSegment(spaceSeg);
  const urlSessionShort = parseSlugSegment(sessionSeg);
  const navigate = useNavigate();
  const location = useLocation();
  const sidebarOpenInitial = useMemo(() => window.innerWidth >= 768, []);
  const [sidebarOpen, setSidebarOpen] = useState(sidebarOpenInitial);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [orgSettingsOpen, setOrgSettingsOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false);
  const [gitSidebarOpen, setGitSidebarOpen] = useState(false);
  const [githubConnected, setGithubConnected] = useState(false);
  const [gitlabConnected, setGitlabConnected] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [onboardingError, setOnboardingError] = useState("");
  const [onboardingCloning, setOnboardingCloning] = useState(false);
  const [workspaceError, setWorkspaceError] = useState("");
  useEffect(() => {
    if (!user) {
      setOrgs([]);
      setSpaces([]);
      setSessions([]);
      setActiveOrgId(null);
      setOrgsLoading(true);
      return;
    }
    setOrgsLoading(true);
      const pendingInvite = localStorage.getItem("waynode-pending-invite");
      if (pendingInvite) {
        localStorage.removeItem("waynode-pending-invite");
        navigate(`/invite/${pendingInvite}`);
        return;
      }
      fetch("/api/repos/status", { headers: getAuthHeaders(), credentials: "include" })
        .then((r) => r.json())
        .then((d) => { setGithubConnected(d.github); setGitlabConnected(d.gitlab); })
        .catch(() => {});
      fetch("/api/auth/me", { headers: getAuthHeaders(), credentials: "include" })
        .then((r) => r.json())
        .then((d) => { if (d.user?.role === "admin") setIsAdmin(true); })
        .catch(() => {});
      fetch("/api/orgs", { headers: getAuthHeaders(), credentials: "include" })
        .then(async (r) => { if (!r.ok) throw new Error("Waynode couldn’t load your organizations."); return r.json(); })
        .then((data: Org[]) => {
          setOrgs(data);
          setWorkspaceError("");
          if (data.length > 0 && !activeOrgId) setActiveOrgId(data[0].id);
        })
        .catch((error) => setWorkspaceError(error instanceof Error ? error.message : "Could not load organizations."))
        .finally(() => setOrgsLoading(false));
  }, [user]);
  const loadSpaces = useCallback(async () => {
    if (!activeOrgId) return;
    setSpacesLoading(true);
    try {
      const res = await fetch(`/api/spaces?orgId=${activeOrgId}`, { headers: getAuthHeaders(), credentials: "include" });
      if (!res.ok) throw new Error("Waynode couldn’t load this organization’s worktrees.");
      const data = await res.json();
      setSpaces(data);
      setWorkspaceError("");
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "Could not load worktrees.");
    } finally {
      setSpacesLoading(false);
    }
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
    const space = spaceArg || spaces.find((s) => s.id === session.space_id);
    const spacePart = space ? slugWithId(space.repo_name, space.id) : session.space_id;
    navigate(`/${spacePart}/${slugWithId(session.title || "session", session.id)}`);
    if (window.innerWidth < 768) setSidebarOpen(false);
  };

  const handleSessionCreated = (session: Session) => {
    setSessions((prev) => prev.some((s) => s.id === session.id) ? prev : [...prev, session]);
  };

  const handleSessionArchived = (session: Session) => {
    // Upsert: when unarchiving, the session may not be in the loaded list
    // (e.g. it was only visible via "Show archived" or loaded in a different
    // space view). Insert it so it appears immediately without a full reload.
    setSessions((prev) =>
      prev.some((s) => s.id === session.id)
        ? prev.map((s) => (s.id === session.id ? session : s))
        : [...prev, session]
    );
  };

  const handleSessionDeleted = (sessionId: string) => {
    setSessions((prev) => prev.filter((s) => s.id !== sessionId));
  };

  const handleOnboardingClone = async (repoUrl: string, branch: string) => {
    if (!activeOrgId) {
      setOnboardingError("Your organization is still loading. Please try again in a moment.");
      return;
    }
    setOnboardingCloning(true);
    setOnboardingError("");
    try {
      const space = await api.spaces.create(repoUrl, branch, undefined, undefined, activeOrgId);
      setSpaces((previous) => previous.some((item) => item.id === space.id) ? previous : [...previous, space]);
      const session = await api.sessions.create(space.id, { title: "First task" });
      handleSessionCreated(session);
      handleSelectSession(session, space);

      const PROG = "clone-progress";
      store.injectProgress(session.id, PROG, `Cloning \`${repoUrl}\` from branch \`${branch || "main"}\`…`);
      const es = api.spaces.cloneStream(space.id);
      es.onmessage = (ev) => {
        try {
          const m = JSON.parse(ev.data);
          if (m.type === "progress") store.injectProgress(session.id, PROG, `Cloning… ${m.line}`);
          else if (m.type === "done") { store.injectProgress(session.id, PROG, `Cloned \`${space.repo_name}\`. The worktree is ready.`); es.close(); }
          else if (m.type === "error") { store.injectProgress(session.id, PROG, `✗ Clone failed: ${m.error || "unknown error"}`); es.close(); }
        } catch {
          store.injectProgress(session.id, PROG, "Clone progress could not be read. The clone may still be running.");
          es.close();
        }
      };
      es.onerror = () => {
        store.injectProgress(session.id, PROG, "Clone progress disconnected. The clone may still be running; refresh the worktree before retrying.");
        es.close();
      };
    } catch (error) {
      setOnboardingError(error instanceof Error ? error.message : "Could not create that worktree.");
      throw error;
    } finally {
      setOnboardingCloning(false);
    }
  };

  useEffect(() => {
    if (!user) return;
    return store.onRename((sessionId, title) => {
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, title } : s))
      );
    });
  }, [user]);

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
    const spaceKnown = spaces.some((s) => parseSlugSegment(slugWithId(s.repo_name, s.id)) === urlSpaceShort);
    const sessionKnown = !urlSessionShort || sessions.some((s) => parseSlugSegment(slugWithId(s.title || "session", s.id)) === urlSessionShort);
    if (spaceKnown && sessionKnown) { setResolvedSpace(null); setResolvedSession(null); return; }

    let cancelled = false;
    api.resolve(urlSpaceShort, urlSessionShort || undefined)
      .then(({ space, session, spaceSlug, sessionSlug }) => {
        if (cancelled) return;
        setResolvedSpace(space);
        setResolvedSession(session);
        setSpaces((prev) => prev.some((s) => s.id === space.id) ? prev : [...prev, space]);
        if (session) setSessions((prev) => prev.some((s) => s.id === session.id) ? prev : [...prev, session]);
        const wantSession = sessionSlug && urlSessionShort;
        if ((spaceSeg && spaceSeg !== spaceSlug) || (wantSession && sessionSeg !== sessionSlug)) {
          navigate(`/${spaceSlug}${wantSession ? `/${sessionSlug}` : ""}`, { replace: true });
        }
      })
      .catch(() => { if (!cancelled) { setResolvedSpace(null); setResolvedSession(null); setWorkspaceError("Could not open this worktree or session. It may have moved, or you may no longer have access."); } });
    return () => { cancelled = true; };
  }, [user, urlSpaceShort, urlSessionShort, spaceSeg, sessionSeg, spaces, sessions, navigate]);

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
    } catch (error) {
      throw error;
    }
  };

  const handleToggleSidebar = () => setSidebarOpen((v) => !v);

  const activeOrg = orgs.find((o) => o.id === activeOrgId);

  const retryWorkspace = () => { setWorkspaceError(""); if (activeOrgId) loadSpaces(); else window.location.reload(); };
  const workspaceNotice = workspaceError && spaces.length > 0 ? <div className="workspace-error" role="alert"><span>Couldn’t refresh Waynode</span><p>{workspaceError}</p><button type="button" onClick={retryWorkspace}>Retry</button></div> : null;

  if (loading) {
    return <StateSurface title="Checking your session" description="Loading your organizations and worktrees." busy />;
  }

  if (authError) return <StateSurface
    title="Couldn’t reach Waynode"
    description={`${authError} No worktree or session data was changed.`}
    tone="error"
    action={{ label: "Try again", onClick: retryAuth }}
  />;

  if (!user) return <>
    <RedirectOutcome />
    {location.pathname === "/login" ? <LoginPage /> : <LandingPage />}
  </>;

  if (orgsLoading) return <StateSurface title="Loading Waynode" description="Fetching your organizations and worktrees." busy />;

  const outcomeNotice = <RedirectOutcome
    canManageBilling={activeOrg?.my_role === "admin"}
    onOpenBilling={() => setOrgSettingsOpen(true)}
  />;

  if (adminOpen && isAdmin) {
    return <>
      {outcomeNotice}
      <div className="app-layout">
        <AdminPanel onClose={() => setAdminOpen(false)} />
      </div>
    </>;
  }

  if (orgSettingsOpen && activeOrg) {
    return <>
      {outcomeNotice}
      <div className="app-layout">
        <OrgSettings
          org={activeOrg}
          onClose={() => setOrgSettingsOpen(false)}
          onRenamed={(updated) => setOrgs((prev) => prev.map((o) => (o.id === updated.id ? { ...o, ...updated } : o)))}
          onDeleted={(deleted) => {
            setOrgs((prev) => prev.filter((o) => o.id !== deleted.id));
            setActiveOrgId((prev) => (prev === deleted.id ? null : prev));
            setOrgSettingsOpen(false);
          }}
        />
      </div>
    </>;
  }

  if (accountSettingsOpen) {
    return <>
      {outcomeNotice}
      <div className="app-layout">
        <AccountSettings
          onClose={() => setAccountSettingsOpen(false)}
          onDeleted={() => { setAccountSettingsOpen(false); logout(); navigate("/"); }}
        />
      </div>
    </>;
  }


  return <>
    {outcomeNotice}
    <div className={`app-layout ${sidebarOpen ? "sidebar-open" : ""}`}>
      {workspaceNotice}
      <div className="sidebar-overlay" onClick={handleToggleSidebar} />
      <Sidebar
        spaces={spaces}
        spacesLoading={spacesLoading}
        sessions={sessions}
        activeSessionId={activeSession?.id || null}
        activeSpaceId={activeSpaceId}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={handleToggleSidebar}
        onSelectSession={handleSelectSession}
        onSpaceCreated={(space) => { setSpaces((prev) => prev.some((s) => s.id === space.id) ? prev : [...prev, space]); refreshRepoStatus(); }}
        onSessionCreated={handleSessionCreated}
        onSessionArchived={handleSessionArchived}
        onSessionDeleted={handleSessionDeleted}
        onSpaceExpand={handleSpaceExpand}
        githubConnected={githubConnected}
        gitlabConnected={gitlabConnected}
        githubAvailable={availableProviders.github}
        gitlabAvailable={availableProviders.gitlab}
        isAdmin={isAdmin}
        onOpenAdmin={() => setAdminOpen(true)}
        onOpenOrgSettings={() => setOrgSettingsOpen(true)}
        onOpenAccountSettings={() => setAccountSettingsOpen(true)}
        user={user}
        onLogout={logout}
        orgs={orgs}
        activeOrgId={activeOrgId}
        onSelectOrg={(id) => { setActiveOrgId(id); setSessions([]); navigate("/"); }}
        onOrgCreated={(org) => setOrgs((prev) => [...prev, org])}
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
            terminalCapability={terminalCapability}
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
              <button className="top-bar-menu-btn icon-btn" onClick={handleToggleSidebar} aria-label="Open worktree navigation"><MenuIcon /></button>
              {isAdmin && <button className="tab-btn" onClick={() => setAdminOpen(true)}>Admin</button>}
            </div>
          )}
          <AppMainState
            spacesCount={spaces.length} spacesLoading={spacesLoading} workspaceError={workspaceError}
            activeOrgId={activeOrgId} activeOrg={activeOrg} sidebarOpen={sidebarOpen}
            githubConnected={githubConnected} gitlabConnected={gitlabConnected}
            cloning={onboardingCloning} onboardingError={onboardingError}
            onToggleSidebar={handleToggleSidebar} onClone={handleOnboardingClone} onRetry={retryWorkspace}
          />
        </div>
      )}
    </div>
  </>;
}

function MenuIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg>;
}
