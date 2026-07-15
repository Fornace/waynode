import type { ChatItem, Submission, SubmissionStatus } from "../types";

export interface SubmissionDraft {
  id: string;
  prompt: string;
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

export function newDraft(prompt: string, isGoal: boolean, kind: "message" | "queue"): SubmissionDraft {
  return { id: crypto.randomUUID(), prompt, isGoal, kind, sentAt: new Date().toISOString() };
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
  const draft = {
    id: submission.id,
    prompt: submission.prompt,
    isGoal: submission.isGoal,
    kind,
    sentAt: existingSentAt ?? serverSentAt ?? new Date().toISOString(),
  };
  const index = items.findIndex((item) => item.role === "user" && item.id === submission.id);

  if (!accepted && submission.status === "failed") {
    if (index >= 0) items.splice(index, 1);
  } else {
    const item: ChatItem = {
      id: submission.id,
      role: "user",
      content: submission.prompt,
      sentAt: draft.sentAt,
      isGoal: submission.isGoal,
      submissionStatus: submission.status,
    };
    if (index >= 0) items[index] = { ...items[index], ...item } as ChatItem;
    else items.push(item);
  }

  const failedDraft = submission.status === "failed"
    ? { ...draft, id: accepted ? crypto.randomUUID() : draft.id }
    : current.failedDraft?.id === submission.id ? null : current.failedDraft;
  const statuses = items.flatMap((item) => item.role === "user" && item.submissionStatus ? [item.submissionStatus] : []);
  const activeStatus = latestActiveStatus(statuses);
  return {
    items,
    failedDraft,
    queuedCount: statuses.filter((status) => status === "queued").length,
    activeStatus,
  };
}

export function optimisticSubmission(view: SubmissionView, draft: SubmissionDraft): SubmissionView {
  return reconcileSubmission(view, {
    id: draft.id,
    prompt: draft.prompt,
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
