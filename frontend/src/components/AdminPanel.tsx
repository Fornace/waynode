import { useState, useEffect } from "react";
import { api } from "../api/client";
import { useEscapeToClose } from "../hooks/useEscapeToClose";

interface AdminUser {
  id: string;
  name: string;
  email: string | null;
  avatar_url: string | null;
  role: string;
  github_id: number | null;
  gitlab_id: number | null;
  created_at: string;
  space_count: number;
  session_count: number;
}

interface AdminPanelProps {
  onClose: () => void;
}

function getAuthHeaders(): Record<string, string> {
  const devToken = localStorage.getItem("waynode-dev-token");
  return devToken ? { "x-dev-token": devToken } : {};
}

export function AdminPanel({ onClose }: AdminPanelProps) {
  // Esc returns from this full-page admin pane.
  useEscapeToClose(onClose);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [stats, setStats] = useState({ users: 0, spaces: 0, sessions: 0, messages: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch("/api/admin/users", { headers: getAuthHeaders(), credentials: "include" }).then(r => r.json()),
      fetch("/api/admin/stats", { headers: getAuthHeaders(), credentials: "include" }).then(r => r.json()),
    ]).then(([u, s]) => {
      setUsers(u);
      setStats(s);
    }).finally(() => setLoading(false));
  }, []);

  const updateRole = async (id: string, role: string) => {
    await fetch(`/api/admin/users/${id}`, {
      method: "PATCH",
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    setUsers(prev => prev.map(u => u.id === id ? { ...u, role } : u));
  };

  const deleteUser = async (id: string) => {
    if (!confirm("Delete this user and all their data?")) return;
    await fetch(`/api/admin/users/${id}`, { method: "DELETE", headers: getAuthHeaders() });
    setUsers(prev => prev.filter(u => u.id !== id));
  };

  if (loading) return <div className="empty-state">Loading admin...</div>;

  return (
    <div style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column" }}>
      <div className="admin-header">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>Admin Panel</div>
            <div style={{ display: "flex", gap: 20, marginTop: 8 }}>
              <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{stats.users} users</span>
              <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{stats.spaces} spaces</span>
              <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{stats.sessions} sessions</span>
              <span style={{ fontSize: 12, color: "var(--text-dim)" }}>{stats.messages} messages</span>
            </div>
          </div>
          <button className="btn-secondary" onClick={onClose}>← Back</button>
        </div>
      </div>

      <table className="admin-table">
        <thead>
          <tr>
            <th>User</th>
            <th>Role</th>
            <th>Spaces</th>
            <th>Sessions</th>
            <th>Joined</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map(u => (
            <tr key={u.id}>
              <td>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {u.avatar_url && <img src={u.avatar_url} alt="" style={{ width: 20, height: 20, borderRadius: "50%" }} />}
                  <div>
                    <div style={{ fontWeight: 500 }}>{u.name}</div>
                    {u.email && <div style={{ fontSize: 11, color: "var(--text-faint)" }}>{u.email}</div>}
                  </div>
                </div>
              </td>
              <td>
                <span className={`role-badge ${u.role}`}>{u.role}</span>
              </td>
              <td>{u.space_count}</td>
              <td>{u.session_count}</td>
              <td style={{ fontSize: 11, color: "var(--text-faint)" }}>{u.created_at}</td>
              <td>
                <div className="admin-actions">
                  <select
                    className="model-select"
                    aria-label={`Role for ${u.name}`}
                    value={u.role}
                    onChange={(e) => updateRole(u.id, e.target.value)}
                  >
                    <option value="admin">admin</option>
                    <option value="user">user</option>
                    <option value="disabled">disabled</option>
                  </select>
                  <button
                    className="admin-action-btn danger"
                    onClick={() => deleteUser(u.id)}
                  >
                    Delete
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
