import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync,
} from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ACTIVE_TASK_STATES = new Set(["queued", "running", "verifying", "retrying"]);

export function structuredRunSnapshot(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.tasks)) return null;
  const statuses = raw.tasks.map((task) => task && typeof task.status === "string" ? task.status : "");
  const passed = statuses.filter((status) => status === "pass").length;
  const failed = statuses.filter((status) => status === "fail").length;
  const running = statuses.some((status) => ACTIVE_TASK_STATES.has(status));
  return {
    runId: typeof raw.run_id === "string" ? raw.run_id : null,
    lifecycle: raw.finished === true && raw.state === "finished" ? "finished" : running ? "running" : "running",
    totalTasks: statuses.length,
    checkedTasks: passed + failed,
    passedTasks: passed,
    failedTasks: failed,
  };
}

function matchesExpectedRun(raw, fileName, expected) {
  if (!raw || raw.run_name !== expected.runName || raw.project !== "Waynode Space") return false;
  if (raw.identity !== expected.identity || !Array.isArray(raw.tasks) || raw.tasks.length !== 1) return false;
  if (raw.tasks[0]?.key !== expected.taskKey || raw.tasks[0]?.check !== expected.check) return false;
  return typeof raw.run_id === "string" && basename(fileName, ".json") === raw.run_id;
}

export function expectedStructuredState(stateDir, expected) {
  const runsDir = join(stateDir, "runs");
  let names;
  try { names = readdirSync(runsDir).filter((name) => name.endsWith(".json")); }
  catch { return null; }
  const matches = [];
  for (const name of names) {
    try {
      const raw = JSON.parse(readFileSync(join(runsDir, name), "utf8"));
      if (matchesExpectedRun(raw, name, expected)) matches.push(raw);
    } catch {}
  }
  if (matches.length !== 1) return null;
  return structuredRunSnapshot(matches[0]);
}

function hashTree(hash, root, rel = "") {
  const path = rel ? join(root, rel) : root;
  const stat = lstatSync(path);
  hash.update(`${rel}\0${stat.mode}\0${stat.size}\0`);
  if (stat.isSymbolicLink()) {
    hash.update(`link\0${readlinkSync(path)}\0`);
  } else if (stat.isDirectory()) {
    hash.update("dir\0");
    for (const name of readdirSync(path).sort()) hashTree(hash, root, rel ? join(rel, name) : name);
  } else if (stat.isFile()) {
    hash.update("file\0");
    hash.update(readFileSync(path));
  } else {
    hash.update("other\0");
  }
}

export function fingerprintGitMetadata(repositoryPath) {
  const gitPath = realpathSync(join(repositoryPath, ".git"));
  const hash = createHash("sha256");
  hashTree(hash, gitPath);
  return hash.digest("hex");
}

export function descendantProcesses(rootPid, processes) {
  const descendants = new Set([Number(rootPid)]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of processes) {
      if (!descendants.has(process.pid) && descendants.has(process.ppid)) {
        descendants.add(process.pid);
        changed = true;
      }
    }
  }
  return processes.filter((process) => descendants.has(process.pid));
}

async function systemProcesses() {
  const { stdout } = await execFileAsync("ps", ["-A", "-o", "pid=,ppid=,pgid="], {
    shell: false, timeout: 5000, maxBuffer: 1024 * 1024,
  });
  return String(stdout).trim().split("\n").flatMap((line) => {
    const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
    return [pid, ppid, pgid].every(Number.isInteger) ? [{ pid, ppid, pgid }] : [];
  });
}

function alive(pid, kill) {
  try { kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

function signalTree(processes, signal, kill) {
  const own = processes.find((entry) => entry.pid === process.pid)?.pgid;
  const groups = new Set(processes.map((entry) => entry.pgid).filter((pgid) => pgid > 1 && pgid !== own));
  for (const pgid of groups) {
    try { kill(-pgid, signal); } catch (error) { if (error?.code !== "ESRCH") throw error; }
  }
  for (const entry of processes) {
    try { kill(entry.pid, signal); } catch (error) { if (error?.code !== "ESRCH") throw error; }
  }
}

async function waitForExit(pids, kill, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (pids.some((pid) => alive(pid, kill)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !pids.some((pid) => alive(pid, kill));
}

export async function terminateProcessTree(rootPid, options = {}) {
  if (!Number.isInteger(Number(rootPid)) || Number(rootPid) <= 1) throw new Error("Invalid Hammersmith process id");
  const list = options.listProcesses || systemProcesses;
  const kill = options.kill || process.kill.bind(process);
  const graceMs = options.graceMs ?? 5000;
  const processes = descendantProcesses(Number(rootPid), await list());
  const pids = processes.map((entry) => entry.pid);
  if (!pids.includes(Number(rootPid)) || !alive(Number(rootPid), kill)) return true;
  signalTree(processes, "SIGINT", kill);
  if (await waitForExit(pids, kill, graceMs)) return true;
  const remaining = descendantProcesses(Number(rootPid), await list());
  signalTree(remaining.length ? remaining : processes, "SIGKILL", kill);
  if (!(await waitForExit(pids, kill, 2000))) throw new Error("Hammersmith descendants are still running");
  return true;
}

export function hostedOuterTimeoutMs({ timeoutSeconds, maxAttempts }) {
  const attempts = Math.max(1, Number(maxAttempts) || 1);
  const perAttempt = Math.max(60, Number(timeoutSeconds) || 60);
  return (attempts * perAttempt + attempts * 120 + 180) * 1000;
}
