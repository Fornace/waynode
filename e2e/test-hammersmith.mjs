/** Model-free contract tests for the Hammersmith integration. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
const root = mkdtempSync(join(tmpdir(), "waynode-hammersmith-test-"));
const repo = join(root, "repo");
mkdirSync(repo);
execFileSync("git", ["init", "-q", repo]);
execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://example.com/example/repo.git"]);
process.env.SESSION_SECRET = "test-session-value";
process.env.ENCRYPTION_KEY = "0".repeat(64);
process.env.DATA_DIR = join(root, "data");
process.env.APP_URL = "https://waynode.example.test";
process.env.WAYNODE_DEPLOYMENT = "hosted";
process.env.WAYNODE_SANDBOX_LLM_KEY = "test-runtime-value";
process.env.SERVER_ONLY_VALUE = "must-not-cross-boundary";
const { default: db } = await import("../lib/db.mjs");
const { deriveSelfHostedTaskLayout, hostedTaskLayout, ManifestFactory } = await import("../lib/hammersmith-manifest.mjs");
const {
  HostedMicrosandboxHammersmithRunner,
  LocalProcessHammersmithRunner,
  structuredRunSnapshot,
} = await import("../lib/hammersmith-runner.mjs");
const {
  createHammersmithJob,
  getHammersmithJob,
  getHammersmithJobBySubmission,
  publicHammersmithJob,
  setSettingsForUser,
  settingForUser,
  updateHammersmithJob,
} = await import("../lib/hammersmith-store.mjs");
const { publishHammersmithJob, subscribeHammersmithJobs } = await import("../lib/hammersmith-events.mjs");
const { setSecret } = await import("../lib/secrets.mjs");
const { normalizeSubmissionMode } = await import("../lib/agent-submissions.mjs");
const {
  clearHammersmithCapabilityCache,
  detectHammersmithCapability,
  validateHammersmithSettings,
} = await import("../routes/hammersmith.js");
const ownerId = randomUUID();
const spaceId = randomUUID();
const sessionId = randomUUID();
const sessionDir = join(repo, ".waynode", "sessions", sessionId);
mkdirSync(sessionDir, { recursive: true });
db.prepare("INSERT INTO users (id, name) VALUES (?, ?)").run(ownerId, "Test owner");
db.prepare(`INSERT INTO spaces (id, owner_id, repo_url, repo_name, repo_full_name, local_path)
  VALUES (?, ?, ?, ?, ?, ?)`)
  .run(spaceId, ownerId, "https://example.com/example/repo.git", "repo", "example/repo", repo);
db.prepare(`INSERT INTO sessions (id, space_id, owner_id, title, pi_session_dir, provider, composer_mode)
  VALUES (?, ?, ?, ?, ?, ?, ?)`)
  .run(sessionId, spaceId, ownerId, "Test", sessionDir, "fornace", "hammersmith");
const description = `job-${randomUUID()}\nKeep punctuation unchanged: [] {} !`;
const manifestFactory = new ManifestFactory({ maxAttempts: 2, timeoutSeconds: 900 });
const selfHostedLayout = deriveSelfHostedTaskLayout(repo);
const manifestText = manifestFactory.serialize({
  jobId: randomUUID(), jobDescription: description, ...selfHostedLayout, engine: "pi", mutating: true,
});
const manifest = JSON.parse(manifestText);
const wrappedDescription = manifest.tasks[0].spec.split("--- USER JOB DESCRIPTION (VERBATIM) ---\n")[1].split("\n--- END USER JOB DESCRIPTION ---")[0];
assert.equal(wrappedDescription, description, "fixed wrapper preserves the exact job description");
assert.equal(manifest.workdir, root);
assert.equal(manifest.tasks[0].key, "repo", "self-hosted task directory resolves to the cloned repository");
assert.equal(manifest.tasks[0].full_access, false);
assert.equal(manifest.tasks[0].engine, "pi");
assert.match(manifest.tasks[0].check, /git diff --check/);
assert.match(manifest.tasks[0].check, /\[ -f package\.json \]/);
assert.deepEqual(manifest.tasks[0].expect_files, []);
assert.ok(manifest.tasks[0].verified.length > 40);
assert.throws(() => normalizeSubmissionMode("surprise"), /Unknown submission mode/);
assert.equal(normalizeSubmissionMode(true), "goal", "legacy isGoal remains compatible");
execFileSync("/bin/sh", ["-c", manifest.tasks[0].check], { cwd: repo, stdio: "pipe" });
const pinnedRoot = join(root, "pinned-source");
mkdirSync(pinnedRoot);
const archive = join(process.cwd(), "vendor/hammersmith/hammersmith-0.1.0+296df004.tar.gz");
execFileSync("tar", ["-xzf", archive, "-C", pinnedRoot]);
const pinnedPythonPath = join(pinnedRoot, "hammersmith-0.1.0");
const pinnedEntry = join(process.cwd(), "vendor/hammersmith/hammersmith-entry.py");
const pinnedConfig = join(root, "pinned-config.toml"); writeFileSync(pinnedConfig, `state_dir = ${JSON.stringify(join(root, "pinned-state"))}\nallow_full_access = false\n`);
function assertPinnedLintClean(text, name) {
  const path = join(root, `${name}.json`);
  writeFileSync(path, text);
  try {
    execFileSync("python3", [pinnedEntry, "--config", pinnedConfig, "lint", path], {
      env: { ...process.env, PYTHONPATH: pinnedPythonPath }, stdio: "pipe",
    });
  } catch (error) {
    const lines = String(error.stdout || "").trim().split("\n").filter(Boolean);
    const detail = `status=${error.status} code=${error.code ?? "n/a"} stdout=${error.stdout} stderr=${error.stderr}`;
    assert.ok(lines.length > 0 && lines.every((line) => line.startsWith("lint: WARNING:")), `pinned lint has only advisory findings (${detail})`);
  }
}
assertPinnedLintClean(manifestText, "short-manifest");
const hostedLayout = hostedTaskLayout();
const longDescription = `Long adversarial job:\n${"Keep this exact line and punctuation [] {} ! --flag $HOME.\n".repeat(900)}`;
const hostedJob = { id: randomUUID() };
const hostedManifestText = manifestFactory.serialize({
  jobId: hostedJob.id, jobDescription: longDescription, ...hostedLayout, engine: "pi", mutating: true,
});
assertPinnedLintClean(hostedManifestText, "long-manifest");
function writeFinishedState(stateDir, { jobId, taskKey, identity, runId = randomUUID() }) {
  const runs = join(stateDir, "runs");
  mkdirSync(runs, { recursive: true });
  writeFileSync(join(runs, `${runId}.json`), JSON.stringify({
    run_id: runId, run_name: `waynode-${jobId}`, project: "Waynode Space", identity,
    state: "finished", finished: true,
    tasks: [{ key: taskKey, status: "pass", check: manifest.tasks[0].check }],
  }));
  return runId;
}
const localState = join(root, "local-job");
mkdirSync(localState, { recursive: true });
const localManifest = join(localState, "manifest.json");
writeFileSync(localManifest, manifestText);
const localCalls = [];
const localSnapshots = [];
const localJob = { id: randomUUID() };
const localRunner = new LocalProcessHammersmithRunner({
  executable: "/fixed/hammersmith",
  onSnapshot: (_id, fields) => localSnapshots.push(fields),
  exec: async (file, args, options) => {
    localCalls.push({ phase: "lint", file, args, options });
    return { stdout: "", stderr: "" };
  },
  spawn: (file, args, options) => {
    localCalls.push({ phase: "run", file, args, options });
    const child = new EventEmitter();
    child.pid = 91001;
    child.kill = () => true;
    writeFinishedState(join(localState, "state"), { jobId: localJob.id, taskKey: selfHostedLayout.taskKey, identity: "waynode" });
    queueMicrotask(() => child.emit("exit", 0, null));
    return child;
  },
});
await localRunner.execute({
  job: localJob,
  session: { id: sessionId, owner_id: ownerId, space_id: spaceId, local_path: repo },
  manifestPath: localManifest,
  stateDir: localState,
});
assert.deepEqual(localCalls.map((call) => call.phase), ["lint", "run"], "lint precedes run");
for (const call of localCalls) {
  assert.equal(call.file, "/fixed/hammersmith");
  assert.equal(call.options.shell, false, "local invocation never uses a shell");
  assert.equal(call.args.some((arg) => arg.includes(description)), false, "job text never enters argv");
  assert.equal(call.args.includes("--no-dashboard"), false);
}
assert.equal(localCalls.find((call) => call.phase === "run").options.detached, true, "self-hosted Hammersmith owns a process group");
assert.equal(localSnapshots.at(-1)?.lifecycle, "finished");
let releaseSetupLint;
let setupLintStartedResolve;
const setupLintStarted = new Promise((resolve) => { setupLintStartedResolve = resolve; });
let setupSpawned = false;
const setupSnapshots = [];
const setupJob = { id: randomUUID() };
const setupRunner = new LocalProcessHammersmithRunner({
  executable: "/fixed/hammersmith",
  onSnapshot: (_id, fields) => setupSnapshots.push(fields),
  exec: () => new Promise((resolve) => { releaseSetupLint = resolve; setupLintStartedResolve(); }),
  spawn: () => { setupSpawned = true; throw new Error("setup stop must prevent spawn"); },
});
const setupExecution = setupRunner.execute({
  job: setupJob, session: { owner_id: ownerId, space_id: spaceId, local_path: repo },
  manifestPath: localManifest, stateDir: join(root, "setup-stop"),
});
await setupLintStarted;
let setupStopSettled = false;
const setupStop = setupRunner.stop(setupJob.id).then((value) => { setupStopSettled = true; return value; });
await Promise.resolve();
assert.equal(setupStopSettled, false, "stop during setup remains non-terminal until setup acknowledges cancellation");
assert.equal(setupSnapshots.some((fields) => fields.lifecycle), false);
releaseSetupLint({ stdout: "", stderr: "" });
assert.equal(await setupStop, true);
await setupExecution;
assert.equal(setupSpawned, false);
assert.equal(setupSnapshots.at(-1)?.lifecycle, "stopped");
let spawnedResolve;
const spawned = new Promise((resolve) => { spawnedResolve = resolve; });
let runningChild;
const stopSnapshots = [];
const stopJob = { id: randomUUID() };
const stopRunner = new LocalProcessHammersmithRunner({
  executable: "/fixed/hammersmith", exec: async () => ({ stdout: "", stderr: "" }),
  onSnapshot: (_id, fields) => stopSnapshots.push(fields),
  spawn: () => {
    runningChild = new EventEmitter();
    runningChild.pid = 91002;
    runningChild.kill = () => true;
    spawnedResolve();
    return runningChild;
  },
  terminateProcessTree: async () => { runningChild.emit("exit", null, "SIGINT"); return true; },
});
const runningExecution = stopRunner.execute({
  job: stopJob, session: { owner_id: ownerId, space_id: spaceId, local_path: repo },
  manifestPath: localManifest, stateDir: join(root, "running-stop"),
});
await spawned;
let runningStopSettled = false;
const runningStop = stopRunner.stop(stopJob.id).then((value) => { runningStopSettled = true; return value; });
await Promise.resolve();
assert.equal(runningStopSettled, false, "stop waits for the child exit acknowledgement");
assert.equal(await runningStop, true);
await runningExecution;
assert.equal(stopSnapshots.at(-1)?.lifecycle, "stopped");
const rawSnapshot = structuredRunSnapshot({
  state: "finished", finished: true,
  tasks: [{ status: "pass", terminal: "misleading failure prose" }, { status: "fail", terminal: "misleading success prose" }],
});
assert.deepEqual(rawSnapshot && {
  lifecycle: rawSnapshot.lifecycle,
  total: rawSnapshot.totalTasks,
  checked: rawSnapshot.checkedTasks,
  passed: rawSnapshot.passedTasks,
  failed: rawSnapshot.failedTasks,
}, { lifecycle: "finished", total: 2, checked: 2, passed: 1, failed: 1 }, "status uses structured fields, not terminal prose");
function commandRecorder(record) {
  const command = {
    args(value) { record.args = value; return command; },
    cwd(value) { record.cwd = value; return command; },
    envs(value) { record.env = value; return command; },
    timeout(value) { record.timeout = value; return command; },
    tty(value) { record.tty = value; return command; },
  };
  return command;
}
const hostedState = join(root, "hosted-job");
mkdirSync(hostedState, { recursive: true });
writeFileSync(join(hostedState, "manifest.json"), hostedManifestText);
const hostedCalls = [];
const hostedSnapshots = [];
setSecret({ scope: "space", spaceId, keyName: "HAMMERSMITH_LLM_KEY", value: "tenant-worker-key" });
const sandbox = {
  async execWith(file, configure) {
    const record = { file };
    configure(commandRecorder(record));
    hostedCalls.push(record);
    if (hostedCalls.length === 2) writeFinishedState(join(hostedState, "state"), {
      jobId: hostedJob.id, taskKey: hostedLayout.taskKey, identity: "waynode-hosted",
    });
    return { status: { success: true, code: 0 } };
  },
  async stop() {},
};
const hostedRunner = new HostedMicrosandboxHammersmithRunner({
  executable: "/fixed/hammersmith",
  sandboxAvailable: async () => true,
  sandboxFactory: async () => sandbox,
  onSnapshot: (_id, fields) => hostedSnapshots.push(fields),
});
await hostedRunner.execute({
  job: hostedJob,
  session: { id: sessionId, owner_id: ownerId, space_id: spaceId, local_path: repo, provider: "fornace" },
  stateDir: hostedState,
});
assert.deepEqual(hostedCalls.map((call) => call.args.at(-2)), ["lint", "--identity"]);
assert.match(hostedCalls[0].args.join(" "), /lint \/job\/manifest\.json/);
assert.match(hostedCalls[1].args.join(" "), /run \/job\/manifest\.json/);
assert.equal(hostedCalls.some((call) => call.args.some((arg) => arg.includes(description))), false);
assert.equal(hostedCalls[0].cwd, hostedLayout.taskdir);
assert.equal(hostedCalls[0].env.SERVER_ONLY_VALUE, undefined, "hosted runner does not inherit server process.env");
assert.equal(hostedCalls[0].env.WAYNODE_LLM_KEY, "tenant-worker-key");
assert.notEqual(hostedCalls[0].env.WAYNODE_LLM_KEY, process.env.WAYNODE_SANDBOX_LLM_KEY);
assert.deepEqual(Object.keys(hostedCalls[0].env).filter((key) => key.includes("SECRET") || key.includes("TOKEN")), []);
assert.equal(hostedSnapshots.at(-1)?.lifecycle, "finished");
const unackedState = join(root, "hosted-unacked");
mkdirSync(unackedState, { recursive: true });
writeFileSync(join(unackedState, "manifest.json"), hostedManifestText);
const unackedSnapshots = [];
const unackedJob = { id: randomUUID() };
const unackedRunner = new HostedMicrosandboxHammersmithRunner({
  executable: "/fixed/hammersmith", sandboxAvailable: async () => true,
  sandboxFactory: async () => ({
    async execWith() { writeFinishedState(join(unackedState, "state"), {
      jobId: unackedJob.id, taskKey: hostedLayout.taskKey, identity: "waynode-hosted",
    }); return { status: { success: true, code: 0 } }; },
    async stop() { throw new Error("shutdown unavailable"); },
  }),
  onSnapshot: (_id, fields) => unackedSnapshots.push(fields),
});
await unackedRunner.execute({
  job: unackedJob, session: { owner_id: ownerId, space_id: spaceId, local_path: repo, provider: "fornace" }, stateDir: unackedState,
});
assert.equal(unackedSnapshots.some((fields) => ["finished", "stopped"].includes(fields.lifecycle)), false, "unacknowledged sandbox shutdown stays non-terminal");
assert.match(unackedSnapshots.at(-1)?.error, /Space lock is retained/);
let fallbackCreated = false;
const unavailableSnapshots = [];
const unavailableRunner = new HostedMicrosandboxHammersmithRunner({
  sandboxAvailable: async () => false,
  sandboxFactory: async () => { fallbackCreated = true; },
  onSnapshot: (_id, fields) => unavailableSnapshots.push(fields),
});
await unavailableRunner.execute({ job: { id: randomUUID() }, session: {}, stateDir: join(root, "no-kvm") });
assert.equal(fallbackCreated, false, "hosted KVM failure has no direct fallback");
assert.equal(unavailableSnapshots[0]?.lifecycle, "stopped");
let capabilityInvocation;
clearHammersmithCapabilityCache();
const capability = await detectHammersmithCapability({
  execute: async (file, args, options) => {
    capabilityInvocation = { file, args, options };
    return { stdout: "hammersmith 0.1.0\n" };
  },
  sandboxAvailable: async () => true,
});
assert.deepEqual(capabilityInvocation.args, ["--version"]);
assert.equal(capabilityInvocation.options.shell, false);
assert.equal(capability.available, true);
assert.deepEqual(Object.keys(capability).sort(), ["available", "dashboardUrl", "installed", "state", "version"]);
assert.equal(JSON.stringify(capability).includes(repo), false, "public capability leaks no filesystem path");
assert.equal(JSON.stringify(capability).includes(process.env.SERVER_ONLY_VALUE), false, "public capability leaks no server value");
clearHammersmithCapabilityCache();
const noKvmHosted = await detectHammersmithCapability({
  hostingMode: "hosted", execute: async () => ({ stdout: "hammersmith 0.1.0\n" }), sandboxAvailable: async () => false,
});
assert.equal(noKvmHosted.available, false);
assert.equal(noKvmHosted.state, "unsupported");
clearHammersmithCapabilityCache();
const noKvmSelfHosted = await detectHammersmithCapability({
  hostingMode: "self-hosted", execute: async () => ({ stdout: "hammersmith 0.1.0\n" }), sandboxAvailable: async () => false,
});
assert.equal(noKvmSelfHosted.available, true, "self-hosted execution does not require KVM");
const dashboard = new URL("https://monitor.example.test/status");
dashboard.username = "u";
dashboard.password = "p";
const validated = validateHammersmithSettings({
  dashboardUrl: null, hostingMode: "self-hosted", defaultEngine: "pi",
}, { dashboardUrl: dashboard.toString(), hostingMode: "self-hosted", defaultEngine: "codex" }, "self-hosted");
assert.equal(new URL(validated.dashboardUrl).username, "");
assert.equal(new URL(validated.dashboardUrl).password, "");
assert.equal(validated.defaultEngine, "codex");
assert.throws(() => validateHammersmithSettings(validated, { dashboardUrl: "file:///tmp/run" }, "self-hosted"), /http or https/);
assert.throws(() => validateHammersmithSettings(validated, { defaultEngine: "unknown" }, "self-hosted"), /Invalid default engine/);
setSettingsForUser(ownerId, { hammersmith_dashboard_url: validated.dashboardUrl });
assert.equal(settingForUser(ownerId, "hammersmith_dashboard_url"), validated.dashboardUrl, "settings persist in SQLite");
const jobOne = createHammersmithJob({
  ownerId, sessionId, submissionId: "durable-submission", spaceId, jobDescription: description,
  stateDir: join(root, "stored-one"), manifestPath: join(root, "stored-one", "manifest.json"), billingReservationId: "test-reservation",
});
assert.equal(db.prepare("SELECT composer_mode FROM sessions WHERE id = ?").get(sessionId).composer_mode, "message");
assert.throws(() => createHammersmithJob({
  ownerId, sessionId, submissionId: "different-submission", spaceId, jobDescription: description,
  stateDir: join(root, "stored-two"), manifestPath: join(root, "stored-two", "manifest.json"),
}), /already running/, "only one Hammersmith job may mutate a Space");
updateHammersmithJob(jobOne.id, {
  run_id: randomUUID(), lifecycle: "finished", total_tasks: 1,
  checked_tasks: 1, passed_tasks: 1, failed_tasks: 0, finished_at: new Date().toISOString(),
});
const terminal = publicHammersmithJob(getHammersmithJob(jobOne.id), "https://monitor.example.test/run");
assert.equal(getHammersmithJob(jobOne.id).billing_reservation_id, null, "terminal state settles its hosted reservation");
assert.equal(terminal.lifecycle, "finished");
assert.equal(terminal.passedTasks, 1);
assert.equal(terminal.failedTasks, 0);
assert.equal(terminal.monitorUrl, "https://monitor.example.test/run");
const replay = createHammersmithJob({
  id: randomUUID(), ownerId, sessionId, submissionId: "durable-submission", spaceId,
  jobDescription: "must not replace the accepted description",
  stateDir: join(root, "stored-replay"), manifestPath: join(root, "stored-replay", "manifest.json"),
});
assert.equal(replay.id, jobOne.id, "terminal duplicate replay returns the original job");
assert.equal(getHammersmithJobBySubmission(ownerId, sessionId, "durable-submission").job_description, description);
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM hammersmith_jobs WHERE submission_id = ?").get("durable-submission").count, 1);
const sseEvents = [];
const unsubscribe = subscribeHammersmithJobs(sessionId, (event) => sseEvents.push(event));
publishHammersmithJob(replay, terminal);
publishHammersmithJob(replay, { ...terminal, checkedTasks: 1, passedTasks: 1 });
unsubscribe();
assert.deepEqual(sseEvents.map((event) => event.type), ["hammersmith_run", "hammersmith_run"]);
assert.equal(sseEvents[0].submission.id, "durable-submission");
assert.equal(sseEvents[1].submission.job.passedTasks, 1, "SSE progress carries structured counters");
const ts = await import(pathToFileURL(join(process.cwd(), "frontend/node_modules/typescript/lib/typescript.js")));
const submissionsSource = readFileSync(join(process.cwd(), "frontend/src/lib/sessionSubmissions.ts"), "utf8");
const submissionsJs = ts.transpileModule(submissionsSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const frontendSubmissions = await import(`data:text/javascript;base64,${Buffer.from(submissionsJs).toString("base64")}`);
const baseRun = { ...terminal, submissionId: "durable-submission", freshness: "live" };
let view = { items: [], failedDraft: null, queuedCount: 0, activeStatus: null };
view = frontendSubmissions.reconcileSubmission(view, frontendSubmissions.submissionFromHammersmithRun(baseRun));
view = frontendSubmissions.reconcileSubmission(view, frontendSubmissions.submissionFromHammersmithRun({ ...baseRun, checkedTasks: 1 }));
assert.equal(view.items.filter((item) => item.role === "user").length, 1, "SSE replay inserts one associated user turn");
assert.equal(view.items.filter((item) => item.role === "hammersmith-run").length, 1, "SSE replay updates one run widget");
assert.equal(view.items.find((item) => item.role === "hammersmith-run").run.checkedTasks, 1);
for (const [name, run, expected] of [
  ["empty", { ...baseRun, lifecycle: "finished", totalTasks: 0, checkedTasks: 0, passedTasks: 0 }, "Finished without full verification"],
  ["partial", { ...baseRun, lifecycle: "finished", totalTasks: 2, checkedTasks: 1, passedTasks: 1 }, "Finished without full verification"],
  ["pass", { ...baseRun, lifecycle: "finished", totalTasks: 1, checkedTasks: 1, passedTasks: 1 }, "Verified"],
  ["fail", { ...baseRun, lifecycle: "finished", totalTasks: 1, checkedTasks: 1, passedTasks: 0, failedTasks: 1 }, "Finished with failures"],
  ["running", { ...baseRun, lifecycle: "running", totalTasks: 1, checkedTasks: 0, passedTasks: 0 }, "Hammersmith running"],
]) assert.equal(frontendSubmissions.hammersmithRunTitle(run), expected, `${name} widget semantics`);
assert.equal(frontendSubmissions.hammersmithFreshness({ ...baseRun, lifecycle: "running", updatedAt: new Date(0).toISOString() }, "live", 20_000), "stale");
await import("./test-hammersmith-adversarial.mjs");
console.log("hammersmith contract: real lint, runtime paths, replay, SSE, stop, settings, and widget semantics verified");
