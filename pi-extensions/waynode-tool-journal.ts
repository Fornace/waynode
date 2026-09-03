import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
  version: 1;
  sessionFile: string;
  results: Record<string, JournalResult>;
}

function journalPath(sessionFile: string): string {
  return `${sessionFile}.waynode-tools.json`;
}

function loadJournal(sessionFile: string): Journal {
  const path = journalPath(sessionFile);
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (value?.version === 1 && value.sessionFile === sessionFile && value.results) return value;
  } catch {}
  return { version: 1, sessionFile, results: {} };
}

function durableWrite(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, "w", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  const dir = openSync(dirname(path), "r");
  try { fsyncSync(dir); } finally { closeSync(dir); }
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

function removeJournal(path: string): void {
  try { unlinkSync(path); } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
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
    if (Object.keys(journal.results).length === 0) removeJournal(journalPath(sessionFile));
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
    journal = sessionFile ? compact(sessionFile, loadJournal(sessionFile)) : undefined;
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

  pi.on("message_end", (event) => {
    if (!sessionFile || !journal || event.message.role !== "toolResult") return;
    if (!journal.results[event.message.toolCallId]) return;
    delete journal.results[event.message.toolCallId];
    if (Object.keys(journal.results).length === 0) removeJournal(journalPath(sessionFile));
    else durableWrite(journalPath(sessionFile), journal);
  });

  pi.on("agent_settled", () => {
    if (sessionFile && journal) compact(sessionFile, journal);
  });
}
