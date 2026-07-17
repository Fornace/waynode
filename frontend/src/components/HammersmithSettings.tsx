import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { HammersmithSettings as Settings } from "../types";

export function HammersmithSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const load = async () => {
    setLoading(true);
    setSaved(false);
    setError("");
    try {
      const next = await api.hammersmith.settings();
      setSettings(next);
      setDraft(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Hammersmith settings could not be loaded.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const updateDraft = (next: Settings) => {
    setDraft(next);
    setSaved(false);
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      const next = await api.hammersmith.saveSettings({
        dashboardUrl: draft.dashboardUrl,
        hostingMode: draft.hostingMode,
        defaultEngine: draft.defaultEngine,
      });
      setSettings(next);
      setDraft(next);
      setSaved(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Hammersmith settings could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  const capability = settings?.capability;
  const dirty = !!draft && !!settings && (
    draft.dashboardUrl !== settings.dashboardUrl ||
    draft.hostingMode !== settings.hostingMode ||
    draft.defaultEngine !== settings.defaultEngine
  );

  return (
    <section className="settings-section hammersmith-settings" aria-labelledby="hammersmith-settings-title">
      <div className="settings-section-title" id="hammersmith-settings-title">Hammersmith</div>
      {loading ? <div className="settings-hint" role="status">Checking Hammersmith…</div> : draft ? <>
        <div className={`hammersmith-detection ${capability?.available ? "is-ready" : "is-setup"}`} role="status">
          <strong>{capability?.available ? "Hammersmith is available" : capability?.installed ? "Hammersmith cannot run in this environment" : "Hammersmith setup required"}</strong>
          <span>{capability?.version ? `Detected ${capability.version}` : "No runnable version was detected."}</span>
        </div>
        <div className="field-card">
          <label className="field-row">
            <span className="field-row-label">Hosting mode</span>
            <span className="field-row-hint">Managed deployments keep swarm work inside the Space microVM.</span>
            <select className="model-select" value={draft.hostingMode} disabled={settings?.hostingModeLocked} onChange={(event) => updateDraft({ ...draft, hostingMode: event.target.value as Settings["hostingMode"] })}>
              <option value="self-hosted">Self-hosted</option><option value="hosted">Hosted</option>
            </select>
          </label>
          <label className="field-row">
            <span className="field-row-label">Default engine</span>
            <span className="field-row-hint">Hosted runs use the Pi already installed in the sandbox.</span>
            <select className="model-select" value={draft.defaultEngine} disabled={draft.hostingMode === "hosted"} onChange={(event) => updateDraft({ ...draft, defaultEngine: event.target.value as Settings["defaultEngine"] })}>
              <option value="pi">Pi</option><option value="codex">Codex</option><option value="opencode">OpenCode</option><option value="grok">Grok</option>
            </select>
          </label>
          <label className="field-row">
            <span className="field-row-label">Dashboard URL</span>
            <span className="field-row-hint">Only credential-free http or https monitor links are accepted.</span>
            <input className="form-input" type="url" value={draft.dashboardUrl || ""} onChange={(event) => updateDraft({ ...draft, dashboardUrl: event.target.value })} placeholder="http://127.0.0.1:8700" />
          </label>
        </div>
        <p className="settings-hint hammersmith-key-guide">Worker API keys are not stored here. Add scoped keys in the existing worktree <strong>Settings → Secrets</strong> surface; saved secret values remain encrypted and are never shown again.</p>
        {error && <div className="form-error" role="alert">{error}</div>}
        {saved && <div className="hammersmith-saved" role="status">Hammersmith settings saved.</div>}
        <div className="hammersmith-settings-actions">
          <button className="btn-secondary" type="button" onClick={load}>Check again</button>
          <button className="btn-primary" type="button" onClick={save} disabled={!dirty || saving}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </> : <div className="settings-hint" role="alert">{error}<button type="button" onClick={load}>Retry</button></div>}
    </section>
  );
}
