import { useSyncExternalStore } from "react";
import type { ChatItem, Block, Submission, SubmissionStatus } from "../types";
import { appendText, appendThinking, appendTool, setToolOutput } from "./sessionBlocks";
import { abortSession, loadHistoryItems, openSessionStream, SubmissionError, submitDraft } from "./sessionTransport";
import {
  newDraft, optimisticSubmission, reconcileSubmission,
  type SubmissionDraft, type SubmissionView,
} from "./sessionSubmissions";
let _idSeq = 0;
const uid = () => `c${Date.now()}-${_idSeq++}`;
const eventSentAt = (event: any) => event.createdAt ?? event.created_at ?? event.timestamp ?? new Date().toISOString();
interface SessionState {
  items: ChatItem[];
  streaming: boolean;
  error: string | null;
  status: string | null;
  loaded: boolean;
  connection: "connecting" | "connected" | "reconnecting" | "disconnected";
  queuedCount: number;
  activeStatus: SubmissionStatus | null;
  failedDraft: SubmissionDraft | null;
}

interface SessionEntry {
  state: SessionState;
  listeners: Set<() => void>;
  es: EventSource | null;
  viewers: number;
  closeTimer: ReturnType<typeof setTimeout> | null;
  msgIndex: Map<string, number>; // messageId -> items index
  connectionFailures: number;
}

const EMPTY: SessionState = {
  items: [],
  streaming: false,
  error: null,
  status: null,
  loaded: false,
  connection: "connecting",
  queuedCount: 0,
  activeStatus: null,
  failedDraft: null,
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
      connectionFailures: 0,
    };
    entries.set(sessionId, e);
  }
  return e;
}

function emit(e: SessionEntry) {
  e.state = { ...e.state };
  for (const l of e.listeners) l();
}

function ensureAssistant(e: SessionEntry, messageId: string, sentAt = new Date().toISOString()): number {
  const idx = e.msgIndex.get(messageId);
  if (idx !== undefined) return idx;
  const items = e.state.items.slice();
  const newIdx = items.length;
  items.push({ id: messageId, role: "assistant", blocks: [], done: false, sentAt });
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

function submissionView(e: SessionEntry): SubmissionView {
  return {
    items: e.state.items,
    failedDraft: e.state.failedDraft,
    queuedCount: e.state.queuedCount,
    activeStatus: e.state.activeStatus,
  };
}

function applySubmission(e: SessionEntry, submission: Submission, accepted = true, kind: "message" | "queue" = "message") {
  const next = reconcileSubmission(submissionView(e), submission, { accepted, kind });
  Object.assign(e.state, next);
  if (["starting", "running"].includes(submission.status)) e.state.streaming = true;
  if (submission.status === "failed") {
    e.state.error = submission.error || "Your message wasn’t delivered. Your draft is ready to retry.";
  } else if (["queued", "starting", "running", "completed"].includes(submission.status)) {
    e.state.error = null;
  }
}

function applyEvent(e: SessionEntry, ev: any) {
  switch (ev.type) {
    case "ping":
      return;

    case "sync": {
      e.connectionFailures = 0;
      e.state.connection = "connected";
      e.state.streaming = !!ev.streaming;
      for (const submission of ev.submissions || []) applySubmission(e, submission);
      if (ev.streaming && ev.partialText) {
        const liveIdx = [...e.msgIndex.values()].find((i) => {
          const m = e.state.items[i];
          return m && m.role === "assistant" && !m.done;
        });
        if (liveIdx === undefined) {
          const id = `sync-${uid()}`;
          ensureAssistant(e, id, eventSentAt(ev));
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

    case "submission":
      applySubmission(e, ev.submission);
      if (ev.submission.status === "starting") e.state.status = "Starting agent…";
      if (ev.submission.status === "running") e.state.status = "Agent working";
      if (["completed", "failed", "cancelled"].includes(ev.submission.status)) e.state.status = null;
      emit(e);
      return;

    case "message_start":
      ensureAssistant(e, ev.messageId, eventSentAt(ev));
      emit(e);
      return;

    case "text_delta":
      ensureAssistant(e, ev.messageId, eventSentAt(ev));
      updateAssistant(e, ev.messageId, (b) => appendText(b, ev.delta || ""));
      emit(e);
      return;

    case "thinking_delta":
      ensureAssistant(e, ev.messageId, eventSentAt(ev));
      updateAssistant(e, ev.messageId, (b) => appendThinking(b, ev.delta || ""));
      emit(e);
      return;

    case "tool_start":
      ensureAssistant(e, ev.messageId, eventSentAt(ev));
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
      e.state.streaming = e.state.queuedCount > 0;
      e.state.status = null;
      // Mark all live assistant messages done.
      e.state.items = e.state.items.map((m) =>
        m.role === "assistant" && !m.done ? { ...m, done: true } : m
      );
      emit(e);
      return;

    case "error":
      e.state.streaming = false;
      e.state.error = "The agent stopped unexpectedly. Your conversation is preserved.";
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

function openStream(sessionId: string) {
  const e = getEntry(sessionId);
  if (e.es) return;
  if (e.closeTimer) {
    clearTimeout(e.closeTimer);
    e.closeTimer = null;
  }
  const es = openSessionStream(sessionId);
  e.state.connection = e.connectionFailures > 0 ? "reconnecting" : "connecting";
  emit(e);
  es.onopen = () => {
    e.connectionFailures = 0;
  };
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
  es.onerror = () => {
    e.connectionFailures++;
    e.state.connection = e.connectionFailures >= 3 ? "disconnected" : "reconnecting";
    emit(e);
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
    const diskItems = await loadHistoryItems(sessionId);
    e.state.items = [...diskItems, ...e.state.items];
    e.msgIndex.clear();
    e.state.loaded = true;
    emit(e);
  } catch {
    e.state.loaded = true;
    e.state.error = "Couldn’t load this conversation. Your saved messages are unchanged.";
    emit(e);
  }
}

export function subscribe(sessionId: string, listener: () => void) {
  const e = getEntry(sessionId);
  e.listeners.add(listener);
  return () => e.listeners.delete(listener);
}

export function getSnapshot(sessionId: string): SessionState {
  return getEntry(sessionId).state;
}

async function postDraft(sessionId: string, draft: SubmissionDraft): Promise<boolean> {
  const e = getEntry(sessionId);
  openStream(sessionId);
  try {
    const submission = await submitDraft(sessionId, draft.kind, draft);
    applySubmission(e, submission, true, draft.kind);
    emit(e);
    return true;
  } catch (error) {
    if (draft.kind === "message" && error instanceof SubmissionError && error.status === 409 && error.body?.error === "busy") {
      return postDraft(sessionId, { ...draft, kind: "queue" });
    }
    applySubmission(e, error instanceof SubmissionError && error.body?.submission ? error.body.submission : {
      id: draft.id, prompt: draft.prompt, isGoal: draft.isGoal, status: "failed",
      error: error instanceof Error ? error.message : "Submission failed",
    }, false, draft.kind);
    e.state.streaming = e.state.activeStatus === "running";
    e.state.status = null;
    emit(e);
    return false;
  }
}

export async function send(sessionId: string, prompt: string, isGoal: boolean): Promise<void> {
  const e = getEntry(sessionId);
  const draft = newDraft(prompt, isGoal, "message");
  Object.assign(e.state, optimisticSubmission(submissionView(e), draft));
  e.state.error = null;
  e.state.status = "Sending…";
  emit(e);
  await postDraft(sessionId, draft);
}

export async function queue(sessionId: string, prompt: string, isGoal = false): Promise<boolean> {
  const e = getEntry(sessionId);
  const draft = newDraft(prompt, isGoal, "queue");
  Object.assign(e.state, optimisticSubmission(submissionView(e), draft));
  emit(e);
  return postDraft(sessionId, draft);
}

export async function retry(sessionId: string): Promise<boolean> {
  const e = getEntry(sessionId);
  e.state.error = null;
  e.connectionFailures = 0;
  e.es?.close();
  e.es = null;
  openStream(sessionId);
  if (!e.state.loaded) void loadHistory(sessionId);
  if (e.state.failedDraft) {
    const draft = { ...e.state.failedDraft, sentAt: new Date().toISOString() };
    Object.assign(e.state, optimisticSubmission(submissionView(e), draft));
    e.state.status = "Sending…";
    emit(e);
    return postDraft(sessionId, draft);
  }
  return false;
}

export async function abort(sessionId: string): Promise<void> {
  const e = getEntry(sessionId);
  const result = await abortSession(sessionId);
  if (!result.cancelled && result.reason) {
    e.state.error = result.reason;
    emit(e);
  }
}

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
  return useSyncExternalStore(
    (cb) => subscribe(sessionId, cb),
    () => getSnapshot(sessionId)
  );
}
