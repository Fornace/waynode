import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../api/client";
import { useEscapeToClose } from "../hooks/useEscapeToClose";
import { ConfirmDialog } from "./ConfirmDialog";

type TokenInfo = { id: string; label: string; created_at: string; last_used_at: string | null };

export function AccountTokens() {
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [label, setLabel] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [newToken, setNewToken] = useState("");
  const [pendingRevoke, setPendingRevoke] = useState<TokenInfo | null>(null);
  const [revoking, setRevoking] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try { setTokens((await api.tokens.list()).tokens); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "API tokens could not be loaded."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (creating || tokens.length >= 10) return;
    setCreating(true);
    setError("");
    try {
      const created = await api.tokens.create(label.trim() || "Waynode app");
      setNewToken(created.token);
      setLabel("");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The API token could not be created.");
    } finally {
      setCreating(false);
    }
  };

  const revoke = async () => {
    if (!pendingRevoke || revoking) return;
    setRevoking(true);
    setError("");
    try {
      await api.tokens.revoke(pendingRevoke.id);
      setTokens((current) => current.filter((token) => token.id !== pendingRevoke.id));
      setPendingRevoke(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The API token could not be revoked.");
    } finally {
      setRevoking(false);
    }
  };

  return <>
    <section className="settings-section" aria-labelledby="api-tokens-title">
      <div className="settings-section-title" id="api-tokens-title">API tokens</div>
      <p className="settings-hint">Use a personal token to sign in to Waynode’s native apps or API. Each token has your account access until you revoke it.</p>
      {error && <div className="form-error account-token-error" role="alert">{error} <button type="button" onClick={load}>Try again</button></div>}
      {loading ? <div className="kv-empty" role="status">Loading API tokens…</div> : tokens.length === 0 ? <div className="kv-empty">No API tokens yet.</div> : (
        <div className="kv-list account-token-list">
          {tokens.map((token) => <div className="kv-row" key={token.id}>
            <div className="kv-text">
              <div className="kv-name">{token.label}</div>
              <div className="kv-sub">Created {formatDate(token.created_at)}{token.last_used_at ? ` · used ${formatDate(token.last_used_at)}` : " · never used"}</div>
            </div>
            <button type="button" className="admin-action-btn danger" onClick={() => setPendingRevoke(token)} aria-label={`Revoke API token ${token.label}`}>Revoke</button>
          </div>)}
        </div>
      )}
      <form className="account-token-create" onSubmit={create}>
        <label htmlFor="api-token-label">Token name <span>optional</span></label>
        <div><input id="api-token-label" className="form-input" maxLength={60} value={label} onChange={(event) => setLabel(event.target.value)} placeholder="My iPhone" /><button type="submit" className="btn-primary" disabled={loading || creating || tokens.length >= 10}>{creating ? "Creating…" : "Create token"}</button></div>
        {tokens.length >= 10 && <p role="status">Token limit reached. Revoke one before creating another.</p>}
      </form>
    </section>
    {newToken && <TokenRevealDialog token={newToken} onClose={() => setNewToken("")} />}
    {pendingRevoke && <ConfirmDialog
      title={`Revoke “${pendingRevoke.label}”?`}
      description="Apps using this token will lose access immediately. This cannot be undone."
      confirmLabel={revoking ? "Revoking…" : "Revoke token"}
      danger
      onCancel={() => { if (!revoking) setPendingRevoke(null); }}
      onConfirm={revoke}
    />}
  </>;
}

function TokenRevealDialog({ token, onClose }: { token: string; onClose: () => void }) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const requestClose = useCallback(() => {
    if (copied || window.confirm("Close without copying this token? It cannot be shown again.")) onClose();
  }, [copied, onClose]);
  useEscapeToClose(requestClose, overlayRef);
  const copy = async () => {
    setCopyError("");
    try { await navigator.clipboard.writeText(token); setCopied(true); }
    catch { setCopyError("Copy failed. Select the token and copy it manually."); }
  };
  return <div className="modal-overlay" ref={overlayRef} onClick={requestClose}>
    <section className="modal token-reveal-dialog" role="dialog" aria-modal="true" aria-labelledby="new-token-title" onClick={(event) => event.stopPropagation()}>
      <h2 id="new-token-title">Save this token now</h2>
      <p>Waynode stores only its secure hash. This value cannot be shown again.</p>
      <textarea readOnly value={token} aria-label="New API token" onFocus={(event) => event.currentTarget.select()} />
      {copyError && <div className="form-error" role="alert">{copyError}</div>}
      <div className="confirm-dialog-actions"><button type="button" className="btn-secondary" onClick={copy}>{copied ? "Copied" : "Copy token"}</button><button type="button" className="btn-primary" onClick={requestClose}>{copied ? "Done" : "I saved it"}</button></div>
    </section>
  </div>;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "at an unknown time" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}
