import { spawn, spawnSync, execSync } from "child_process";
import { isAbsolute, join, relative, sep } from "path";
import { homedir } from "os";
import { readFileSync, existsSync, readdirSync, realpathSync } from "fs";
import { config } from "./config.mjs";
import db from "./db.mjs";
import { resolvePiModel } from "./pi-model.mjs";
import { buildHostedSandboxEnv, buildPiEnv } from "./pi-env.mjs";
import { sandboxChatLlmEnv } from "./sandbox-llm-key.mjs";
import { spawnSandboxedTerminal } from "./sandbox-terminal-pty.mjs";
import { beginHostedGuestMutation, enforceHostedGitCredentialBoundary } from "./git-creds.mjs";
import { piSessionArgs } from "./pi-session-args.mjs";
import { normalizeSubmissionMode } from "./agent-submissions.mjs";

export { buildHostedSandboxEnv, buildPiEnv } from "./pi-env.mjs";

let _piAvailable = null;
let _kvmAvailable = null;

export function embeddedPiResourceArgs(agentDir = join(homedir(), ".pi", "agent")) {
  const args = ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"];
  const goalExtension = join(agentDir, "npm", "node_modules", "pi-codex-goal", "src", "index.ts");
  if (agentDir === "/root/.pi/agent" || existsSync(goalExtension)) args.push("--extension", goalExtension);
  return args;
}

export function isPiAvailable() {
  if (_piAvailable !== null) return _piAvailable;
  try {
    execSync("which pi", { stdio: "pipe" });
    _piAvailable = true;
  } catch {
    _piAvailable = false;
  }
  return _piAvailable;
}

export function isKvmAvailable() {
  if (_kvmAvailable !== null) return _kvmAvailable;
  try {
    _kvmAvailable = existsSync("/dev/kvm");
  } catch {
    _kvmAvailable = false;
  }
  return _kvmAvailable;
}

export function isSandboxAvailable() {
  return isKvmAvailable();
}

export function enforceHostedSandbox(sandboxAvailable, deployment = config.deployment) {
  if (deployment === "hosted" && !sandboxAvailable) {
    throw new Error("Hosted agent execution requires hardware sandboxing");
  }
}

export function canFallbackToDirect(deployment = config.deployment) {
  return deployment !== "hosted";
}

export function enforceTerminalAvailability(deployment = config.deployment) {
  if (deployment !== "self-hosted") {
    const error = new Error(deployment === "hosted"
      ? "Interactive terminal is not available on Waynode Cloud yet"
      : "Interactive terminal is disabled for this deployment");
    error.terminalDisabled = true;
    throw error;
  }
}

const GOAL_PREFIX = `You must use the create_goal tool to create a goal for the following task, then work autonomously until you can call update_goal with status "complete". Task: `;

export function getPiArgs({ session, prompt, mode, isGoal, sessionDir = session.pi_session_dir, agentDir }) {
  const model = resolvePiModel(session).spec;
  const submissionMode = normalizeSubmissionMode(mode ?? isGoal);
  if (submissionMode === "hammersmith") throw new Error("Hammersmith jobs cannot run through Pi chat");
  const fullPrompt = submissionMode === "goal" ? GOAL_PREFIX + prompt : prompt;
  return [
    "-p", fullPrompt,
    "--no-approve",
    ...embeddedPiResourceArgs(agentDir),
    "--session-dir", sessionDir,
    ...piSessionArgs(session, sessionDir),
    "--model", model,
  ];
}

/** Translate a host session path into the already-mounted guest worktree. */
export function getSandboxSessionDir({ workspaceDir, sessionDir }) {
  const child = relative(realpathSync(workspaceDir), realpathSync(sessionDir));
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error("Sandbox session directory must be inside the worktree");
  }
  return join("/workspace", ...child.split(sep));
}

export function getSandboxPiArgs({ session, prompt, mode, isGoal, workspaceDir }) {
  const sessionDir = getSandboxSessionDir({ workspaceDir, sessionDir: session.pi_session_dir });
  return getPiArgs({ session, prompt, mode, isGoal, sessionDir, agentDir: "/root/.pi/agent" });
}

export async function runPiMessage({ session, prompt, mode, isGoal = false, onChunk = null }) {
  const space = db.prepare("SELECT local_path FROM spaces WHERE id = ?").get(session.space_id);
  if (!space) throw new Error("Space not found");

  const submissionMode = normalizeSubmissionMode(mode ?? isGoal);
  const directArgs = getPiArgs({ session, prompt, mode: submissionMode });
  const sandboxAvailable = await isSandboxAvailable();
  const hosted = config.deployment === "hosted";
  enforceHostedSandbox(sandboxAvailable);
  const releaseGuestMutation = hosted ? beginHostedGuestMutation(session.space_id) : null;
  try {
    // Establish the boundary while host Git is excluded, then keep it excluded
    // until the guest VM has stopped and can no longer rewrite .git/config.
    if (hosted) enforceHostedGitCredentialBoundary(session.space_id);
    const env = hosted
      ? buildHostedSandboxEnv({ ownerId: session.owner_id })
      : buildPiEnv(session.space_id, { ownerId: session.owner_id });
    if (sandboxAvailable) {
      const llmEnv = sandboxChatLlmEnv(session);
      const sandboxArgs = getSandboxPiArgs({ session, prompt, mode: submissionMode, workspaceDir: space.local_path });
      try {
        return await runInSandbox({
          args: sandboxArgs, cwd: space.local_path, env: { ...env, ...llmEnv },
          spaceId: session.space_id, onChunk,
        });
      } catch (err) {
        if (!canFallbackToDirect()) throw err;
        console.error("[sandbox] failed, falling back to direct:", err.message);
      }
    }
    return runPiDirect({ args: directArgs, cwd: space.local_path, env });
  } finally {
    releaseGuestMutation?.();
  }
}

/** Direct (non-sandboxed) pi execution — dev fallback only. */
function runPiDirect({ args, cwd, env }) {
  const result = spawnSync("pi", args, {
    cwd, env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  });
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status,
  };
}

// Exported (in addition to being used internally by runPiMessage) solely so
// it can be exercised directly by a mocked-SDK unit test without needing
// real KVM — see the standalone control-flow test referenced in
// docs/TASKS.md E14. Not otherwise part of the module's intended public API.
export async function runInSandbox({ args, cwd, env, spaceId, onChunk = null }) {
  const { Sandbox, NetworkPolicy, Rule, Destination } = await import("microsandbox");

  // Egress allowlist (first-match-wins per direction).
  const scopedEgress = {
    defaultEgress: "deny",
    defaultIngress: "allow",
    rules: [
      // fornace-llm, reached over the WireGuard tunnel (10.200.0.1:4000)
      Rule.allowEgress(Destination.cidr("10.200.0.1/32")),
      // git hosts (clone/push/fetch as the space owner)
      Rule.allowEgress(Destination.domain("github.com")),
      Rule.allowEgress(Destination.domainSuffix("github.com")),
      Rule.allowEgress(Destination.domain("raw.githubusercontent.com")),
      Rule.allowEgress(Destination.domain("gitlab.com")),
      Rule.allowEgress(Destination.domainSuffix("gitlab.com")),
      Rule.allowDns(),
      // hard block cloud metadata (IMDS) — SSRF / credential theft
      Rule.denyEgress(Destination.group("metadata")),
    ],
  };

  const name = `wn-${spaceId}-${Date.now()}`;
  const sandbox = await Sandbox.builder(name)
    .image("waynode-sandbox:latest")
    .cpus(2)
    .memory(2048)
    .network((n) => n.policy(scopedEgress))
    // Bind-mount the space's repo as the VM's /workspace (rw). pi's edits
    // persist to the host repo, so sidebar commits + terminal see the same tree.
    .volume("/workspace", (m) => m.bind(cwd))
    .replace()
    .create();

  // ── EXPERIMENTAL incremental streaming (see config.mjs sandboxStreamEnabled
  // and the SandboxedAgentHandle doc comment in agent-manager.mjs for the
  // full trail of what's verified vs. assumed here) ──────────────────────
  //
  // VERIFIED BY READING SOURCE (microsandbox 0.5.7, dist typings
  // byte-identical to 0.6.1 as of 2026-07-01):
  //   - Sandbox.logStream({sources, follow:true}) returns a LogStream that
  //     tails the on-disk exec.log independently of the exec's own client
  //     connection (crates/runtime/lib/relay.rs tap_frame_into_log runs on
  //     the guest-relay reader task, not on any per-exec-client channel) —
  //     structurally this is a separate reader, not multiplexed onto the
  //     same protocol connection as execWith(...).
  //   - Because our exec runs with .tty(true), pty mode merges stdout+stderr
  //     at the guest kernel level and the relay tags those frames source
  //     "output" (per dist/logs.d.ts LogSource doc) — NOT "stdout"/"stderr".
  //     That's why sources is ["output"] below; asking for stdout/stderr
  //     here would silently receive nothing.
  //
  // NOT VERIFIED (no /dev/kvm in this dev environment, cannot exercise
  // end-to-end): running logStream({follow:true}) concurrently with an
  // in-flight execWith(...).tty(true)) on the same Sandbox object. No
  // upstream example (TS/Go/Rust) does this — every example calls
  // logStream strictly after the exec/shell call already resolved. If a
  // future engineer with real KVM sees corrupted/duplicated output, stuck
  // turns, or relay protocol errors specifically when sandboxStreamEnabled
  // is on, START HERE — this concurrency assumption is the first suspect.
  //
  // Whether or not streaming is enabled/working, this function ALWAYS
  // still returns the full collected stdout/stderr from execWith at the
  // end — onChunk is purely an additive side channel for incremental UI
  // updates, never the source of truth for the persisted/final message.
  // `recv()` on a follow:true stream blocks awaiting the NEXT entry, so a
  // plain boolean flag checked between iterations can't unblock an
  // already-pending recv() once exec resolves. Race each recv() against a
  // stop signal instead, so draining always stops promptly when the exec
  // call finishes (or throws) — this is what keeps the fallback airtight:
  // we must never let a wedged/slow log stream delay returning the final
  // collected text to the caller.
  let resolveStop;
  const stopSignal = new Promise((resolve) => { resolveStop = resolve; });
  let streamDrainDone = null;
  if (onChunk && config.sandboxStreamEnabled) {
    streamDrainDone = (async () => {
      let logStream;
      try {
        logStream = await sandbox.logStream({ sources: ["output"], follow: true });
      } catch (err) {
        console.warn("[sandbox] logStream unavailable, no incremental output:", err.message);
        return;
      }
      try {
        const STOP = Symbol("stop");
        for (;;) {
          const next = await Promise.race([logStream.recv(), stopSignal.then(() => STOP)]);
          if (next === STOP || next === null) break;
          try {
            const text = next.text();
            if (text) onChunk(text);
          } catch (err) {
            console.warn("[sandbox] logStream entry decode failed:", err.message);
          }
        }
      } catch (err) {
        // Any failure here (relay hiccup, unsupported concurrent read, log
        // rotation MissedRotation, etc.) must NEVER fail the turn — the
        // caller still gets the full text from execWith below.
        console.warn("[sandbox] logStream drain failed, falling back to whole-response:", err.message);
      } finally {
        try { await logStream?.[Symbol.asyncDispose]?.(); } catch {}
      }
    })();
  }

  try {
    // .tty(true): pi's bash tool uses node-pty, which deadlocks in the
    // microVM without a real controlling TTY (root-caused during integration).
    const out = await sandbox.execWith("pi", (e) =>
      e.args(args).cwd("/workspace").envs(env).tty(true)
    );
    return {
      stdout: out.stdout() || "",
      stderr: out.stderr() || "",
      status: out.status?.success ? 0 : (out.status?.code ?? 1),
    };
  } finally {
    // Stop draining the log stream once exec resolves (success or error).
    // resolveStop() unblocks any in-flight recv() race above; the drain
    // loop then disposes the LogStream so it doesn't outlive the sandbox.
    // Bounded wait, not an unconditional await: if disposal itself ever
    // hung (unverified corner of a mechanism this repo can't test against
    // real KVM), we still must not block returning the exec's collected
    // output to the caller — that guarantee is more important than a
    // clean stream teardown.
    resolveStop();
    if (streamDrainDone) {
      await Promise.race([
        streamDrainDone,
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]).catch(() => {});
    }
    try { await sandbox.stop(); } catch {}
  }
}

export async function runPiTerminal({ session, cols = 80, rows = 24 }) {
  const space = db.prepare("SELECT local_path FROM spaces WHERE id = ?").get(session.space_id);
  if (!space) throw new Error("Space not found");
  const args = [
    "--session-dir", session.pi_session_dir,
    "-c", // continue the chat session in this dir — the terminal is a view onto
          // the same conversation, not a fresh one. (chat ↔ terminal switches
          // reuse the session via the per-session dir.)
    "--model", resolvePiModel(session).spec,
  ];
  const sandboxAvailable = await isSandboxAvailable();
  const hosted = config.deployment === "hosted";
  enforceTerminalAvailability();
  enforceHostedSandbox(sandboxAvailable);
  const env = buildPiEnv(session.space_id, { ownerId: session.owner_id });

  if (sandboxAvailable) {
    const llmEnv = sandboxChatLlmEnv(session);
    try {
      return await spawnSandboxedTerminal({
        args,
        cwd: space.local_path,
        env: { ...env, ...llmEnv },
        spaceId: session.space_id,
        sessionId: session.id,
      });
    } catch (error) {
      if (!canFallbackToDirect()) throw error;
      console.error("[sandbox] terminal failed, falling back to direct:", error.message);
    }
  }

  const { spawn: ptySpawn } = await import("node-pty");
  return ptySpawn("pi", args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd: space.local_path,
    env,
  });
}

export function readGoalStatus(sessionDir) {
  try {
    const files = existsSync(sessionDir) ? readdirSync(sessionDir) : [];
    const jsonl = files.filter((f) => f.endsWith(".jsonl"));
    for (const file of jsonl) {
      const raw = readFileSync(join(sessionDir, file), "utf8");
      const lines = raw.trim().split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.type === "custom" && entry.key?.startsWith("pi-codex-goal")) {
            return entry.value;
          }
        } catch {}
      }
    }
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
