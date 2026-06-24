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
      <div className="modal" style={{ width: 600, maxWidth: "90vw" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div className="modal-title">{space.repo_name} Settings</div>
          <div className="tabs">
            <button className={`tab-btn ${tab === "agents" ? "active" : ""}`} onClick={() => setTab("agents")}>AGENTS.md</button>
            <button className={`tab-btn ${tab === "secrets" ? "active" : ""}`} onClick={() => setTab("secrets")}>Secrets</button>
          </div>
        </div>

        {loading ? (
          <div style={{ color: "var(--text-dim)", textAlign: "center", padding: 40 }}>Loading...</div>
        ) : tab === "agents" ? (
          <div>
            <textarea
              className="composer-input"
              style={{ minHeight: 300, fontFamily: "var(--mono)", fontSize: 12 }}
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
            <div style={{ marginBottom: 16 }}>
              {secrets.length === 0 && (
                <div style={{ color: "var(--text-faint)", fontSize: 12, padding: "20px 0" }}>
                  No secrets. Add API keys below — they'll be injected as env vars when pi runs.
                </div>
              )}
              {secrets.map((s) => (
                <div key={s.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
                  <code style={{ fontSize: 12 }}>{s.key_name}</code>
                  <button className="btn-secondary" style={{ padding: "2px 8px", fontSize: 11 }} onClick={() => deleteSecret(s.id)}>Delete</button>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <input className="modal-input" placeholder="KEY_NAME" value={newKeyName} onChange={(e) => setNewKeyName(e.target.value)} />
              <input className="modal-input" placeholder="value" type="password" value={newValue} onChange={(e) => setNewValue(e.target.value)} />
              <button className="btn-primary" onClick={addSecret}>Add</button>
            </div>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={onClose}>Close</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
