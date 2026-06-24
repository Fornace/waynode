import { useState } from "react";
import { useAuth } from "../context/AuthContext";

export function LoginPage() {
  const { user } = useAuth();
  const [showDev, setShowDev] = useState(false);
  const [devToken, setDevToken] = useState("");

  const handleDevLogin = () => {
    localStorage.setItem("waynode-dev-token", devToken);
    window.location.reload();
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-title">Waynode AI</div>
        <div className="login-subtitle">Sign in to your workspace</div>

        <a className="login-btn" href="/auth/github">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
          </svg>
          Continue with GitHub
        </a>

        <a className="login-btn" href="/auth/gitlab">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M23.955 13.587l-1.347-4.135-2.673-8.228a.456.456 0 00-.867 0l-2.672 8.228H7.604l-2.673-8.228a.456.456 0 00-.867 0L1.392 9.452.045 13.587a.924.924 0 00.331 1.022L12 23.054l11.624-8.445a.92.92 0 00.331-1.022"/>
          </svg>
          Continue with GitLab
        </a>

        <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--border)" }}>
          {!showDev ? (
            <button onClick={() => setShowDev(true)} style={{ fontSize: 12, color: "var(--text-faint)", width: "100%" }}>
              Use dev token instead
            </button>
          ) : (
            <div>
              <input
                className="modal-input"
                placeholder="Paste dev token"
                value={devToken}
                onChange={(e) => setDevToken(e.target.value)}
                style={{ marginBottom: 8 }}
              />
              <button className="btn-primary" style={{ width: "100%" }} onClick={handleDevLogin} disabled={!devToken.trim()}>
                Login with token
              </button>
            </div>
          )}
        </div>

        {user && (
          <div style={{ marginTop: 16, fontSize: 12, color: "var(--text-dim)" }}>
            Already signed in as {user.name}
          </div>
        )}
      </div>
    </div>
  );
}
