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

const MODEL_OPTIONS = [
  { id: "fornace-fast", name: "Fornace Fast" },
  { id: "fornace-reasoning", name: "Fornace Reasoning" },
  { id: "fornace-max", name: "Fornace Max" },
  { id: "glm-5.2-fast", name: "GLM 5.2 Fast" },
  { id: "glm-5.2-reasoning", name: "GLM 5.2 Reasoning" },
  { id: "qwen-flash", name: "Qwen Flash" },
];

export function OrgSettings({ org, onClose }: OrgSettingsProps) {
  // Esc returns from this full-page settings pane (no overlay/focus trap;
  // it's a pane, not a modal).
  useEscapeToClose(onClose);
  const [tab, setTab] = useState<"general" | "integrations" | "members">("general");
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [baseline, setBaseline] = useState<Record<string, string>>({});
  const [members, setMembers] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch(`/api/orgs/${org.id}/settings`, { headers: getAuthHeaders(), credentials: "include" }).then(r => r.json()),
      fetch(`/api/orgs/${org.id}/members`, { headers: getAuthHeaders(), credentials: "include" }).then(r => r.json()),
    ]).then(([s, m]) => {
      setSettings(s);
      setBaseline(s);
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
    setBaseline(settings);
    setSaving(false);
    setDirty(false);
  };

  const discard = () => {
    setSettings(baseline);
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
    <div className="settings-page">
      <div className="admin-header">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{org.name}</div>
            <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 4 }}>Org Settings · {org.slug}</div>
          </div>
          <button className="btn-secondary" onClick={onClose}>← Back</button>
        </div>
        <div className="tabs" style={{ marginTop: 14 }}>
          <button className={`tab-btn ${tab === "general" ? "active" : ""}`} onClick={() => setTab("general")}>General</button>
          <button className={`tab-btn ${tab === "integrations" ? "active" : ""}`} onClick={() => setTab("integrations")}>Integrations</button>
          <button className={`tab-btn ${tab === "members" ? "active" : ""}`} onClick={() => setTab("members")}>Members</button>
        </div>
      </div>

      <div className="settings-body">
        {tab === "general" && (
          <div className="settings-section">
            <div className="settings-section-title">Identity</div>
            <div className="field-card">
              <div className="field-row">
                <div className="field-row-head">
                  <span className="field-row-label">Org Name</span>
                </div>
                <input
                  className="form-input"
                  value={settings.name || org.name}
                  onChange={(e) => { setSettings({ ...settings, name: e.target.value }); setDirty(true); }}
                />
              </div>
            </div>
          </div>
        )}

        {tab === "general" && (
          <div className="settings-section">
            <div className="settings-section-title">Defaults</div>
            <div className="field-card">
              <div className="field-row">
                <div className="field-row-head">
                  <span className="field-row-label">Default Model</span>
                  <span className="field-row-hint">Used for new sessions in this org</span>
                </div>
                <select
                  className="form-input"
                  value={settings.default_model || "fornace-fast"}
                  onChange={(e) => { setSettings({ ...settings, default_model: e.target.value }); setDirty(true); }}
                >
                  {MODEL_OPTIONS.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </div>
            </div>
          </div>
        )}

        {tab === "integrations" && (
          <>
            <div className="settings-section">
              <div className="settings-section-title">Notes</div>
              <div className="settings-hint">
                These settings are scoped to this org. Spaces and sessions within this org use these integrations.
                Pi can be instructed to install additional tools in its working directory.
              </div>
            </div>
            <div className="settings-section">
              <div className="settings-section-title">Knowledge & Memory</div>
              <div className="field-card">
                <div className="field-row">
                  <div className="field-row-head">
                    <span className="field-row-label">Obsidian CouchDB Remote URL</span>
                  </div>
                  <input
                    className="form-input"
                    placeholder="http://couchdb:5984/obsidian-org"
                    value={settings.obsidian_url || ""}
                    onChange={(e) => { setSettings({ ...settings, obsidian_url: e.target.value }); setDirty(true); }}
                  />
                </div>
                <div className="field-row">
                  <div className="field-row-head">
                    <span className="field-row-label">Honcho Server URL</span>
                  </div>
                  <input
                    className="form-input"
                    placeholder="http://honcho:7432"
                    value={settings.honcho_url || ""}
                    onChange={(e) => { setSettings({ ...settings, honcho_url: e.target.value }); setDirty(true); }}
                  />
                </div>
                <div className="field-row">
                  <div className="field-row-head">
                    <span className="field-row-label">Honcho Workspace</span>
                  </div>
                  <input
                    className="form-input"
                    placeholder="default"
                    value={settings.honcho_workspace || ""}
                    onChange={(e) => { setSettings({ ...settings, honcho_workspace: e.target.value }); setDirty(true); }}
                  />
                </div>
              </div>
            </div>
          </>
        )}

        {tab === "members" && (
          <div className="settings-section">
            <div className="settings-section-title">Members · {members.length}</div>
            {members.length === 0 ? (
              <div className="kv-empty">No members yet.</div>
            ) : (
              <div className="kv-list">
                {members.map(m => (
                  <div key={m.id} className="kv-row">
                    <div className="kv-main">
                      {m.avatar_url
                        ? <img src={m.avatar_url} alt="" style={{ width: 28, height: 28, borderRadius: "50%", flexShrink: 0 }} />
                        : <div style={{ width: 28, height: 28, borderRadius: "50%", background: "var(--bg-elevated)", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "var(--text-dim)" }}>{(m.name || "?").charAt(0).toUpperCase()}</div>}
                      <div className="kv-text">
                        <div className="kv-name">{m.name}</div>
                        {m.email && <div className="kv-sub">{m.email}</div>}
                      </div>
                    </div>
                    <div className="kv-actions">
                      <select className="role-select" value={m.role} onChange={(e) => updateMemberRole(m.id, e.target.value)}>
                        <option value="admin">admin</option>
                        <option value="editor">editor</option>
                        <option value="viewer">viewer</option>
                      </select>
                      <button className="admin-action-btn danger" onClick={() => removeMember(m.id)}>Remove</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {dirty && (
        <div className="settings-save-bar">
          <span className="save-dot">Unsaved changes</span>
          <button className="btn-secondary" onClick={discard}>Discard</button>
          <button className="btn-primary" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save Changes"}
          </button>
        </div>
      )}
    </div>
  );
}
