import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";

export function readGoalStatus(sessionDir) {
  // pi-codex-goal persists goal state as session entries shaped
  //   { type: "custom", customType: "pi-codex-goal", data: { kind, ... } }
  // with kinds "set" (full goal), "usage" (status + usage refresh) and
  // "clear". Fold them in file order — the same reconstruction the
  // extension itself does (goal-persistence.ts / state.ts), minus branch
  // awareness (waynode sessions are linear). The previous implementation
  // matched `entry.key`/`entry.value`, fields pi never writes, so goal
  // status was permanently null in every client.
  try {
    const files = existsSync(sessionDir) ? readdirSync(sessionDir) : [];
    // Session filenames start with an ISO timestamp; lexical sort ascending,
    // take the newest file.
    const jsonl = files.filter((f) => f.endsWith(".jsonl")).sort();
    const file = jsonl[jsonl.length - 1];
    if (!file) return null;
    const lines = readFileSync(join(sessionDir, file), "utf8").trim().split("\n");
    let goal = null;
    for (const line of lines) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.type !== "custom" || entry.customType !== "pi-codex-goal") continue;
      const data = entry.data;
      if (!data || typeof data !== "object") continue;
      if (data.kind === "set" && data.goal) goal = data.goal;
      else if (data.kind === "clear") goal = null;
      else if (data.kind === "usage" && goal && goal.goalId === data.goalId) {
        goal = { ...goal, status: data.status ?? goal.status, usage: data.usage ?? goal.usage };
      }
    }
    if (!goal) return null;
    return {
      status: goal.status ?? null,
      objective: goal.objective,
      tokenBudget: goal.tokenBudget ?? undefined,
      tokenUsage: goal.usage?.tokensUsed ?? undefined,
      elapsedMs: goal.usage?.activeSeconds != null ? goal.usage.activeSeconds * 1000 : undefined,
    };
  } catch {}
  return null;
}

/**
 * Sum token usage across ALL assistant messages persisted in a pi session
 * dir. There's no long-lived RPC process for the sandboxed (one-shot per
 * turn) path to ask `get_session_stats` of, but pi's own implementation of
 * that command (agent-session.js getSessionStats()) does nothing more than
 * sum `usage.{input,output,cacheRead,cacheWrite}` off every persisted
 * assistant message — the same data this reads straight from the JSONL
 * session file that `pi_session_dir` already points at (host-readable: it
 * lives inside the bind-mounted repo, not inside the microVM). Mirrors
 * readGoalStatus()'s file-scanning approach above.
 *
 * Returns the cumulative total (input+output+cacheRead+cacheWrite) across
 * the whole session, matching SessionStats.tokens.total's semantics — the
 * caller is responsible for diffing against the last-seen total to bill
 * only the delta.
 */
export function computeSessionTokenTotal(sessionDir) {
  let total = 0;
  try {
    const files = existsSync(sessionDir) ? readdirSync(sessionDir) : [];
    const jsonl = files.filter((f) => f.endsWith(".jsonl"));
    for (const file of jsonl) {
      const raw = readFileSync(join(sessionDir, file), "utf8");
      for (const line of raw.trim().split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const entry = JSON.parse(trimmed);
          if (entry.type === "message" && entry.message?.role === "assistant") {
            const u = entry.message.usage;
            if (u) total += (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
          }
        } catch {}
      }
    }
  } catch {}
  return total;
}
