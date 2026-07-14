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

function UsageBar({ used, limit }: { used: number; limit: number }) {
  const percentage = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const className = percentage >= 100 ? "usage-bar-over" : percentage >= 80 ? "usage-bar-warn" : "";
  return <div className="usage-bar-track"><div className={`usage-bar-fill ${className}`} style={{ width: `${percentage}%` }} /></div>;
}

interface OrgBillingProps {
  billing: BillingInfo;
  busy: string | null;
  error: string;
  onCheckout: (plan: string) => void;
  onOpenPortal: () => void;
}

export function OrgBilling({ billing, busy, error, onCheckout, onOpenPortal }: OrgBillingProps) {
  return <>
    <div className="settings-section">
      <div className="settings-section-title">Current Plan</div>
      <div className="field-card"><div className="field-row">
        <div className="field-row-head">
          <span className="field-row-label">{billing.plans[billing.plan]?.name || billing.plan}</span>
          <span className="field-row-hint">
            {billing.plan === "free" ? "Free forever" : `$${billing.plans[billing.plan]?.price}/mo`}
            {billing.status !== "active" && ` · ${billing.status}`}
          </span>
        </div>
        {billing.plan !== "free" && <button className="btn-secondary" onClick={onOpenPortal} disabled={busy === "portal"}>{busy === "portal" ? "Opening…" : "Manage billing"}</button>}
      </div></div>
    </div>

    <div className="settings-section">
      <div className="settings-section-title">Usage This Period</div>
      <div className="field-card">
        <div className="field-row"><div className="field-row-head"><span className="field-row-label">Tokens</span><span className="field-row-hint">{formatTokens(billing.quota.tokens.used)} / {formatTokens(billing.quota.tokens.limit)}</span></div><UsageBar used={billing.quota.tokens.used} limit={billing.quota.tokens.limit} /></div>
        <div className="field-row"><div className="field-row-head"><span className="field-row-label">Storage</span><span className="field-row-hint">{formatBytes(billing.quota.storage.used)} / {formatBytes(billing.quota.storage.limit)}</span></div><UsageBar used={billing.quota.storage.used} limit={billing.quota.storage.limit} /></div>
      </div>
    </div>

    <div className="settings-section">
      <div className="settings-section-title">Plans</div>
      {error && <div className="field-row-hint" style={{ color: "var(--red)", marginBottom: 10 }}>{error}</div>}
      <div className="plan-grid">
        {(["starter", "pro", "team"] as const).map((planId) => {
          const plan = billing.plans[planId];
          if (!plan) return null;
          const isCurrent = billing.plan === planId;
          return <div key={planId} className={`plan-card ${isCurrent ? "plan-card-current" : ""}`}>
            <div className="plan-card-name">{plan.name}</div>
            <div className="plan-card-price">${plan.price}<span>/mo</span></div>
            <div className="plan-card-specs">{formatTokens(plan.tokensPerMonth)} tokens/mo<br />{formatBytes(plan.storageBytes)} storage<br />{plan.seats} seats</div>
            {isCurrent
              ? <button className="btn-secondary" disabled>Current plan</button>
              : <button className="btn-primary" onClick={() => onCheckout(planId)} disabled={busy === planId}>{busy === planId ? "Redirecting…" : billing.plan === "free" ? "Upgrade" : "Switch"}</button>}
          </div>;
        })}
      </div>
    </div>
  </>;
}
