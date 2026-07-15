import type { Block, ChatItem, ChatMessage, Submission } from "../types";
import type { SubmissionDraft } from "./sessionSubmissions";

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
  const response = await fetch(`/api/sessions/${sessionId}/${kind}`, {
    method: "POST",
    credentials: "include",
    headers: jsonHeaders(),
    body: JSON.stringify({
      prompt: draft.prompt,
      isGoal: draft.isGoal,
      submissionId: draft.id,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new SubmissionError(body.error || "Submission failed", response.status, body);
  return body.submission;
}

let historySequence = 0;

export async function loadHistoryItems(sessionId: string): Promise<ChatItem[]> {
  const response = await fetch(`/api/sessions/${sessionId}/messages`, {
    credentials: "include",
    headers: jsonHeaders(),
  });
  if (!response.ok) throw new Error("History failed");
  const messages = await response.json() as ChatMessage[];
  return messages.map((message) => {
    const id = `history-${historySequence++}`;
    const sentAt = message.createdAt ?? message.created_at ?? message.timestamp ?? null;
    if (message.role !== "assistant") return { id, role: message.role, content: message.content, sentAt } as ChatItem;
    const blocks: Block[] = [];
    if (message.thinking) blocks.push({ type: "thinking", text: message.thinking });
    blocks.push({ type: "text", text: message.content || "" });
    return { id, role: "assistant", blocks, done: true, sentAt };
  });
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
