import { WaynodeMark } from "./Brand";

interface StateSurfaceProps {
  title: string;
  description?: string;
  busy?: boolean;
  tone?: "neutral" | "error";
  action?: { label: string; onClick: () => void };
  secondaryAction?: { label: string; onClick: () => void };
  compact?: boolean;
}

export function StateSurface({ title, description, busy = false, tone = "neutral", action, secondaryAction, compact = false }: StateSurfaceProps) {
  return (
    <section
      className={`state-surface is-${tone} ${compact ? "is-compact" : ""}`}
      role={tone === "error" ? "alert" : "status"}
      aria-live={tone === "error" ? "assertive" : "polite"}
      aria-busy={busy}
    >
      {busy && <span className="state-progress" aria-hidden="true" />}
      {!busy && <span className="state-brand-mark" aria-hidden="true"><WaynodeMark size={28} /></span>}
      <h1>{title}</h1>
      {description && <p>{description}</p>}
      {(action || secondaryAction) && (
        <div className="state-actions">
          {action && <button type="button" className="state-primary" onClick={action.onClick}>{action.label}</button>}
          {secondaryAction && <button type="button" className="state-secondary" onClick={secondaryAction.onClick}>{secondaryAction.label}</button>}
        </div>
      )}
    </section>
  );
}
