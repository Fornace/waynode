import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import express from "express";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = mkdtempSync(join(tmpdir(), "waynode-hammersmith-adversarial-"));
const repo = join(root, "repo");
mkdirSync(repo);
execFileSync("git", ["init", "-q", repo]);
process.env.SESSION_SECRET = "test-session-value";
process.env.ENCRYPTION_KEY = "0".repeat(64);
process.env.DATA_DIR = join(root, "data");
process.env.APP_URL = "https://waynode.example.test";
process.env.WAYNODE_DEPLOYMENT = "hosted";
process.env.WAYNODE_SANDBOX_LLM_KEY = "test-runtime-value";

const { ManifestFactory, deriveSelfHostedTaskLayout } = await import("../lib/hammersmith-manifest.mjs");
const {
  HostedMicrosandboxHammersmithRunner, LocalProcessHammersmithRunner, hostedOuterTimeoutMs,
} = await import("../lib/hammersmith-runner.mjs");
const {
  descendantProcesses, expectedStructuredState, fingerprintGitMetadata, terminateProcessTree,
} = await import("../lib/hammersmith-runtime.mjs");
const {
  clearHammersmithCapabilityCache, default: hammersmithRoutes, detectHammersmithCapability, settingsFor,
} = await import("../routes/hammersmith.js");
const {
  createHammersmithJob, setSettingsForUser, updateHammersmithJob,
} = await import("../lib/hammersmith-store.mjs");
const { default: db } = await import("../lib/db.mjs");
const { hammersmithWorkerLlmEnv } = await import("../lib/sandbox-llm-key.mjs");
const { hammersmithLeaseError } = await import("../lib/hammersmith-lease.mjs");

const layout = deriveSelfHostedTaskLayout(repo);
const factory = new ManifestFactory({ maxAttempts: 2, timeoutSeconds: 900 });
const check = JSON.parse(factory.serialize({
  jobId: "template", jobDescription: "test", ...layout, engine: "pi", mutating: true,
})).tasks[0].check;

function manifestFor(jobId, stateDir) {
  const path = join(stateDir, "manifest.json");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path, factory.serialize({
    jobId, jobDescription: "adversarial verification", ...layout, engine: "pi", mutating: true,
  }));
  return path;
}

function stateRecord(stateDir, { fileId, jobId, runName = `waynode-${jobId}`, status = "pass" }) {
  const runs = join(stateDir, "state", "runs");
  mkdirSync(runs, { recursive: true });
  writeFileSync(join(runs, `${fileId}.json`), JSON.stringify({
    run_id: fileId,
    run_name: runName,
    project: "Waynode Space",
    identity: "waynode",
    state: "finished",
    finished: true,
    tasks: [{ key: layout.taskKey, status, check }],
  }));
}

async function runLocalCase({ exitCode, writeState, mutateGit = false }) {
  const job = { id: crypto.randomUUID() };
  const stateDir = join(root, job.id);
  const snapshots = [];
  const runner = new LocalProcessHammersmithRunner({
    executable: "/fixed/hammersmith",
    exec: async () => ({ stdout: "", stderr: "" }),
    onSnapshot: (_id, fields) => { snapshots.push(fields); return null; },
    spawn: () => {
      const child = new EventEmitter();
      child.pid = 92000 + snapshots.length;
      writeState?.(stateDir, job.id);
      if (mutateGit) writeFileSync(join(repo, ".git", "waynode-forgery"), "changed");
      queueMicrotask(() => child.emit("exit", exitCode, null));
      return child;
    },
  });
  await runner.execute({
    job,
    session: { owner_id: "owner", space_id: "space", local_path: repo },
    manifestPath: manifestFor(job.id, stateDir),
    stateDir,
  });
  return { job, stateDir, snapshots };
}

const unrelated = await runLocalCase({
  exitCode: 0,
  writeState: (stateDir, jobId) => {
    stateRecord(stateDir, { fileId: "zzzz-forged", jobId, runName: "unrelated-run" });
  },
});
assert.equal(unrelated.snapshots.at(-1)?.lifecycle, "stopped", "unrelated lexically-late JSON cannot verify a job");
assert.equal(expectedStructuredState(join(unrelated.stateDir, "state"), {
  runName: `waynode-${unrelated.job.id}`, taskKey: layout.taskKey, identity: "waynode", check,
}), null);

const failedExit = await runLocalCase({
  exitCode: 1,
  writeState: (stateDir, jobId) => stateRecord(stateDir, { fileId: `run-${jobId}`, jobId }),
});
assert.equal(failedExit.snapshots.at(-1)?.lifecycle, "stopped", "a failed Hammersmith process cannot become Verified");
assert.equal(failedExit.snapshots.some((fields) => fields.lifecycle === "finished"), false);

const gitMutation = await runLocalCase({
  exitCode: 0,
  writeState: (stateDir, jobId) => stateRecord(stateDir, { fileId: `run-${jobId}`, jobId }),
  mutateGit: true,
});
assert.equal(gitMutation.snapshots.at(-1)?.lifecycle, "stopped", ".git mutation fails verification");
assert.match(gitMutation.snapshots.at(-1)?.error, /\.git metadata changed/);

const processes = [
  { pid: process.pid, ppid: 1, pgid: process.pid },
  { pid: 700, ppid: 1, pgid: 700 },
  { pid: 701, ppid: 700, pgid: 701 },
  { pid: 702, ppid: 701, pgid: 701 },
];
assert.deepEqual(descendantProcesses(700, processes).map(({ pid }) => pid), [700, 701, 702]);
const alive = new Set([700, 701, 702]);
const signals = [];
await terminateProcessTree(700, {
  listProcesses: async () => processes,
  kill(target, signal) {
    if (signal === 0) {
      if (!alive.has(target)) throw Object.assign(new Error("absent"), { code: "ESRCH" });
      return;
    }
    signals.push([target, signal]);
    if (target < 0) {
      for (const entry of processes) if (entry.pgid === -target) alive.delete(entry.pid);
    } else alive.delete(target);
  },
  graceMs: 10,
});
assert.equal(alive.size, 0, "stop proves the parent and separately grouped descendants absent");
assert.ok(signals.some(([target]) => target === -701), "the worker process group is signalled");

assert.equal(hostedOuterTimeoutMs({ timeoutSeconds: 900, maxAttempts: 2 }), 2_220_000);
assert.ok(hostedOuterTimeoutMs({ timeoutSeconds: 2400, maxAttempts: 2 }) > 4_800_000);
clearHammersmithCapabilityCache();
const helpFallback = await detectHammersmithCapability({
  hostingMode: "self-hosted",
  execute: async (_file, args) => {
    if (args[0] === "--version") throw new Error("legacy CLI has no version flag");
    return { stdout: "usage: hammersmith [-h] command" };
  },
});
assert.equal(helpFallback.available, true, "installed legacy CLI help is a safe capability fallback");

const invalidUser = crypto.randomUUID();
db.prepare("INSERT INTO users (id, name) VALUES (?, ?)").run(invalidUser, "Legacy settings");
setSettingsForUser(invalidUser, {
  hammersmith_hosting_mode: "broken-mode",
  hammersmith_default_engine: "broken-engine",
});
const normalized = settingsFor(invalidUser);
assert.equal(normalized.hostingMode, "hosted");
assert.equal(normalized.defaultEngine, "pi");
assert.throws(
  () => hammersmithWorkerLlmEnv({ space_id: "missing-space", org_id: null }),
  /encrypted Space or organization/,
  "hosted launch fails before execution when a scoped credential is unavailable",
);

const leaseSpace = crypto.randomUUID();
const leaseSession = crypto.randomUUID();
db.prepare(`INSERT INTO spaces (id, owner_id, repo_url, repo_name, repo_full_name, local_path)
  VALUES (?, ?, ?, ?, ?, ?)`).run(leaseSpace, invalidUser, "https://example.test/lease.git", "lease", "test/lease", repo);
db.prepare(`INSERT INTO sessions (id, space_id, owner_id, title, pi_session_dir, provider)
  VALUES (?, ?, ?, ?, ?, ?)`).run(leaseSession, leaseSpace, invalidUser, "Lease", join(root, "session"), "fornace");
const leaseJob = createHammersmithJob({
  ownerId: invalidUser, sessionId: leaseSession, submissionId: "lease-test", spaceId: leaseSpace,
  jobDescription: "hold mutation lease", stateDir: join(root, "lease"), manifestPath: join(root, "lease", "manifest.json"),
});
assert.equal(hammersmithLeaseError(leaseSpace)?.status, 409, "the durable lease blocks every wired repository mutation route");
updateHammersmithJob(leaseJob.id, { lifecycle: "stopped", finished_at: new Date().toISOString() });
assert.equal(hammersmithLeaseError(leaseSpace), null);

const finishedJob = createHammersmithJob({
  ownerId: invalidUser, sessionId: leaseSession, submissionId: "finished-stop-race", spaceId: leaseSpace,
  jobDescription: "finish before stop arrives", stateDir: join(root, "finished"), manifestPath: join(root, "finished", "manifest.json"),
});
updateHammersmithJob(finishedJob.id, { lifecycle: "finished", finished_at: new Date().toISOString() });
const stopApp = express();
stopApp.use((req, _res, next) => { req.user = { id: invalidUser }; req.isAuthenticated = () => true; next(); });
stopApp.use(hammersmithRoutes);
const stopServer = await new Promise((resolve) => {
  const server = stopApp.listen(0, "127.0.0.1", () => resolve(server));
});
try {
  for (const [lifecycle, terminalJob] of [["stopped", leaseJob], ["finished", finishedJob]]) {
    const response = await fetch(`http://127.0.0.1:${stopServer.address().port}/api/hammersmith/jobs/${terminalJob.id}/stop`, { method: "POST" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, stopped: true }, `${lifecycle} stop is idempotently acknowledged`);
  }
} finally {
  await new Promise((resolve, reject) => stopServer.close((error) => error ? reject(error) : resolve()));
}

const recoveryFingerprint = fingerprintGitMetadata(repo);
let localRecoveryFields;
let treeRecovered = false;
const localRecovery = new LocalProcessHammersmithRunner({
  terminateProcessTree: async (pid) => { assert.equal(pid, 733); treeRecovered = true; },
  onSnapshot: (_id, fields) => { localRecoveryFields = fields; return null; },
});
await localRecovery.recover({
  job: { id: "restart-local", runtime_pid: 733, git_fingerprint: recoveryFingerprint },
  session: { local_path: repo },
});
assert.equal(treeRecovered, true);
assert.equal(localRecoveryFields.lifecycle, "stopped", "restart recovery releases only after process-tree absence");

let hostedRecoveryFields;
const notFound = Object.assign(new Error("absent"), { name: "SandboxNotFoundError" });
const hostedRecovery = new HostedMicrosandboxHammersmithRunner({
  sandboxLookup: async () => { throw notFound; },
  onSnapshot: (_id, fields) => { hostedRecoveryFields = fields; return null; },
});
await hostedRecovery.recover({
  job: { id: "restart-hosted", runtime_id: "wn-hs-restart-hosted", git_fingerprint: recoveryFingerprint },
  session: { local_path: repo },
});
assert.equal(hostedRecoveryFields.lifecycle, "stopped", "an already-absent sandbox is safely recoverable");

const ts = await import(pathToFileURL(join(process.cwd(), "frontend/node_modules/typescript/lib/typescript.js")));
async function importTs(path) {
  const source = readFileSync(path, "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
}
const submissions = await importTs(join(process.cwd(), "frontend/src/lib/sessionSubmissions.ts"));
const terminalLoading = {
  lifecycle: "finished", freshness: "loading", totalTasks: 1, checkedTasks: 1,
  passedTasks: 1, failedTasks: 0,
};
assert.equal(submissions.hammersmithRunTitle(terminalLoading), "Verified", "terminal reload state outranks loading freshness");
let view = {
  items: [], failedDraft: { id: "old", prompt: "rejected", mode: "message", isGoal: false, kind: "message", sentAt: new Date().toISOString() },
  queuedCount: 0, activeStatus: null,
};
view = submissions.reconcileSubmission(view, {
  id: "replacement", prompt: "new accepted text", mode: "message", status: "completed",
});
assert.equal(view.failedDraft, null, "a distinct accepted send clears the stale rejected draft");

const persistence = await importTs(join(process.cwd(), "frontend/src/lib/composerModePersistence.ts"));
const order = [];
let releasePatch;
const queue = new persistence.ComposerModePersistence();
queue.save(() => new Promise((resolve) => { releasePatch = () => { order.push("patch"); resolve(); }; }));
const submit = queue.beforeSubmit().then(() => order.push("post"));
await Promise.resolve();
assert.deepEqual(order, []);
releasePatch();
await submit;
assert.deepEqual(order, ["patch", "post"], "composer PATCH settles before one-shot POST");

assert.ok(fingerprintGitMetadata(repo));
console.log("hammersmith adversarial contracts: forged state, exit trust, process tree, budget, settings, and client reconciliation PASS");
