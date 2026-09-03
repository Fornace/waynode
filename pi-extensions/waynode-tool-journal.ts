import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import {
  closeSync, fsyncSync, openSync, readFileSync, readdirSync, renameSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

interface JournalResult {
  toolCallId: string;
  toolName: string;
  content: unknown[];
  details?: unknown;
  usage?: unknown;
  addedToolNames?: string[];
  isError: boolean;
  timestamp: number;
}

interface Journal {
  version: 2;
  sessionId: string;
  results: Record<string, JournalResult>;
}

function journalPath(sessionFile: string): string {
  return `${sessionFile}.waynode-tools.json`;
}

function validResults(value: unknown): value is Record<string, JournalResult> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function loadJournal(sessionFile: string, sessionId: string): Journal {
  try {
    const value = JSON.parse(readFileSync(journalPath(sessionFile), "utf8"));
    if (value?.version === 2 && value.sessionId === sessionId && validResults(value.results)) {
      return value;
    }
    // v1 stored an absolute path. Accept an adjacent legacy sidecar by stable
    // filename so an upgrade can recover a guest /workspace path on the host.
    if (value?.version === 1 && basename(value.sessionFile || "") === basename(sessionFile)
        && validResults(value.results)) {
      return { version: 2, sessionId, results: value.results };
    }
  } catch {}
  return { version: 2, sessionId, results: {} };
}

function syncDirectory(path: string): void {
  const fd = openSync(dirname(path), "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function removeDurably(path: string): void {
  try {
    unlinkSync(path);
    syncDirectory(path);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function cleanupTemporaryWrites(path: string): void {
  const prefix = `${basename(path)}.`;
  let removed = false;
  try {
    for (const name of readdirSync(dirname(path))) {
      if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
      try { unlinkSync(join(dirname(path), name)); removed = true; } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (removed) syncDirectory(path);
}

function durableWrite(path: string, value: unknown): void {
  // Unique names prevent parallel tool completions from sharing one temp file.
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8");
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

function sessionToolResults(sessionFile: string): Set<string> {
  const ids = new Set<string>();
  try {
    for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let entry: any;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry?.type === "message" && entry.message?.role === "toolResult"
          && typeof entry.message.toolCallId === "string") ids.add(entry.message.toolCallId);
    }
  } catch {}
  return ids;
}

function compact(sessionFile: string, journal: Journal): Journal {
  const persisted = sessionToolResults(sessionFile);
  let changed = false;
  for (const id of Object.keys(journal.results)) {
    if (!persisted.has(id)) continue;
    delete journal.results[id];
    changed = true;
  }
  if (changed) {
    if (Object.keys(journal.results).length === 0) removeDurably(journalPath(sessionFile));
    else durableWrite(journalPath(sessionFile), journal);
  }
  return journal;
}

/**
 * Pi persists assistant tool calls before execution, then persists tool results
 * after `tool_execution_end`. A process kill in that gap loses the result and
 * makes `--continue` re-run the call. This extension closes the gap with a
 * separate fsync-backed result journal. The host repairs JSONL from it before
 * any recovery continuation is submitted.
 */
export default function waynodeToolJournal(pi: ExtensionAPI): void {
  let sessionFile: string | undefined;
  let journal: Journal | undefined;

  pi.on("session_start", (_event, ctx) => {
    sessionFile = ctx.sessionManager.getSessionFile();
    const sessionId = ctx.sessionManager.getSessionId();
    if (!sessionFile || !sessionId) { journal = undefined; return; }
    cleanupTemporaryWrites(journalPath(sessionFile));
    journal = compact(sessionFile, loadJournal(sessionFile, sessionId));
  });

  pi.on("tool_execution_end", (event) => {
    if (!sessionFile || !journal) return;
    const result = event.result ?? {};
    journal.results[event.toolCallId] = {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      content: Array.isArray(result.content) ? result.content : [],
      details: result.details,
      usage: result.usage,
      addedToolNames: result.addedToolNames,
      isError: !!event.isError,
      timestamp: Date.now(),
    };
    durableWrite(journalPath(sessionFile), journal);
  });

  // message_end runs before SessionManager.appendMessage(). Cleanup here
  // would reopen the exact crash window this journal exists to close.
  pi.on("agent_settled", () => {
    if (sessionFile && journal) compact(sessionFile, journal);
  });
}
