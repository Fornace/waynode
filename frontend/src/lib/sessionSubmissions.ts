import type { ChatItem, ComposerMode, HammersmithRun, Submission, SubmissionStatus } from "../types";

export interface SubmissionDraft {
  id: string;
  prompt: string;
  mode?: ComposerMode;
  isGoal: boolean;
  kind: "message" | "queue";
  sentAt: string;
}

export interface SubmissionView {
  items: ChatItem[];
  failedDraft: SubmissionDraft | null;
  queuedCount: number;
  activeStatus: SubmissionStatus | null;
}

export const HAMMERSMITH_STALE_AFTER_MS = 10_000;

export function hammersmithFreshness(run: HammersmithRun, transport: HammersmithRun["freshness"] = "live", now = Date.now()) {
  if (transport !== "live" || run.lifecycle !== "running") return transport;
  const updated = new Date(run.updatedAt).getTime();
  return Number.isFinite(updated) && now - updated <= HAMMERSMITH_STALE_AFTER_MS ? "live" : "stale";
}

export function hammersmithRunTitle(run: HammersmithRun) {
  const verified = run.totalTasks > 0 && run.checkedTasks === run.totalTasks
    && run.passedTasks === run.totalTasks && run.failedTasks === 0;
  if (run.lifecycle === "finished") return verified ? "Verified" : run.failedTasks > 0 ? "Finished with failures" : "Finished without full verification";
  if (run.lifecycle === "stopped") return "Run stopped";
  if (run.freshness === "loading") return "Loading run status…";
  if (run.freshness === "reconnecting") return "Reconnecting";
  if (run.freshness === "unavailable") return "Run status unavailable";
  if (run.freshness === "stale") return "Run status is stale";
  return "Hammersmith running";
}

function submissionMode(value: ComposerMode | boolean | undefined, isGoal = false): ComposerMode {
  if (value === true || isGoal) return "goal";
  if (value === false || value === undefined) return "message";
  return value;
}

export function newDraft(prompt: string, mode: ComposerMode | boolean, kind: "message" | "queue"): SubmissionDraft {
  const normalized = submissionMode(mode);
  return { id: crypto.randomUUID(), prompt, mode: normalized, isGoal: normalized === "goal", kind, sentAt: new Date().toISOString() };
}

export function submissionFromHammersmithRun(run: HammersmithRun): Submission {
  return {
    id: run.submissionId || `hammersmith-user-${run.id}`,
    prompt: run.description,
    mode: "hammersmith",
    isGoal: false,
    status: "completed",
    createdAt: run.createdAt,
    jobId: run.id,
    job: run,
  };
}

export function reconcileSubmission(
  current: SubmissionView,
  submission: Submission,
  options: { accepted?: boolean; kind?: "message" | "queue" } = {},
): SubmissionView {
  const { accepted = true, kind = "message" } = options;
  let items = current.items.slice();
  const serverSentAt = submission.createdAt ?? submission.created_at ?? submission.timestamp;
  const existingSentAt = items.find((item) => item.role === "user" && item.id === submission.id)?.sentAt;
  const normalizedMode = submissionMode(submission.mode, submission.isGoal);
  const draft: SubmissionDraft = {
    id: submission.id,
    prompt: submission.prompt,
    ...(submission.mode !== undefined ? { mode: normalizedMode } : {}),
    isGoal: normalizedMode === "goal",
    kind,
    sentAt: existingSentAt ?? serverSentAt ?? new Date().toISOString(),
  };
  const index = items.findIndex((item) => item.role === "user" && item.id === submission.id);
  const pendingIndex = index >= 0 ? index : findPendingSubmissionIndex(items, submission.prompt, normalizedMode === "goal");

  if (!accepted && submission.status === "failed") {
    if (pendingIndex >= 0) items.splice(pendingIndex, 1);
  } else {
    const item: ChatItem = {
      id: submission.id,
      role: "user",
      content: submission.prompt,
      sentAt: draft.sentAt,
      mode: draft.mode ?? normalizedMode,
      isGoal: draft.isGoal,
      submissionStatus: submission.status,
    };
    if (pendingIndex >= 0) items[pendingIndex] = { ...items[pendingIndex], ...item } as ChatItem;
    else items.push(item);
    if (submission.job) {
      const runId = `hammersmith-${submission.job.id}`;
      const runIndex = items.findIndex((entry) => entry.id === runId);
      const previousRun = runIndex >= 0 && items[runIndex].role === "hammersmith-run"
        ? items[runIndex].run : null;
      const runItem: ChatItem = {
        id: runId, role: "hammersmith-run", initiatingItemId: submission.id,
        run: {
          ...previousRun,
          ...submission.job,
          monitorUrl: submission.job.monitorUrl || previousRun?.monitorUrl || null,
          freshness: submission.job.freshness || "live",
        },
        sentAt: submission.job.createdAt,
      };
      if (runIndex >= 0) items[runIndex] = runItem;
      else items.splice((pendingIndex >= 0 ? pendingIndex : items.length - 1) + 1, 0, runItem);
    }
  }

  const failedDraft = submission.status === "failed"
    ? { ...draft, id: accepted ? crypto.randomUUID() : draft.id }
    : accepted ? null : current.failedDraft;
  const statuses = items.flatMap((item) => item.role === "user" && item.submissionStatus ? [item.submissionStatus] : []);
  const activeStatus = latestActiveStatus(statuses);
  return {
    items,
    failedDraft,
    queuedCount: statuses.filter((status) => status === "queued").length,
    activeStatus,
  };
}

function isPendingStatus(status?: SubmissionStatus): boolean {
  return status === "sending" || status === "queued" || status === "starting" || status === "running";
}

function findPendingSubmissionIndex(items: ChatItem[], prompt: string, isGoal: boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (
      item.role === "user"
      && item.content === prompt
      && Boolean(item.isGoal) === isGoal
      && isPendingStatus(item.submissionStatus)
    ) {
      return index;
    }
  }
  return -1;
}

export function optimisticSubmission(view: SubmissionView, draft: SubmissionDraft): SubmissionView {
  return reconcileSubmission(view, {
    id: draft.id,
    prompt: draft.prompt,
    mode: draft.mode ?? (draft.isGoal ? "goal" : "message"),
    isGoal: draft.isGoal,
    status: "sending",
    createdAt: draft.sentAt,
  }, { accepted: true, kind: draft.kind });
}

function latestActiveStatus(statuses: SubmissionStatus[]): SubmissionStatus | null {
  for (const status of ["running", "starting", "queued", "sending"] as SubmissionStatus[]) {
    if (statuses.includes(status)) return status;
  }
  return null;
}
