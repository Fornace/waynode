import { execFile, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { config } from "./config.mjs";
import { beginHostedGuestMutation, enforceHostedGitCredentialBoundary } from "./git-creds.mjs";
import { buildHostedSandboxEnv, buildPiEnv, enforceHostedSandbox, isSandboxAvailable } from "./pi-runner.mjs";
import { hammersmithWorkerLlmEnv } from "./sandbox-llm-key.mjs";
import { hostedTaskLayout, hammersmithChecks } from "./hammersmith-manifest.mjs";
import { publishHammersmithJob } from "./hammersmith-events.mjs";
import { publicHammersmithJob, updateHammersmithJob } from "./hammersmith-store.mjs";
import {
  expectedStructuredState, fingerprintGitMetadata, hostedOuterTimeoutMs,
  structuredRunSnapshot, terminateProcessTree,
} from "./hammersmith-runtime.mjs";

const execFileAsync = promisify(execFile);

export { structuredRunSnapshot, hostedOuterTimeoutMs };

function writeRuntimeConfig(path, stateDir) {
  writeFileSync(path, `state_dir = ${JSON.stringify(stateDir)}\nallow_full_access = false\n`, { mode: 0o600 });
}

function processEnv(base) {
  return { ...base, HAMMERSMITH_NO_CATALOG_REFRESH: "1", PYTHONUNBUFFERED: "1" };
}

function lintWarningsOnly(result) {
  const stdout = typeof result?.stdout === "function" ? result.stdout() : result?.stdout;
  const lines = String(stdout || "").trim().split("\n").filter(Boolean);
  return lines.length > 0 && lines.every((line) => line.startsWith("lint: WARNING:"));
}

function childExit(child) {
  return new Promise((resolve, reject) => {
    child.once("exit", (code, signal) => resolve([code, signal]));
    child.once("error", reject);
  });
}

function expectation(job, taskKey, identity) {
  return {
    runName: `waynode-${job.id}`,
    taskKey,
    identity,
    check: hammersmithChecks.mutating,
  };
}

class HammersmithRunner {
  constructor({ executable = config.hammersmith.executable, onSnapshot = updateHammersmithJob } = {}) {
    this.executable = executable;
    this.onSnapshot = onSnapshot;
    this.active = new Map();
  }

  prepare(jobId) {
    const existing = this.active.get(jobId);
    if (existing) return existing;
    let readyResolve;
    let doneResolve;
    const control = {
      stopRequested: false,
      stopHandle: null,
      stopPromise: null,
      ready: new Promise((resolve) => { readyResolve = resolve; }),
      done: new Promise((resolve) => { doneResolve = resolve; }),
      readyResolve,
      doneResolve,
    };
    this.active.set(jobId, control);
    return control;
  }

  async preflight({ manifestPath, stateDir }) {
    const runStateDir = join(stateDir, "state");
    mkdirSync(runStateDir, { recursive: true });
    const configPath = join(stateDir, "config.toml");
    writeRuntimeConfig(configPath, runStateDir);
    try {
      await execFileAsync(this.executable, ["--config", configPath, "lint", manifestPath], {
        shell: false, timeout: 120_000, windowsHide: true, maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      if (!lintWarningsOnly(error)) throw error;
    }
  }

  setStopHandle(control, stopHandle) {
    control.stopHandle = () => {
      control.stopPromise ||= Promise.resolve().then(stopHandle);
      return control.stopPromise;
    };
    control.readyResolve();
  }

  finish(jobId, control) {
    control.readyResolve();
    control.doneResolve();
    if (this.active.get(jobId) === control) this.active.delete(jobId);
  }

  persist(jobId, fields) {
    const updated = this.onSnapshot(jobId, fields);
    if (updated?.session_id) publishHammersmithJob(updated, publicHammersmithJob(updated));
    return updated;
  }

  ingest(job, stateDir, expected, { terminal = false, processSucceeded = false } = {}) {
    const snapshot = expectedStructuredState(stateDir, expected);
    if (!snapshot || (terminal && !processSucceeded)) return null;
    const lifecycle = snapshot.lifecycle === "finished" && !terminal ? "running" : snapshot.lifecycle;
    this.persist(job.id, {
      run_id: snapshot.runId,
      lifecycle,
      total_tasks: snapshot.totalTasks,
      checked_tasks: snapshot.checkedTasks,
      passed_tasks: snapshot.passedTasks,
      failed_tasks: snapshot.failedTasks,
      ...(lifecycle === "finished" ? { finished_at: new Date().toISOString(), error: null } : {}),
    });
    return { ...snapshot, lifecycle };
  }

  watch(job, stateDir, expected) {
    const timer = setInterval(() => this.ingest(job, stateDir, expected), 1000);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  recordFingerprint(job, session) {
    const value = fingerprintGitMetadata(session.local_path);
    this.persist(job.id, { git_fingerprint: value });
    return value;
  }

  assertFingerprint(session, expected) {
    if (!expected || fingerprintGitMetadata(session.local_path) !== expected) {
      throw new Error("Repository .git metadata changed during Hammersmith execution");
    }
  }

  async stop(jobId) {
    const control = this.active.get(jobId);
    if (!control) return false;
    control.stopRequested = true;
    await control.ready;
    if (control.stopHandle) await control.stopHandle();
    await control.done;
    return true;
  }
}

export class LocalProcessHammersmithRunner extends HammersmithRunner {
  constructor(options = {}) {
    super(options);
    this.exec = options.exec || ((file, args, opts) => execFileAsync(file, args, opts));
    this.spawn = options.spawn || spawn;
    this.terminateTree = options.terminateProcessTree || terminateProcessTree;
  }

  async execute({ job, session, manifestPath, stateDir }) {
    const control = this.prepare(job.id);
    const taskKey = manifestTaskKey(manifestPath);
    const expected = expectation(job, taskKey, "waynode");
    let fingerprint = null;
    let runtimeStarted = false;
    let shutdownAcknowledged = false;
    mkdirSync(stateDir, { recursive: true });
    const configPath = join(stateDir, "config.toml");
    const runStateDir = join(stateDir, "state");
    mkdirSync(runStateDir, { recursive: true });
    writeRuntimeConfig(configPath, runStateDir);
    const env = processEnv(buildPiEnv(session.space_id, { ownerId: session.owner_id }));
    const common = { cwd: session.local_path, env, shell: false, windowsHide: true, maxBuffer: 1024 * 1024 };
    try {
      fingerprint = this.recordFingerprint(job, session);
      try {
        await this.exec(this.executable, ["--config", configPath, "lint", manifestPath], common);
      } catch (error) {
        if (!lintWarningsOnly(error)) throw error;
      }
      if (control.stopRequested) {
        this.persist(job.id, { lifecycle: "stopped", finished_at: new Date().toISOString(), error: "Run stopped by user before worker launch" });
        return;
      }
      const child = this.spawn(this.executable, ["--config", configPath, "run", manifestPath, "--identity", "waynode"], {
        cwd: common.cwd, env, shell: false, windowsHide: true, detached: true,
        stdio: ["ignore", "ignore", "ignore"],
      });
      if (!Number.isInteger(child.pid) || child.pid <= 1) throw new Error("Hammersmith did not provide a process id");
      runtimeStarted = true;
      this.persist(job.id, { runtime_kind: "self-hosted", runtime_id: `process-group:${child.pid}`, runtime_pid: child.pid });
      const exited = childExit(child);
      this.setStopHandle(control, async () => {
        await this.terminateTree(child.pid);
        shutdownAcknowledged = true;
        await exited;
      });
      if (control.stopRequested) await control.stopHandle();
      const stopWatching = this.watch(job, runStateDir, expected);
      const [code, signal] = await exited;
      stopWatching();
      if (!control.stopRequested) shutdownAcknowledged = true;
      this.assertFingerprint(session, fingerprint);
      const succeeded = code === 0 && signal == null && !control.stopRequested;
      const snapshot = this.ingest(job, runStateDir, expected, { terminal: true, processSucceeded: succeeded });
      if (!snapshot || snapshot.lifecycle !== "finished") {
        this.persist(job.id, {
          lifecycle: "stopped", finished_at: new Date().toISOString(),
          error: control.stopRequested ? "Run stopped by user" : signal
            ? `Hammersmith stopped by ${signal}` : `Hammersmith did not produce its expected terminal record (code ${code ?? 1})`,
        });
      }
    } catch (error) {
      const retainLock = runtimeStarted && control.stopRequested && !shutdownAcknowledged;
      this.persist(job.id, retainLock
        ? { error: `Process-tree shutdown was not acknowledged; the Space lock is retained: ${error.message}` }
        : { lifecycle: "stopped", finished_at: new Date().toISOString(), error: `Hammersmith could not complete: ${error.message}` });
    } finally {
      this.finish(job.id, control);
    }
  }

  async recover({ job, session }) {
    try {
      if (job.runtime_pid) await this.terminateTree(job.runtime_pid);
      this.assertFingerprint(session, job.git_fingerprint);
      return this.persist(job.id, {
        lifecycle: "stopped", finished_at: new Date().toISOString(),
        error: "Waynode recovered this interrupted run after proving its local runtime absent",
      });
    } catch (error) {
      this.persist(job.id, { error: `Recovery could not prove the local runtime absent; the Space lock is retained: ${error.message}` });
      throw error;
    }
  }
}

export class HostedMicrosandboxHammersmithRunner extends HammersmithRunner {
  constructor(options = {}) {
    super(options);
    this.sandboxFactory = options.sandboxFactory || null;
    this.sandboxLookup = options.sandboxLookup || null;
    this.sandboxAvailable = options.sandboxAvailable || isSandboxAvailable;
  }

  sandboxName(job) { return `wn-hs-${job.id}`; }

  async createSandbox(job, session, stateDir) {
    if (this.sandboxFactory) return this.sandboxFactory({ job, session, stateDir });
    const { Sandbox, Rule, Destination } = await import("microsandbox");
    const policy = {
      defaultEgress: "deny", defaultIngress: "allow",
      rules: [
        Rule.allowEgress(Destination.cidr("10.200.0.1/32")),
        Rule.allowEgress(Destination.domain("github.com")),
        Rule.allowEgress(Destination.domainSuffix("github.com")),
        Rule.allowEgress(Destination.domain("gitlab.com")),
        Rule.allowEgress(Destination.domainSuffix("gitlab.com")),
        Rule.allowDns(), Rule.denyEgress(Destination.group("metadata")),
      ],
    };
    return Sandbox.builder(this.sandboxName(job))
      .image("waynode-sandbox:latest").cpus(2).memory(4096)
      .network((network) => network.policy(policy))
      .volume(hostedTaskLayout().taskdir, (mount) => mount.bind(session.local_path))
      .volume("/job", (mount) => mount.bind(stateDir))
      .replace().create();
  }

  async execute({ job, session, stateDir }) {
    const control = this.prepare(job.id);
    const expected = expectation(job, hostedTaskLayout().taskKey, "waynode-hosted");
    let releaseMutation = null;
    let sandbox;
    let stopWatching = null;
    let processSucceeded = false;
    let failure = null;
    let fingerprint = null;
    try {
      enforceHostedSandbox(await this.sandboxAvailable(), "hosted");
      const workerEnv = hammersmithWorkerLlmEnv(session);
      mkdirSync(join(stateDir, "state"), { recursive: true });
      writeRuntimeConfig(join(stateDir, "config.toml"), "/job/state");
      const env = processEnv({ ...buildHostedSandboxEnv({ ownerId: session.owner_id }), ...workerEnv });
      enforceHostedGitCredentialBoundary(session.space_id);
      fingerprint = this.recordFingerprint(job, session);
      releaseMutation = beginHostedGuestMutation(session.space_id);
      this.persist(job.id, { runtime_kind: "hosted", runtime_id: this.sandboxName(job) });
      sandbox = await this.createSandbox(job, session, stateDir);
      this.setStopHandle(control, () => sandbox.stop());
      if (control.stopRequested) await control.stopHandle();
      if (!control.stopRequested) {
        const taskdir = hostedTaskLayout().taskdir;
        const lint = await sandbox.execWith(this.executable, (command) => command
          .args(["--config", "/job/config.toml", "lint", "/job/manifest.json"])
          .cwd(taskdir).envs(env).timeout(120_000));
        if (!lint.status?.success && !lintWarningsOnly(lint)) {
          throw new Error("hammersmith lint rejected the server-owned manifest");
        }
        if (control.stopRequested) await control.stopHandle();
        if (!control.stopRequested) {
          stopWatching = this.watch(job, join(stateDir, "state"), expected);
          const result = await sandbox.execWith(this.executable, (command) => command
            .args(["--config", "/job/config.toml", "run", "/job/manifest.json", "--identity", "waynode-hosted"])
            .cwd(taskdir).envs(env).timeout(hostedOuterTimeoutMs(config.hammersmith)).tty(true));
          processSucceeded = result.status?.success === true && !control.stopRequested;
          if (!processSucceeded) failure = `Hammersmith process failed (code ${result.status?.code ?? 1})`;
        }
      }
    } catch (error) {
      failure = control.stopRequested ? "Run stopped by user" : `Hosted Hammersmith stopped: ${error.message}`;
    } finally {
      stopWatching?.();
      let shutdownAcknowledged = !sandbox;
      try {
        if (sandbox) await (control.stopPromise || sandbox.stop());
        shutdownAcknowledged = true;
      } catch (error) {
        this.persist(job.id, { error: `Sandbox shutdown was not acknowledged; the Space lock is retained: ${error.message}` });
      }
      if (shutdownAcknowledged) {
        releaseMutation?.();
        try { this.assertFingerprint(session, fingerprint); }
        catch (error) { failure = error.message; processSucceeded = false; }
        const snapshot = this.ingest(job, join(stateDir, "state"), expected, { terminal: true, processSucceeded });
        if (!snapshot || snapshot.lifecycle !== "finished") {
          this.persist(job.id, {
            lifecycle: "stopped", finished_at: new Date().toISOString(),
            error: failure || "Hosted Hammersmith ended without its expected terminal record",
          });
        }
      }
      this.finish(job.id, control);
    }
  }

  async lookupSandbox(name) {
    if (this.sandboxLookup) return this.sandboxLookup(name);
    const { Sandbox } = await import("microsandbox");
    return Sandbox.get(name);
  }

  async recover({ job, session }) {
    try {
      let handle = null;
      try { handle = await this.lookupSandbox(job.runtime_id || this.sandboxName(job)); }
      catch (error) {
        if (error?.name !== "SandboxNotFoundError" && error?.code !== "SANDBOX_NOT_FOUND") throw error;
      }
      if (handle) {
        const current = await handle.refresh();
        if (["running", "draining"].includes(current.status)) await current.stopWithTimeout(10_000);
        const stopped = await current.refresh();
        if (["running", "draining"].includes(stopped.status)) throw new Error("sandbox is still running");
      }
      this.assertFingerprint(session, job.git_fingerprint);
      return this.persist(job.id, {
        lifecycle: "stopped", finished_at: new Date().toISOString(),
        error: "Waynode recovered this interrupted run after proving its sandbox absent",
      });
    } catch (error) {
      this.persist(job.id, { error: `Recovery could not prove the sandbox absent; the Space lock is retained: ${error.message}` });
      throw error;
    }
  }
}

function manifestTaskKey(manifestPath) {
  const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  const key = raw?.tasks?.[0]?.key;
  if (typeof key !== "string" || !key) throw new Error("Server-owned manifest has no task key");
  return key;
}

export function createHammersmithRunner(runtimeConfig = config) {
  return runtimeConfig.deployment === "hosted"
    ? new HostedMicrosandboxHammersmithRunner({ executable: runtimeConfig.hammersmith.executable })
    : new LocalProcessHammersmithRunner({ executable: runtimeConfig.hammersmith.executable });
}
