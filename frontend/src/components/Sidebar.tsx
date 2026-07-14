import { useState } from "react";
import type { Space, Session, Org, GitSnapshot } from "../types";
import { api } from "../api/client";
import * as store from "../lib/sessionStore";
import { RepoPicker } from "./RepoPicker";
import { OrgSwitcher, SessionMenu, UserMenu } from "./SidebarMenus";
import { ConfirmDialog } from "./ConfirmDialog";

interface SidebarProps {
  spaces: Space[];
  spacesLoading: boolean;
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
  onSpaceExpand: (spaceId: string) => Promise<void>;
  githubConnected: boolean;
  gitlabConnected: boolean;
  githubAvailable: boolean;
  gitlabAvailable: boolean;
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
  spaces, spacesLoading, sessions, activeSessionId, activeSpaceId,
  onToggleSidebar, onSelectSession, onSpaceCreated, onSessionCreated, onSessionArchived, onSessionDeleted, onSpaceExpand,
  githubConnected, gitlabConnected, githubAvailable, gitlabAvailable, isAdmin, onOpenAdmin, onOpenOrgSettings, onOpenAccountSettings,
  orgs, activeOrgId, onSelectOrg, onOrgCreated, user, onLogout,
}: SidebarProps) {
  const [expandedSpaces, setExpandedSpaces] = useState<Set<string>>(new Set());
  const [showPicker, setShowPicker] = useState(false);
  const [issue, setIssue] = useState<{ message: string; retry?: () => void } | null>(null);

  // Lazily-fetched, per-space git status — only populated when a space is
  // expanded (or refreshed after a git action), never polled globally.
  const [gitStatus, setGitStatus] = useState<Record<string, GitSnapshot>>({});
  // Archived sessions per space, fetched on demand when "Show archived" is toggled.
  const [archivedBySpace, setArchivedBySpace] = useState<Record<string, Session[]>>({});
  const [showArchivedFor, setShowArchivedFor] = useState<Set<string>>(new Set());
  const [openMenuFor, setOpenMenuFor] = useState<string | null>(null);
  const [busySessionId, setBusySessionId] = useState<string | null>(null);
  const [loadingSessionSpaces, setLoadingSessionSpaces] = useState<Set<string>>(new Set());
  const [confirmingLogout, setConfirmingLogout] = useState(false);

  const refreshGitStatus = (spaceId: string): void => {
    api.git.status(spaceId).then((snap) => {
      setGitStatus((prev) => ({ ...prev, [spaceId]: snap }));
    }).catch(() => setIssue({ message: "Waynode couldn’t check this worktree’s Git status. Existing changes are unchanged.", retry: () => refreshGitStatus(spaceId) }));
  };

  const loadSpaceSessions = (spaceId: string): void => {
    setLoadingSessionSpaces((previous) => new Set(previous).add(spaceId));
    onSpaceExpand(spaceId)
      .catch(() => setIssue({ message: "Sessions for this worktree couldn’t be loaded.", retry: () => loadSpaceSessions(spaceId) }))
      .finally(() => setLoadingSessionSpaces((previous) => { const next = new Set(previous); next.delete(spaceId); return next; }));
  };

  const toggleSpace = (spaceId: string) => {
    const expanding = !expandedSpaces.has(spaceId);
    setExpandedSpaces((previous) => {
      const next = new Set(previous);
      if (expanding) next.add(spaceId); else next.delete(spaceId);
      return next;
    });
    if (!expanding) return;
    loadSpaceSessions(spaceId);
    refreshGitStatus(spaceId);
  };

  const loadArchived = (spaceId: string): void => {
    api.sessions.list(spaceId, { includeArchived: true }).then((all) => {
      const archived = all.filter((s) => !!s.archived);
      setArchivedBySpace((prev) => ({ ...prev, [spaceId]: archived }));
    }).catch(() => setIssue({ message: "Archived sessions couldn’t be loaded.", retry: () => loadArchived(spaceId) }));
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
      setIssue({ message: (err as Error).message, retry: () => handleArchive(session, archived) });
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
      setIssue({ message: (err as Error).message, retry: () => handleDelete(session) });
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
      setIssue({ message: `The safety commit failed, so the session was not ${action === "archive" ? "archived" : "deleted"}: ${(err as Error).message}`, retry: () => handleMergeAnd(session, action) });
      setBusySessionId(null);
      return;
    }
    if (action === "archive") await handleArchive(session, true);
    else await handleDelete(session);
  };

  const handleClone = async (repoUrl: string, branch: string, authUser?: string, authToken?: string) => {
    const space = await api.spaces.create(repoUrl, branch, authUser, authToken, activeOrgId || undefined);
    onSpaceCreated(space);

    // Land the user in a fresh session immediately and stream the clone progress
    // into its chat as a single updating system message (the clone is now running
    // in the background server-side).
    try {
      const session = await api.sessions.create(space.id, { title: "Clone" });
      onSessionCreated(session);
      onSelectSession(session, space);

      const PROG = "clone-progress";
      store.injectProgress(session.id, PROG, `Cloning \`${repoUrl}\` from branch \`${branch || "main"}\`…`);
      const es = api.spaces.cloneStream(space.id);
      es.onmessage = (ev) => {
        try {
          const m = JSON.parse(ev.data);
          if (m.type === "progress") {
            // git clone progress lines can be noisy; show the latest meaningful one.
            store.injectProgress(session.id, PROG, `Cloning… ${m.line}`);
          } else if (m.type === "done") {
            store.injectProgress(session.id, PROG, `Cloned \`${space.repo_name}\`. The worktree is ready.`);
            es.close();
          } else if (m.type === "error") {
            store.injectProgress(session.id, PROG, `✗ Clone failed: ${m.error || "unknown error"}`);
            es.close();
          }
        } catch {
          store.injectProgress(session.id, PROG, "Clone progress could not be read. The clone may still be running.");
          es.close();
        }
      };
      es.onerror = () => {
        store.injectProgress(session.id, PROG, "Clone progress disconnected. The clone may still be running; refresh the worktree before retrying.");
        es.close();
      };
    } catch (err) {
      // Session/nav failed but the space cloned fine — surface the error.
      setIssue({ message: `The worktree was created, but its first session could not be opened: ${(err as Error).message}` });
    }
  };

  const handleNewSession = async (spaceId: string): Promise<void> => {
    try {
      const session = await api.sessions.create(spaceId);
      onSessionCreated(session);
      onSelectSession(session);
    } catch (err) {
      setIssue({ message: (err as Error).message, retry: () => handleNewSession(spaceId) });
    }
  };

  const handleCreateOrg = async (name: string) => {
    try {
      const org = await api.orgs.create(name);
      onOrgCreated(org);
      onSelectOrg(org.id);
    } catch (err) {
      setIssue({ message: (err as Error).message });
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
            New worktree
          </button>

          {orgs.length > 0 && (
            <button type="button" className="new-space-btn sidebar-settings-btn" onClick={onOpenOrgSettings}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
              Organization settings
            </button>
          )}

          <div style={{ height: 12 }} />

          {spacesLoading ? <div className="sidebar-empty" role="status">Loading worktrees…</div> : spaces.length === 0 && (
            <div className="sidebar-empty">No worktrees yet. Use New worktree to clone a repository.</div>
          )}

          {spaces.map((space) => {
            const expanded = expandedSpaces.has(space.id);
            const spaceSessions = sessions.filter((s) => s.space_id === space.id && !s.archived);
            const uncommittedCount = gitStatus[space.id]?.files.length || 0;
            const archivedSessions = archivedBySpace[space.id] || [];
            const showingArchived = showArchivedFor.has(space.id);
            return (
              <div key={space.id} className="space-group">
                <button type="button"
                  className={`space-item ${activeSpaceId === space.id ? "active" : ""}`}
                  onClick={() => toggleSpace(space.id)}
                  aria-expanded={expanded}
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
                </button>
                {expanded && (
                  <div className="space-sessions">
                    {loadingSessionSpaces.has(space.id) && <div className="sidebar-session-state" role="status">Loading sessions…</div>}
                    {spaceSessions.map((session) => (
                      <div
                        key={session.id}
                        className={`session-item ${activeSessionId === session.id ? "active" : ""}`}
                      >
                        <button
                          type="button"
                          className="session-item-open"
                          onClick={() => onSelectSession(session)}
                          aria-current={activeSessionId === session.id ? "page" : undefined}
                          title={session.title}
                        >
                          <span className="session-item-title">{session.title}</span>
                        </button>
                        <button
                          className="session-menu-btn"
                          onClick={(e) => { e.stopPropagation(); setOpenMenuFor(openMenuFor === session.id ? null : session.id); }}
                          disabled={busySessionId === session.id}
                          title="Session actions"
                          aria-label={`Actions for ${session.title}`}
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
                    <button type="button" className="new-session-btn" onClick={() => handleNewSession(space.id)}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                      New Session
                    </button>
                    {archivedSessions.length > 0 && (
                      <button type="button" className="archived-toggle" onClick={() => toggleShowArchived(space.id)} aria-expanded={showingArchived}>
                        {showingArchived ? "Hide archived" : `Show archived (${archivedSessions.length})`}
                      </button>
                    )}
                    {showingArchived && archivedSessions.map((session) => (
                      <div key={session.id} className="session-item archived">
                        <span className="session-item-title">{session.title}</span>
                        <button
                          className="session-unarchive-btn"
                          onClick={() => handleArchive(session, false)}
                          disabled={busySessionId === session.id}
                          aria-label={`Unarchive ${session.title}`}
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

        {issue && !showPicker && <div className="sidebar-issue" role="alert">
          <p>{issue.message}</p>
          <div className="sidebar-issue-actions">
            {issue.retry && <button type="button" onClick={() => { const retry = issue.retry; setIssue(null); retry?.(); }}>Try again</button>}
            <button type="button" onClick={() => setIssue(null)}>Dismiss</button>
          </div>
        </div>}

        {user && <UserMenu user={user} isAdmin={isAdmin} onOpenAdmin={onOpenAdmin} onOpenAccountSettings={onOpenAccountSettings} onLogout={() => setConfirmingLogout(true)} />}
      </div>

      {showPicker && (
        <RepoPicker
          onClose={() => setShowPicker(false)}
          onClone={handleClone}
          githubConnected={githubConnected}
          gitlabConnected={gitlabConnected}
          githubAvailable={githubAvailable}
          gitlabAvailable={gitlabAvailable}
        />
      )}

      {confirmingLogout && <ConfirmDialog
        title="Log out of Waynode?"
        description="Your worktrees and running agent sessions stay on this server. You can sign in again to resume them."
        confirmLabel="Log out"
        onCancel={() => setConfirmingLogout(false)}
        onConfirm={() => { setConfirmingLogout(false); onLogout(); }}
      />}

    </>
  );
}
