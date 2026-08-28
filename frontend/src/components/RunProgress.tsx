interface RunProgressProps {
  active: boolean;
  status: string | null;
  queued: number;
  connection: "connecting" | "connected" | "reconnecting" | "disconnected";
}

/**
 * Compact, always-legible truth about the current run. It never invents
 * certainty: activity, connectivity, and queued work are shown independently.
 */
export function RunProgress({ active, status, queued, connection }: RunProgressProps) {
  if (!active && queued === 0) return null;
  const connectionText = connection === "connected" ? "Live"
    : connection === "connecting" ? "Connecting"
      : connection === "reconnecting" ? "Reconnecting" : "Offline";
  const phase = status || (active ? "Agent working…" : "Waiting to start…");
  return (
    <div className={`run-progress is-${connection}`} role="status" aria-live="polite">
      <span className="run-progress-pulse" aria-hidden="true" />
      <div className="run-progress-copy">
        <strong>{phase}</strong>
        <span>Work continues on the server if you close this page.</span>
      </div>
      <div className="run-progress-meta" aria-label="Run state">
        <span className={`run-live-badge is-${connection}`}>{connectionText}</span>
        {queued > 0 && <span>{queued} queued</span>}
      </div>
    </div>
  );
}
