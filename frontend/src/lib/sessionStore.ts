import { useSyncExternalStore } from "react";
import type { ChatItem, Block } from "../types";

/**
 * sessionStore
 * ------------
 * Module-scoped singleton that owns per-session chat state AND the live SSE
 * connection. Because it lives here (not inside a React component), navigating
 * between sessions does NOT tear down the stream — a turn keeps streaming in the
 * background, and returning to the session shows the full, up-to-date state
 * instantly from cache.
 *
 * Lifecycle:
 *  - `acquire(sessionId)`  → load disk history + open the SSE stream (refcount++)
 *  - `release(sessionId)`  → refcount--; close the stream when idle & unviewed
 *  - `send/queue/abort`    → drive the server-side agent
 */

const DEV_TOKEN = localStorage.getItem("waynode-dev-token") || "";
const authQ = DEV_TOKEN ? `?t=${encodeURIComponent(DEV_TOKEN)}` : "";
const jsonHeaders: Record<string, string> = {
  "Content-Type": "application/json",
  ...(DEV_TOKEN ? { "x-dev-token": DEV_TOKEN } : {}),
};

let _idSeq = 0;
const uid = () => `c${Date.now()}-${_idSeq++}`;

interface SessionState {
  items: ChatItem[];
  streaming: boolean;
  error: string | null;
  status: string | null;
  loaded: boolean;
}

interface SessionEntry {
  state: SessionState;
  listeners: Set<() => void>;
  es: EventSource | null;
  viewers: number;
  closeTimer: ReturnType<typeof setTimeout> | null;
  msgIndex: Map<string, number>; // messageId -> items index
}

const EMPTY: SessionState = {
  items: [],
  streaming: false,
  error: null,
  status: null,
  loaded: false,
};

const entries = new Map<string, SessionEntry>();
const renameListeners = new Set<(sessionId: string, title: string) => void>();

function getEntry(sessionId: string): SessionEntry {
  let e = entries.get(sessionId);
  if (!e) {
    e = {
      state: { ...EMPTY, items: [] },
      listeners: new Set(),
      es: null,
      viewers: 0,
      closeTimer: null,
      msgIndex: new Map(),
    };
    entries.set(sessionId, e);
  }
  return e;
}

function emit(e: SessionEntry) {
  // Shallow-clone state so useSyncExternalStore sees a new reference.
  e.state = { ...e.state };
  for (const l of e.listeners) l();
}

// ── Mutations ──

function ensureAssistant(e: SessionEntry, messageId: string): number {
  const idx = e.msgIndex.get(messageId);
  if (idx !== undefined) return idx;
  const items = e.state.items.slice();
  const newIdx = items.length;
  items.push({ id: messageId, role: "assistant", blocks: [], done: false });
  e.state.items = items;
  e.msgIndex.set(messageId, newIdx);
  return newIdx;
}

function updateAssistant(e: SessionEntry, messageId: string, fn: (blocks: Block[]) => Block[]) {
  const idx = e.msgIndex.get(messageId);
  if (idx === undefined) return;
  const items = e.state.items.slice();
  const msg = items[idx];
  if (msg.role !== "assistant") return;
  items[idx] = { ...msg, blocks: fn(msg.blocks) };
  e.state.items = items;
}

function applyEvent(e: SessionEntry, ev: any) {
  switch (ev.type) {
    case "ping":
      return;

    case "sync": {
      // Reconnect snapshot. If streaming with partial text and no live msg, create one.
      e.state.streaming = !!ev.streaming;
      if (ev.streaming && ev.partialText) {
        const liveIdx = [...e.msgIndex.values()].find((i) => {
          const m = e.state.items[i];
          return m && m.role === "assistant" && !m.done;
        });
        if (liveIdx === undefined) {
          const id = `sync-${uid()}`;
          ensureAssistant(e, id);
          updateAssistant(e, id, (b) => appendText(b, ev.partialText));
        }
      }
      emit(e);
      return;
    }

    case "start":
      e.state.streaming = true;
      e.state.error = null;
      emit(e);
      return;

    case "message_start":
      ensureAssistant(e, ev.messageId);
      emit(e);
      return;

    case "text_delta":
      ensureAssistant(e, ev.messageId);
      updateAssistant(e, ev.messageId, (b) => appendText(b, ev.delta || ""));
      emit(e);
      return;

    case "thinking_delta":
      ensureAssistant(e, ev.messageId);
      updateAssistant(e, ev.messageId, (b) => appendThinking(b, ev.delta || ""));
      emit(e);
      return;

    case "tool_start":
      ensureAssistant(e, ev.messageId);
      updateAssistant(e, ev.messageId, (b) =>
        appendTool(b, { id: ev.toolCallId, name: ev.toolName, args: ev.args })
      );
      emit(e);
      return;

    case "tool_delta":
      ensureAssistant(e, ev.messageId);
      updateAssistant(e, ev.messageId, (b) =>
        setToolOutput(b, ev.toolCallId, ev.text || "", "running")
      );
      emit(e);
      return;

    case "tool_end":
      updateAssistant(e, ev.messageId, (b) =>
        setToolOutput(b, ev.toolCallId, ev.text || "", ev.isError ? "error" : "done")
      );
      emit(e);
      return;

    case "status":
      e.state.status = ev.text || null;
      emit(e);
      return;

    case "end":
      e.state.streaming = false;
      e.state.status = null;
      // Mark all live assistant messages done.
      e.state.items = e.state.items.map((m) =>
        m.role === "assistant" && !m.done ? { ...m, done: true } : m
      );
      emit(e);
      return;

    case "error":
      e.state.streaming = false;
      e.state.error = ev.message || "Unknown error";
      e.state.items = [
        ...e.state.items,
        { id: uid(), role: "system", content: `⚠ ${ev.message || "Error"}` },
      ];
      emit(e);
      return;

    case "session_renamed":
      for (const l of renameListeners) l(/* sessionId via closure not available */ "", ev.title);
      // We don't know sessionId here from the event, but the active stream owns it.
      // The store tags events with sessionId in onMessage before dispatch.
      emit(e);
      return;
  }
}

function appendText(blocks: Block[], text: string): Block[] {
  const out = blocks.slice();
  const last = out[out.length - 1];
  if (last && last.type === "text") out[out.length - 1] = { ...last, text: last.text + text };
  else out.push({ type: "text", text });
  return out;
}

function appendThinking(blocks: Block[], text: string): Block[] {
  const out = blocks.slice();
  const last = out[out.length - 1];
  if (last && last.type === "thinking") out[out.length - 1] = { ...last, text: last.text + text };
  else out.push({ type: "thinking", text });
  return out;
}

function appendTool(blocks: Block[], t: { id: string; name: string; args: any }): Block[] {
  const out = blocks.slice();
  if (!out.some((b) => b.type === "tool" && b.id === t.id)) {
    out.push({ type: "tool", id: t.id, name: t.name, args: t.args, output: "", status: "running" });
  }
  return out;
}

function setToolOutput(
  blocks: Block[],
  id: string,
  output: string,
  status: "running" | "done" | "error"
): Block[] {
  return blocks.map((b) => (b.type === "tool" && b.id === id ? { ...b, output, status } : b));
}

// ── SSE lifecycle ──

function openStream(sessionId: string) {
  const e = getEntry(sessionId);
  if (e.es) return;
  if (e.closeTimer) {
    clearTimeout(e.closeTimer);
    e.closeTimer = null;
  }
  const es = new EventSource(`/api/sessions/${sessionId}/stream${authQ}`, { withCredentials: true });
  es.onmessage = (msg) => {
    try {
      const ev = JSON.parse(msg.data);
      // Tag rename events with the owning session.
      if (ev.type === "session_renamed") {
        for (const l of renameListeners) l(sessionId, ev.title);
        return;
      }
      applyEvent(e, ev);
    } catch {}
  };
  e.es = es;
}

function scheduleClose(sessionId: string) {
  const e = getEntry(sessionId);
  if (e.closeTimer) clearTimeout(e.closeTimer);
  e.closeTimer = setTimeout(() => {
    if (e.viewers <= 0 && !e.state.streaming) {
      e.es?.close();
      e.es = null;
    }
    e.closeTimer = null;
  }, 30000);
}

// ── Public API ──

export function acquire(sessionId: string) {
  const e = getEntry(sessionId);
  e.viewers++;
  if (!e.state.loaded) loadHistory(sessionId);
  openStream(sessionId);
  return () => release(sessionId);
}

export function release(sessionId: string) {
  const e = getEntry(sessionId);
  e.viewers = Math.max(0, e.viewers - 1);
  if (e.viewers <= 0 && !e.state.streaming) scheduleClose(sessionId);
}

async function loadHistory(sessionId: string) {
  const e = getEntry(sessionId);
  try {
    const res = await fetch(`/api/sessions/${sessionId}/messages`, {
      credentials: "include",
      headers: jsonHeaders,
    });
    const msgs = (await res.json()) as { role: string; content: string; thinking?: string | null }[];
    e.state.items = msgs.map((m) => {
      if (m.role === "assistant") {
        const blocks: Block[] = [];
        if (m.thinking) blocks.push({ type: "thinking", text: m.thinking });
        blocks.push({ type: "text", text: m.content || "" });
        return { id: uid(), role: "assistant" as const, blocks, done: true };
      }
      return { id: uid(), role: m.role as any, content: m.content };
    });
    e.msgIndex.clear();
    e.state.loaded = true;
    emit(e);
  } catch {}
}

export function subscribe(sessionId: string, listener: () => void) {
  const e = getEntry(sessionId);
  e.listeners.add(listener);
  return () => e.listeners.delete(listener);
}

export function getSnapshot(sessionId: string): SessionState {
  return getEntry(sessionId).state;
}

export async function send(sessionId: string, prompt: string, isGoal: boolean): Promise<void> {
  const e = getEntry(sessionId);
  // Optimistic user message.
  e.state.items = [...e.state.items, { id: uid(), role: "user", content: prompt, isGoal }];
  e.state.error = null;
  emit(e);

  openStream(sessionId); // ensure events can flow

  const res = await fetch(`/api/sessions/${sessionId}/message`, {
    method: "POST",
    credentials: "include",
    headers: jsonHeaders,
    body: JSON.stringify({ prompt, isGoal }),
  });

  if (res.status === 409) {
    // Busy → queue a follow-up.
    await queue(sessionId, prompt);
  } else if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    e.state.items = [
      ...e.state.items,
      { id: uid(), role: "system", content: `⚠ ${body.error || res.statusText}` },
    ];
    emit(e);
  }
}

export async function queue(sessionId: string, prompt: string): Promise<void> {
  const e = getEntry(sessionId);
  e.state.items = [
    ...e.state.items,
    { id: uid(), role: "system", content: `📝 Queued: "${prompt.slice(0, 80)}${prompt.length > 80 ? "…" : ""}"` },
  ];
  emit(e);
  await fetch(`/api/sessions/${sessionId}/queue`, {
    method: "POST",
    credentials: "include",
    headers: jsonHeaders,
    body: JSON.stringify({ prompt }),
  });
}

export async function abort(sessionId: string): Promise<void> {
  await fetch(`/api/sessions/${sessionId}/abort`, {
    method: "POST",
    credentials: "include",
    headers: jsonHeaders,
  });
}

export function onRename(cb: (sessionId: string, title: string) => void): () => void {
  renameListeners.add(cb);
  return () => renameListeners.delete(cb);
}

// ── React binding ──

export function useSessionChat(sessionId: string) {
  return useSyncExternalStore(
    (cb) => subscribe(sessionId, cb),
    () => getSnapshot(sessionId)
  );
}
