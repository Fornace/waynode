import type { Block, ChatItem, ChatMessage, HammersmithRun, Submission } from "../types";
import { submissionFromHammersmithRun, type SubmissionDraft } from "./sessionSubmissions";

function authQuery() {
  const token = localStorage.getItem("waynode-dev-token") || "";
  return token ? `?t=${encodeURIComponent(token)}` : "";
}

function jsonHeaders(): Record<string, string> {
  const token = localStorage.getItem("waynode-dev-token") || "";
  return {
    "Content-Type": "application/json",
    ...(token ? { "x-dev-token": token } : {}),
  };
}

export class SubmissionError extends Error {
  constructor(message: string, public status: number, public body: any) {
    super(message);
  }
}

export async function submitDraft(
  sessionId: string,
  kind: "message" | "queue",
  draft: SubmissionDraft,
): Promise<Submission> {
  const endpoint = draft.mode === "hammersmith"
    ? `/api/sessions/${sessionId}/hammersmith`
    : `/api/sessions/${sessionId}/${kind}`;
  const response = await fetch(endpoint, {
    method: "POST",
    credentials: "include",
    headers: jsonHeaders(),
    body: JSON.stringify({
      prompt: draft.prompt,
      mode: draft.mode,
      isGoal: draft.isGoal,
      submissionId: draft.id,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new SubmissionError(body.error || "Submission failed", response.status, body);
  return { ...body.submission, ...(body.job ? { job: { ...body.job, freshness: "live" } } : {}) };
}

let historySequence = 0;

export async function loadHistoryItems(sessionId: string): Promise<ChatItem[]> {
  const [response, jobsResponse] = await Promise.all([
    fetch(`/api/sessions/${sessionId}/messages`, {
      credentials: "include", headers: jsonHeaders(),
    }),
    fetch(`/api/sessions/${sessionId}/hammersmith/jobs`, {
      credentials: "include", headers: jsonHeaders(),
    }),
  ]);
  if (!response.ok) throw new Error("History failed");
  const messages = await response.json() as ChatMessage[];
  const items: ChatItem[] = messages.map((message): ChatItem => {
    const id = `history-${historySequence++}`;
    const sentAt = message.createdAt ?? message.created_at ?? message.timestamp ?? null;
    if (message.role !== "assistant") return { id, role: message.role, content: message.content, sentAt } as ChatItem;
    const blocks: Block[] = [];
    if (message.thinking) blocks.push({ type: "thinking", text: message.thinking });
    blocks.push({ type: "text", text: message.content || "" });
    return { id, role: "assistant", blocks, done: true, sentAt };
  });
  if (jobsResponse.ok) {
    const jobs = await jobsResponse.json() as HammersmithRun[];
    for (const job of jobs) {
      const submission = submissionFromHammersmithRun({ ...job, freshness: "live" });
      items.push({ id: submission.id, role: "user", content: submission.prompt, mode: "hammersmith", isGoal: false, submissionStatus: "completed", sentAt: job.createdAt });
      items.push({ id: `hammersmith-${job.id}`, role: "hammersmith-run", initiatingItemId: submission.id, run: { ...job, freshness: "live" }, sentAt: job.createdAt });
    }
  }
  return items.sort((a, b) => {
    // Bug 8: null timestamps must keep disk order — do not let them bubble to the top via epoch fallback.
    if (a.sentAt == null || b.sentAt == null) return 0;
    const delta = new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime();
    if (delta) return delta;
    if (a.role === "hammersmith-run") return 1;
    if (b.role === "hammersmith-run") return -1;
    return 0;
  });
}

export async function loadHammersmithRuns(sessionId: string): Promise<HammersmithRun[]> {
  const response = await fetch(`/api/sessions/${sessionId}/hammersmith/jobs`, { credentials: "include", headers: jsonHeaders() });
  if (!response.ok) throw new Error("Hammersmith status failed");
  return response.json();
}

export function openSessionStream(sessionId: string) {
  return new EventSource(`/api/sessions/${sessionId}/stream${authQuery()}`, { withCredentials: true });
}

export async function abortSession(sessionId: string) {
  const response = await fetch(`/api/sessions/${sessionId}/abort`, {
    method: "POST",
    credentials: "include",
    headers: jsonHeaders(),
  });
  if (!response.ok) throw new Error("Abort failed");
  return response.json() as Promise<{ ok: boolean; cancelled: boolean; reason?: string }>;
}
