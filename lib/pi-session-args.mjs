import { existsSync, readdirSync } from "node:fs";

/**
 * New Waynode sessions have an empty directory, so `pi --continue` has
 * nothing to resume and may wait indefinitely. Give new sessions the same
 * stable UUID as Waynode; retain `--continue` for historic directories whose
 * pi-generated session ID predates this convention.
 */
export function piSessionArgs(session, sessionDir = session.pi_session_dir) {
  let hasHistory = false;
  try {
    hasHistory = existsSync(sessionDir) && readdirSync(sessionDir).some((name) => name.endsWith(".jsonl"));
  } catch {}
  return hasHistory ? ["--continue"] : ["--session-id", session.id];
}
