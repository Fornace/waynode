/**
 * Per-session event bus. SSE subscribers attach to the session, not to a
 * specific agent handle, so a viewer that opens a stream on an idle session
 * (no agent running) starts receiving events the moment a later POST spawns
 * one, and survives handle swaps (crash + respawn, chat/terminal reclaim).
 */

const buses = new Map();

export function subscribeSession(sessionId, subscriber) {
  let set = buses.get(sessionId);
  if (!set) {
    set = new Set();
    buses.set(sessionId, set);
  }
  set.add(subscriber);
  return () => {
    const current = buses.get(sessionId);
    if (!current) return;
    current.delete(subscriber);
    if (current.size === 0) buses.delete(sessionId);
  };
}

export function publishSessionEvent(sessionId, event) {
  const set = buses.get(sessionId);
  if (!set) return;
  for (const subscriber of set) {
    try {
      subscriber(event);
    } catch {}
  }
}

export function subscriberCount(sessionId) {
  return buses.get(sessionId)?.size ?? 0;
}
