// Per-session unsent-draft persistence. Survives ChatTab remounts on session
// switch so the user never loses what they were typing when navigating between
// sessions. Cleared on successful send. Backed by sessionStorage when available
// (survives a page refresh within the same tab); falls back to a module-level
// Map when sessionStorage is unavailable (SSR, restricted contexts).

const KEY_PREFIX = "waynode-draft:";
const memory = new Map<string, string>();

function readStore(): Storage | null {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage : null;
  } catch {
    return null;
  }
}

export function get(sessionId: string): string {
  try {
    const store = readStore();
    if (store) return store.getItem(KEY_PREFIX + sessionId) ?? "";
  } catch {
    // fall through to memory
  }
  return memory.get(sessionId) ?? "";
}

export function set(sessionId: string, value: string): void {
  memory.set(sessionId, value);
  try {
    const store = readStore();
    if (store) store.setItem(KEY_PREFIX + sessionId, value);
  } catch {
    // memory Map already updated above
  }
}

export function clear(sessionId: string): void {
  memory.delete(sessionId);
  try {
    const store = readStore();
    if (store) store.removeItem(KEY_PREFIX + sessionId);
  } catch {
    // memory Map already updated above
  }
}
