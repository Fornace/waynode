import { useState } from "react";
import type { Space, Session, Org, GitSnapshot } from "../types";
import { api } from "../api/client";
import * as store from "../lib/sessionStore";
import { RepoPicker } from "./RepoPicker";
import { OrgSwitcher, SessionMenu, UserMenu } from "./SidebarMenus";

interface SidebarProps {
  spaces: Space[];
  sessions: Session[];
  activeSessionId: string | null;
  activeSpaceId: string | null;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onSelectSession: (session: Session, space?: Space) => void;
  onSpaceCreated: (space: Space) => void;
  onSessionCreated: (session: Session) => void;
  onSessionArchived: (session: Session) => void;
  onSessionDeleted: (sessionId: string) => void;
  onSpaceExpand: (spaceId: string) => void;
  githubConnected: boolean;
  gitlabConnected: boolean;
  isAdmin: boolean;
  onOpenAdmin: () => void;
  onOpenOrgSettings: () => void;
  onOpenAccountSettings: () => void;
  orgs: Org[];
  activeOrgId: string | null;
  onSelectOrg: (orgId: string) => void;
  onOrgCreated: (org: Org) => void;
  user: { name: string; email: string | null; avatar_url: string | null } | null;
  onLogout: () => void;
}

export function Sidebar({
  spaces, sessions, activeSessionId, activeSpaceId,
  onToggleSidebar, onSelectSession, onSpaceCreated, onSessionCreated, onSessionArchived, onSessionDeleted, onSpaceExpand,
  githubConnected, gitlabConnected, isAdmin, onOpenAdmin, onOpenOrgSettings, onOpenAccountSettings,
  orgs, activeOrgId, onSelectOrg, onOrgCreated, user, onLogout,
}: SidebarProps) {
  const [expandedSpaces, setExpandedSpaces] = useState<Set<string>>(new Set());
  const [showPicker, setShowPicker] = useState(false);
  const [error, setError] = useState("");

  // Lazily-fetched, per-space git status — only populated when a space is
  // expanded (or refreshed after a git action), never polled globally.
  const [gitStatus, setGitStatus] = useState<Record<string, GitSnapshot>>({});
  // Archived sessions per space, fetched on demand when "Show archived" is toggled.
  const [archivedBySpace, setArchivedBySpace] = useState<Record<string, Session[]>>({});
  const [showArchivedFor, setShowArchivedFor] = useState<Set<string>>(new Set());
  const [openMenuFor, setOpenMenuFor] = useState<string | null>(null);
  const [busySessionId, setBusySessionId] = useState<string | null>(null);

  const refreshGitStatus = (spaceId: string) => {
    api.git.status(spaceId).then((snap) => {
      setGitStatus((prev) => ({ ...prev, [spaceId]: snap }));
    }).catch(() => {});
  };

  const toggleSpace = (spaceId: string) => {
    setExpandedSpaces((prev) => {
      const next = new Set(prev);
      if (next.has(spaceId)) {
        next.delete(spaceId);
      } else {
        next.add(spaceId);
        onSpaceExpand(spaceId);
        refreshGitStatus(spaceId);
      }
      return next;
    });
  };

  const loadArchived = (spaceId: string) => {
    api.sessions.list(spaceId, { includeArchived: true }).then((all) => {
      const archived = all.filter((s) => !!s.archived);
      setArchivedBySpace((prev) => ({ ...prev, [spaceId]: archived }));
    }).catch(() => {});
  };

  const toggleShowArchived = (spaceId: string) => {
    setShowArchivedFor((prev) => {
      const next = new Set(prev);
      if (next.has(spaceId)) next.delete(spaceId);
      else { next.add(spaceId); loadArchived(spaceId); }
      return next;
    });
  };

  // sessions share one working tree per space; "merge" here means safety-committing
  // any uncommitted work in that shared tree before the session is archived/deleted —
  // there is no per-session git branch to merge.
  const ensureCommitted = async (spaceId: string, session: Session) => {
    const snap = await api.git.status(spaceId);
    if (!snap.hasUncommittedChanges || snap.files.length === 0) return;
    await api.git.commit(spaceId, {
      files: snap.files.map((f) => f.path),
      summary: `Auto-commit before closing session: ${session.title}`,
    });
  };

  const handleArchive = async (session: Session, archived: boolean) => {
    setBusySessionId(session.id);
    setOpenMenuFor(null);
    try {
      const updated = await api.sessions.archive(session.id, archived);
      onSessionArchived(updated);
      loadArchived(session.space_id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusySessionId(null);
    }
  };

  const handleDelete = async (session: Session) => {
    if (!confirm(`Delete session "${session.title}"? This cannot be undone.`)) return;
    setBusySessionId(session.id);
    setOpenMenuFor(null);
    try {
      await api.sessions.delete(session.id);
      onSessionDeleted(session.id);
      setArchivedBySpace((prev) => ({
        ...prev,
        [session.space_id]: (prev[session.space_id] || []).filter((s) => s.id !== session.id),
      }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusySessionId(null);
    }
  };

  const handleMergeAnd = async (session: Session, action: "archive" | "delete") => {
    setBusySessionId(session.id);
    setOpenMenuFor(null);
    try {
      await ensureCommitted(session.space_id, session);
      refreshGitStatus(session.space_id);
    } catch (err) {
      setError(`Auto-commit failed, ${action} cancelled: ${(err as Error).message}`);
      setBusySessionId(null);
      return;
    }
    if (action === "archive") await handleArchive(session, true);
    else await handleDelete(session);
  };

  const handleClone = async (repoUrl: string, branch: string, authUser?: string, authToken?: string) => {
    let space;
    try {
      space = await api.spaces.create(repoUrl, branch, authUser, authToken, activeOrgId || undefined);
    } catch (err) {
      setError((err as Error).message);
      throw err;
    }
    onSpaceCreated(space);

    // Land the user in a fresh session immediately and stream the clone progress
    // into its chat as a single updating system message (the clone is now running
    // in the background server-side).
    try {
      const session = await api.sessions.create(space.id, { title: "Clone" });
      onSessionCreated(session);
      onSelectSession(session, space);

      const PROG = "clone-progress";
      store.injectProgress(session.id, PROG, `📦 Cloning \`${repoUrl}\` (branch \`${branch || "main"}\`)…`);
      const es = api.spaces.cloneStream(space.id);
      let lastLine = "";
      es.onmessage = (ev) => {
        try {
          const m = JSON.parse(ev.data);
          if (m.type === "progress") {
            // git clone progress lines can be noisy; show the latest meaningful one.
            lastLine = m.line;
            store.injectProgress(session.id, PROG, `📦 Cloning… ${m.line}`);
          } else if (m.type === "done") {
            store.injectProgress(session.id, PROG, `✅ Cloned \`${space.repo_name}\` — ready to go.`);
            es.close();
          } else if (m.type === "error") {
            store.injectProgress(session.id, PROG, `✗ Clone failed: ${m.error || "unknown error"}`);
            es.close();
          }
        } catch {}
      };
      es.onerror = () => store.injectProgress(session.id, PROG, `✗ Lost clone progress stream.`);
    } catch (err) {
      // Session/nav failed but the space cloned fine — surface the error.
      setError((err as Error).message);
    }
  };

  const handleNewSession = async (spaceId: string) => {
    try {
      const session = await api.sessions.create(spaceId);
      onSessionCreated(session);
      onSelectSession(session);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleCreateOrg = async (name: string) => {
    try {
      const org = await api.orgs.create(name);
      onOrgCreated(org);
      onSelectOrg(org.id);
    } catch (err) {
      setError((err as Error).message);
      throw err;
    }
  };

  return (
    <>
      <div className="sidebar">
        <OrgSwitcher orgs={orgs} activeOrgId={activeOrgId} onSelect={onSelectOrg} onCreate={handleCreateOrg} onToggleSidebar={onToggleSidebar} />

        <div className="sidebar-content">
          <button type="button" className="new-space-btn" onClick={() => setShowPicker(true)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
            Clone Repository
          </button>

          {orgs.length > 0 && (
            <button type="button" className="new-space-btn sidebar-settings-btn" onClick={onOpenOrgSettings}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
              Org Settings
            </button>
          )}

          <div style={{ height: 12 }} />

          {spaces.length === 0 && (
            <div style={{ padding: "20px 8px", textAlign: "center", color: "var(--text-faint)", fontSize: 12 }}>
              No spaces yet. Clone a repo to get started.
            </div>
          )}

          {spaces.map((space) => {
            const expanded = expandedSpaces.has(space.id);
            const spaceSessions = sessions.filter((s) => s.space_id === space.id && !s.archived);
            const uncommittedCount = gitStatus[space.id]?.files.length || 0;
            const archivedSessions = archivedBySpace[space.id] || [];
            const showingArchived = showArchivedFor.has(space.id);
            return (
              <div key={space.id} className="space-group">
                <div
                  className={`space-item ${activeSpaceId === space.id ? "active" : ""}`}
                  onClick={() => toggleSpace(space.id)}
                >
                  <span className={`space-chevron ${expanded ? "expanded" : ""}`}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6"/></svg>
                  </span>
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {space.repo_name}
                  </span>
                  {uncommittedCount > 0 && (
                    <span className="space-git-badge" title={`${uncommittedCount} uncommitted file${uncommittedCount === 1 ? "" : "s"}`}>
                      {uncommittedCount} changed
                    </span>
                  )}
                  {space.session_count ? (
                    <span style={{ fontSize: 10, color: "var(--text-faint)", background: "var(--bg-elevated)", padding: "1px 6px", borderRadius: "10px" }}>{space.session_count}</span>
                  ) : null}
                </div>
                {expanded && (
                  <div className="space-sessions">
                    {spaceSessions.map((session) => (
                      <div
                        key={session.id}
                        className={`session-item ${activeSessionId === session.id ? "active" : ""}`}
                        onClick={() => onSelectSession(session)}
                      >
                        <span className="session-item-title">{session.title}</span>
                        <button
                          className="session-menu-btn"
                          onClick={(e) => { e.stopPropagation(); setOpenMenuFor(openMenuFor === session.id ? null : session.id); }}
                          disabled={busySessionId === session.id}
                          title="Session actions"
                        >
                          {busySessionId === session.id ? "…" : "⋯"}
                        </button>
                        {openMenuFor === session.id && (
                          <SessionMenu
                            onClose={() => setOpenMenuFor(null)}
                            items={[
                              { label: "Archive", onClick: () => handleArchive(session, true) },
                              { label: "Merge & Archive", onClick: () => handleMergeAnd(session, "archive") },
                              { label: "Merge & Delete", onClick: () => handleMergeAnd(session, "delete") },
                              { label: "Delete", danger: true, onClick: () => handleDelete(session) },
                            ]}
                          />
                        )}
                      </div>
                    ))}
                    <div className="new-session-btn" onClick={() => handleNewSession(space.id)}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                      New Session
                    </div>
                    {archivedSessions.length > 0 && (
                      <div className="archived-toggle" onClick={() => toggleShowArchived(space.id)}>
                        {showingArchived ? "Hide archived" : `Show archived (${archivedSessions.length})`}
                      </div>
                    )}
                    {showingArchived && archivedSessions.map((session) => (
                      <div key={session.id} className="session-item archived">
                        <span className="session-item-title">{session.title}</span>
                        <button
                          className="session-unarchive-btn"
                          onClick={() => handleArchive(session, false)}
                          disabled={busySessionId === session.id}
                        >
                          {busySessionId === session.id ? "…" : "Unarchive"}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {user && <UserMenu user={user} isAdmin={isAdmin} onOpenAdmin={onOpenAdmin} onOpenAccountSettings={onOpenAccountSettings} onLogout={onLogout} />}
      </div>

      {showPicker && (
        <RepoPicker
          onClose={() => setShowPicker(false)}
          onClone={handleClone}
          githubConnected={githubConnected}
          gitlabConnected={gitlabConnected}
        />
      )}

      {error && !showPicker && (
        <div style={{ position: "fixed", bottom: 16, right: 16, background: "var(--red)", color: "#fff", padding: "8px 16px", borderRadius: 8, fontSize: 12, zIndex: 1000 }}>
          {error}
          <button onClick={() => setError("")} style={{ marginLeft: 8, opacity: 0.7 }}>✕</button>
        </div>
      )}
    </>
  );
}
