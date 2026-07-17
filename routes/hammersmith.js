import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { Router } from "express";
import { requireAuth } from "../lib/auth.mjs";
import {
  billingEnabled, releaseTokenReservation, reserveTokenQuota, TURN_RESERVATION_TOKENS,
} from "../lib/billing.mjs";
import { config } from "../lib/config.mjs";
import {
  deriveSelfHostedTaskLayout, hostedTaskLayout, ManifestFactory, normalizeHammersmithEngine,
} from "../lib/hammersmith-manifest.mjs";
import { createHammersmithRunner } from "../lib/hammersmith-runner.mjs";
import { publishHammersmithJob } from "../lib/hammersmith-events.mjs";
import { isSpaceBusy } from "../lib/agent-manager.mjs";
import {
  createHammersmithJob, getHammersmithJob, getHammersmithJobBySubmission, listHammersmithJobs,
  hasRunningHammersmithJob,
  publicHammersmithJob, sessionForHammersmith, setSettingsForUser, settingForUser,
  updateHammersmithJob,
} from "../lib/hammersmith-store.mjs";
import { isSandboxAvailable } from "../lib/pi-runner.mjs";
import { hammersmithWorkerLlmEnv } from "../lib/sandbox-llm-key.mjs";

const execFileAsync = promisify(execFile);
const capabilityRouter = Router();
const router = Router();
const runners = {
  hosted: createHammersmithRunner({ ...config, deployment: "hosted" }),
  "self-hosted": createHammersmithRunner({ ...config, deployment: "self-hosted" }),
};
const activeRunners = new Map();
const manifestFactory = new ManifestFactory(config.hammersmith);
const capabilityCache = new Map();
const SETTINGS = {
  dashboardUrl: "hammersmith_dashboard_url",
  hostingMode: "hammersmith_hosting_mode",
  defaultEngine: "hammersmith_default_engine",
};

function safeUrl(value, fallback = null) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return fallback;
    url.username = "";
    url.password = "";
    return url.toString();
  } catch { return fallback; }
}

function defaultDashboardUrl() {
  const origin = safeUrl(config.appUrl);
  return origin ? new URL("/hammersmith", origin).toString() : null;
}

export async function detectHammersmithCapability({
  now = Date.now, execute = execFileAsync, sandboxAvailable = isSandboxAvailable,
  hostingMode = config.deployment === "hosted" ? "hosted" : "self-hosted",
} = {}) {
  const cached = capabilityCache.get(hostingMode);
  if (cached?.expiresAt > now()) return cached.value;
  let installed = false;
  let version = null;
  try {
    const { stdout } = await execute(config.hammersmith.executable, ["--version"], {
      shell: false, timeout: 5000, windowsHide: true, maxBuffer: 16 * 1024,
    });
    const firstLine = String(stdout || "").split("\n")[0].trim();
    installed = firstLine.length > 0;
    version = installed ? firstLine.slice(0, 80) : null;
  } catch {
    try {
      const { stdout } = await execute(config.hammersmith.executable, ["-h"], {
        shell: false, timeout: 5000, windowsHide: true, maxBuffer: 16 * 1024,
      });
      installed = String(stdout || "").includes("usage: hammersmith");
    } catch {}
  }
  const sandboxReady = hostingMode !== "hosted" || await sandboxAvailable();
  const value = {
    available: installed && sandboxReady,
    installed,
    dashboardUrl: defaultDashboardUrl(),
    ...(version ? { version } : {}),
    state: !installed ? "setup-required" : sandboxReady ? "ready" : "unsupported",
  };
  capabilityCache.set(hostingMode, { value, expiresAt: now() + 5000 });
  return value;
}

export function clearHammersmithCapabilityCache() {
  capabilityCache.clear();
}

capabilityRouter.get("/api/hammersmith/capability", async (_req, res) => {
  res.json(await detectHammersmithCapability());
});

export function settingsFor(userId) {
  const fallbackMode = config.deployment === "hosted" ? "hosted" : "self-hosted";
  const storedMode = settingForUser(userId, SETTINGS.hostingMode);
  const hostingMode = config.deployment === "hosted"
    ? "hosted" : ["hosted", "self-hosted"].includes(storedMode) ? storedMode : fallbackMode;
  const configuredDashboard = settingForUser(userId, SETTINGS.dashboardUrl);
  const storedEngine = settingForUser(userId, SETTINGS.defaultEngine);
  const defaultEngine = normalizeHammersmithEngine(storedEngine, { hosted: hostingMode === "hosted" });
  if ((storedMode && storedMode !== hostingMode) || (storedEngine && storedEngine !== defaultEngine)) {
    setSettingsForUser(userId, {
      [SETTINGS.hostingMode]: hostingMode,
      [SETTINGS.defaultEngine]: defaultEngine,
    });
  }
  return {
    dashboardUrl: safeUrl(configuredDashboard, defaultDashboardUrl()),
    hostingMode,
    defaultEngine,
    hostingModeLocked: config.deployment === "hosted",
  };
}

export function validateHammersmithSettings(current, input, deployment = config.deployment) {
  const next = { ...current };
  if (input.dashboardUrl !== undefined) {
    const value = safeUrl(input.dashboardUrl);
    if (!value) throw Object.assign(new Error("Dashboard URL must use http or https"), { status: 400 });
    next.dashboardUrl = value;
  }
  if (input.hostingMode !== undefined) {
    if (!['self-hosted', 'hosted'].includes(input.hostingMode)) throw Object.assign(new Error("Invalid hosting mode"), { status: 400 });
    if (deployment === "hosted" && input.hostingMode !== "hosted") throw Object.assign(new Error("Managed hosting mode cannot be changed"), { status: 400 });
    next.hostingMode = input.hostingMode;
  }
  if (input.defaultEngine !== undefined) {
    const normalized = normalizeHammersmithEngine(input.defaultEngine, { hosted: deployment === "hosted" });
    if (normalized !== input.defaultEngine && deployment !== "hosted") throw Object.assign(new Error("Invalid default engine"), { status: 400 });
    next.defaultEngine = normalized;
  }
  return next;
}

function monitorUrl(job, userId) {
  return `/api/hammersmith/jobs/${job.id}/monitor`;
}

function reserveHammersmithBudget(session, hostingMode, res) {
  if (hostingMode !== "hosted" || !billingEnabled || !session.org_id) return { allowed: true, reservation: null };
  try {
    const requested = config.hammersmith.maxAttempts * TURN_RESERVATION_TOKENS;
    return {
      allowed: true,
      reservation: reserveTokenQuota(session.org_id, `hammersmith:${randomUUID()}`, requested),
    };
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.status === 402 ? error.message : "Hammersmith usage could not be reserved. Try again.",
    });
    return { allowed: false, reservation: null };
  }
}

function ownSession(req, res) {
  const session = sessionForHammersmith(req.params.sessionId, req.user.id);
  if (!session) res.status(404).json({ error: "Session not found" });
  return session;
}

function ownJob(req, res) {
  const job = getHammersmithJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Run not found" }), null;
  if (job.owner_id !== req.user.id) return res.status(403).json({ error: "Owner only" }), null;
  return job;
}

router.get("/api/hammersmith/settings", requireAuth, async (req, res) => {
  const settings = settingsFor(req.user.id);
  res.json({ ...settings, capability: await detectHammersmithCapability({ hostingMode: settings.hostingMode }) });
});

router.patch("/api/hammersmith/settings", requireAuth, async (req, res) => {
  const current = settingsFor(req.user.id);
  let next;
  try { next = validateHammersmithSettings(current, req.body || {}); }
  catch (error) { return res.status(error.status || 400).json({ error: error.message }); }
  setSettingsForUser(req.user.id, {
    [SETTINGS.dashboardUrl]: next.dashboardUrl,
    [SETTINGS.hostingMode]: next.hostingMode,
    [SETTINGS.defaultEngine]: next.defaultEngine,
  });
  clearHammersmithCapabilityCache();
  res.json({ ...next, capability: await detectHammersmithCapability({ hostingMode: next.hostingMode }) });
});

function submissionFor(job, publicJob) {
  return {
    id: job.submission_id, prompt: job.job_description, mode: "hammersmith",
    isGoal: false, status: "completed", createdAt: job.created_at, jobId: job.id, job: publicJob,
  };
}

function sendExistingJob(res, job, userId) {
  const view = publicHammersmithJob(job, monitorUrl(job, userId));
  return res.json({ ok: true, duplicate: true, submission: submissionFor(job, view), job: view });
}

router.post("/api/sessions/:sessionId/hammersmith", requireAuth, async (req, res) => {
  const session = ownSession(req, res);
  if (!session) return;
  if (req.body?.mode !== "hammersmith") return res.status(400).json({ error: "Unknown or unavailable submission mode" });
  const description = req.body?.prompt;
  if (typeof description !== "string" || !description.trim()) return res.status(400).json({ error: "prompt required" });
  const suppliedSubmissionId = req.body?.submissionId;
  if (suppliedSubmissionId !== undefined && (typeof suppliedSubmissionId !== "string" || !suppliedSubmissionId || suppliedSubmissionId.length > 128)) {
    return res.status(400).json({ error: "submission_id must be a non-empty string of at most 128 characters" });
  }
  const submissionId = suppliedSubmissionId || randomUUID();
  const existing = getHammersmithJobBySubmission(req.user.id, session.id, submissionId);
  if (existing) return sendExistingJob(res, existing, req.user.id);
  const userSettings = settingsFor(req.user.id);
  const jobRunner = runners[userSettings.hostingMode];
  if (!jobRunner) return res.status(503).json({ error: "Hammersmith runner is unavailable" });
  const capability = await detectHammersmithCapability({ hostingMode: userSettings.hostingMode });
  if (!capability.available) return res.status(503).json({ error: capability.installed ? "Hosted Hammersmith requires the sandbox/KVM runtime" : "Hammersmith is not installed" });
  if (isSpaceBusy(session.space_id) || hasRunningHammersmithJob(session.space_id)) {
    return res.status(409).json({ error: "This Space already has a mutating job in progress" });
  }

  if (userSettings.hostingMode === "hosted") {
    try { hammersmithWorkerLlmEnv(session); }
    catch (error) { return res.status(error.status || 503).json({ error: error.message }); }
  }
  const admission = reserveHammersmithBudget(session, userSettings.hostingMode, res);
  if (!admission.allowed) return;

  const id = randomUUID();
  const stateDir = join(config.hammersmith.jobDir, session.space_id, id);
  const manifestPath = join(stateDir, "manifest.json");
  const engine = normalizeHammersmithEngine(userSettings.defaultEngine, { hosted: userSettings.hostingMode === "hosted" });
  try {
    const layout = userSettings.hostingMode === "hosted"
      ? hostedTaskLayout()
      : deriveSelfHostedTaskLayout(session.local_path);
    const manifest = manifestFactory.serialize({
      jobId: id, jobDescription: description,
      workdir: layout.workdir, taskKey: layout.taskKey,
      engine, mutating: true,
    });
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(manifestPath, manifest, { mode: 0o600 });
    await jobRunner.preflight({ manifestPath, stateDir });
  } catch (error) {
    releaseTokenReservation(admission.reservation?.id);
    return res.status(error.status || 500).json({ error: `Hammersmith launch prerequisites failed: ${error.message}` });
  }

  let job;
  try {
    job = createHammersmithJob({
      id, ownerId: req.user.id, sessionId: session.id, submissionId,
      spaceId: session.space_id, jobDescription: description, stateDir, manifestPath,
      billingReservationId: admission.reservation?.id || null,
      runtimeKind: userSettings.hostingMode,
    });
  } catch (error) {
    releaseTokenReservation(admission.reservation?.id);
    return res.status(error.status || 500).json({ error: error.message });
  }
  if (job.id !== id) {
    releaseTokenReservation(admission.reservation?.id);
    return sendExistingJob(res, job, req.user.id);
  }
  activeRunners.set(id, jobRunner);
  jobRunner.prepare(id);
  const publicJob = publicHammersmithJob(job, monitorUrl(job, req.user.id));
  publishHammersmithJob(job, publicJob);
  queueMicrotask(() => jobRunner.execute({ job, session, manifestPath, stateDir })
    .finally(() => activeRunners.delete(id)));
  res.status(202).json({
    ok: true,
    submission: submissionFor(job, publicJob),
    job: publicJob,
  });
});

router.get("/api/sessions/:sessionId/hammersmith/jobs", requireAuth, (req, res) => {
  const session = ownSession(req, res);
  if (!session) return;
  res.json(listHammersmithJobs(session.id).map((job) => publicHammersmithJob(job, monitorUrl(job, req.user.id))));
});

router.get("/api/hammersmith/jobs/:jobId", requireAuth, (req, res) => {
  const job = ownJob(req, res);
  if (job) res.json(publicHammersmithJob(job, monitorUrl(job, req.user.id)));
});

router.post("/api/hammersmith/jobs/:jobId/stop", requireAuth, async (req, res) => {
  const job = ownJob(req, res);
  if (!job) return;
  if (job.lifecycle !== "running") return res.json({ ok: true, stopped: true });
  const runner = activeRunners.get(job.id);
  const recoveryRunner = runners[job.runtime_kind];
  try {
    if (runner) {
      if (!(await runner.stop(job.id))) throw new Error("Runtime shutdown was not acknowledged");
    } else {
      if (!recoveryRunner) throw new Error("Recovery runner is unavailable");
      const session = sessionForHammersmith(job.session_id, job.owner_id);
      await recoveryRunner.recover({ job, session });
    }
  } catch (error) {
    return res.status(503).json({ ok: false, stopped: false, error: `Runtime shutdown failed; the Space lock is retained: ${error.message}` });
  }
  let terminal = getHammersmithJob(job.id);
  if (terminal.lifecycle === "running") {
    terminal = updateHammersmithJob(job.id, { lifecycle: "stopped", finished_at: new Date().toISOString(), error: "Run stopped by user" });
  }
  const view = publicHammersmithJob(terminal, monitorUrl(terminal, req.user.id));
  publishHammersmithJob(terminal, view);
  res.json({ ok: true, stopped: true, job: view });
});

router.get("/api/hammersmith/jobs/:jobId/monitor", requireAuth, (req, res) => {
  const job = ownJob(req, res);
  if (!job) return;
  const verified = job.lifecycle === "finished" && job.total_tasks > 0 && job.checked_tasks === job.total_tasks && job.passed_tasks === job.total_tasks && job.failed_tasks === 0;
  const title = verified ? "Verified" : job.lifecycle === "finished" ? "Finished without full verification" : job.lifecycle === "stopped" ? "Run stopped" : "Hammersmith running";
  res.type("html").send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Hammersmith run</title><main><h1>${title}</h1><p>${job.checked_tasks}/${job.total_tasks} checked · ${job.passed_tasks} passed · ${job.failed_tasks} failed</p></main>`);
});

export { capabilityRouter as hammersmithCapabilityRouter };
export default router;
