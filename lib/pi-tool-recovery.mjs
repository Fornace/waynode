import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, openSync, readFileSync, readdirSync,
  renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { projectSession, readSessionEntries } from "./pi-session-projection.mjs";

const JOURNAL_SUFFIX = ".waynode-tools.json";

function id(existing) {
  let value;
  do { value = randomBytes(4).toString("hex"); } while (existing.has(value));
  existing.add(value);
  return value;
}

function sessionFiles(sessionDir) {
  if (!existsSync(sessionDir)) return [];
  return readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl")).sort()
    .map((name) => join(sessionDir, name));
}

function sessionIdFromFile(sessionFile) {
  try {
    for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (entry?.type === "session" && typeof entry.id === "string") return entry.id;
      break;
    }
  } catch {}
  return null;
}

function durableAppend(path, line) {
  const fd = openSync(path, "a");
  try {
    writeFileSync(fd, line, "utf8");
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

function syncDirectory(path) {
  const fd = openSync(dirname(path), "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function removeDurably(path) {
  try {
    unlinkSync(path);
    syncDirectory(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function durableRewrite(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, value, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    syncDirectory(path);
  } catch (error) {
    if (fd !== undefined) try { closeSync(fd); } catch {}
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
}

function cleanTemporaryWrites(path) {
  const prefix = `${basename(path)}.`;
  let removed = false;
  try {
    for (const name of readdirSync(dirname(path))) {
      if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
      try { unlinkSync(join(dirname(path), name)); removed = true; } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (removed) syncDirectory(path);
}

function journalFor(sessionFile) {
  const path = `${sessionFile}${JOURNAL_SUFFIX}`;
  cleanTemporaryWrites(path);
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    const sessionId = sessionIdFromFile(sessionFile);
    const identityMatches = value?.version === 2
      ? !!sessionId && value.sessionId === sessionId
      // Adjacent v1 journals are upgrade-compatible across host/guest paths.
      : value?.version === 1 && basename(value.sessionFile || "") === basename(sessionFile);
    return identityMatches && value.results && typeof value.results === "object"
      ? { path, value } : null;
  } catch {
    return null;
  }
}

function unresolvedCalls(entries) {
  const results = new Set();
  for (const entry of entries) {
    if (entry?.type === "message" && entry.message?.role === "toolResult") {
      results.add(entry.message.toolCallId);
    }
  }
  const calls = [];
  for (const entry of entries) {
    if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
    for (const block of entry.message.content || []) {
      if (block?.type === "toolCall" && !results.has(block.id)) {
        calls.push({ id: block.id, name: block.name });
      }
    }
  }
  return calls;
}

function fallbackResult(call) {
  return {
    toolCallId: call.id,
    toolName: call.name,
    content: [{
      type: "text",
      text: "Waynode recovered after the execution process stopped before this tool result was durably recorded. The tool may have produced side effects. Inspect current state before deciding whether to retry it.",
    }],
    isError: true,
    timestamp: Date.now(),
  };
}

/**
 * Complete interrupted tool calls before sending a recovery prompt to Pi.
 * Journaled completions are restored exactly. Calls without a journaled end
 * become explicit error results, preventing Pi from executing them again.
 */
export function repairInterruptedToolCalls(sessionDir) {
  const files = sessionFiles(sessionDir);
  if (files.length === 0) return { repaired: 0, restored: 0, uncertain: 0 };
  const entries = readSessionEntries(sessionDir);
  const projection = projectSession(sessionDir);
  const activeIds = new Set(projection.items.map((item) => item.id));
  const calls = unresolvedCalls(entries.filter((entry) => activeIds.has(entry.id)));
  const journals = files.map(journalFor).filter(Boolean);

  if (calls.length === 0) {
    // A crash after Pi persisted the result but before agent_settled may leave
    // redundant journal data. Delete only records proven present in JSONL.
    const persisted = new Set(entries.filter((entry) => entry.message?.role === "toolResult")
      .map((entry) => entry.message.toolCallId));
    consumeJournalResults(journals, persisted);
    return { repaired: 0, restored: 0, uncertain: 0 };
  }

  const target = files[files.length - 1];
  const existing = new Set(entries.map((entry) => entry?.id).filter(Boolean));
  let parentId = projection.leafId;
  let restored = 0;
  let uncertain = 0;

  for (const call of calls) {
    let result;
    for (let i = journals.length - 1; i >= 0 && !result; i -= 1) {
      result = journals[i].value.results[call.id];
    }
    if (result) restored += 1;
    else { result = fallbackResult(call); uncertain += 1; }
    const entry = {
      type: "message",
      id: id(existing),
      parentId,
      timestamp: new Date().toISOString(),
      message: {
        role: "toolResult",
        toolCallId: call.id,
        toolName: result.toolName || call.name,
        content: Array.isArray(result.content) ? result.content : [],
        details: result.details,
        usage: result.usage,
        ...(result.addedToolNames?.length ? { addedToolNames: result.addedToolNames } : {}),
        isError: !!result.isError,
        timestamp: result.timestamp || Date.now(),
      },
    };
    durableAppend(target, `${JSON.stringify(entry)}\n`);
    parentId = entry.id;
  }

  consumeJournalResults(journals, new Set(calls.map((call) => call.id)));
  return { repaired: calls.length, restored, uncertain };
}

function consumeJournalResults(journals, consumedIds) {
  for (const journal of journals) {
    let changed = false;
    for (const toolCallId of consumedIds) {
      if (!journal.value.results[toolCallId]) continue;
      delete journal.value.results[toolCallId];
      changed = true;
    }
    if (!changed) continue;
    if (Object.keys(journal.value.results).length === 0) removeDurably(journal.path);
    else durableRewrite(journal.path, `${JSON.stringify(journal.value)}\n`);
  }
}
