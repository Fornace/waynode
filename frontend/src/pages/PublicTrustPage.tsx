import { useCallback, useEffect, useState } from "react";
import { WaynodeMark } from "../components/Brand";
import { PrivacyPolicyContent } from "./PrivacyPolicyContent";
import { TermsContent } from "./TermsContent";
import { SecurityContent, SupportContent } from "./TrustSupportContent";

type Page = "privacy" | "terms" | "security" | "support" | "status";
type ServiceState = "checking" | "operational" | "unavailable";

const pageInfo: Record<Page, { title: string; eyebrow: string; summary: string; sections: [string, string][] }> = {
  privacy: {
    title: "Privacy notice", eyebrow: "Your data and operating boundary",
    summary: "What Waynode Cloud processes, why, who receives it, and the controls available to you.",
    sections: [["scope", "Scope"], ["data", "Data"], ["basis", "Purposes"], ["sharing", "Recipients"], ["retention", "Retention"], ["rights", "Rights"], ["cookies", "Cookies"]],
  },
  terms: {
    title: "Terms of service", eyebrow: "Waynode Cloud terms",
    summary: "The service boundary, subscription lifecycle, consumer withdrawal information, and responsibilities on both sides.",
    sections: [["service", "Service"], ["accounts", "Accounts"], ["subscription", "Subscription"], ["withdrawal", "Withdrawal"], ["use", "Acceptable use"], ["ownership", "Ownership"], ["availability", "Availability"], ["ending", "Ending service"]],
  },
  security: {
    title: "Security", eyebrow: "Controls, limits, and reporting",
    summary: "Implemented Cloud controls and a direct path for good-faith vulnerability reports.",
    sections: [["boundary", "Boundary"], ["controls", "Controls"], ["limits", "Limits"], ["report", "Report"]],
  },
  support: {
    title: "Support", eyebrow: "Get useful help without exposing secrets",
    summary: "The right channel for Cloud accounts, billing, security, and self-hosted community issues.",
    sections: [["contact", "Contact"], ["include", "What to include"], ["billing", "Billing"], ["self-host", "Self-hosted"]],
  },
  status: {
    title: "Service status", eyebrow: "Current Waynode Cloud readiness",
    summary: "A live, deliberately narrow readiness signal. No infrastructure or customer detail is exposed.",
    sections: [["current", "Current status"], ["meaning", "What this means"], ["help", "Report a problem"]],
  },
};

function TrustFooter() {
  return <footer className="trust-footer">
    <span>Waynode · operated under the public trading name Fornace, Italy</span>
    <nav aria-label="Trust and support">
      <a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/security">Security</a>
      <a href="/support">Support</a><a href="/status">Status</a>
    </nav>
    <a href="mailto:info@fornacestudio.com">info@fornacestudio.com</a>
  </footer>;
}

function StatusContent() {
  const [state, setState] = useState<ServiceState>("checking");
  const [checkedAt, setCheckedAt] = useState("");
  const check = useCallback(async () => {
    setState("checking");
    try {
      const response = await fetch("/api/health/ready", { cache: "no-store" });
      const body = await response.json().catch(() => null);
      setState(response.ok && body?.ready === true ? "operational" : "unavailable");
    } catch { setState("unavailable"); }
    setCheckedAt(new Date().toLocaleString());
  }, []);
  useEffect(() => { void check(); }, [check]);

  const copy = state === "operational"
    ? "All public readiness checks are passing."
    : state === "unavailable"
      ? "Waynode Cloud is not currently passing every readiness check."
      : "Checking Waynode Cloud now…";
  return <>
    <section id="current"><h2>Current status</h2>
      <div className={`service-state ${state}`} role="status" aria-live="polite">
        <span aria-hidden="true" /><div><strong>{state === "operational" ? "Operational" : state === "unavailable" ? "Service interruption" : "Checking"}</strong><p>{copy}</p></div>
      </div>
      <div className="status-actions"><button type="button" onClick={() => void check()} disabled={state === "checking"}>Check again</button>{checkedAt && <span>Checked from this device: {checkedAt}</span>}</div>
    </section>
    <section id="meaning"><h2>What this signal means</h2><p>
      It reflects whether the managed service can currently satisfy its readiness gate.
      It does not expose dependency names, deployment identifiers, customer data, an
      incident history, or component-level diagnostics. It is not an uptime SLA.
    </p></section>
    <section id="help"><h2>Seeing something different?</h2><p>
      A local network, OAuth provider, repository provider, or account-specific problem
      may not change this signal. See <a href="/support">Support</a> and include the time,
      device, organization, action, and redacted error. For security concerns, use
      <a href="/security"> the security reporting path</a>.
    </p></section>
  </>;
}

function PageContent({ page }: { page: Page }) {
  if (page === "privacy") return <PrivacyPolicyContent />;
  if (page === "terms") return <TermsContent />;
  if (page === "security") return <SecurityContent />;
  if (page === "support") return <SupportContent />;
  return <StatusContent />;
}

export function PublicTrustPage({ page }: { page: Page }) {
  const info = pageInfo[page];
  useEffect(() => {
    const priorTitle = document.title;
    const description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    const priorDescription = description?.content;
    document.title = `${info.title} · Waynode`;
    if (description) description.content = info.summary;
    const hash = window.location.hash.slice(1);
    if (hash) requestAnimationFrame(() => document.getElementById(hash)?.scrollIntoView());
    else window.scrollTo(0, 0);
    return () => {
      document.title = priorTitle;
      if (description && priorDescription !== undefined) description.content = priorDescription;
    };
  }, [info]);

  return <div className="trust-page">
    <a className="skip-link" href="#trust-content">Skip to main content</a>
    <header className="trust-header">
      <a className="product-brand" href="/" aria-label="Waynode home"><WaynodeMark size={28} tension /><span>Waynode</span></a>
      <nav aria-label="Public navigation"><a href="/security">Security</a><a href="/support">Support</a><a className="product-sign-in" href="/login">Sign in</a></nav>
    </header>
    <main id="trust-content" className="trust-main" tabIndex={-1}>
      <div className="trust-hero"><p className="product-eyebrow">{info.eyebrow}</p><h1>{info.title}</h1><p>{info.summary}</p><span>Effective 15 July 2026 · Fornace · Italy</span></div>
      <div className="trust-layout">
        <aside aria-label="On this page"><strong>On this page</strong>{info.sections.map(([id, label]) => <a href={`#${id}`} key={id}>{label}</a>)}</aside>
        <article className="trust-document"><PageContent page={page} /></article>
      </div>
    </main>
    <TrustFooter />
  </div>;
}
