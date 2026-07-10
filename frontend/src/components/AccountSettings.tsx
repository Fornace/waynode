import { useEffect, useState } from "react";
import { api } from "../api/client";

interface AccountSettingsProps {
  onClose: () => void;
  onDeleted: () => void;
}

export function AccountSettings({ onClose, onDeleted }: AccountSettingsProps) {
  const [blockers, setBlockers] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    api.auth.deletionCheck()
      .then((result) => { if (!cancelled) setBlockers(result.blockers); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "Could not check account deletion."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const handleDelete = async () => {
    if (confirmText !== "DELETE" || deleting) return;
    setDeleting(true);
    setError("");
    try {
      await api.auth.deleteAccount();
      onDeleted();
    } catch (err) {
      const body = (err as { body?: { blockers?: Array<{ id: string; name: string }> } }).body;
      if (body?.blockers) setBlockers(body.blockers);
      setError(err instanceof Error ? err.message : "Could not delete account.");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal settings-modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Account settings">
        <div className="settings-modal-head">
          <div className="modal-title" style={{ margin: 0 }}>Account</div>
          <button className="icon-btn-ghost" onClick={onClose} aria-label="Close account settings">✕</button>
        </div>
        <div className="settings-modal-body">
          <div className="settings-section">
            <div className="settings-section-title">Account deletion</div>
            <p className="settings-hint">This permanently removes your profile, connected provider tokens, API tokens, personal settings, and personal workspaces. Shared organization work stays with another administrator.</p>
          </div>
          {loading ? <div className="settings-hint">Checking your workspaces…</div> : blockers.length > 0 ? (
            <div className="settings-section">
              <div className="form-error">Before deletion, appoint another admin for:</div>
              <ul className="settings-hint" style={{ margin: "8px 0 0", paddingLeft: 20 }}>
                {blockers.map((org) => <li key={org.id}>{org.name}</li>)}
              </ul>
              <p className="settings-hint">This prevents an organization or its billing from being left without an owner.</p>
            </div>
          ) : (
            <div className="settings-section">
              <label className="form-label" htmlFor="delete-account-confirm">Type <strong>DELETE</strong> to continue</label>
              <input id="delete-account-confirm" className="modal-input" value={confirmText} onChange={(event) => setConfirmText(event.target.value)} autoComplete="off" />
            </div>
          )}
          {error && <div className="form-error">{error}</div>}
        </div>
        <div className="settings-save-bar" style={{ position: "static", background: "var(--bg-surface)", borderTop: "1px solid var(--border)" }}>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-danger" onClick={handleDelete} disabled={loading || blockers.length > 0 || confirmText !== "DELETE" || deleting}>
            {deleting ? "Deleting…" : "Delete account"}
          </button>
        </div>
      </div>
    </div>
  );
}
