import { useState, useEffect, useRef, useCallback, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { Space } from "../types";
import { api } from "../api/client";
import { useEscapeToClose } from "../hooks/useEscapeToClose";

interface SpaceSettingsProps {
  space: Space;
  onClose: () => void;
}

export function SpaceSettings({ space, onClose }: SpaceSettingsProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<"agents" | "secrets">("agents");
  const [agentsContent, setAgentsContent] = useState("");
  const [agentsDirty, setAgentsDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [secrets, setSecrets] = useState<{ id: string; key_name: string }[]>([]);
  const [newKeyName, setNewKeyName] = useState("");
  const [newValue, setNewValue] = useState("");
  const [error, setError] = useState("");
  const requestClose = useCallback(() => {
    if (!agentsDirty || window.confirm(`Discard unsaved AGENTS.md changes for ${space.repo_name}?`)) onClose();
  }, [agentsDirty, onClose, space.repo_name]);
  useEscapeToClose(requestClose, overlayRef);

  // APG roving-tabIndex tabs (ported from GitSidebar.tsx moveTab).
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const tabs: { key: typeof tab; label: string }[] = [{ key: "agents", label: "AGENTS.md" }, { key: "secrets", label: "Secrets" }];
  const moveTab = (event: ReactKeyboardEvent<HTMLButtonElement>, current: number) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : event.key === "ArrowRight" ? (current + 1) % tabs.length : (current - 1 + tabs.length) % tabs.length;
    setTab(tabs[next].key); tabRefs.current[next]?.focus();
  };

  useEffect(() => {
    Promise.all([
      fetch(`/api/spaces/${space.id}/files?path=AGENTS.md`).then((r) => r.ok ? r.json() : null),
      fetch(`/api/spaces/${space.id}/secrets`).then((r) => r.json()),
    ]).then(([file, secs]) => {
      setAgentsContent(file?.content || "");
      setSecrets(secs);
    }).catch((caught) => setError(caught instanceof Error ? caught.message : "Could not load worktree settings."))
      .finally(() => setLoading(false));
  }, [space.id]);

  const saveAgents = async () => {
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/spaces/${space.id}/files`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "AGENTS.md", content: agentsContent }),
      });
      if (!response.ok) throw new Error("AGENTS.md could not be saved.");
      setAgentsDirty(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "AGENTS.md could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  const addSecret = async () => {
    if (!newKeyName.trim() || !newValue.trim()) return;
    setError("");
    try {
      const response = await fetch(`/api/spaces/${space.id}/secrets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keyName: newKeyName.trim(), value: newValue }),
      });
      if (!response.ok) throw new Error("The secret could not be added.");
      setNewKeyName("");
      setNewValue("");
      const listResponse = await fetch(`/api/spaces/${space.id}/secrets`);
      if (!listResponse.ok) throw new Error("The secret was added, but the list could not be refreshed.");
      setSecrets(await listResponse.json());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The secret could not be added.");
    }
  };

  const deleteSecret = async (id: string, keyName: string) => {
    if (!window.confirm(`Delete secret “${keyName}”? The value cannot be recovered.`)) return;
    setError("");
    try {
      const response = await fetch(`/api/secrets/${id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(`Secret “${keyName}” could not be deleted.`);
      setSecrets((current) => current.filter((secret) => secret.id !== id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The secret could not be deleted.");
    }
  };

  return (
    <div className="modal-overlay" ref={overlayRef} onClick={requestClose}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="space-settings-title">
        <div className="settings-modal-head">
          <h1 className="modal-title" id="space-settings-title" style={{ margin: 0 }}>{space.repo_name} Settings</h1>
          <div className="tabs" role="tablist" aria-label="Worktree settings sections">
            {tabs.map((t, i) => (
              <button key={t.key} ref={(node) => { tabRefs.current[i] = node; }} role="tab" id={`space-tab-${t.key}`} aria-selected={tab === t.key} aria-controls="space-settings-panel" tabIndex={tab === t.key ? 0 : -1} className={`tab-btn ${tab === t.key ? "active" : ""}`} onClick={() => setTab(t.key)} onKeyDown={(event) => moveTab(event, i)}>{t.label}</button>
            ))}
          </div>
        </div>

        <div className="settings-modal-body" id="space-settings-panel" role="tabpanel" aria-labelledby={`space-tab-${tab}`} tabIndex={0}>
          {error && <div className="form-error" role="alert">{error}</div>}
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
                aria-label="AGENTS.md editor"
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
                      <button className="admin-action-btn danger" onClick={() => deleteSecret(s.id, s.key_name)} aria-label={`Delete secret ${s.key_name}`}>Delete</button>
                    </div>
                  ))}
                </div>
              )}
              <div className="add-kv-card">
                <div className="add-kv-row">
                  <input
                    className="form-input"
                    placeholder="KEY_NAME"
                    aria-label="Secret name"
                    value={newKeyName}
                    onChange={(e) => setNewKeyName(e.target.value)}
                  />
                  <input
                    className="form-input"
                    placeholder="value"
                    type="password"
                    aria-label="Secret value"
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
            <button className="btn-secondary" onClick={requestClose}>Close</button>
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
