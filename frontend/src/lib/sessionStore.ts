import type { ChatItem, Block, ComposerMode, HammersmithRun, Submission, SubmissionStatus } from "../types";
import { appendText, appendThinking, appendTool, setToolOutput } from "./sessionBlocks";
import { abortSession, loadHammersmithRuns, loadHistoryItems, openSessionStream, SubmissionError, submitDraft } from "./sessionTransport";
import {
  newDraft, optimisticSubmission, reconcileSubmission,
  hammersmithFreshness, submissionFromHammersmithRun,
  type SubmissionDraft, type SubmissionView,
} from "./sessionSubmissions";
let _idSeq = 0;
export const uid = () => `c${Date.now()}-${_idSeq++}`;
const eventSentAt = (event: any) => event.createdAt ?? event.created_at ?? event.timestamp ?? new Date().toISOString();
interface SessionState {
  items: ChatItem[]; streaming: boolean; error: string | null; status: string | null;
  loaded: boolean; connection: "connecting" | "connected" | "reconnecting" | "disconnected";
  queuedCount: number; activeStatus: SubmissionStatus | null; failedDraft: SubmissionDraft | null;
}
interface SessionEntry {
  state: SessionState; listeners: Set<() => void>; es: EventSource | null; viewers: number;
  closeTimer: ReturnType<typeof setTimeout> | null;
  msgIndex: Map<string, number>; // messageId -> items index
  connectionFailures: number; runPoll: ReturnType<typeof setInterval> | null;
  runPollFailures: number; historyPromise: Promise<void> | null;
}
const EMPTY: SessionState = {
  items: [], streaming: false, error: null, status: null, loaded: false,
  connection: "connecting", queuedCount: 0, activeStatus: null, failedDraft: null,
};
const entries = new Map<string, SessionEntry>();
export const renameListeners = new Set<(sessionId: string, title: string) => void>();
export function getEntry(sessionId: string): SessionEntry {
  let e = entries.get(sessionId);
  if (!e) {
    e = {
      state: { ...EMPTY, items: [] }, listeners: new Set(), es: null, viewers: 0,
      closeTimer: null, msgIndex: new Map(), connectionFailures: 0,
      runPoll: null, runPollFailures: 0, historyPromise: null,
    };
    entries.set(sessionId, e);
  }
  return e;
}
export function emit(e: SessionEntry) {
  e.state = { ...e.state };
  for (const l of e.listeners) l();
}
// Stable content signature for dedup: id is a per-load transient (historySequence), so dedup by role+text/time.
function contentKey(item: ChatItem): string {
  if (item.role === "assistant") return `a:${item.sentAt ?? ""}:${item.blocks.map((b) => b.type === "text" || b.type === "thinking" ? b.text : "").join("|")}`;
  if (item.role === "hammersmith-run") return `h:${item.run.id}`;
  if (item.role === "system") return `s:${item.key ?? ""}:${item.content}`;
  return `u:${item.sentAt ?? ""}:${item.content}`;
}
// Rebuild msgIndex from the merged items array so prepended history doesn't drop streaming bubbles.
function rebuildMsgIndex(e: SessionEntry) {
  e.msgIndex = new Map();
  e.state.items.forEach((item, idx) => {
    if (item.role === "assistant" && !item.done) e.msgIndex.set(item.id, idx);
  });
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
      // Bug 6: stop the interval after a bounded number of consecutive failures.
      if (e.runPollFailures >= 3 && e.runPoll) { clearInterval(e.runPoll); e.runPoll = null; }
    }
  };
  void poll();
  e.runPoll = setInterval(poll, 2500);
}
function applyDelta(e: SessionEntry, ev: any, fn: (blocks: Block[]) => Block[]) {
  ensureAssistant(e, ev.messageId, eventSentAt(ev));
  updateAssistant(e, ev.messageId, fn);
  emit(e);
}
function applyEvent(sessionId: string, e: SessionEntry, ev: any) {
  switch (ev.type) {
    case "ping":
      return;
    case "connecting": e.connectionFailures = 0; e.state.connection = "connected"; emit(e); return;
    case "sync": {
      e.connectionFailures = 0;
      e.state.connection = "connected";
      e.state.streaming = !!ev.streaming;
      for (const submission of ev.submissions || []) applySubmission(e, submission);
      // The sync snapshot is the server's full active-submission truth. Any
      // locally-active submission missing from it was lost to a server
      // restart — settle it as failed so the composer never stays locked
      // behind a phantom "running" item until page reload. "sending" is
      // excluded: that's a client-side POST still in flight, unknown to the
      // server by definition.
      const known = new Set((ev.submissions || []).map((s: Submission) => s.id));
      for (const item of e.state.items) {
        if (item.role !== "user" || !item.submissionStatus || known.has(item.id)) continue;
        if (!["queued", "starting", "running"].includes(item.submissionStatus)) continue;
        applySubmission(e, {
          id: item.id, prompt: item.content, mode: item.mode ?? (item.isGoal ? "goal" : "message"),
          isGoal: item.isGoal ?? false,
          status: "failed", error: "The server restarted while this message was in flight. Your draft is ready to retry.",
        });
      }
      if (ev.streaming && ev.partialText) {
        const liveIdx = [...e.msgIndex.values()].find((i) => {
          const m = e.state.items[i];
          return m && m.role === "assistant" && !m.done;
        });
        if (liveIdx === undefined) {
          const id = `sync-${uid()}`;
          ensureAssistant(e, id, eventSentAt(ev));
          updateAssistant(e, id, (b) => appendText(b, ev.partialText));
        } else {
          const items = e.state.items.slice();
          const msg = items[liveIdx];
          if (msg.role === "assistant") {
            const replacement: Block = { type: "text", text: ev.partialText };
            const hadText = msg.blocks.some((b) => b.type === "text");
            const blocks = hadText ? msg.blocks.map((b) => b.type === "text" ? replacement : b) : [...msg.blocks, replacement];
            items[liveIdx] = { ...msg, blocks };
            e.state.items = items;
          }
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
    case "hammersmith_run":
      if (ev.submission?.job) {
        applySubmission(e, { ...ev.submission, job: { ...ev.submission.job, freshness: hammersmithFreshness(ev.submission.job) } });
        if (ev.submission.job.lifecycle === "running") ensureRunPolling(ev.submission.job.sessionId);
      }
      emit(e);
      return;
    case "message_start": {
      // Bug 4: adopt the first real messageId for a sync-created bubble (re-key msgIndex + restamp id).
      const adopt = !e.msgIndex.has(ev.messageId) && [...e.msgIndex.entries()].find(([k, i]) =>
        k.startsWith("sync-") && e.state.items[i]?.role === "assistant" && !e.state.items[i]!.done);
      if (adopt) {
        const [oldKey, idx] = adopt;
        e.msgIndex.delete(oldKey);
        e.msgIndex.set(ev.messageId, idx);
        const items = e.state.items.slice();
        items[idx] = { ...items[idx], id: ev.messageId, sentAt: eventSentAt(ev) };
        e.state.items = items;
      } else {
        ensureAssistant(e, ev.messageId, eventSentAt(ev));
      }
      emit(e);
      return;
    }
    case "text_delta":
      applyDelta(e, ev, (b) => appendText(b, ev.delta || ""));
      return;
    case "thinking_delta":
      applyDelta(e, ev, (b) => appendThinking(b, ev.delta || ""));
      return;
    case "tool_start":
      applyDelta(e, ev, (b) => appendTool(b, { id: ev.toolCallId, name: ev.toolName, args: ev.args }));
      return;
    case "tool_delta":
      applyDelta(e, ev, (b) => setToolOutput(b, ev.toolCallId, ev.text || "", "running"));
      return;
    case "tool_end":
      applyDelta(e, ev, (b) => setToolOutput(b, ev.toolCallId, ev.text || "", ev.isError ? "error" : "done"));
      return;
    case "status":
      e.state.status = ev.text || null; emit(e); return;
    case "end":
      e.state.streaming = e.state.queuedCount > 0;
      e.state.status = null;
      e.state.items = e.state.items.map((m) => m.role === "assistant" && !m.done ? { ...m, done: true } : m);
      // Bug 7: if the last viewer left mid-turn, schedule the SSE close now that streaming ended.
      if (e.viewers <= 0) scheduleClose(sessionId);
      emit(e); return;
    case "error":
      e.state.streaming = false;
      e.state.error = "The agent stopped unexpectedly. Your conversation is preserved.";
      if (e.viewers <= 0) scheduleClose(sessionId);
      emit(e); return;
    case "session_renamed":
      for (const l of renameListeners) l(/* sessionId via closure not available */ "", ev.title);
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
      if (ev.type === "session_renamed") { for (const l of renameListeners) l(sessionId, ev.title); return; }
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
    // Bug 6: no viewers → stop burning requests on the Hammersmith run poller.
    if (e.runPoll) { clearInterval(e.runPoll); e.runPoll = null; }
  }
}
async function loadHistory(sessionId: string) {
  const e = getEntry(sessionId);
  // Bug 1: in-flight guard so a StrictMode double-mount / fast A→B→A switch never starts two loads.
  if (e.historyPromise) return e.historyPromise;
  const promise = (async () => {
    try {
      const diskItems = await loadHistoryItems(sessionId);
      // Bug 1 (content-key dedup): history-N ids are per-load transient; dedup by stable signature.
      const live = new Set(e.state.items.map(contentKey));
      const fresh = diskItems.filter((item) => !live.has(contentKey(item)));
      e.state.items = [...fresh, ...e.state.items];
      // Bug 2: rebuild msgIndex from the merged items so prepended history doesn't drop streaming bubbles.
      rebuildMsgIndex(e);
      e.state.loaded = true;
      emit(e);
      if (diskItems.some((item) => item.role === "hammersmith-run" && item.run.lifecycle === "running")) ensureRunPolling(sessionId);
    } catch {
      // Bug 5: leave loaded=false so retry() can refetch after a healed network.
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
      id: draft.id, prompt: draft.prompt, mode: draft.mode ?? (draft.isGoal ? "goal" : "message"), isGoal: draft.isGoal, status: "failed",
      error: error instanceof Error ? error.message : "Submission failed",
    }, false, draft.kind);
    e.state.streaming = false;
    e.state.status = null;
    emit(e);
    return false;
  }
}
export async function send(sessionId: string, prompt: string, mode: ComposerMode | boolean): Promise<boolean> {
  const e = getEntry(sessionId);
  const draft = newDraft(prompt, mode, "message");
  Object.assign(e.state, optimisticSubmission(submissionView(e), draft));
  e.state.error = null;
  e.state.status = "Sending…";
  emit(e);
  return postDraft(sessionId, draft);
}
export async function queue(sessionId: string, prompt: string, mode: ComposerMode | boolean = "message"): Promise<boolean> {
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
export { injectSystem, injectProgress, onRename, useSessionChat } from "./sessionActions";
