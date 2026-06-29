import { spawn, spawnSync, execSync } from "child_process";
import { join } from "path";
import { readFileSync, existsSync, readdirSync } from "fs";
import { config } from "./config.mjs";
import { getSecretsEnv } from "./secrets.mjs";
import { identityForUserId } from "./git-identity.mjs";
import { credsForSpace, askpassEnv } from "./git-creds.mjs";
import db from "./db.mjs";

let _piAvailable = null;
let _kvmAvailable = null;

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

const GOAL_PREFIX = `You must use the create_goal tool to create a goal for the following task, then work autonomously until you can call update_goal with status "complete". Task: `;

/**
 * SECURITY: the minimal environment handed to pi. pi runs ARBITRARY tenant code,
 * so it must NEVER receive the server's secrets (ENCRYPTION_KEY,
 * *_CLIENT_SECRET, SESSION_SECRET, DEV_AUTH_TOKEN, LLM_API_KEY, …). Spreading
 * process.env wholesale would let any tenant agent `printenv` the master key and
 * decrypt every tenant's stored tokens.
 *
 * This is an ALLOWLIST: only system basics + pi/lean-ctx config (none secret).
 * Space secrets are added separately via getSecretsEnv().
 */
const ENV_ALLOWLIST = [
  "PATH", "HOME", "USER", "LOGNAME",
  "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ", "TMPDIR", "SHELL",
];
const ENV_PREFIX_ALLOW = ["PI_", "LEAN_CTX_"]; // pi + lean-ctx config; none secret

function minimalBaseEnv() {
  const env = {};
  for (const k of ENV_ALLOWLIST) {
    if (process.env[k] !== undefined && process.env[k] !== "") env[k] = process.env[k];
  }
  for (const [k, v] of Object.entries(process.env)) {
    if (ENV_PREFIX_ALLOW.some((p) => k.startsWith(p))) env[k] = v;
  }
  env.HOME = env.HOME || "/root"; // pi config lives in ~/.pi (Dockerfile sets /root)
  return env;
}

export function buildPiEnv(spaceId, { ownerId } = {}) {
  // Start from a MINIMAL allowlist (NOT process.env), then add only the
  // space's own secrets + the git identity/credentials for the session owner.
  const env = { ...minimalBaseEnv(), ...getSecretsEnv(spaceId) };
  // Attribute pi's git commits to the SESSION OWNER (the delegating human),
  // never to a bot. The env vars are inherited by every git op pi runs, so
  // delegated merges land as the user who delegated them.
  const identity = identityForUserId(ownerId);
  env.GIT_AUTHOR_NAME = identity.name;
  env.GIT_AUTHOR_EMAIL = identity.email;
  env.GIT_COMMITTER_NAME = identity.name;
  env.GIT_COMMITTER_EMAIL = identity.email;
  // Authenticate git ops pi runs (push/pull/fetch/submodules) with the space
  // owner's provider token, routed by provider host (GitHub vs GitLab).
  Object.assign(env, askpassEnv(credsForSpace(spaceId)));
  return env;
}

function getPiArgs({ session, prompt, isGoal }) {
  const model = session.model ? `fornace/${session.model}` : "fornace/fornace-fast";
  const fullPrompt = isGoal ? GOAL_PREFIX + prompt : prompt;
  return [
    "-p", fullPrompt,
    "--session-dir", session.pi_session_dir,
    "-c", // continue the session in this dir (see agent-manager.mjs)
    "--model", model,
  ];
}

export function runPiMessageSync({ session, prompt, isGoal = false }) {
  const space = db.prepare("SELECT local_path FROM spaces WHERE id = ?").get(session.space_id);
  if (!space) throw new Error("Space not found");

  const args = getPiArgs({ session, prompt, isGoal });
  const env = buildPiEnv(session.space_id, { ownerId: session.owner_id });

  // ── Sandboxed mode: run inside microsandbox microVM ──
  if (isSandboxAvailable()) {
    try {
      return runInSandbox({ args, cwd: space.local_path, env });
    } catch (err) {
      console.error("[sandbox] failed, falling back to direct:", err.message);
    }
  }

  // ── Direct mode: run pi as child process ──
  const result = spawnSync("pi", args, {
    cwd: space.local_path,
    env,
    encoding: "utf8",
    timeout: 120000,
    stdio: ["pipe", "pipe", "pipe"],
  });

  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status,
  };
}

async function runInSandbox({ args, cwd, env }) {
  const { Sandbox } = await import("microsandbox");

  const sandboxName = `waynode-${Date.now()}`;
  const sandbox = await Sandbox.builder(sandboxName)
    .image("node:26-slim")
    .cpus(1)
    .memory(1024)
    .create();

  try {
    // Mount the repo directory
    // Run pi inside the sandbox
    const output = await sandbox.exec("pi", args, { cwd: "/workspace", env });
    return {
      stdout: output.stdout() || "",
      stderr: output.stderr() || "",
      status: 0,
    };
  } finally {
    await sandbox.stop();
  }
}

export async function runPiTerminal({ session, cols = 80, rows = 24 }) {
  const { spawn: ptySpawn } = await import("node-pty");
  const space = db.prepare("SELECT local_path FROM spaces WHERE id = ?").get(session.space_id);
  if (!space) throw new Error("Space not found");

  return ptySpawn("pi", [
    "--session-dir", session.pi_session_dir,
    "-c", // continue the chat session in this dir — the terminal is a view onto
          // the same conversation, not a fresh one. (chat ↔ terminal switches
          // reuse the session via the per-session dir.)
    "--model", session.model ? `fornace/${session.model}` : "fornace/fornace-fast",
  ], {
    name: "xterm-256color",
    cols,
    rows,
    cwd: space.local_path,
    env: buildPiEnv(session.space_id, { ownerId: session.owner_id }),
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
