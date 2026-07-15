/** Web submission reconciliation without a browser runtime. */
import assert from "node:assert/strict";
import {
  optimisticSubmission,
  reconcileSubmission,
} from "../frontend/src/lib/sessionSubmissions.ts";

const empty = { items: [], failedDraft: null, queuedCount: 0, activeStatus: null };
const goal = {
  id: "goal-1",
  prompt: "finish the release",
  isGoal: true,
  kind: "message",
  sentAt: "2026-07-15T12:00:00.000Z",
};

let view = optimisticSubmission(empty, goal);
assert.equal(view.items.length, 1);
assert.equal(view.items[0].submissionStatus, "sending");
assert.equal(view.items[0].sentAt, goal.sentAt, "optimistic time is the actual send time");

view = reconcileSubmission(view, {
  id: goal.id, prompt: goal.prompt, isGoal: true, status: "queued",
}, { kind: "queue" });
assert.equal(view.items.length, 1, "queue acknowledgement reconciles the optimistic row");
assert.equal(view.items[0].isGoal, true, "goal intent survives queue acknowledgement");
assert.equal(view.items[0].sentAt, goal.sentAt, "queue acknowledgement preserves send time");
assert.equal(view.queuedCount, 1);

view = reconcileSubmission(view, {
  id: goal.id, prompt: goal.prompt, isGoal: true, status: "failed", error: "Queue full",
}, { accepted: false, kind: "queue" });
assert.equal(view.items.length, 0, "rejected optimistic row is removed");
assert.deepEqual(view.failedDraft, { ...goal, kind: "queue" });
assert.equal(view.queuedCount, 0);

const retryDraft = view.failedDraft;
view = optimisticSubmission(view, retryDraft);
view = optimisticSubmission(view, retryDraft);
assert.equal(view.items.length, 1, "retry cannot append duplicate optimistic rows");
view = reconcileSubmission(view, {
  id: goal.id, prompt: goal.prompt, isGoal: true, status: "starting",
}, { kind: "queue" });
assert.equal(view.failedDraft, null);
assert.equal(view.items[0].submissionStatus, "starting");
view = reconcileSubmission(view, {
  id: goal.id, prompt: goal.prompt, isGoal: true, status: "completed",
}, { kind: "queue" });
assert.equal(view.items.length, 1);
assert.equal(view.activeStatus, null);

view = reconcileSubmission(view, {
  id: "run-failed", prompt: "try the build", isGoal: false, status: "failed", error: "Agent exited",
});
assert.equal(view.items.some((item) => item.id === "run-failed"), true, "accepted failed turns remain honest history");
assert.notEqual(view.failedDraft.id, "run-failed", "execution retry gets a fresh server id");
view = optimisticSubmission(view, view.failedDraft);
assert.equal(new Set(view.items.map((item) => item.id)).size, view.items.length);

console.log("web submission reconciliation regression passed");
