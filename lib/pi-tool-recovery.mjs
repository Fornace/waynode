import { randomBytes } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, openSync, readFileSync, readdirSync,
  renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
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

function durableAppend(path, line) {
  const fd = openSync(path, "a");
  try {
    writeFileSync(fd, line, "utf8");
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

function durableRewrite(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, "w", 0o600);
  try {
    writeFileSync(fd, value, "utf8");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(temporary, path);
  const dir = openSync(dirname(path), "r");
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

function journalFor(sessionFile) {
  const path = `${sessionFile}${JOURNAL_SUFFIX}`;
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value?.version === 1 && value.sessionFile === sessionFile && value.results
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
  const activeIds = new Set(projectSession(sessionDir).items.map((item) => item.id));
  const calls = unresolvedCalls(entries.filter((entry) => activeIds.has(entry.id)));
  if (calls.length === 0) return { repaired: 0, restored: 0, uncertain: 0 };

  const target = files[files.length - 1];
  const existing = new Set(entries.map((entry) => entry?.id).filter(Boolean));
  let parentId = projectSession(sessionDir).leafId;
  let restored = 0;
  let uncertain = 0;
  const journals = files.map(journalFor).filter(Boolean);

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

  const repairedIds = new Set(calls.map((call) => call.id));
  for (const journal of journals) {
    for (const toolCallId of repairedIds) delete journal.value.results[toolCallId];
    if (Object.keys(journal.value.results).length === 0) unlinkSync(journal.path);
    else durableRewrite(journal.path, `${JSON.stringify(journal.value)}\n`);
  }
  return { repaired: calls.length, restored, uncertain };
}
