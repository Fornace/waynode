import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { WaynodeMark } from "../components/Brand";

function getAuthHeaders(): Record<string, string> {
  const devToken = localStorage.getItem("waynode-dev-token");
  return devToken ? { "x-dev-token": devToken } : {};
}

export function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const [accepting, setAccepting] = useState(false);

  useEffect(() => {
    if (loading || !token) return;
    if (!user) {
      // Preserve the invite so it auto-accepts once the OAuth flow completes.
      localStorage.setItem("waynode-pending-invite", token);
      return;
    }

    setAccepting(true);
    fetch(`/api/invites/${token}/accept`, {
      method: "POST",
      headers: getAuthHeaders(),
      credentials: "include",
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Failed to accept invite");
        localStorage.removeItem("waynode-pending-invite");
        navigate("/");
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setAccepting(false));
  }, [loading, user, token, navigate]);

  if (loading) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">⏳</div>
        <div>Loading...</div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="login-page">
        <div className="login-card">
          <WaynodeMark size={48} spin />
          <div className="login-title">You've been invited</div>
          <div className="login-subtitle">Log in to accept this invite</div>

          <a className="login-btn" href="/auth/github">
            Continue with GitHub
          </a>
          <a className="login-btn" href="/auth/gitlab">
            Continue with GitLab
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="empty-state">
      <div className="empty-state-icon">{error ? "✗" : "⏳"}</div>
      <div>{error || (accepting ? "Joining workspace…" : "Accepting invite…")}</div>
    </div>
  );
}
