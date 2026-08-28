import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { RECOVERY_MARKER } from "./session-recovery-marker.mjs";

/**
 * Full-fidelity projection of a pi session directory.
 *
 * pi persists an append-only tree of entries (stable 8-hex ids, parentId
 * links) per session file; `--continue` appends to the same file. This module
 * turns those entries into the wire items clients render: user text,
 * assistant blocks (thinking, text, tool calls), tool results, bash
 * executions, and compaction notes. Entry ids are durable cursors — the same
 * ids flow to clients as SSE `id:` lines and come back as `since` /
 * Last-Event-ID on reconnect.
 */

const SKIP_ENTRY_TYPES = new Set([
  "session",
  "session_info",
  "model_change",
  "thinking_level_change",
]);

function contentText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && (b.type === "text" || !b.type))
    .map((b) => b.text || "")
    .join("");
}

function normalizeTimestamp(entry, message) {
  const raw = entry?.timestamp ?? message?.timestamp;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const d = new Date(raw);
    if (Number.isFinite(d.getTime()) && raw > 946684800000 && raw < 4102444800000) {
      return d.toISOString();
    }
    return null;
  }
  if (typeof raw === "string") {
    const d = new Date(raw);
    if (Number.isFinite(d.getTime())) return d.toISOString();
  }
  return null;
}

function projectAssistantBlocks(content) {
  const blocks = [];
  if (!Array.isArray(content)) {
    const text = contentText(content);
    if (text) blocks.push({ type: "text", text });
    return blocks;
  }
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text" && b.text) blocks.push({ type: "text", text: b.text });
    else if (b.type === "thinking" && b.thinking) blocks.push({ type: "thinking", text: b.thinking });
    else if (b.type === "toolCall") {
      blocks.push({ type: "toolCall", id: b.id, name: b.name, args: b.arguments ?? b.args ?? {} });
    }
    // image blocks are not projected into chat text
  }
  return blocks;
}

/** One entry → one wire item, or null when the entry is not user-visible. */
export function projectEntry(entry) {
  if (!entry || SKIP_ENTRY_TYPES.has(entry.type)) return null;
  const timestamp = normalizeTimestamp(entry, entry.message);
  const base = { id: entry.id, parentId: entry.parentId ?? null, timestamp };

  if (entry.type === "message" || entry.type === "hook_message" || entry.type === "custom") {
    const message = entry.message;
    if (!message || !message.role) return null;
    switch (message.role) {
      case "user": {
        const text = contentText(message.content);
        if (!text.trim()) return null;
        if (text.startsWith(RECOVERY_MARKER)) {
          return {
            ...base,
            role: "note",
            kind: "recovery",
            text: "Turn resumed automatically after a server restart.",
          };
        }
        return { ...base, role: "user", text };
      }
      case "assistant": {
        const blocks = projectAssistantBlocks(message.content);
        if (blocks.length === 0) return null;
        return { ...base, role: "assistant", blocks };
      }
      case "toolResult":
        return {
          ...base,
          role: "toolResult",
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          isError: !!message.isError,
          text: contentText(message.content),
        };
      case "bashExecution":
        return {
          ...base,
          role: "bashExecution",
          command: message.command,
          exitCode: message.exitCode,
          cancelled: !!message.cancelled,
          text: message.output ?? "",
        };
      default:
        return null;
    }
  }

  if (entry.type === "compaction") {
    return { ...base, role: "note", kind: "compaction", text: entry.summary ?? "Context compacted" };
  }
  if (entry.type === "branchSummary" || entry.type === "branch_summary") {
    return { ...base, role: "note", kind: "branchSummary", text: entry.summary ?? "" };
  }
  return null;
}

/** Parse every .jsonl file in the dir, in filename order, line order. */
export function readSessionEntries(sessionDir) {
  const out = [];
  if (!sessionDir || typeof sessionDir !== "string" || !existsSync(sessionDir)) return out;
  const files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl")).sort();
  for (const file of files) {
    let raw;
    try {
      raw = readFileSync(join(sessionDir, file), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {}
    }
  }
  return out;
}

/**
 * Walk back from `leafIndex` through parentId links. Returns the array of
 * [index, entry] pairs from root to leaf, guarding against cycles.
 */
function chainFrom(entries, leafIndex) {
  const chain = [];
  const seen = new Set();
  let index = leafIndex;
  while (index >= 0 && index < entries.length && !seen.has(index)) {
    const entry = entries[index];
    seen.add(index);
    chain.push([index, entry]);
    const parent = entry.parentId;
    if (!parent) break;
    // Find the parent: search backwards from the current index (parents are
    // always appended before children in pi's linear files).
    let parentIndex = -1;
    for (let i = index - 1; i >= 0; i--) {
      if (entries[i]?.id === parent) {
        parentIndex = i;
        break;
      }
    }
    if (parentIndex === -1) break;
    index = parentIndex;
  }
  chain.reverse();
  return chain;
}

/**
 * Project the active branch(es) of the session in conversation order.
 *
 * A well-formed dir has one chain. Legacy dirs may hold several files with
 * independent chains (created before --session-id pinning); those are
 * concatenated oldest-first. Abandoned branches (terminal forks) are excluded
 * because only the chain ending at the newest entry is walked.
 */
export function projectSession(sessionDir) {
  const entries = readSessionEntries(sessionDir);
  if (entries.length === 0) return { items: [], leafId: null };

  const segments = [];
  let end = entries.length - 1;
  while (end >= 0) {
    // Skip trailing entries without ids (none in practice; headers filtered later).
    while (end >= 0 && typeof entries[end]?.id !== "string") end -= 1;
    if (end < 0) break;
    const chain = chainFrom(entries, end);
    segments.push(chain);
    const chainStart = chain.length ? chain[0][0] : end;
    end = chainStart - 1;
  }
  segments.reverse();

  const items = [];
  let leafId = null;
  for (const chain of segments) {
    for (const [, entry] of chain) {
      if (typeof entry.id === "string") leafId = entry.id;
      const item = projectEntry(entry);
      if (item) items.push(item);
    }
  }
  return { items, leafId };
}

/**
 * Items after a cursor. `fromStart` is true when no cursor was supplied or
 * the cursor is unknown (caller treats items as a full snapshot).
 */
export function projectAfter(sessionDir, sinceId) {
  const { items, leafId } = projectSession(sessionDir);
  if (!sinceId) return { items, leafId, fromStart: true };
  const index = items.findIndex((item) => item.id === sinceId);
  if (index === -1) return { items, leafId, fromStart: true };
  return { items: items.slice(index + 1), leafId, fromStart: false };
}
