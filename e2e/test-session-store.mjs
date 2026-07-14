/** Persistent browser-session store regression, including process restart. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const inheritedRoot = process.env.WAYNODE_SESSION_TEST_ROOT;
const root = inheritedRoot || mkdtempSync(join(tmpdir(), "waynode-browser-sessions-"));
process.env.DATA_DIR = root;
process.env.SESSION_SECRET = "browser-session-test";
process.env.ENCRYPTION_KEY = "0".repeat(64);

const invoke = (store, method, ...args) => new Promise((resolve, reject) => {
  store[method](...args, (error, value) => error ? reject(error) : resolve(value));
});

async function runChildPhase(phase) {
  const { SQLiteSessionStore } = await import("../lib/sqlite-session-store.mjs");
  const store = new SQLiteSessionStore({ pruneIntervalMs: 60_000 });
  try {
    if (phase === "write") {
      await invoke(store, "set", "restart-sid", {
        cookie: { expires: new Date(Date.now() + 120_000).toISOString() },
        passport: { user: "restart-user" },
        oauthState: "restart-nonce",
      });
    } else if (phase === "read-destroy") {
      const value = await invoke(store, "get", "restart-sid");
      assert.equal(value?.passport?.user, "restart-user");
      assert.equal(value?.oauthState, "restart-nonce");
      await invoke(store, "destroy", "restart-sid");
    } else {
      throw new Error(`Unknown child phase: ${phase}`);
    }
  } finally {
    store.close();
  }
}

function spawnPhase(phase) {
  return spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    env: {
      ...process.env,
      WAYNODE_SESSION_TEST_ROOT: root,
      WAYNODE_SESSION_TEST_PHASE: phase,
    },
    encoding: "utf8",
    timeout: 15_000,
  });
}

async function runParentSuite() {
  const write = spawnPhase("write");
  assert.equal(write.status, 0, write.stderr || write.stdout);
  const reopen = spawnPhase("read-destroy");
  assert.equal(reopen.status, 0, reopen.stderr || reopen.stdout);

  const { default: db } = await import("../lib/db.mjs");
  const { SQLiteSessionStore } = await import("../lib/sqlite-session-store.mjs");
  const store = new SQLiteSessionStore({ pruneIntervalMs: 60_000 });
  try {
    assert.equal(await invoke(store, "get", "restart-sid"), null, "the reopened process destroyed the session");
    const expiry = new Date(Date.now() + 60_000).toISOString();
    const original = { cookie: { expires: expiry }, passport: { user: "user-1" }, oauthState: "nonce" };
    await invoke(store, "set", "sid-1", original);
    assert.deepEqual(await invoke(store, "get", "sid-1"), original);

    const touched = { ...original, cookie: { expires: new Date(Date.now() + 120_000).toISOString() } };
    await invoke(store, "touch", "sid-1", touched);
    assert.deepEqual(await invoke(store, "get", "sid-1"), touched, "touch persists the refreshed cookie");
    assert.equal(await invoke(store, "length"), 1);
    assert.deepEqual((await invoke(store, "all")).map((item) => item.id), ["sid-1"]);

    db.prepare("INSERT INTO browser_sessions (sid, session_json, expires_at) VALUES (?, ?, ?)")
      .run("expired", JSON.stringify(original), Date.now() - 1);
    assert.equal(await invoke(store, "get", "expired"), null, "expired sessions fail closed");
    db.prepare("INSERT INTO browser_sessions (sid, session_json, expires_at) VALUES (?, ?, ?)")
      .run("corrupt", "not json", Date.now() + 60_000);
    assert.equal(await invoke(store, "get", "corrupt"), null, "corrupt sessions fail closed");
    db.prepare("INSERT INTO browser_sessions (sid, session_json, expires_at) VALUES (?, ?, ?)")
      .run("wrong-shape", JSON.stringify({ passport: { user: "user-1" } }), Date.now() + 60_000);
    assert.equal(await invoke(store, "get", "wrong-shape"), null, "schema-corrupt sessions fail closed");

    await invoke(store, "destroy", "sid-1");
    assert.equal(await invoke(store, "get", "sid-1"), null, "logout destroys the durable session");
    await invoke(store, "touch", "sid-1", touched);
    assert.equal(await invoke(store, "get", "sid-1"), null, "a stale touch cannot resurrect logout");
    console.log("persistent browser session regression passed");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.env.WAYNODE_SESSION_TEST_PHASE) {
  await runChildPhase(process.env.WAYNODE_SESSION_TEST_PHASE);
} else {
  await runParentSuite();
}
