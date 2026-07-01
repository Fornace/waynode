import { useState, useEffect, useRef } from "react";
import type { Space } from "../types";
import { api } from "../api/client";
import { useEscapeToClose } from "../hooks/useEscapeToClose";

interface SpaceSettingsProps {
  space: Space;
  onClose: () => void;
}

export function SpaceSettings({ space, onClose }: SpaceSettingsProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  // Layer 1 of the keyboard contract: Esc closes the topmost modal and focus
  // is trapped inside so the terminal behind it stops receiving input.
  useEscapeToClose(onClose, overlayRef);
  const [tab, setTab] = useState<"agents" | "secrets">("agents");
  const [agentsContent, setAgentsContent] = useState("");
  const [agentsDirty, setAgentsDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [secrets, setSecrets] = useState<{ id: string; key_name: string }[]>([]);
  const [newKeyName, setNewKeyName] = useState("");
  const [newValue, setNewValue] = useState("");

  useEffect(() => {
    Promise.all([
      fetch(`/api/spaces/${space.id}/files?path=AGENTS.md`).then((r) => r.ok ? r.json() : null),
      fetch(`/api/spaces/${space.id}/secrets`).then((r) => r.json()),
    ]).then(([file, secs]) => {
      setAgentsContent(file?.content || "");
      setSecrets(secs);
    }).finally(() => setLoading(false));
  }, [space.id]);

  const saveAgents = async () => {
    setSaving(true);
    await fetch(`/api/spaces/${space.id}/files`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "AGENTS.md", content: agentsContent }),
    });
    setAgentsDirty(false);
    setSaving(false);
  };

  const addSecret = async () => {
    if (!newKeyName.trim() || !newValue.trim()) return;
    await fetch(`/api/spaces/${space.id}/secrets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyName: newKeyName, value: newValue }),
    });
    setNewKeyName("");
    setNewValue("");
    const secs = await fetch(`/api/spaces/${space.id}/secrets`).then((r) => r.json());
    setSecrets(secs);
  };

  const deleteSecret = async (id: string) => {
    await fetch(`/api/secrets/${id}`, { method: "DELETE" });
    setSecrets(secrets.filter((s) => s.id !== id));
  };

  return (
    <div className="modal-overlay" ref={overlayRef} onClick={onClose}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-modal-head">
          <div className="modal-title" style={{ margin: 0 }}>{space.repo_name} Settings</div>
          <div className="tabs">
            <button className={`tab-btn ${tab === "agents" ? "active" : ""}`} onClick={() => setTab("agents")}>AGENTS.md</button>
            <button className={`tab-btn ${tab === "secrets" ? "active" : ""}`} onClick={() => setTab("secrets")}>Secrets</button>
          </div>
        </div>

        <div className="settings-modal-body">
          {loading ? (
            <div className="kv-empty">Loading…</div>
          ) : tab === "agents" ? (
            <>
              <div className="settings-hint" style={{ marginBottom: 12 }}>
                <strong>AGENTS.md</strong> is read by pi at the start of every session. Use it for repo conventions,
                build commands, and per-project rules.
              </div>
              <textarea
                className="form-input agents-editor"
                value={agentsContent}
                onChange={(e) => { setAgentsContent(e.target.value); setAgentsDirty(true); }}
                placeholder="# AGENTS.md — pi reads this on every session"
                spellCheck={false}
              />
            </>
          ) : (
            <>
              <div className="settings-hint" style={{ marginBottom: 12 }}>
                Secrets are encrypted and injected as environment variables when pi runs in this space.
                Values are never shown again after you add them. Add a <code>GITHUB_TOKEN</code> or{" "}
                <code>GITLAB_TOKEN</code> secret to use a scoped token for git operations in this space
                instead of your personal login token.
              </div>
              {secrets.length === 0 ? (
                <div className="kv-empty">No secrets yet. Add API keys below.</div>
              ) : (
                <div className="kv-list">
                  {secrets.map((s) => (
                    <div key={s.id} className="kv-row">
                      <span className="kv-key">
                        <span className="kv-dot" />
                        {s.key_name}
                      </span>
                      <button className="admin-action-btn danger" onClick={() => deleteSecret(s.id)}>Delete</button>
                    </div>
                  ))}
                </div>
              )}
              <div className="add-kv-card">
                <div className="add-kv-row">
                  <input
                    className="form-input"
                    placeholder="KEY_NAME"
                    value={newKeyName}
                    onChange={(e) => setNewKeyName(e.target.value)}
                  />
                  <input
                    className="form-input"
                    placeholder="value"
                    type="password"
                    value={newValue}
                    onChange={(e) => setNewValue(e.target.value)}
                  />
                  <button className="btn-primary" onClick={addSecret} disabled={!newKeyName.trim() || !newValue.trim()}>Add</button>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="settings-save-bar" style={{ position: "static", background: "var(--bg-surface)", borderTop: "1px solid var(--border)" }}>
          {tab === "agents" && agentsDirty && <span className="save-dot">Unsaved changes</span>}
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <button className="btn-secondary" onClick={onClose}>Close</button>
            {tab === "agents" && (
              <button className="btn-primary" onClick={saveAgents} disabled={saving || !agentsDirty}>
                {saving ? "Saving…" : "Save"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
