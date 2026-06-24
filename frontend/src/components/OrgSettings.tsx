import { useState, useEffect } from "react";
import type { Org } from "../types";
import { useEscapeToClose } from "../hooks/useEscapeToClose";

interface OrgSettingsProps {
  org: Org;
  onClose: () => void;
}

function getAuthHeaders(): Record<string, string> {
  const devToken = localStorage.getItem("waynode-dev-token");
  return devToken ? { "x-dev-token": devToken } : {};
}

export function OrgSettings({ org, onClose }: OrgSettingsProps) {
  // Esc returns from this full-page settings pane (no overlay/focus trap;
  // it's a pane, not a modal).
  useEscapeToClose(onClose);
  const [tab, setTab] = useState<"general" | "integrations" | "members">("general");
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [members, setMembers] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch(`/api/orgs/${org.id}/settings`, { headers: getAuthHeaders(), credentials: "include" }).then(r => r.json()),
      fetch(`/api/orgs/${org.id}/members`, { headers: getAuthHeaders(), credentials: "include" }).then(r => r.json()),
    ]).then(([s, m]) => {
      setSettings(s);
      setMembers(m);
    });
  }, [org.id]);

  const save = async () => {
    setSaving(true);
    await fetch(`/api/orgs/${org.id}/settings`, {
      method: "PATCH",
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
    setSaving(false);
    setDirty(false);
  };

  const updateMemberRole = async (userId: string, role: string) => {
    await fetch(`/api/orgs/${org.id}/members/${userId}`, {
      method: "PATCH",
      headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    setMembers(prev => prev.map(m => m.id === userId ? { ...m, role } : m));
  };

  const removeMember = async (userId: string) => {
    if (!confirm("Remove this member from the org?")) return;
    await fetch(`/api/orgs/${org.id}/members/${userId}`, { method: "DELETE", headers: getAuthHeaders() });
    setMembers(prev => prev.filter(m => m.id !== userId));
  };

  return (
    <div style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column" }}>
      <div className="admin-header">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{org.name}</div>
            <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 4 }}>Org Settings · {org.slug}</div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {dirty && (
              <button className="btn-primary" onClick={save} disabled={saving}>
                {saving ? "Saving..." : "Save Changes"}
              </button>
            )}
            <button className="btn-secondary" onClick={onClose}>← Back</button>
          </div>
        </div>
        <div className="tabs" style={{ marginTop: 12 }}>
          <button className={`tab-btn ${tab === "general" ? "active" : ""}`} onClick={() => setTab("general")}>General</button>
          <button className={`tab-btn ${tab === "integrations" ? "active" : ""}`} onClick={() => setTab("integrations")}>Integrations</button>
          <button className={`tab-btn ${tab === "members" ? "active" : ""}`} onClick={() => setTab("members")}>Members</button>
        </div>
      </div>

      <div style={{ padding: 20, maxWidth: 600 }}>
        {tab === "general" && (
          <div className="repo-url-form">
            <div className="form-field">
              <label className="form-label">Org Name</label>
              <input className="form-input" value={settings.name || org.name} onChange={(e) => { setSettings({ ...settings, name: e.target.value }); setDirty(true); }} />
            </div>
            <div className="form-field">
              <label className="form-label">Default Model</label>
              <select className="form-input" value={settings.default_model || "fornace-fast"} onChange={(e) => { setSettings({ ...settings, default_model: e.target.value }); setDirty(true); }}>
                <option value="fornace-fast">Fornace Fast</option>
                <option value="fornace-reasoning">Fornace Reasoning</option>
                <option value="fornace-max">Fornace Max</option>
                <option value="glm-5.2-fast">GLM 5.2 Fast</option>
                <option value="glm-5.2-reasoning">GLM 5.2 Reasoning</option>
                <option value="qwen-flash">Qwen Flash</option>
              </select>
            </div>
          </div>
        )}

        {tab === "integrations" && (
          <div className="repo-url-form">
            <div className="form-field">
              <label className="form-label">Obsidian CouchDB Remote URL</label>
              <input className="form-input" placeholder="http://couchdb:5984/obsidian-org" value={settings.obsidian_url || ""} onChange={(e) => { setSettings({ ...settings, obsidian_url: e.target.value }); setDirty(true); }} />
            </div>
            <div className="form-field">
              <label className="form-label">Honcho Server URL</label>
              <input className="form-input" placeholder="http://honcho:7432" value={settings.honcho_url || ""} onChange={(e) => { setSettings({ ...settings, honcho_url: e.target.value }); setDirty(true); }} />
            </div>
            <div className="form-field">
              <label className="form-label">Honcho Workspace</label>
              <input className="form-input" placeholder="default" value={settings.honcho_workspace || ""} onChange={(e) => { setSettings({ ...settings, honcho_workspace: e.target.value }); setDirty(true); }} />
            </div>
            <div style={{ fontSize: 12, color: "var(--text-faint)", marginTop: 12, lineHeight: 1.5 }}>
              These settings are scoped to this org. Spaces and sessions within this org will use these integrations.
              Pi can be instructed to install additional tools in its working directory.
            </div>
          </div>
        )}

        {tab === "members" && (
          <table className="admin-table">
            <thead>
              <tr><th>Member</th><th>Role</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {members.map(m => (
                <tr key={m.id}>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      {m.avatar_url && <img src={m.avatar_url} alt="" style={{ width: 20, height: 20, borderRadius: "50%" }} />}
                      <div>
                        <div style={{ fontWeight: 500 }}>{m.name}</div>
                        {m.email && <div style={{ fontSize: 11, color: "var(--text-faint)" }}>{m.email}</div>}
                      </div>
                    </div>
                  </td>
                  <td><span className={`role-badge ${m.role}`}>{m.role}</span></td>
                  <td>
                    <div className="admin-actions">
                      <select className="model-select" value={m.role} onChange={(e) => updateMemberRole(m.id, e.target.value)}>
                        <option value="admin">admin</option>
                        <option value="editor">editor</option>
                        <option value="viewer">viewer</option>
                      </select>
                      <button className="admin-action-btn danger" onClick={() => removeMember(m.id)}>Remove</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
