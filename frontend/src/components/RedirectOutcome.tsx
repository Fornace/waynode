import { useEffect, useState } from "react";

type Outcome = {
  kind: "success" | "info" | "error";
  title: string;
  message: string;
  billing?: boolean;
};

const STORAGE_KEY = "waynode-redirect-outcome";

function outcomeFromLocation(): Outcome | null {
  const params = new URLSearchParams(window.location.search);
  const billing = params.get("billing");
  const authError = params.get("auth_error");
  if (billing === "success") return {
    kind: "success",
    title: "Checkout completed",
    message: "Stripe is confirming the subscription. Open billing to verify the current plan and renewal date.",
    billing: true,
  };
  if (billing === "cancelled") return {
    kind: "info",
    title: "Checkout cancelled",
    message: "Nothing changed. Your current trial or plan remains in place.",
    billing: true,
  };
  if (!authError) return null;
  const messages: Record<string, string> = {
    session_failed: "The sign-in session could not be secured. Please try again.",
    login_failed: "Waynode could not finish signing you in. Please try again.",
    github_failed: "GitHub sign-in did not complete. Please try again or use another enabled provider.",
    gitlab_failed: "GitLab sign-in did not complete. Please try again or use another enabled provider.",
  };
  return {
    kind: "error",
    title: "Sign-in did not complete",
    message: messages[authError] || "The provider returned an error. Please try again.",
  };
}

export function RedirectOutcome({ canManageBilling, onOpenBilling }: { canManageBilling?: boolean; onOpenBilling?: () => void }) {
  const [outcome, setOutcome] = useState<Outcome | null>(() => {
    const current = outcomeFromLocation();
    if (current) return current;
    try { return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null"); } catch { return null; }
  });

  useEffect(() => {
    const current = outcomeFromLocation();
    if (!current) return;
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(current));
    const url = new URL(window.location.href);
    url.searchParams.delete("billing");
    url.searchParams.delete("auth_error");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  if (!outcome) return null;
  const dismiss = () => {
    sessionStorage.removeItem(STORAGE_KEY);
    setOutcome(null);
  };
  return (
    <aside className={`redirect-outcome ${outcome.kind}`} role={outcome.kind === "error" ? "alert" : "status"}>
      <div><strong>{outcome.title}</strong><span>{outcome.message}</span></div>
      {outcome.billing && canManageBilling && onOpenBilling && <button type="button" onClick={onOpenBilling}>Open billing</button>}
      {outcome.billing && canManageBilling === false && <span className="redirect-outcome-guidance">Ask an organization admin to verify billing.</span>}
      <button type="button" className="redirect-outcome-dismiss" onClick={dismiss} aria-label="Dismiss notification">Dismiss</button>
    </aside>
  );
}
