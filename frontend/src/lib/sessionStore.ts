import { useSyncExternalStore } from "react";
import type { ChatItem, ComposerMode, HammersmithRun, Submission, SubmissionStatus } from "../types";
import { appendText, appendThinking, appendTool, setToolOutput } from "./sessionBlocks";
import { abortSession, loadEvents, loadHammersmithRuns, openSessionStream, resumeSession as requestResume, SubmissionError, submitDraft } from "./sessionTransport";
import {
  newDraft, optimisticSubmission, reconcileSubmission,
  hammersmithFreshness, submissionFromHammersmithRun,
  type SubmissionDraft, type SubmissionView,
} from "./sessionSubmissions";
import { liveOverlayItem, mergeEntries, type LiveOverlay, type WireEntry } from "./sessionEntries";

let _idSeq = 0;
const uid = () => `c${Date.now()}-${_idSeq++}`;
const eventSentAt = (event: any) => event.createdAt ?? event.created_at ?? event.timestamp ?? new Date().toISOString();
const LIVE_PREFIX = "live-";

interface SessionState {
  items: ChatItem[]; streaming: boolean; error: string | null; status: string | null;
  loaded: boolean; connection: "connecting" | "connected" | "reconnecting" | "disconnected";
  queuedCount: number; activeStatus: SubmissionStatus | null; failedDraft: SubmissionDraft | null;
  interruptedCount: number;
}interface SessionEntry {
  state: SessionState; listeners: Set<() => void>; es: EventSource | null; viewers: number;
  closeTimer: ReturnType<typeof setTimeout> | null;
  connectionFailures: number; runPoll: ReturnType<typeof setInterval> | null;
  runPollFailures: number; historyPromise: Promise<void> | null;
  liveEnded: boolean; // the in-flight message received its message_end
}
const EMPTY: SessionState = {
  items: [], streaming: false, error: null, status: null, loaded: false,
  connection: "connecting", queuedCount: 0, activeStatus: null, failedDraft: null,
  interruptedCount: 0,
};
const entries = new Map<string, SessionEntry>();
const renameListeners = new Set<(sessionId: string, title: string) => void>();
function getEntry(sessionId: string): SessionEntry {
  let e = entries.get(sessionId);
  if (!e) {
    e = {
      state: { ...EMPTY, items: [] }, listeners: new Set(), es: null, viewers: 0,
      closeTimer: null, connectionFailures: 0, runPoll: null, runPollFailures: 0,
      historyPromise: null, liveEnded: false,
    };
    entries.set(sessionId, e);
  }
  return e;
}
function emit(e: SessionEntry) {
  e.state = { ...e.state };
  for (const l of e.listeners) l();
}
function findLiveIndex(e: SessionEntry): number {
  return e.state.items.findIndex((item) => item.role === "assistant" && !item.done && item.id.startsWith(LIVE_PREFIX));
}
function ensureLive(e: SessionEntry, messageId: string | null, sentAt: string | null): number {
  const existing = findLiveIndex(e);
  if (existing >= 0) return existing;
  const items = e.state.items.slice();
  items.push({ id: `${LIVE_PREFIX}${messageId ?? uid()}`, role: "assistant", blocks: [], done: false, sentAt, live: true });
  e.state.items = items;
  return e.state.items.length - 1;
}
function updateLive(e: SessionEntry, fn: (item: Extract<ChatItem, { role: "assistant" }>) => Extract<ChatItem, { role: "assistant" }>) {
  const idx = findLiveIndex(e);
  if (idx < 0) return;
  const items = e.state.items.slice();
  items[idx] = fn(items[idx] as Extract<ChatItem, { role: "assistant" }>);
  e.state.items = items;
}
function dropLive(e: SessionEntry) {
  const idx = findLiveIndex(e);
  if (idx < 0) return;
  const items = e.state.items.slice();
  items.splice(idx, 1);
  e.state.items = items;
}
/** Durable entries: merge by id; an ended live overlay is superseded. */
function applyEntries(e: SessionEntry, list: WireEntry[]) {
  const hadLive = findLiveIndex(e) >= 0;
  const { items, changed } = mergeEntries(e.state.items, list);
  e.state.items = items;
  if (hadLive && e.liveEnded && list.some((entry) => entry.role === "assistant" || entry.role === "toolResult")) {
    dropLive(e);
    e.liveEnded = false;
  } else if (changed && findLiveIndex(e) >= 0) {
    // Keep the live bubble last: persisted items land before it.
    const idx = findLiveIndex(e);
    if (idx >= 0 && idx !== e.state.items.length - 1) {
      const items2 = e.state.items.slice();
      const [live] = items2.splice(idx, 1);
      items2.push(live);
      e.state.items = items2;
    }
  }
}
function applyDelta(e: SessionEntry, ev: any, fn: (blocks: import("../types").Block[]) => import("../types").Block[]) {
  const idx = ensureLive(e, ev.messageId ?? null, eventSentAt(ev));
  const items = e.state.items.slice();
  const item = items[idx] as Extract<ChatItem, { role: "assistant" }>;
  items[idx] = { ...item, blocks: fn(item.blocks) };
  e.state.items = items;
}
function submissionView(e: SessionEntry): SubmissionView {
  return {
    items: e.state.items, failedDraft: e.state.failedDraft,
    queuedCount: e.state.queuedCount, activeStatus: e.state.activeStatus,
  };
}
function applySubmission(e: SessionEntry, submission: Submission, accepted = true, kind: "message" | "queue" = "message") {
  Object.assign(e.state, reconcileSubmission(submissionView(e), submission, { accepted, kind }));
  if (submission.status === "failed") e.state.error = submission.error || "Your message wasn’t delivered. Your draft is ready to retry.";
  else if (["queued", "starting", "running", "completed"].includes(submission.status)) e.state.error = null;
}
function applyRuns(e: SessionEntry, runs: HammersmithRun[], freshness: HammersmithRun["freshness"] = "live") {
  for (const run of runs) {
    const error = e.state.error;
    applySubmission(e, submissionFromHammersmithRun({ ...run, freshness: hammersmithFreshness(run, freshness) }));
    e.state.error = error;
  }
}
function ensureRunPolling(sessionId: string) {
  const e = getEntry(sessionId);
  if (e.runPoll) return;
  const poll = async () => {
    try {
      const runs = await loadHammersmithRuns(sessionId);
      e.runPollFailures = 0;
      applyRuns(e, runs, "live");
      emit(e);
      if (!runs.some((run) => run.lifecycle === "running")) {
        if (e.runPoll) clearInterval(e.runPoll);
        e.runPoll = null;
      }
    } catch {
      e.runPollFailures += 1;
      const freshness = e.runPollFailures >= 3 ? "unavailable" : "reconnecting";
      e.state.items = e.state.items.map((item) => item.role === "hammersmith-run" && item.run.lifecycle === "running"
        ? { ...item, run: { ...item.run, freshness } } : item);
      emit(e);
      if (e.runPollFailures >= 3 && e.runPoll) { clearInterval(e.runPoll); e.runPoll = null; }
    }
  };
  void poll();
  e.runPoll = setInterval(poll, 2500);
}
function applyEvent(sessionId: string, e: SessionEntry, ev: any) {
  switch (ev.type) {
    case "ping": return;
    case "connecting": e.connectionFailures = 0; e.state.connection = "connected"; emit(e); return;
    case "sync": {
      e.connectionFailures = 0;
      e.state.connection = "connected";
      e.state.streaming = !!ev.streaming;
      e.state.interruptedCount = (ev.interrupted || []).length;
      if (e.state.interruptedCount > 0 && !ev.streaming) {
        e.state.status = "Ready to resume";
      }
      if (ev.fromStart === false) applyEntries(e, ev.entries || []);
      else { e.state.items = []; applyEntries(e, ev.entries || []); }
      if (ev.live) {
        const overlay = liveOverlayItem(ev.live as LiveOverlay, new Date().toISOString());
        if (overlay) { e.state.items = [...e.state.items, overlay]; e.liveEnded = false; }
      } else if (!ev.streaming) dropLive(e);
      for (const submission of ev.submissions || []) applySubmission(e, submission);
      const known = new Set((ev.submissions || []).map((s: Submission) => s.id));
      for (const item of e.state.items) {
        if (item.role !== "user" || !item.submissionStatus) continue;
        const itemId = (item as any).submissionId || item.id;
        if (known.has(itemId)) continue;
        if (!["queued", "starting", "running"].includes(item.submissionStatus)) continue;
        applySubmission(e, {
          id: itemId, prompt: item.content, mode: item.mode ?? "message",
          status: "failed", error: "The server restarted while this message was in flight. Your draft is ready to retry.",
        });
      }
      emit(e); return;
    }
    case "entries": applyEntries(e, ev.entries || []); emit(e); return;
    case "queue": e.state.queuedCount = ev.queued ?? 0; emit(e); return;
    case "start":
      e.state.streaming = true;
      e.state.error = null;
      emit(e); return;
    case "submission":
      applySubmission(e, ev.submission);
      if (["starting", "running"].includes(ev.submission.status)) e.state.streaming = true;
      if (ev.submission.status === "starting") e.state.status = "Starting agent…";
      if (ev.submission.status === "running") e.state.status = "Agent working";
      if (["completed", "failed", "cancelled"].includes(ev.submission.status)) e.state.status = null;
      emit(e); return;
    case "hammersmith_run":
      if (ev.submission?.job) {
        applySubmission(e, { ...ev.submission, job: { ...ev.submission.job, freshness: hammersmithFreshness(ev.submission.job) } });
        if (ev.submission.job.lifecycle === "running") ensureRunPolling(ev.submission.job.sessionId);
      }
      emit(e); return;
    case "message_start": {
      dropLive(e);
      e.liveEnded = false;
      ensureLive(e, ev.messageId ?? null, eventSentAt(ev));
      emit(e); return;
    }
    case "text_delta": applyDelta(e, ev, (b) => appendText(b, ev.delta || "")); emit(e); return;
    case "thinking_delta": applyDelta(e, ev, (b) => appendThinking(b, ev.delta || "")); emit(e); return;
    case "tool_start": applyDelta(e, ev, (b) => appendTool(b, { id: ev.toolCallId, name: ev.toolName, args: ev.args })); emit(e); return;
    case "tool_delta": applyDelta(e, ev, (b) => setToolOutput(b, ev.toolCallId, ev.text || "", "running")); emit(e); return;
    case "tool_end": applyDelta(e, ev, (b) => setToolOutput(b, ev.toolCallId, ev.text || "", ev.isError ? "error" : "done")); emit(e); return;
    case "message_end": e.liveEnded = true; return;
    case "status": e.state.status = ev.text || null; emit(e); return;
    case "end":
      e.state.streaming = e.state.queuedCount > 0;
      e.state.status = null;
      e.state.items = e.state.items.map((m) => m.role === "assistant" && !m.done ? { ...m, done: true } : m);
      if (e.viewers <= 0) scheduleClose(sessionId);
      emit(e); return;
    case "resumed":
      e.state.items = [...e.state.items, { id: uid(), role: "system", content: `🔄 ${ev.message || "Turn resumed after a server restart."}`, sentAt: new Date().toISOString() }];
      e.state.streaming = true;
      e.state.interruptedCount = 0;
      e.state.status = "Resuming interrupted turn…";
      emit(e); return;
    case "error":
      e.state.streaming = false;
      e.state.error = "The agent stopped unexpectedly. Your conversation is preserved.";
      if (e.viewers <= 0) scheduleClose(sessionId);
      emit(e); return;
    case "session_renamed":
      for (const l of renameListeners) l(sessionId, ev.title);
      emit(e); return;
  }
}
function openStream(sessionId: string) {
  const e = getEntry(sessionId);
  if (e.es) return;
  if (e.closeTimer) { clearTimeout(e.closeTimer); e.closeTimer = null; }
  const es = openSessionStream(sessionId);
  e.state.connection = e.connectionFailures > 0 ? "reconnecting" : "connecting";
  emit(e);
  es.onopen = () => { e.connectionFailures = 0; e.state.connection = "connected"; emit(e); };
  es.onmessage = (msg) => {
    try {
      const ev = JSON.parse(msg.data);
      applyEvent(sessionId, e, ev);
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
    if (e.viewers <= 0 && !e.state.streaming) { e.es?.close(); e.es = null; }
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
  if (e.viewers <= 0) {
    if (!e.state.streaming) scheduleClose(sessionId);
    if (e.runPoll) { clearInterval(e.runPoll); e.runPoll = null; }
  }
}
async function loadHistory(sessionId: string) {
  const e = getEntry(sessionId);
  if (e.historyPromise) return e.historyPromise;
  const promise = (async () => {
    try {
      const [eventBatch, runs] = await Promise.all([
        loadEvents(sessionId),
        loadHammersmithRuns(sessionId).catch(() => [] as HammersmithRun[]),
      ]);
      // A full reload starts from the durable projection; any live overlay
      // from an in-flight turn is re-established by the sync event.
      e.state.items = [];
      applyEntries(e, eventBatch.items);
      applyRuns(e, runs, "live");
      e.state.loaded = true;
      emit(e);
      if (runs.some((run) => run.lifecycle === "running")) ensureRunPolling(sessionId);
    } catch {
      e.state.error = "Couldn’t load this conversation. Your saved messages are unchanged.";
      emit(e);
    } finally {
      e.historyPromise = null;
    }
  })();
  e.historyPromise = promise;
  return promise;
}
export function subscribe(sessionId: string, listener: () => void) {
  const e = getEntry(sessionId);
  e.listeners.add(listener);
  return () => e.listeners.delete(listener);
}
export function getSnapshot(sessionId: string): SessionState { return getEntry(sessionId).state; }
async function postDraft(sessionId: string, draft: SubmissionDraft): Promise<boolean> {
  const e = getEntry(sessionId);
  openStream(sessionId);
  try {
    const submission = await submitDraft(sessionId, draft.kind, draft);
    applySubmission(e, submission, true, draft.kind);
    emit(e);
    if (submission.job?.lifecycle === "running") ensureRunPolling(sessionId);
    return true;
  } catch (error) {
    if (draft.kind === "message" && error instanceof SubmissionError && error.status === 409 && error.body?.error === "busy") {
      return postDraft(sessionId, { ...draft, kind: "queue" });
    }
    applySubmission(e, error instanceof SubmissionError && error.body?.submission ? error.body.submission : {
      id: draft.id, prompt: draft.prompt, mode: draft.mode, status: "failed",
      error: error instanceof Error ? error.message : "Submission failed",
    }, false, draft.kind);
    e.state.streaming = false;
    e.state.status = null;
    emit(e);
    return false;
  }
}
export async function send(sessionId: string, prompt: string, mode: ComposerMode): Promise<boolean> {
  const e = getEntry(sessionId);
  const draft = newDraft(prompt, mode, "message");
  Object.assign(e.state, optimisticSubmission(submissionView(e), draft));
  e.state.error = null;
  e.state.status = "Sending…";
  emit(e);
  return postDraft(sessionId, draft);
}
export async function queue(sessionId: string, prompt: string, mode: ComposerMode = "message"): Promise<boolean> {
  const e = getEntry(sessionId);
  const draft = newDraft(prompt, mode, "queue");
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
export async function resumeInterrupted(sessionId: string): Promise<boolean> {
  const e = getEntry(sessionId);
  e.state.status = "Resuming interrupted turn…";
  e.state.error = null;
  emit(e);
  try {
    const result = await requestResume(sessionId);
    if (!result.ok) throw new Error("Resume was not accepted");
    e.state.streaming = true;
    e.state.interruptedCount = 0;
    emit(e);
    return true;
  } catch (error) {
    e.state.status = null;
    e.state.error = error instanceof Error ? error.message : "Resume failed";
    emit(e);
    return false;
  }
}
export function injectSystem(sessionId: string, content: string) { const e = getEntry(sessionId); e.state.items = [...e.state.items, { id: uid(), role: "system", content, sentAt: new Date().toISOString() }]; emit(e); }
export function injectProgress(sessionId: string, key: string, content: string) {
  const e = getEntry(sessionId), items = e.state.items.slice(), last = items[items.length - 1];
  if (last && last.role === "system" && (last as any).key === key) items[items.length - 1] = { ...last, content } as any;
  else items.push({ id: uid(), role: "system", content, key, sentAt: new Date().toISOString() });
  e.state.items = items; emit(e);
}
export function onRename(cb: (sessionId: string, title: string) => void): () => void { renameListeners.add(cb); return () => renameListeners.delete(cb); }
export function useSessionChat(sessionId: string) { return useSyncExternalStore((cb) => subscribe(sessionId, cb), () => getSnapshot(sessionId)); }
