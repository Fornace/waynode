import { spawn, execSync } from "child_process";
import { join } from "path";
import { readFileSync } from "fs";
import { config } from "./config.mjs";
import { getSecretsEnv } from "./secrets.mjs";
import db from "./db.mjs";

let _piAvailable = null;

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

export function isChatAvailable() {
  return isPiAvailable() || (config.llm.baseUrl && config.llm.apiKey);
}

const GOAL_PREFIX = `You must use the create_goal tool to create a goal for the following task, then work autonomously until you can call update_goal with status "complete". Task: `;

export function buildPiEnv(spaceId) {
  return { ...process.env, ...getSecretsEnv(spaceId) };
}

export function runPiMessage({ session, prompt, isGoal = false }) {
  const space = db.prepare("SELECT local_path FROM spaces WHERE id = ?").get(session.space_id);
  if (!space) throw new Error("Space not found");

  const model = session.model || config.pi.defaultModel;
  const fullPrompt = isGoal ? GOAL_PREFIX + prompt : prompt;

  return spawn("pi", [
    "-p", fullPrompt,
    "--session-dir", session.pi_session_dir,
    "--model", model,
  ], {
    cwd: space.local_path,
    env: buildPiEnv(session.space_id),
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export async function runPiTerminal({ session, cols = 80, rows = 24 }) {
  const { spawn: ptySpawn } = await import("node-pty");
  const space = db.prepare("SELECT local_path FROM spaces WHERE id = ?").get(session.space_id);
  if (!space) throw new Error("Space not found");

  return ptySpawn("pi", [
    "--session-dir", session.pi_session_dir,
    "--model", session.model || config.pi.defaultModel,
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
    const raw = readFileSync(join(sessionDir, "session.jsonl"), "utf8");
    const lines = raw.trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = JSON.parse(lines[i]);
      if (entry.type === "custom" && entry.key?.startsWith("pi-codex-goal")) {
        return entry.value;
      }
    }
  } catch {}
  return null;
}
