export interface BillingPlan {
  name: string;
  price: number;
  storageBytes: number;
  tokensPerMonth: number;
  seats: number;
}

export interface BillingInfo {
  enabled: boolean;
  plan: string;
  status: string;
  current_period_end: string | null;
  can_manage_billing: boolean;
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

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return String(value);
}

function formatDate(value: string | null): string {
  if (!value) return "";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}

function UsageBar({ label, used, limit, valueText }: { label: string; used: number; limit: number; valueText: string }) {
  const percentage = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const className = percentage >= 100 ? "usage-bar-over" : percentage >= 80 ? "usage-bar-warn" : "";
  return <div className="usage-bar-track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percentage)} aria-valuetext={valueText}><div className={`usage-bar-fill ${className}`} style={{ width: `${percentage}%` }} /></div>;
}

interface OrgBillingProps {
  billing: BillingInfo;
  busy: string | null;
  error: string;
  onCheckout: (plan: string) => void;
  onOpenPortal: () => void;
}

export function OrgBilling({ billing, busy, error, onCheckout, onOpenPortal }: OrgBillingProps) {
  const currentName = billing.plans[billing.plan]?.name || (billing.plan === "trial" ? "Free trial" : "No active plan");
  const periodEnd = formatDate(billing.current_period_end);
  const currentDetail = billing.status === "expired"
    ? `Trial ended${periodEnd ? ` ${periodEnd}` : ""} · choose a plan to continue agent work`
    : billing.plan === "trial"
      ? `1 seat · trial ends${periodEnd ? ` ${periodEnd}` : " soon"}`
      : `${billing.plans[billing.plan]?.price ? `$${billing.plans[billing.plan].price}/month` : billing.status}${periodEnd ? ` · renews ${periodEnd}` : ""}`;
  return <>
    <div className="settings-section">
      <div className="settings-section-title">Current Plan</div>
      <div className="field-card"><div className="field-row">
        <div className="field-row-head">
          <span className="field-row-label">{currentName}</span>
          <span className="field-row-hint">{currentDetail}</span>
        </div>
        {billing.can_manage_billing && <button className="btn-secondary" onClick={onOpenPortal} disabled={busy !== null}>{busy === "portal" ? "Opening…" : "Manage billing"}</button>}
      </div></div>
    </div>

    <div className="settings-section">
      <div className="settings-section-title">Usage This Period</div>
      <div className="field-card">
        <div className="field-row"><div className="field-row-head"><span className="field-row-label">Tokens</span><span className="field-row-hint">{formatTokens(billing.quota.tokens.used)} / {formatTokens(billing.quota.tokens.limit)}</span></div><UsageBar label="Token usage" used={billing.quota.tokens.used} limit={billing.quota.tokens.limit} valueText={`${formatTokens(billing.quota.tokens.used)} of ${formatTokens(billing.quota.tokens.limit)} tokens`} /></div>
        <div className="field-row"><div className="field-row-head"><span className="field-row-label">Storage</span><span className="field-row-hint">{formatBytes(billing.quota.storage.used)} / {formatBytes(billing.quota.storage.limit)}</span></div><UsageBar label="Storage usage" used={billing.quota.storage.used} limit={billing.quota.storage.limit} valueText={`${formatBytes(billing.quota.storage.used)} of ${formatBytes(billing.quota.storage.limit)}`} /></div>
      </div>
    </div>

    <div className="settings-section">
      <div className="settings-section-title">Plans</div>
      {error && <div className="field-row-hint" role="alert" style={{ color: "var(--red)", marginBottom: 10 }}>{error}</div>}
      <div className="plan-grid">
        {(["starter", "pro", "team", "hammersmith"] as const).map((planId) => {
          const plan = billing.plans[planId];
          if (!plan) return null;
          const isCurrent = billing.plan === planId;
          return <div key={planId} className={`plan-card ${isCurrent ? "plan-card-current" : ""}`}>
            <div className="plan-card-name">{plan.name}</div>
            <div className="plan-card-price">${plan.price}<span>/mo</span></div>
            <div className="plan-card-specs">{formatTokens(plan.tokensPerMonth)} tokens/mo<br />{formatBytes(plan.storageBytes)} storage<br />{plan.seats} seats</div>
            {isCurrent
              ? <button className="btn-secondary" disabled>Current plan</button>
              : <button className="btn-primary" onClick={() => onCheckout(planId)} disabled={busy !== null}>{busy === planId ? "Redirecting…" : ["free", "trial"].includes(billing.plan) ? "Choose plan" : "Switch plan"}</button>}
          </div>;
        })}
      </div>
    </div>
  </>;
}
