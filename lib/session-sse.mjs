import { projectAfter, projectSession } from "./pi-session-projection.mjs";
import { SubmissionLedger, goalPrompt } from "./agent-submissions.mjs";

/**
 * SSE plumbing + the v2 sync event builder shared by the session stream and
 * messages/events endpoints. Wire contract: docs/SESSION-WIRE-PROTOCOL.md.
 */

export function sseSetup(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();
}

export function writeSSE(res, ev, eventId) {
  if (res.destroyed || res.writableEnded) return;
  try {
    if (eventId) res.write(`id: ${eventId}\n`);
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
    if (typeof res.flush === "function") res.flush();
  } catch {}
}

export const cleanupSseOnResponseClose = (res, cleanups) =>
  res.once("close", () => cleanups.forEach((cleanup) => cleanup()));

/** Cursor from Last-Event-ID header or ?since= query parameter. */
export function streamCursor(req) {
  const header = req.headers["last-event-id"];
  if (typeof header === "string" && header) return header;
  if (typeof req.query.since === "string" && req.query.since) return req.query.since;
  return null;
}

/**
 * Replay projection for a stream open/reconnect. Without a cursor this is the
 * full snapshot; with one, only entries after it (fromStart=false).
 */
export function replaySession(sessionDir, since) {
  return since
    ? projectAfter(sessionDir, since)
    : { ...projectSession(sessionDir), fromStart: true };
}

/**
 * The v2 sync event: durable entries (stable pi entry ids, full fidelity),
 * the live in-flight message overlay, and active submissions. Legacy flat
 * fields (partialText, tools) keep the native app contract intact.
 */
export function buildSyncEvent(session, handle, since) {
  const projected = replaySession(session.pi_session_dir, since);
  const recoverable = handle?.streaming ? [] : SubmissionLedger.recoverableRows(session.id);
  // Bind durable pi entry ids to Waynode submission ids before any new handle
  // broadcasts status. This prevents an interrupted original user row + its
  // resumed submission from rendering as two user bubbles on cold reconnect.
  for (const row of recoverable) {
    const user = [...projected.items].reverse().find((entry) =>
      entry.role === "user" && (entry.text === row.prompt || entry.text === goalPrompt(row.prompt, row.mode)),
    );
    if (user) user.submissionId = row.id;
  }
  const live = handle?.streaming
    ? {
        messageId: handle.curMsgId ?? null,
        text: handle.liveText ?? "",
        thinking: handle.liveThinking ?? "",
        tools: handle.liveTools ?? [],
      }
    : null;
  return {
    event: {
      type: "sync",
      fromStart: projected.fromStart,
      cursor: since,
      entries: projected.items,
      // Native v1 decoder reads `items`; web v2 reads `entries`. Native
      // refreshes /messages on settle; this snapshot keeps mid-turn history.
      items: projected.items.map(withLegacyFields),
      leafId: projected.leafId,
      streaming: !!(handle && handle.streaming),
      live,
      partialText: handle?.streaming ? (handle.liveText ?? "") : "",
      tools: handle?.liveTools ?? [],
      submissions: handle?.getSubmissionSnapshot?.() ?? [],
      interrupted: recoverable,
    },
    leafId: projected.leafId,
  };
}

/** Legacy /messages shape merged onto full-fidelity items (native app + web). */
export function withLegacyFields(item) {
  if (item.role === "user") return { ...item, content: item.text };
  if (item.role === "assistant") {
    const text = item.blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
    const thinking = item.blocks.filter((b) => b.type === "thinking").map((b) => b.text).join("") || null;
    // Native legacy endpoint uses strings for dynamic tool args.
    const blocks = item.blocks.map((block) => block.type === "toolCall"
      ? { type: "tool", id: block.id, name: block.name, args: JSON.stringify(block.args ?? {}), output: "", status: "running" }
      : block);
    return { ...item, blocks, content: text, thinking };
  }
  return item;
}
