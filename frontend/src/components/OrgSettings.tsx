import { useState, useEffect, useCallback } from "react";
import type { Org } from "../types";
import { useEscapeToClose } from "../hooks/useEscapeToClose";
import { OrgBilling, type BillingInfo } from "./OrgBilling";

interface OrgSettingsProps { org: Org; onClose: () => void; onRenamed: (org: Org) => void; onDeleted?: (org: Org) => void; }
function getAuthHeaders(): Record<string, string> { const token = localStorage.getItem("waynode-dev-token"); return token ? { "x-dev-token": token } : {}; }
export function OrgSettings({ org, onClose, onRenamed, onDeleted }: OrgSettingsProps) {
  const isAdmin = org.my_role === "admin";
  const canEdit = org.my_role !== "viewer";
  const [tab, setTab] = useState<"general" | "integrations" | "members" | "billing">("general");
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [baseline, setBaseline] = useState<Record<string, string>>({});
  const [members, setMembers] = useState<any[]>([]);
  const [modelOptions, setModelOptions] = useState<{ id: string; name: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [nameInput, setNameInput] = useState(org.name);
  const [nameSaving, setNameSaving] = useState(false);
  const [inviteUrl, setInviteUrl] = useState("");
  const [inviteCopied, setInviteCopied] = useState(false);
  const [inviteError, setInviteError] = useState("");
  const [billingEnabled, setBillingEnabled] = useState(false);
  const [billing, setBilling] = useState<BillingInfo | null>(null);
  const [billingBusy, setBillingBusy] = useState<string | null>(null);
  const [billingError, setBillingError] = useState("");
  const [billingLoading, setBillingLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [actionError, setActionError] = useState("");
  const requestClose = useCallback(() => {
    if (!dirty || window.confirm("Discard unsaved organization settings?")) onClose();
  }, [dirty, onClose]);
  useEscapeToClose(requestClose);

  useEffect(() => { setNameInput(org.name); }, [org.name]);
  useEffect(() => {
    Promise.all([
      fetch(`/api/orgs/${org.id}/settings`, { headers: getAuthHeaders(), credentials: "include" }).then(r => r.json()),
      fetch(`/api/orgs/${org.id}/members`, { headers: getAuthHeaders(), credentials: "include" }).then(r => r.json()),
      fetch("/api/models", { headers: getAuthHeaders(), credentials: "include" }).then(r => r.json()),
    ]).then(([s, m, modelData]) => {
      setSettings(s);
      setBaseline(s);
      setMembers(m);
      setModelOptions(modelData.models || []);
    });
  }, [org.id]);
  useEffect(() => {
    fetch("/api/billing/enabled").then(r => r.json()).then(d => setBillingEnabled(!!d.enabled)).catch(() => setBillingEnabled(false));
  }, []);
  useEffect(() => {
    if (!billingEnabled || !isAdmin) return;
    setBillingLoading(true);
    setBillingError("");
    fetch(`/api/orgs/${org.id}/billing`, { headers: getAuthHeaders(), credentials: "include" })
      .then(async r => { const data = await r.json(); if (!r.ok) throw new Error(data.error || "Could not load billing"); return data; })
      .then(setBilling)
      .catch(error => setBillingError(error instanceof Error ? error.message : "Could not load billing"))
      .finally(() => setBillingLoading(false));
  }, [org.id, billingEnabled, isAdmin]);
  const startCheckout = async (plan: string) => {
    setBillingError("");
    setBillingBusy(plan);
    try {
      const res = await fetch(`/api/orgs/${org.id}/billing/checkout`, {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ plan }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to start checkout");
      window.location.href = data.url;
    } catch (e) {
      setBillingError((e as Error).message);
      setBillingBusy(null);
    }
  };
  const openPortal = async () => {
    setBillingError("");
    setBillingBusy("portal");
    try {
      const res = await fetch(`/api/orgs/${org.id}/billing/portal`, {
        method: "POST",
        headers: getAuthHeaders(),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to open billing portal");
      window.location.href = data.url;
    } catch (e) {
      setBillingError((e as Error).message);
      setBillingBusy(null);
    }
  };
  const save = async () => {
    setSaving(true);
    setActionError("");
    try {
      const response = await fetch(`/api/orgs/${org.id}/settings`, {
        method: "PATCH",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      if (!response.ok) throw new Error("Organization settings could not be saved.");
      setBaseline(settings);
      setDirty(false);
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "Organization settings could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  const discard = () => { setSettings(baseline); setDirty(false); };
  const updateMemberRole = async (userId: string, role: string) => {
    setActionError("");
    try {
      const response = await fetch(`/api/orgs/${org.id}/members/${userId}`, {
        method: "PATCH",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      if (!response.ok) throw new Error("The member role could not be changed.");
      setMembers(prev => prev.map(m => m.id === userId ? { ...m, role } : m));
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "The member role could not be changed.");
    }
  };
  const removeMember = async (userId: string, memberName: string) => {
    if (!window.confirm(`Remove “${memberName}” from ${org.name}? They will lose access to this organization’s worktrees and sessions.`)) return;
    setActionError("");
    try {
      const response = await fetch(`/api/orgs/${org.id}/members/${userId}`, { method: "DELETE", headers: getAuthHeaders() });
      if (!response.ok) throw new Error(`${memberName} could not be removed.`);
      setMembers(prev => prev.filter(m => m.id !== userId));
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "The member could not be removed.");
    }
  };
  const saveName = async () => {
    const name = nameInput.trim();
    if (!name || name === org.name) return;
    setNameSaving(true);
    try {
      const res = await fetch(`/api/orgs/${org.id}`, {
        method: "PATCH",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const updated = await res.json();
      onRenamed(updated);
    } finally {
      setNameSaving(false);
    }
  };
  const deleteOrg = async () => {
    if (!confirm(`Delete "${org.name}"? This permanently deletes every space, session, and setting in this org. This cannot be undone.`)) return;
    setDeleteError("");
    setDeleting(true);
    try {
      const res = await fetch(`/api/orgs/${org.id}`, { method: "DELETE", headers: getAuthHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to delete organization");
      onDeleted?.(org);
    } catch (e) {
      setDeleteError((e as Error).message);
    } finally {
      setDeleting(false);
    }
  };
  const createInvite = async () => {
    setInviteError("");
    setInviteCopied(false);
    try {
      const res = await fetch(`/api/orgs/${org.id}/invites`, {
        method: "POST",
        headers: { ...getAuthHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ role: "editor" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create invite");
      setInviteUrl(data.url);
    } catch (e) {
      setInviteError((e as Error).message);
    }
  };

  const copyInvite = async () => { await navigator.clipboard.writeText(inviteUrl); setInviteCopied(true); };
  return (
    <div className="settings-page">
      <div className="admin-header">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{org.name}</div>
            <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 4 }}>Org Settings · {org.slug}</div>
          </div>
          <button className="btn-secondary" onClick={requestClose}>← Back</button>
        </div>
        <div className="tabs" style={{ marginTop: 14 }} role="tablist" aria-label="Organization settings sections">
          <button role="tab" aria-selected={tab === "general"} className={`tab-btn ${tab === "general" ? "active" : ""}`} onClick={() => setTab("general")}>General</button>
          {canEdit && <button role="tab" aria-selected={tab === "integrations"} className={`tab-btn ${tab === "integrations" ? "active" : ""}`} onClick={() => setTab("integrations")}>Integrations</button>}
          <button role="tab" aria-selected={tab === "members"} className={`tab-btn ${tab === "members" ? "active" : ""}`} onClick={() => setTab("members")}>Members</button>
          {billingEnabled && isAdmin && (
            <button role="tab" aria-selected={tab === "billing"} className={`tab-btn ${tab === "billing" ? "active" : ""}`} onClick={() => setTab("billing")}>Billing</button>
          )}
        </div>
      </div>

      <div className="settings-body">
        {actionError && <div className="workspace-error settings-inline-error" role="alert"><span>Action failed</span><p>{actionError}</p><button type="button" onClick={() => setActionError("")}>Dismiss</button></div>}
        {tab === "general" && (
          <div className="settings-section">
            <div className="settings-section-title">Identity</div>
            <div className="field-card">
              <div className="field-row">
                <div className="field-row-head">
                  <span className="field-row-label">Org Name</span>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    className="form-input"
                    aria-label="Organization name"
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    disabled={!isAdmin}
                  />
                  {isAdmin && <button
                    className="btn-primary"
                    onClick={saveName}
                    disabled={nameSaving || !nameInput.trim() || nameInput.trim() === org.name}
                  >
                    {nameSaving ? "Saving…" : "Save"}
                  </button>}
                </div>
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
                  aria-label="Default model"
                  value={modelOptions.some(m => m.id === settings.default_model) ? settings.default_model : modelOptions[0]?.id || ""}
                  onChange={(e) => { setSettings({ ...settings, default_model: e.target.value }); setDirty(true); }}
                  disabled={!canEdit}
                >
                  {modelOptions.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </div>
            </div>
          </div>
        )}

        {tab === "general" && org.my_role === "admin" && (
          <div className="settings-section">
            <div className="settings-section-title">Danger Zone</div>
            <div className="field-card">
              <div className="field-row">
                <div className="field-row-head">
                  <span className="field-row-label">Delete Organization</span>
                  <span className="field-row-hint">Permanently deletes this org, its spaces, and all sessions. Cannot be undone.</span>
                </div>
                <button className="admin-action-btn danger" onClick={deleteOrg} disabled={deleting}>
                  {deleting ? "Deleting…" : "Delete Organization"}
                </button>
                {deleteError && <div className="field-row-hint" role="alert" style={{ color: "var(--red)" }}>{deleteError}</div>}
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
            <div className="field-card">
              <div className="field-row">
                <div className="field-row-head">
                  <span className="field-row-label">Invite a teammate</span>
                  <span className="field-row-hint">Generates a shareable link that adds anyone who opens it as an editor</span>
                </div>
                {!isAdmin ? <span className="field-row-hint">Only organization admins can create invites.</span> : inviteUrl ? (
                  <div style={{ display: "flex", gap: 8 }}>
                    <input className="form-input" readOnly value={inviteUrl} onClick={(e) => (e.target as HTMLInputElement).select()} />
                    <button className="btn-secondary" onClick={copyInvite}>{inviteCopied ? "Copied!" : "Copy"}</button>
                  </div>
                ) : (
                  <button className="btn-secondary" onClick={createInvite}>Invite</button>
                )}
                {inviteError && <div className="field-row-hint" style={{ color: "var(--red)" }}>{inviteError}</div>}
              </div>
            </div>

            <div className="settings-section-title" style={{ marginTop: 16 }}>Members · {members.length}</div>
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
                    {isAdmin && <div className="kv-actions">
                      <select className="role-select" aria-label={`Role for ${m.name}`} value={m.role} onChange={(e) => updateMemberRole(m.id, e.target.value)}>
                        <option value="admin">admin</option>
                        <option value="editor">editor</option>
                        <option value="viewer">viewer</option>
                      </select>
                      <button className="admin-action-btn danger" onClick={() => removeMember(m.id, m.name || m.email || "this member")}>Remove</button>
                    </div>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === "billing" && billingLoading && <div className="kv-empty">Loading billing…</div>}
        {tab === "billing" && billingError && !billing && <div className="workspace-error" role="alert"><span>Billing unavailable</span><p>{billingError}</p></div>}
        {tab === "billing" && billing && (
          <OrgBilling billing={billing} busy={billingBusy} error={billingError} onCheckout={startCheckout} onOpenPortal={openPortal} />
        )}
      </div>

      {dirty && canEdit && (
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
