import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { WaynodeMark } from "../components/Brand";
import { StateSurface } from "../components/StateSurface";

function getAuthHeaders(): Record<string, string> {
  const devToken = localStorage.getItem("waynode-dev-token");
  return devToken ? { "x-dev-token": devToken } : {};
}

export function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const { user, loading, availableProviders, error: authError, retry: retryAuth } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const [accepting, setAccepting] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const lastAttemptRef = useRef("");

  useEffect(() => {
    if (loading) return;
    if (!token) {
      setError("This invite link is incomplete. Ask the sender for a new link.");
      return;
    }
    if (!user) {
      // Preserve the invite so it auto-accepts once the OAuth flow completes.
      localStorage.setItem("waynode-pending-invite", token);
      return;
    }

    const attemptKey = `${token}:${retryCount}`;
    if (lastAttemptRef.current === attemptKey) return;
    lastAttemptRef.current = attemptKey;
    let cancelled = false;
    setAccepting(true);
    setError("");
    fetch(`/api/invites/${token}/accept`, {
      method: "POST",
      headers: getAuthHeaders(),
      credentials: "include",
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "This invite could not be accepted.");
        localStorage.removeItem("waynode-pending-invite");
        navigate("/");
      })
      .catch((e) => { if (!cancelled) setError((e as Error).message); })
      .finally(() => { if (!cancelled) setAccepting(false); });
    return () => { cancelled = true; };
  }, [loading, user, token, navigate, retryCount]);

  if (loading) {
    return (
      <StateSurface title="Checking your invite" description="Confirming your session before opening the worktree." busy />
    );
  }

  if (authError) return <StateSurface
    title="Couldn’t reach Waynode"
    description={`${authError} Your invite has been kept on this device.`}
    tone="error"
    action={{ label: "Try again", onClick: retryAuth }}
  />;

  if (!user) {
    return (
      <div className="login-page">
        <div className="login-card">
          <WaynodeMark size={48} />
          <div className="login-title">You've been invited</div>
          <div className="login-subtitle">Log in to accept this invite</div>

          {availableProviders.github && <a className="login-btn" href="/auth/github">
            Continue with GitHub
          </a>}
          {availableProviders.gitlab && <a className="login-btn" href="/auth/gitlab">
            Continue with GitLab
          </a>}
          {!availableProviders.github && !availableProviders.gitlab && <p className="login-provider-empty">No sign-in provider is available on this server. Ask the administrator to enable one.</p>}
        </div>
      </div>
    );
  }

  if (error) return <StateSurface
    title="Couldn’t accept this invite"
    description={`${error} Your existing worktrees and sessions are unchanged.`}
    tone="error"
    action={{ label: "Try again", onClick: () => setRetryCount((value) => value + 1) }}
    secondaryAction={{ label: "Go to Waynode", onClick: () => navigate("/") }}
  />;

  return <StateSurface
    title={accepting ? "Joining the organization" : "Preparing your invite"}
    description="This may take a moment. You’ll be taken to its worktrees when it’s ready."
    busy
  />;
}
