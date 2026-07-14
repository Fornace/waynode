/** Microsandbox 0.6.6 bidirectional terminal adapter regression. */
import assert from "node:assert/strict";
import { SandboxTerminalPty, spawnSandboxedTerminal } from "../lib/sandbox-terminal-pty.mjs";

const encoder = new TextEncoder();
const { Sandbox, ExecOptionsBuilder } = await import("microsandbox");
const installedOptions = new ExecOptionsBuilder();
assert.equal(typeof Sandbox.prototype.execStreamWith, "function", "installed SDK exposes programmatic exec streaming");
assert.equal(typeof installedOptions.stdinPipe, "function", "installed SDK exposes a writable stdin pipe");
assert.equal(typeof installedOptions.tty, "function", "installed SDK exposes guest TTY allocation");

function fakeSdk(events) {
  const calls = { builder: [], exec: [], writes: [], stopped: 0, killed: 0, stdinClosed: 0 };
  const stdin = {
    async write(data) { calls.writes.push(data); },
    async close() { calls.stdinClosed += 1; },
  };
  const exec = {
    async recv() { return events.shift() ?? null; },
    async wait() { return { code: 0, success: true }; },
    async kill() { calls.killed += 1; },
    async takeStdin() { return stdin; },
  };
  const sandbox = {
    async execStreamWith(command, configure) {
      const options = {};
      const builder = {
        args(value) { options.args = value; return this; },
        cwd(value) { options.cwd = value; return this; },
        envs(value) { options.env = value; return this; },
        stdinPipe() { options.stdinPipe = true; return this; },
        tty(value) { options.tty = value; return this; },
      };
      configure(builder);
      calls.exec.push({ command, options });
      return exec;
    },
    async stop() { calls.stopped += 1; },
  };
  const chain = {
    image(value) { calls.builder.push(["image", value]); return this; },
    cpus(value) { calls.builder.push(["cpus", value]); return this; },
    memory(value) { calls.builder.push(["memory", value]); return this; },
    network(configure) {
      configure({ policy(value) { calls.policy = value; } });
      return this;
    },
    volume(path, configure) {
      configure({ bind(value) { calls.volume = [path, value]; } });
      return this;
    },
    replace() { return this; },
    async create() { return sandbox; },
  };
  const destination = new Proxy({}, { get: (_, key) => (value) => ({ key, value }) });
  const Rule = {
    allowEgress: (destinationValue) => ({ allow: destinationValue }),
    denyEgress: (destinationValue) => ({ deny: destinationValue }),
    allowDns: () => ({ dns: true }),
  };
  return { sdk: { Sandbox: { builder: (name) => { calls.name = name; return chain; } }, Rule, Destination: destination }, calls, exec, stdin, sandbox };
}

const fixture = fakeSdk([
  { kind: "started", pid: 42 },
  { kind: "stdout", data: encoder.encode("Way") },
  { kind: "stderr", data: encoder.encode("node") },
  { kind: "exited", code: 0 },
]);
const pty = await spawnSandboxedTerminal({
  args: ["--model", "fornace/fornace-fast"],
  cwd: "/data/repos/space",
  env: { SAFE: "yes" },
  spaceId: "space",
  sessionId: "session",
  sdk: fixture.sdk,
});

let output = "";
let exitEvent = null;
pty.onData((data) => { output += data; });
pty.onExit((event) => { exitEvent = event; });
await new Promise((resolve) => setImmediate(resolve));

assert.equal(output, "Waynode", "stdout and stderr are streamed through the adapter");
assert.deepEqual(exitEvent, { exitCode: 0 }, "guest exit is forwarded");
assert.deepEqual(fixture.calls.volume, ["/workspace", "/data/repos/space"], "only the worktree is bind-mounted");
assert.equal(fixture.calls.exec[0].command, "pi");
assert.equal(fixture.calls.exec[0].options.cwd, "/workspace");
assert.equal(fixture.calls.exec[0].options.stdinPipe, true, "stdin is programmatically writable");
assert.equal(fixture.calls.exec[0].options.tty, true, "guest allocates the controlling TTY");
assert.equal(fixture.calls.exec[0].options.env.SAFE, "yes");
assert.equal(fixture.calls.stopped, 1, "microVM stops after pi exits");

const live = fakeSdk([]);
let resolveEvent;
live.exec.recv = () => new Promise((resolve) => { resolveEvent = resolve; });
const livePty = new SandboxTerminalPty(live.sandbox, live.exec, live.stdin);
livePty.write("git status\r");
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(live.calls.writes, ["git status\r"], "input stays inside the guest exec stream");
livePty.resize(140, 40);
livePty.kill();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(live.calls.killed, 1, "kill targets the guest exec");
assert.equal(live.calls.stopped, 1, "kill also stops the microVM");
resolveEvent(null);

console.log("sandbox terminal: 16 assertions passed");
