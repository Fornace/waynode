import { useState, useEffect } from "react";
import type { Org } from "../types";
import { useEscapeToClose } from "../hooks/useEscapeToClose";

interface OrgSettingsProps {
  org: Org;
  onClose: () => void;
  onRenamed: (org: Org) => void;
  onDeleted?: (org: Org) => void;
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

interface BillingPlan {
  name: string;
  price: number;
  storageBytes: number;
  tokensPerMonth: number;
  seats: number;
}

interface BillingInfo {
  enabled: boolean;
  plan: string;
  status: string;
  current_period_end: string | null;
  usage: { tokens_used: number; storage_bytes: number };
  quota: {
    tokens: { used: number; limit: number; exceeded: boolean };
    storage: { used: number; limit: number; exceeded: boolean };
  };
  plans: Record<string, BillingPlan>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function UsageBar({ used, limit }: { used: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const cls = pct >= 100 ? "usage-bar-over" : pct >= 80 ? "usage-bar-warn" : "";
  return (
    <div className="usage-bar-track">
      <div className={`usage-bar-fill ${cls}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function OrgSettings({ org, onClose, onRenamed, onDeleted }: OrgSettingsProps) {
  // Esc returns from this full-page settings pane (no overlay/focus trap;
  // it's a pane, not a modal).
  useEscapeToClose(onClose);
  const [tab, setTab] = useState<"general" | "integrations" | "members" | "billing">("general");
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [baseline, setBaseline] = useState<Record<string, string>>({});
  const [members, setMembers] = useState<any[]>([]);
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
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  useEffect(() => { setNameInput(org.name); }, [org.name]);

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

  // Self-host installs never set STRIPE_SECRET_KEY — /api/billing/enabled
  // reports false and the Billing tab hides itself entirely.
  useEffect(() => {
    fetch("/api/billing/enabled").then(r => r.json()).then(d => setBillingEnabled(!!d.enabled)).catch(() => setBillingEnabled(false));
  }, []);

  useEffect(() => {
    if (!billingEnabled) return;
    fetch(`/api/orgs/${org.id}/billing`, { headers: getAuthHeaders(), credentials: "include" })
      .then(r => r.json())
      .then(setBilling)
      .catch(() => {});
  }, [org.id, billingEnabled]);

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

  const copyInvite = async () => {
    await navigator.clipboard.writeText(inviteUrl);
    setInviteCopied(true);
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
          {billingEnabled && (
            <button className={`tab-btn ${tab === "billing" ? "active" : ""}`} onClick={() => setTab("billing")}>Billing</button>
          )}
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
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    className="form-input"
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                  />
                  <button
                    className="btn-primary"
                    onClick={saveName}
                    disabled={nameSaving || !nameInput.trim() || nameInput.trim() === org.name}
                  >
                    {nameSaving ? "Saving…" : "Save"}
                  </button>
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
                  value={settings.default_model || "fornace-fast"}
                  onChange={(e) => { setSettings({ ...settings, default_model: e.target.value }); setDirty(true); }}
                >
                  {MODEL_OPTIONS.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
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
                {deleteError && <div className="field-row-hint" style={{ color: "var(--red)" }}>{deleteError}</div>}
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
                {inviteUrl ? (
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

        {tab === "billing" && billing && (
          <>
            <div className="settings-section">
              <div className="settings-section-title">Current Plan</div>
              <div className="field-card">
                <div className="field-row">
                  <div className="field-row-head">
                    <span className="field-row-label">{billing.plans[billing.plan]?.name || billing.plan}</span>
                    <span className="field-row-hint">
                      {billing.plan === "free" ? "Free forever" : `$${billing.plans[billing.plan]?.price}/mo`}
                      {billing.status !== "active" && ` · ${billing.status}`}
                    </span>
                  </div>
                  {billing.plan !== "free" && (
                    <button className="btn-secondary" onClick={openPortal} disabled={billingBusy === "portal"}>
                      {billingBusy === "portal" ? "Opening…" : "Manage billing"}
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className="settings-section">
              <div className="settings-section-title">Usage This Period</div>
              <div className="field-card">
                <div className="field-row">
                  <div className="field-row-head">
                    <span className="field-row-label">Tokens</span>
                    <span className="field-row-hint">{formatTokens(billing.quota.tokens.used)} / {formatTokens(billing.quota.tokens.limit)}</span>
                  </div>
                  <UsageBar used={billing.quota.tokens.used} limit={billing.quota.tokens.limit} />
                </div>
                <div className="field-row">
                  <div className="field-row-head">
                    <span className="field-row-label">Storage</span>
                    <span className="field-row-hint">{formatBytes(billing.quota.storage.used)} / {formatBytes(billing.quota.storage.limit)}</span>
                  </div>
                  <UsageBar used={billing.quota.storage.used} limit={billing.quota.storage.limit} />
                </div>
              </div>
            </div>

            <div className="settings-section">
              <div className="settings-section-title">Plans</div>
              {billingError && <div className="field-row-hint" style={{ color: "var(--red)", marginBottom: 10 }}>{billingError}</div>}
              <div className="plan-grid">
                {(["starter", "pro", "team"] as const).map((planId) => {
                  const plan = billing.plans[planId];
                  if (!plan) return null;
                  const isCurrent = billing.plan === planId;
                  return (
                    <div key={planId} className={`plan-card ${isCurrent ? "plan-card-current" : ""}`}>
                      <div className="plan-card-name">{plan.name}</div>
                      <div className="plan-card-price">${plan.price}<span>/mo</span></div>
                      <div className="plan-card-specs">
                        {formatTokens(plan.tokensPerMonth)} tokens/mo<br />
                        {formatBytes(plan.storageBytes)} storage<br />
                        {plan.seats} seats
                      </div>
                      {isCurrent ? (
                        <button className="btn-secondary" disabled>Current plan</button>
                      ) : (
                        <button className="btn-primary" onClick={() => startCheckout(planId)} disabled={billingBusy === planId}>
                          {billingBusy === planId ? "Redirecting…" : billing.plan === "free" ? "Upgrade" : "Switch"}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </>
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
