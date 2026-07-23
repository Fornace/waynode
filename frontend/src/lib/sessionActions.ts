import { useSyncExternalStore } from "react";
import { getEntry, emit, uid, renameListeners, subscribe, getSnapshot } from "./sessionStore";

export function injectSystem(sessionId: string, content: string) {
  const e = getEntry(sessionId);
  e.state.items = [...e.state.items, { id: uid(), role: "system", content, sentAt: new Date().toISOString() }];
  emit(e);
}
export function injectProgress(sessionId: string, key: string, content: string) {
  const e = getEntry(sessionId);
  const items = e.state.items.slice();
  const last = items[items.length - 1];
  if (last && last.role === "system" && (last as any).key === key) {
    items[items.length - 1] = { ...last, content } as any;
  } else {
    items.push({ id: uid(), role: "system", content, key, sentAt: new Date().toISOString() });
  }
  e.state.items = items;
  emit(e);
}
export function onRename(cb: (sessionId: string, title: string) => void): () => void {
  renameListeners.add(cb);
  return () => renameListeners.delete(cb);
}
export function useSessionChat(sessionId: string) {
  return useSyncExternalStore((cb) => subscribe(sessionId, cb), () => getSnapshot(sessionId));
}
