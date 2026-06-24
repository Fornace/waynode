import { spawn, spawnSync, execSync } from "child_process";
import { join } from "path";
import { readFileSync, existsSync, readdirSync } from "fs";
import { config } from "./config.mjs";
import { getSecretsEnv } from "./secrets.mjs";
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

export function buildPiEnv(spaceId) {
  return { ...process.env, ...getSecretsEnv(spaceId) };
}

function getPiArgs({ session, prompt, isGoal }) {
  const model = session.model ? `fornace/${session.model}` : "fornace/fornace-fast";
  const fullPrompt = isGoal ? GOAL_PREFIX + prompt : prompt;
  return [
    "-p", fullPrompt,
    "--session-dir", session.pi_session_dir,
    "--model", model,
  ];
}

export function runPiMessageSync({ session, prompt, isGoal = false }) {
  const space = db.prepare("SELECT local_path FROM spaces WHERE id = ?").get(session.space_id);
  if (!space) throw new Error("Space not found");

  const args = getPiArgs({ session, prompt, isGoal });
  const env = buildPiEnv(session.space_id);

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
    "--model", session.model ? `fornace/${session.model}` : "fornace/fornace-fast",
  ], {
    name: "xterm-256color",
    cols,
    rows,
    cwd: space.local_path,
    env: buildPiEnv(session.space_id),
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
