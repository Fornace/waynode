/**
 * lib/clone-progress.mjs — in-memory registry for streaming git clone progress.
 *
 * Clones are kicked off in the background after the space row exists; clients
 * subscribe via SSE (/api/spaces/:id/clone-events) to get live progress lines.
 * No DB column needed — entries are short-lived and auto-cleaned after the clone
 * settles (or 5 min), so a late subscriber to an already-finished space just
 * sees nothing.
 */
const CLEANUP_MS = 5 * 60 * 1000;

// spaceId -> { lines: string[], done: bool, error: string|null, subscribers: Set<fn>, timer }
const registry = new Map();

export function startClone(spaceId) {
  const existing = registry.get(spaceId);
  if (existing && existing.timer) clearTimeout(existing.timer);
  registry.set(spaceId, { lines: [], done: false, error: null, subscribers: new Set(), timer: null });
}

export function publish(spaceId, line) {
  const e = registry.get(spaceId);
  if (!e) return;
  e.lines.push(line);
  for (const fn of e.subscribers) fn({ type: "progress", line });
}

export function finishClone(spaceId, error = null) {
  const e = registry.get(spaceId);
  if (!e) return;
  if (error) e.error = error;
  else e.done = true;
  for (const fn of e.subscribers) fn({ type: error ? "error" : "done", error });
  e.subscribers.clear();
  // Keep the buffered lines around briefly so a late SSE opener can replay.
  e.timer = setTimeout(() => registry.delete(spaceId), CLEANUP_MS).unref?.();
}

/**
 * Subscribe to a clone's progress. Replays buffered lines + terminal state, then
 * streams live. Returns an unsubscribe fn. Safe to call for an unknown/finished
 * spaceId (replays nothing, returns noop).
 */
export function subscribe(spaceId, fn) {
  const e = registry.get(spaceId);
  if (!e) return () => {};
  for (const line of e.lines) fn({ type: "progress", line });
  if (e.error) fn({ type: "error", error: e.error });
  if (e.done) fn({ type: "done" });
  if (e.done || e.error) return () => {};
  e.subscribers.add(fn);
  return () => e.subscribers.delete(fn);
}
