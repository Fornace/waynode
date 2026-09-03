import assert from "node:assert/strict";
import express from "express";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "waynode-admission-"));
process.env.DATA_DIR = root;
process.env.SESSION_SECRET = "admission-test";
process.env.ENCRYPTION_KEY = "0".repeat(64);
process.env.DEV_AUTH_TOKEN = "admission-token";
process.env.PI_BINARY = process.execPath;

const { default: db } = await import("../lib/db.mjs");
const { createSession } = await import("../lib/sessions.mjs");
const manager = await import("../lib/agent-manager.mjs");
const { AgentSurface } = await import("../lib/agent-surface.mjs");
const { default: router } = await import("../routes/sessions.js");

const userId = "dev-user";
const spaceId = "admission-space";
const repo = join(root, "repos", spaceId);
mkdirSync(repo, { recursive: true });
db.prepare("INSERT INTO users (id, name) VALUES (?, ?)").run(userId, "Admission Tester");
db.prepare(`INSERT INTO spaces (id, owner_id, repo_url, repo_name, local_path)
  VALUES (?, ?, ?, ?, ?)`).run(spaceId, userId, "https://example.test/repo.git", "repo", repo);
const first = createSession({ spaceId, userId, title: "First" });
const second = createSession({ spaceId, userId, title: "Second" });

function durableHandle(session) {
  class AdmissionHandle extends AgentSurface {
    constructor() {
      super(session);
      this.dead = false;
      this.isReady = true;
      this.dispatched = [];
    }
    sendPrompt(prompt, mode, id) {
      const { record, created } = this.submissions.create({ id, prompt, mode, status: "starting" });
      if (!created) return Promise.resolve(record);
      this.dispatched.push({ prompt, mode, id });
      return record.completion;
    }
    shutdown() { this.dead = true; }
  }
  return new AdmissionHandle();
}
const firstHandle = durableHandle(first);
const secondHandle = durableHandle(second);
manager.__injectAgentForTest(first.id, firstHandle);
manager.__injectAgentForTest(second.id, secondHandle);

const app = express();
app.use(express.json());
app.use(router);
const server = await new Promise((resolve) => {
  const value = app.listen(0, "127.0.0.1", () => resolve(value));
});
const base = `http://127.0.0.1:${server.address().port}`;
const auth = { "x-dev-token": process.env.DEV_AUTH_TOKEN, "content-type": "application/json" };
async function submit(sessionId, path, body) {
  const response = await fetch(`${base}/api/sessions/${sessionId}/${path}`, {
    method: "POST", headers: auth, body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
  });
  return { status: response.status, body: await response.json() };
}

try {
  const request = { submissionId: "stable-id", prompt: "ship it", mode: "message" };
  const accepted = await submit(first.id, "message", request);
  assert.equal(accepted.status, 200);
  assert.equal(firstHandle.dispatched.length, 1);
  assert.equal(db.prepare("SELECT status FROM submissions WHERE id = ?").get(request.submissionId).status, "starting");

  const retry = await submit(first.id, "message", request);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.duplicate, true);
  assert.equal(firstHandle.dispatched.length, 1, "response-loss retry must not dispatch twice");

  assert.equal((await submit(first.id, "message", { ...request, prompt: "changed" })).status, 409);
  assert.equal((await submit(first.id, "message", { ...request, mode: "goal" })).status, 409);
  assert.equal((await submit(second.id, "message", request)).status, 409);
  assert.equal(secondHandle.dispatched.length, 0);

  db.exec(`CREATE TRIGGER reject_submission BEFORE INSERT ON submissions
    WHEN NEW.id = 'disk-failure' BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
  const failed = await submit(first.id, "message", {
    submissionId: "disk-failure", prompt: "must persist", mode: "message",
  });
  assert.equal(failed.status, 500);
  assert.equal(firstHandle.dispatched.length, 1, "persistence failure must precede dispatch and acknowledgement");
  assert.equal(db.prepare("SELECT 1 FROM submissions WHERE id = 'disk-failure'").get(), undefined);

  console.log("submission HTTP admission regression passed");
} finally {
  server.close();
  manager.stopAgent(first.id, first);
  manager.stopAgent(second.id, second);
  db.close();
  rmSync(root, { recursive: true, force: true });
}
