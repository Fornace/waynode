import type { Block, ChatItem } from "../types";

/**
 * Wire entry types (docs/SESSION-WIRE-PROTOCOL.md): the durable projection
 * the server broadcasts (`entries` events) and serves from /events. Every
 * entry has a stable pi entry id usable as a replay cursor.
 */

export interface WireToolCall { type: "toolCall"; id: string; name: string; args: any }
export interface WireTextBlock { type: "text"; text: string }
export interface WireThinkingBlock { type: "thinking"; text: string }
export type WireAssistantBlock = WireTextBlock | WireThinkingBlock | WireToolCall;

export type WireEntry =
  | { id: string; parentId: string | null; timestamp: string | null; role: "user"; text: string; submissionId?: string }
  | { id: string; parentId: string | null; timestamp: string | null; role: "assistant"; blocks: WireAssistantBlock[] }
  | { id: string; parentId: string | null; timestamp: string | null; role: "toolResult"; toolCallId: string; toolName: string; isError: boolean; text: string }
  | { id: string; parentId: string | null; timestamp: string | null; role: "bashExecution"; command: string; exitCode: number | undefined; cancelled: boolean; text: string }
  | { id: string; parentId: string | null; timestamp: string | null; role: "note"; kind: string; text: string };

export interface LiveToolState { toolCallId: string; name: string; args: any; output: string; state: "running" | "done" | "error" }

/** The live in-flight assistant message overlay (sync.live / deltas). */
export interface LiveOverlay {
  messageId: string | null;
  text: string;
  thinking: string;
  tools: LiveToolState[];
}

export function wireEntryToBlocks(entry: Extract<WireEntry, { role: "assistant" }>): Block[] {
  const blocks: Block[] = [];
  for (const block of entry.blocks) {
    if (block.type === "text") blocks.push({ type: "text", text: block.text });
    else if (block.type === "thinking") blocks.push({ type: "thinking", text: block.text });
    else blocks.push({ type: "tool", id: block.id, name: block.name, args: block.args, output: "", status: "running" });
  }
  return blocks;
}

/** A durable user entry becomes a user bubble; keep the raw prompt display. */
export function layoutUserEntry(entry: Extract<WireEntry, { role: "user" }>): ChatItem {
  return {
    id: entry.id,
    role: "user",
    content: entry.text,
    sentAt: entry.timestamp,
  };
}

export function layoutAssistantEntry(entry: Extract<WireEntry, { role: "assistant" }>): ChatItem {
  return {
    id: entry.id,
    role: "assistant",
    blocks: wireEntryToBlocks(entry),
    done: true,
    sentAt: entry.timestamp,
  };
}

export function layoutNoteEntry(entry: Extract<WireEntry, { role: "note" }>): ChatItem {
  const label = entry.kind === "compaction" ? "📝 Context compacted. Earlier work was summarized to keep the session fast." : `📝 ${entry.text}`;
  return { id: entry.id, role: "system", content: label, sentAt: entry.timestamp };
}

export function layoutBashEntry(entry: Extract<WireEntry, { role: "bashExecution" }>): ChatItem {
  const status = entry.cancelled ? "cancelled" : entry.exitCode === undefined ? "" : entry.exitCode === 0 ? "✓" : "⚠";
  return { id: entry.id, role: "system", content: `${status === "" ? "📝" : status} Terminal: ${entry.command}`, sentAt: entry.timestamp };
}

export function layoutEntry(entry: WireEntry): ChatItem | null {
  switch (entry.role) {
    case "user": return layoutUserEntry(entry);
    case "assistant": return layoutAssistantEntry(entry);
    case "note": return layoutNoteEntry(entry);
    case "bashExecution": return layoutBashEntry(entry);
    default: return null; // toolResult entries patch their tool block instead
  }
}

/**
 * Patch the assistant item that owns toolCallId with the durable result.
 * Searches backwards so the newest matching tool call wins.
 */
export function applyToolResult(items: ChatItem[], result: Extract<WireEntry, { role: "toolResult" }>): ChatItem[] {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.role !== "assistant") continue;
    const hasCall = item.blocks.some((block) => block.type === "tool" && block.id === result.toolCallId);
    if (!hasCall) continue;
    const blocks = item.blocks.map((block) =>
      block.type === "tool" && block.id === result.toolCallId
        ? { ...block, output: result.text, status: result.isError ? ("error" as const) : ("done" as const), endedAt: Date.now() }
        : block,
    );
    const copy = items.slice();
    copy[index] = { ...item, blocks };
    return copy;
  }
  return items;
}

/** Build the live overlay item from a sync snapshot's live block. */
export function liveIndex(items: ChatItem[]): number {
  return items.findIndex((item) => item.role === "assistant" && !item.done && item.live === true);
}

export function dropLiveItem(items: ChatItem[]): ChatItem[] {
  const index = liveIndex(items);
  if (index < 0) return items;
  const copy = items.slice();
  copy.splice(index, 1);
  return copy;
}

export function addLiveItem(items: ChatItem[], messageId: string | null, sentAt: string | null): ChatItem[] {
  if (liveIndex(items) >= 0) return items;
  return [...items, {
    id: `live-${messageId ?? crypto.randomUUID()}`,
    role: "assistant" as const,
    blocks: [],
    done: false,
    sentAt,
    live: true,
  }];
}

export function updateLiveBlocks(items: ChatItem[], fn: (blocks: Block[]) => Block[]): ChatItem[] {
  const index = liveIndex(items);
  if (index < 0) return items;
  const item = items[index];
  if (item.role !== "assistant") return items;
  const copy = items.slice();
  copy[index] = { ...item, blocks: fn(item.blocks) };
  return copy;
}

export function liveOverlayItem(live: LiveOverlay | null | undefined, sentAt: string | null): ChatItem | null {
  if (!live) return null;
  const blocks: Block[] = [];
  if (live.thinking) blocks.push({ type: "thinking", text: live.thinking });
  for (const tool of live.tools ?? []) {
    blocks.push({
      type: "tool",
      id: tool.toolCallId,
      name: tool.name,
      args: tool.args,
      output: tool.output,
      status: tool.state,
    });
  }
  if (live.text) blocks.push({ type: "text", text: live.text });
  return {
    id: `live-${live.messageId ?? "stream"}`,
    role: "assistant",
    blocks,
    done: false,
    sentAt,
  };
}

/**
 * Merge a batch of durable entries into the item list. Idempotent by entry
 * id; user entries annotated with a submissionId adopt (and preserve) the
 * optimistic bubble's display text and status.
 */
export function toolStatusText(toolName: string, args: any): string {
  const label = toolName === "bash" || toolName === "shell" || toolName === "ctx_shell" ? "Running command"
    : toolName === "read" || toolName === "ctx_read" ? "Reading file"
      : toolName === "edit" || toolName === "ctx_edit" ? "Editing file"
        : toolName === "write" ? "Writing file"
          : toolName?.includes("search") || toolName?.includes("grep") ? "Searching the codebase" : "Using tool";
  const target = typeof args?.path === "string" ? args.path : typeof args?.file === "string" ? args.file : "";
  return target ? `${label}: ${target}` : `${label}…`;
}

export function mergeEntries(items: ChatItem[], entries: WireEntry[]): { items: ChatItem[]; changed: boolean } {
  let next = items;
  let changed = false;
  for (const entry of entries) {
    if (entry.role === "toolResult") {
      const patched = applyToolResult(next, entry);
      if (patched !== next) { next = patched; changed = true; }
      continue;
    }
    if (next.some((item) => item.id === entry.id)) continue;
    const laid = layoutEntry(entry);
    if (!laid) continue;
    if (entry.role === "user" && entry.submissionId) {
      const optimisticIndex = next.findIndex((item) => item.role === "user" && item.id === entry.submissionId);
      if (optimisticIndex >= 0) {
        const optimistic = next[optimisticIndex] as Extract<ChatItem, { role: "user" }>;
        const merged: ChatItem = {
          ...laid,
          content: optimistic.content,
          mode: optimistic.mode,
          submissionStatus: optimistic.submissionStatus,
          submissionId: entry.submissionId,
        } as ChatItem;
        const copy = next.slice();
        copy[optimisticIndex] = merged;
        next = copy;
        changed = true;
        continue;
      }
    }
    next = [...next, laid];
    changed = true;
  }
  return { items: next, changed };
}
