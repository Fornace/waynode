import { useState } from "react";
import type { Space, Session, Org } from "../types";
import { api } from "../api/client";
import { RepoPicker } from "./RepoPicker";

interface SidebarProps {
  spaces: Space[];
  sessions: Session[];
  activeSessionId: string | null;
  activeSpaceId: string | null;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onSelectSession: (session: Session) => void;
  onSpaceCreated: () => void;
  onSessionCreated: (session: Session) => void;
  onSpaceExpand: (spaceId: string) => void;
  githubConnected: boolean;
  gitlabConnected: boolean;
  isAdmin: boolean;
  onOpenAdmin: () => void;
  onOpenOrgSettings: () => void;
  orgs: Org[];
  activeOrgId: string | null;
  onSelectOrg: (orgId: string) => void;
  user: { name: string; avatar_url: string | null } | null;
}

export function Sidebar({
  spaces, sessions, activeSessionId, activeSpaceId,
  onToggleSidebar, onSelectSession, onSpaceCreated, onSessionCreated, onSpaceExpand,
  githubConnected, gitlabConnected, isAdmin, onOpenAdmin, onOpenOrgSettings,
  orgs, activeOrgId, onSelectOrg, user,
}: SidebarProps) {
  const [expandedSpaces, setExpandedSpaces] = useState<Set<string>>(new Set());
  const [showPicker, setShowPicker] = useState(false);
  const [showOrgSwitcher, setShowOrgSwitcher] = useState(false);
  const [error, setError] = useState("");

  const toggleSpace = (spaceId: string) => {
    setExpandedSpaces((prev) => {
      const next = new Set(prev);
      if (next.has(spaceId)) next.delete(spaceId);
      else { next.add(spaceId); onSpaceExpand(spaceId); }
      return next;
    });
  };

  const handleClone = async (repoUrl: string, branch: string, authUser?: string, authToken?: string) => {
    try {
      await api.spaces.create(repoUrl, branch, authUser, authToken, activeOrgId || undefined);
      onSpaceCreated();
    } catch (err) {
      setError((err as Error).message);
      throw err;
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

  const activeOrg = orgs.find((o) => o.id === activeOrgId);

  return (
    <>
      <div className="sidebar">
        <div className="sidebar-header">
          <div style={{ flex: 1, position: "relative" }}>
            <button
              style={{ fontWeight: 700, fontSize: 15, display: "flex", alignItems: "center", gap: 6, width: "100%" }}
              onClick={() => setShowOrgSwitcher(!showOrgSwitcher)}
            >
              <span>{activeOrg?.name || "Waynode"}</span>
              <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{orgs.length > 1 ? "▾" : ""}</span>
            </button>
            {showOrgSwitcher && orgs.length > 1 && (
              <div className="send-dropdown" style={{ position: "absolute", top: "100%", left: 0, marginTop: 4 }}>
                {orgs.map((org) => (
                  <button
                    key={org.id}
                    className="send-dropdown-item"
                    style={org.id === activeOrgId ? { color: "var(--accent)" } : {}}
                    onClick={() => { onSelectOrg(org.id); setShowOrgSwitcher(false); }}
                  >
                    <div>{org.name}</div>
                    {org.space_count !== undefined && <div className="item-desc">{org.space_count} spaces</div>}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className="sidebar-collapse-btn" onClick={onToggleSidebar}>✕</button>
        </div>

        <div className="sidebar-content">
          <div className="new-space-btn" onClick={() => setShowPicker(true)}>
            + Clone Repository
          </div>

          {orgs.length > 0 && (
            <div className="new-space-btn" style={{ marginTop: 4 }} onClick={onOpenOrgSettings}>
              ⚙ Org Settings
            </div>
          )}

          {spaces.length === 0 && (
            <div style={{ padding: "20px 8px", textAlign: "center", color: "var(--text-faint)", fontSize: 12 }}>
              No spaces yet. Clone a repo to get started.
            </div>
          )}

          {spaces.map((space) => {
            const expanded = expandedSpaces.has(space.id);
            const spaceSessions = sessions.filter((s) => s.space_id === space.id);
            return (
              <div key={space.id} className="space-group">
                <div
                  className={`space-item ${activeSpaceId === space.id ? "active" : ""}`}
                  onClick={() => toggleSpace(space.id)}
                >
                  <span className={`space-chevron ${expanded ? "expanded" : ""}`}>▶</span>
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {space.repo_name}
                  </span>
                  {space.session_count ? (
                    <span style={{ fontSize: 10, color: "var(--text-faint)" }}>{space.session_count}</span>
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
                        {session.title}
                      </div>
                    ))}
                    <div className="new-session-btn" onClick={() => handleNewSession(space.id)}>
                      + New Session
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {user && (
          <div className="sidebar-footer">
            {user.avatar_url && <img className="user-avatar" src={user.avatar_url} alt="" />}
            <span className="user-name">{user.name}</span>
            {isAdmin && (
              <button onClick={onOpenAdmin} style={{ fontSize: 14, padding: "2px 6px" }} title="Admin">⚙</button>
            )}
          </div>
        )}
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
