import type { HammersmithRun, Submission } from "../types";
import type { SubmissionDraft } from "./sessionSubmissions";
import type { WireEntry } from "./sessionEntries";

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
      submissionId: draft.id,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new SubmissionError(body.error || "Submission failed", response.status, body);
  return { ...body.submission, ...(body.job ? { job: { ...body.job, freshness: "live" } } : {}) };
}

/** Durable session projection from /events (see SESSION-WIRE-PROTOCOL). */
export async function loadEvents(sessionId: string): Promise<{ items: WireEntry[]; leafId: string | null; fromStart: boolean }> {
  const response = await fetch(`/api/sessions/${sessionId}/events`, {
    credentials: "include", headers: jsonHeaders(),
  });
  if (!response.ok) throw new Error("History failed");
  return response.json();
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

export async function resumeSession(sessionId: string) {
  const response = await fetch(`/api/sessions/${sessionId}/resume`, {
    method: "POST", credentials: "include", headers: jsonHeaders(),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Resume failed");
  return body as { ok: boolean; submissionId: string };
}
