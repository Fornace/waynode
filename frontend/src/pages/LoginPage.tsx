import { useState } from "react";
import { useAuth } from "../context/AuthContext";
import { WaynodeMark } from "../components/Brand";

const githubIcon = <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" /></svg>;
const gitlabIcon = <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M23.955 13.587l-1.347-4.135-2.673-8.228a.456.456 0 00-.867 0l-2.672 8.228H7.604l-2.673-8.228a.456.456 0 00-.867 0L1.392 9.452.045 13.587a.924.924 0 00.331 1.022L12 23.054l11.624-8.445a.92.92 0 00.331-1.022" /></svg>;

export function LoginPage() {
  const { providers, error, retry } = useAuth();
  const [showDev, setShowDev] = useState(false);
  const [devToken, setDevToken] = useState("");
  const noProviders = !providers.github && !providers.gitlab;

  const handleDevLogin = () => {
    localStorage.setItem("waynode-dev-token", devToken.trim());
    window.location.assign("/");
  };

  return (
    <main className="login-page">
      <a className="login-home" href="/" aria-label="Back to Waynode home">← Waynode</a>
      <section className="login-card" aria-labelledby="login-title">
        <WaynodeMark size={48} tension />
        <h1 className="login-title" id="login-title">Sign in to Waynode</h1>
        <p className="login-subtitle">Your repositories and sessions stay on this configured Waynode server.</p>

        {error && <div className="login-error" role="alert"><span>{error}</span><button type="button" onClick={retry}>Retry</button></div>}
        {providers.github && <a className="login-btn" href="/auth/github">{githubIcon} Continue with GitHub</a>}
        {providers.gitlab && <a className="login-btn" href="/auth/gitlab">{gitlabIcon} Continue with GitLab</a>}
        {noProviders && !error && <p className="login-provider-empty" role="status">This server has no OAuth provider configured. Ask its administrator to enable GitHub or GitLab.</p>}

        {import.meta.env.DEV && (
          <div className="login-dev">
            {!showDev ? <button type="button" onClick={() => setShowDev(true)}>Use local development token</button> : <>
              <label htmlFor="dev-token">Development token</label>
              <input id="dev-token" className="modal-input" type="password" autoComplete="off" value={devToken} onChange={(event) => setDevToken(event.target.value)} />
              <button className="btn-primary" type="button" onClick={handleDevLogin} disabled={!devToken.trim()}>Sign in locally</button>
            </>}
          </div>
        )}

        <details className="login-server"><summary>Using a self-hosted server?</summary><p>Open the URL of that deployment directly. Sign-in and repository data stay scoped to that server.</p></details>
      </section>
    </main>
  );
}
