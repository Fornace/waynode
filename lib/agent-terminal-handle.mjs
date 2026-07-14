const TERMINAL_BUFFER_CAP = 64 * 1024;

export class AgentBusyError extends Error {
  constructor(sessionId) {
    super(`Agent is busy for session ${sessionId}`);
    this.name = "AgentBusyError";
    this.agentBusy = true;
  }
}

/** A server-owned interactive pi PTY that survives client disconnects. */
export class TerminalHandle {
  constructor(session, pty, onExit, meterUsage, meterIntervalMs = 30_000) {
    this.sessionId = session.id;
    this.spaceId = session.space_id;
    this.pty = pty;
    this.dead = false;
    this.subscribers = new Set();
    this._buf = "";
    this.cols = 80;
    this.rows = 24;
    this._lastActive = Date.now();
    this._meterUsage = meterUsage;
    this._meterTimer = meterUsage ? setInterval(() => this.meter(), meterIntervalMs) : null;
    this._meterTimer?.unref?.();

    pty.onData((data) => {
      this._lastActive = Date.now();
      this._buf += data;
      if (this._buf.length > TERMINAL_BUFFER_CAP) {
        this._buf = this._buf.slice(-TERMINAL_BUFFER_CAP);
      }
      this._broadcast({ type: "output", data });
    });

    pty.onExit(({ exitCode }) => {
      this.dead = true;
      if (this._meterTimer) clearInterval(this._meterTimer);
      this.meter();
      this._broadcast({ type: "exit", exitCode });
      this.subscribers.clear();
      onExit?.();
    });
  }

  meter() {
    try { this._meterUsage?.(); } catch (error) { console.error(`[terminal:${this.sessionId}] metering failed:`, error.message); }
  }

  _broadcast(event) {
    for (const subscriber of this.subscribers) {
      try { subscriber(event); } catch {}
    }
  }

  attach(subscriber) {
    this.subscribers.add(subscriber);
    this._lastActive = Date.now();
    if (this._buf) {
      try { subscriber({ type: "output", data: this._buf }); } catch {}
    }
    try { this.pty.resize(this.cols, this.rows); } catch {}
    return () => this.subscribers.delete(subscriber);
  }

  input(data) {
    if (this.dead) return;
    this._lastActive = Date.now();
    try { this.pty.write(data); } catch {}
  }

  resize(cols, rows) {
    if (this.dead) return;
    this.cols = cols || 80;
    this.rows = rows || 24;
    try { this.pty.resize(this.cols, this.rows); } catch {}
  }

  kill() {
    if (this.dead) return;
    if (this._meterTimer) clearInterval(this._meterTimer);
    this._meterTimer = null;
    this.meter();
    try { this.pty.kill(); } catch {}
  }
}
