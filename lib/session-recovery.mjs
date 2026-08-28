import db from "./db.mjs";
import { getAgent } from "./agent-manager.mjs";
import { getSession } from "./sessions.mjs";
import { getSpace } from "./spaces.mjs";
import { projectSession } from "./pi-session-projection.mjs";
import { SubmissionLedger } from "./agent-submissions.mjs";
import { publishSessionEvent } from "./session-bus.mjs";

/**
 * Recovery continuation: turns interrupted by a server restart or deploy are
 * detected from persisted submissions + the pi session tail and automatically
 * resumed, so unattended work never silently dies. Mirrors trigger.dev's
 * recovery-boot default: the model keeps its context (pi --continue already
 * sees the original user message and any partial output) and receives a
 * continuation instruction.
 */

const MESSAGE_RESUME_PROMPT = [
  "Your previous turn was interrupted by a server restart before it finished.",
  "Continue exactly where you left off and complete the answer to the last user message.",
  "Do not repeat work that is already visible in the conversation.",
].join(" ");

const GOAL_RESUME_PROMPT = [
  "Your autonomous goal run was interrupted by a server restart.",
  "Continue working toward the goal from where the conversation shows progress,",
  "and keep going until you can call update_goal with status \"complete\".",
].join(" ");

export function resumePromptFor(mode) {
  return mode === "goal" ? GOAL_RESUME_PROMPT : MESSAGE_RESUME_PROMPT;
}

/**
 * Describe the interruption state of a session from durable data alone.
 * Returns null when nothing looks interrupted.
 */
export function detectInterruptedTurn(session) {
  const rows = SubmissionLedger.recoverableRows(session.id);
  if (rows.length === 0) return null;
  const { items } = projectSession(session.pi_session_dir);
  const lastUser = [...items].reverse().find((item) => item.role === "user");
  const lastUserIndex = lastUser ? items.indexOf(lastUser) : -1;
  const producedAfterUser = lastUserIndex >= 0
    ? items.slice(lastUserIndex + 1).some((item) => item.role === "assistant" || item.role === "toolResult")
    : false;
  return {
    submission: rows[0],
    queuedBehind: rows.length - 1,
    started: producedAfterUser,
  };
}

/** Resume one interrupted submission on a session. Returns true on dispatch. */
export async function resumeSession(session, row, { reason = "server-restart" } = {}) {
  const space = getSpace(session.space_id);
  if (!space) return false;
  let handle;
  try {
    handle = await getAgent(session);
  } catch (error) {
    console.error(`[recovery] cannot start agent for ${session.id}: ${error.message}`);
    return false;
  }
  publishSessionEvent(session.id, {
    type: "resumed",
    reason,
    submissionId: row.id,
    message: "Turn resumed automatically after a server restart.",
  });
  try {
    // Dispatch without awaiting turn completion: the boot scan must not
    // block on agent runtime (routes fire-and-forget the same way).
    handle.sendPrompt(resumePromptFor(row.mode), row.mode, row.id, { resumed: true })
      .catch((error) => console.error(`[recovery] resumed turn failed for ${session.id}: ${error.message}`));
    return true;
  } catch (error) {
    console.error(`[recovery] resume failed for ${session.id}: ${error.message}`);
    return false;
  }
}

/** Sessions whose submissions a restart left unfinished. */
export function interruptedSessionIds() {
  try {
    return db
      .prepare("SELECT DISTINCT session_id FROM submissions WHERE status IN ('queued','starting','running','interrupted')")
      .all()
      .map((row) => row.session_id);
  } catch {
    return [];
  }
}

let bootScanDone = false;
let recoveryPrepared = false;
let preparedCount = 0;

/** Freeze the previous process's active rows before this process accepts work. */
export function prepareInterruptedSessions() {
  if (recoveryPrepared) return preparedCount;
  recoveryPrepared = true;
  preparedCount = SubmissionLedger.markAllInterrupted();
  return preparedCount;
}

/**
 * Boot-time scan: resume rows frozen by prepareInterruptedSessions, with
 * bounded concurrency so a restart storm does not fork N agents at once.
 * Runs exactly once per server process. The preparation MUST happen before
 * listen(), otherwise new turns could be mistaken for stale work.
 */
export async function resumeInterruptedSessions({ concurrency = 2, log = console.log } = {}) {
  if (bootScanDone) return { resumed: 0, failed: 0 };
  bootScanDone = true;
  const interruptedCount = prepareInterruptedSessions();
  if (interruptedCount === 0) return { resumed: 0, failed: 0 };
  const ids = interruptedSessionIds();
  log(`[recovery] resuming ${interruptedCount} interrupted turn(s) across ${ids.length} session(s)`);
  let resumed = 0;
  let failed = 0;
  const queue = [...ids];
  const worker = async () => {
    while (queue.length > 0) {
      const id = queue.shift();
      const session = getSession(id);
      if (!session || session.archived) continue;
      const rows = SubmissionLedger.recoverableRows(id);
      if (rows.length === 0) continue;
      const primary = rows[0];
      const ok = await resumeSession(session, primary);
      if (ok) {
        resumed += 1;
        // Queued siblings ride behind the resumed turn as follow-ups.
        for (const sibling of rows.slice(1)) {
          try {
            const handle = await getAgent(session);
            handle.followUp(sibling.prompt, sibling.mode, sibling.id)
              .catch(() => {});
          } catch (error) {
            console.error(`[recovery] sibling follow-up failed for ${id}: ${error.message}`);
          }
        }
      } else {
        failed += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
  return { resumed, failed };
}
