const BACKLOG_CAP = 64 * 1024;
const SIGKILL_EXIT_CODE = 137;

function terminalNetworkPolicy(Rule, Destination) {
  return {
    defaultEgress: "deny",
    defaultIngress: "allow",
    rules: [
      Rule.allowEgress(Destination.cidr("10.200.0.1/32")),
      Rule.allowEgress(Destination.domain("github.com")),
      Rule.allowEgress(Destination.domainSuffix("github.com")),
      Rule.allowEgress(Destination.domain("raw.githubusercontent.com")),
      Rule.allowEgress(Destination.domain("gitlab.com")),
      Rule.allowEgress(Destination.domainSuffix("gitlab.com")),
      Rule.allowDns(),
      Rule.denyEgress(Destination.group("metadata")),
    ],
  };
}

/** node-pty-shaped adapter backed entirely by a microsandbox exec stream. */
export class SandboxTerminalPty {
  constructor(sandbox, exec, stdin, onDispose = null) {
    this.sandbox = sandbox;
    this.exec = exec;
    this.stdin = stdin;
    this.dead = false;
    this._dataListeners = new Set();
    this._exitListeners = new Set();
    this._backlog = "";
    this._exitEvent = null;
    this._decoder = new TextDecoder();
    this._writeChain = Promise.resolve();
    this._cleanupStarted = false;
    this._onDispose = onDispose;
    this._pump().catch((error) => this._fail(error));
  }

  onData(listener) {
    this._dataListeners.add(listener);
    if (this._backlog) {
      const backlog = this._backlog;
      this._backlog = "";
      queueMicrotask(() => listener(backlog));
    }
    return { dispose: () => this._dataListeners.delete(listener) };
  }

  onExit(listener) {
    this._exitListeners.add(listener);
    if (this._exitEvent) queueMicrotask(() => listener(this._exitEvent));
    return { dispose: () => this._exitListeners.delete(listener) };
  }

  write(data) {
    if (this.dead || !data) return;
    this._writeChain = this._writeChain
      .then(() => this.stdin.write(data))
      .catch((error) => this._fail(error));
  }

  // microsandbox 0.6.6 allocates a guest TTY but its high-level ExecHandle
  // does not yet expose TIOCSWINSZ. Keep the node-pty contract fail-safe: the
  // terminal remains interactive at its initial 80x24 instead of escaping to
  // a host PTY. A future SDK resize method can be wired here without changing
  // TerminalHandle or the WebSocket protocol.
  resize() {}

  kill() {
    if (this.dead) return;
    this._terminate().catch((error) => this._fail(error));
  }

  async _pump() {
    let sawExit = false;
    for (;;) {
      const event = await this.exec.recv();
      if (event === null) break;
      if (event.kind === "stdout" || event.kind === "stderr") {
        this._emitData(this._decoder.decode(event.data, { stream: true }));
      } else if (event.kind === "exited") {
        sawExit = true;
        this._finish(event.code);
        break;
      }
    }
    if (!sawExit && !this.dead) {
      const status = await this.exec.wait();
      this._finish(status.code ?? (status.success ? 0 : 1));
    }
  }

  async _terminate() {
    try {
      await this.exec.kill();
    } finally {
      this._finish(SIGKILL_EXIT_CODE);
    }
  }

  _emitData(text) {
    if (!text) return;
    if (this._dataListeners.size === 0) {
      this._backlog = (this._backlog + text).slice(-BACKLOG_CAP);
      return;
    }
    for (const listener of this._dataListeners) {
      try { listener(text); } catch {}
    }
  }

  _finish(exitCode) {
    if (this.dead) return;
    const tail = this._decoder.decode();
    if (tail) this._emitData(tail);
    this.dead = true;
    this._exitEvent = { exitCode };
    for (const listener of this._exitListeners) {
      try { listener(this._exitEvent); } catch {}
    }
    this._cleanup();
  }

  _fail(error) {
    if (this.dead) return;
    this._emitData(`\r\n[Sandbox terminal error: ${error?.message || "unknown error"}]\r\n`);
    this._finish(1);
  }

  _cleanup() {
    if (this._cleanupStarted) return;
    this._cleanupStarted = true;
    Promise.resolve(this.stdin.close()).catch(() => {});
    Promise.resolve(this.sandbox.stop()).catch(() => {});
    Promise.resolve(this._onDispose?.()).catch(() => {});
  }
}

/** Start pi in a hardware-isolated microVM and expose a node-pty-like handle. */
export async function spawnSandboxedTerminal({
  args,
  cwd,
  env,
  spaceId,
  sessionId,
  onDispose = null,
  sdk = null,
}) {
  const { Sandbox, Rule, Destination } = sdk || await import("microsandbox");
  const safeId = String(sessionId || spaceId).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 72);
  const name = `wn-terminal-${safeId}-${Date.now()}`;
  const sandbox = await Sandbox.builder(name)
    .image("waynode-sandbox:latest")
    .cpus(2)
    .memory(2048)
    .network((network) => network.policy(terminalNetworkPolicy(Rule, Destination)))
    .volume("/workspace", (mount) => mount.bind(cwd))
    .replace()
    .create();

  try {
    const exec = await sandbox.execStreamWith("pi", (builder) => builder
      .args(args)
      .cwd("/workspace")
      .envs({ ...env, TERM: "xterm-256color", COLUMNS: "80", LINES: "24" })
      .stdinPipe()
      .tty(true));
    const stdin = await exec.takeStdin();
    if (!stdin) throw new Error("microsandbox did not provide a terminal stdin stream");
    return new SandboxTerminalPty(sandbox, exec, stdin, onDispose);
  } catch (error) {
    try { await sandbox.stop(); } catch {}
    throw error;
  }
}
