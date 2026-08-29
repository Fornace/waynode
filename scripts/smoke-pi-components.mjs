#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const manifestPath = resolve(process.argv[2] || "config/pi-components.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const agentDir = process.env.PI_CODING_AGENT_DIR || "/root/.pi/agent";
const expectedGoal = manifest.packages.find((entry) => entry.name === "pi-codex-goal")?.version;
const expectedLean = manifest.packages.find((entry) => entry.name === "pi-lean-ctx")?.version;
if (!expectedGoal || !expectedLean) throw new Error("Required packages are missing from the component manifest");
const packageRoot = join(agentDir, "npm", "node_modules");
const extensions = [
  join(packageRoot, "pi-codex-goal", "src", "index.ts"),
  join(packageRoot, "pi-lean-ctx", "extensions", "index.ts"),
];
for (const extension of extensions) {
  const expected = extension.includes("pi-codex-goal") ? expectedGoal : expectedLean;
  const installed = JSON.parse(readFileSync(join(extension, "..", "..", "package.json"), "utf8")).version;
  if (installed !== expected) throw new Error(`Expected ${extension} version ${expected}, found ${installed}`);
}

const child = spawn("pi", [
  "--mode", "rpc",
  "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
  ...extensions.flatMap((extension) => ["--extension", extension]),
  "--no-session",
], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });

let stdout = "";
let stderr = "";
const responses = new Map();
const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });
child.stdin.end([
  JSON.stringify({ id: "state", type: "get_state" }),
  JSON.stringify({ id: "commands", type: "get_commands" }),
  "",
].join("\n"));

const [code] = await new Promise((resolvePromise, reject) => {
  child.once("error", reject);
  child.once("close", (...args) => resolvePromise(args));
});
clearTimeout(timeout);
for (const line of stdout.split("\n")) {
  if (!line.trim()) continue;
  let event;
  try { event = JSON.parse(line); } catch { continue; }
  if (event.type === "response" && event.id) responses.set(event.id, event);
}
if (code !== 0) throw new Error(`pi RPC smoke exited ${code}: ${stderr.trim()}`);
if (!responses.get("state")?.success) throw new Error("pi RPC get_state failed");
const commands = responses.get("commands")?.data?.commands || [];
for (const expected of [
  ["goal", "pi-codex-goal"],
  ["lean-ctx", "pi-lean-ctx"],
]) {
  if (!commands.some((command) => command.name === expected[0] && command.source === "extension")) {
    throw new Error(`${expected[1]} did not expose /${expected[0]} over RPC`);
  }
}
console.log(`Pi component smoke passed: RPC ready, goal ${expectedGoal}, lean-ctx ${expectedLean}.`);
