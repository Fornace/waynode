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
      <div className="modal" style={{ width: 640, maxWidth: "90vw", padding: 0 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: "20px 24px", borderBottom: "1px solid rgba(255,255,255,0.1)", display: "flex", justifyContent: "space-between", alignItems: "center", background: "rgba(0,0,0,0.2)" }}>
          <div className="modal-title" style={{ margin: 0 }}>{space.repo_name} Settings</div>
          <div className="tabs">
            <button className={`tab-btn ${tab === "agents" ? "active" : ""}`} onClick={() => setTab("agents")}>AGENTS.md</button>
            <button className={`tab-btn ${tab === "secrets" ? "active" : ""}`} onClick={() => setTab("secrets")}>Secrets</button>
          </div>
        </div>

        <div style={{ padding: 24 }}>
          {loading ? (
            <div style={{ color: "var(--text-dim)", textAlign: "center", padding: 40 }}>Loading...</div>
          ) : tab === "agents" ? (
            <div>
              <textarea
                className="form-input"
                style={{ width: "100%", minHeight: 300, fontFamily: "var(--mono)", fontSize: 13, resize: "vertical" }}
                value={agentsContent}
                onChange={(e) => setAgentsContent(e.target.value)}
                placeholder="# AGENTS.md — pi reads this on every session"
              />
              <div className="modal-actions">
                <button className="btn-secondary" onClick={onClose}>Close</button>
                <button className="btn-primary" onClick={saveAgents} disabled={saving}>
                  {saving ? "Saving..." : "Save"}
                </button>
              </div>
            </div>
          ) : (
            <div>
              <div style={{ marginBottom: 20 }}>
                {secrets.length === 0 && (
                  <div style={{ color: "var(--text-faint)", fontSize: 13, padding: "20px 0", textAlign: "center" }}>
                    No secrets. Add API keys below — they'll be injected as env vars when pi runs.
                  </div>
                )}
                {secrets.map((s) => (
                  <div key={s.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                    <code style={{ fontSize: 13, color: "var(--text)" }}>{s.key_name}</code>
                    <button className="btn-secondary" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => deleteSecret(s.id)}>Delete</button>
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input className="form-input" style={{ flex: 1 }} placeholder="KEY_NAME" value={newKeyName} onChange={(e) => setNewKeyName(e.target.value)} />
                <input className="form-input" style={{ flex: 1 }} placeholder="value" type="password" value={newValue} onChange={(e) => setNewValue(e.target.value)} />
                <button className="btn-primary" onClick={addSecret} disabled={!newKeyName.trim() || !newValue.trim()}>Add</button>
              </div>
              <div className="modal-actions">
                <button className="btn-secondary" onClick={onClose}>Close</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
