import type { HammersmithRun } from "../types";
import { hammersmithRunTitle } from "../lib/sessionSubmissions";

function trustedMonitor(url: string | null) {
  if (!url) return null;
  try {
    const parsed = new URL(url, window.location.origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    return parsed;
  } catch { return null; }
}

function ageLabel(updatedAt: string) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(updatedAt).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ago`;
}

export function HammersmithRunWidget({ run }: { run: HammersmithRun }) {
  const checked = Math.min(run.totalTasks, run.checkedTasks);
  const monitor = trustedMonitor(run.monitorUrl);
  const title = hammersmithRunTitle(run);

  return (
    <article className={`hammersmith-run lifecycle-${run.lifecycle}`} aria-labelledby={`hammersmith-title-${run.id}`}>
      <div className="hammersmith-run-head">
        <span className="hammersmith-run-mark" aria-hidden="true">H</span>
        <div>
          <span className="hammersmith-run-kicker">Hammersmith</span>
          <strong id={`hammersmith-title-${run.id}`}>{title}</strong>
        </div>
      </div>
      <div className="hammersmith-run-counts" aria-label={`${checked} of ${run.totalTasks} checked, ${run.passedTasks} passed, ${run.failedTasks} failed`}>
        <span><b>{checked}/{run.totalTasks}</b> checked</span>
        <span><b>{run.passedTasks}</b> passed</span>
        <span><b>{run.failedTasks}</b> failed</span>
      </div>
      <div className="hammersmith-progress" role="progressbar" aria-label="Verified swarm progress" aria-valuemin={0} aria-valuemax={Math.max(1, run.totalTasks)} aria-valuenow={checked}>
        <span style={{ width: `${run.totalTasks ? checked / run.totalTasks * 100 : 0}%` }} />
      </div>
      {run.freshness !== "live" && run.freshness !== "loading" && (
        <p className="hammersmith-stale">Last update {ageLabel(run.updatedAt)}</p>
      )}
      {run.error && <p className="hammersmith-run-error">{run.error}</p>}
      <div className="hammersmith-run-actions">
        {monitor && <a href={monitor.toString()} target="_blank" rel="noopener noreferrer" aria-label={`Open full monitor on trusted host ${monitor.host}, opens in a new tab`}>Open full monitor →</a>}
        {!monitor && <span className="hammersmith-monitor-unavailable">Monitor link unavailable</span>}
        {run.freshness === "unavailable" && <button type="button" onClick={() => window.location.reload()}>Retry status</button>}
      </div>
      <span className="sr-only" aria-live="polite">{title}. {checked} of {run.totalTasks} checked.</span>
    </article>
  );
}
