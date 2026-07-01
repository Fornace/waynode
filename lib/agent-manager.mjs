import { spawn } from "child_process";
import db from "./db.mjs";
import { config } from "./config.mjs";
import { buildPiEnv, readGoalStatus, runPiTerminal, runPiMessage, isSandboxAvailable, computeSessionTokenTotal } from "./pi-runner.mjs";
import { generateTitle } from "./title.mjs";
import { updateSession } from "./sessions.mjs";
import { getSpace } from "./spaces.mjs";
import { recordTokenUsage } from "./billing.mjs";

/**
 * AgentManager
 * ------------
 * Owns ONE long-lived `pi --mode rpc` subprocess per session.
 *
 * This is the fix for both "no token streaming" and "session dies when you
 * navigate away": the agent process lives HERE (in the manager), not in the
 * HTTP request. A client subscribes to its event stream via SSE; when the
 * client disconnects/navigates, only the subscriber is detached — the agent
 * keeps running and can be re-attached later.
 *
 * Protocol: JSON over stdin/stdout, one record per line (LF only — NOT
 * readline, which wrongly splits on U+2028/U+2029 inside JSON strings).
 */

const IDLE_REAP_MS = 30 * 60 * 1000; // kill idle agents after 30min

const agents = new Map(); // sessionId -> AgentHandle (chat rpc)
const terminals = new Map(); // sessionId -> TerminalHandle (interactive pty)

/**
 * Thrown by reclaimChat() when the chat agent is mid-turn (streaming === true)
 * and therefore must NOT be killed. Callers (getTerminal) let this propagate
 * so the route layer can reject the terminal request cleanly instead of
 * silently killing real in-progress work.
 */
class AgentBusyError extends Error {
  constructor(sessionId) {
    super(`Agent is busy for session ${sessionId}`);
    this.name = "AgentBusyError";
    this.agentBusy = true;
  }
}

function rid() {
  return Math.random().toString(36).slice(2, 10);
}

function extractText(result) {
  if (!result) return "";
  if (typeof result === "string") return result;
  const content = result.content || result.partialResult?.content || [];
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && (c.type === "text" || !c.type))
      .map((c) => c.text || "")
      .join("");
  }
  return result.output || "";
}

class AgentHandle {
  constructor(session) {
    this.sessionId = session.id;
    this.spaceId = session.space_id;
    this.title = session.title;
    this.proc = null;
    this.dead = false;

    this._reqSeq = 0;
    this._pending = new Map(); // reqId -> {resolve, reject}
    this._outBuf = Buffer.alloc(0);

    this.subscribers = new Set(); // fn(normalizedEvent)

    this.streaming = false;
    this.curMsgId = null;
    this.liveText = ""; // in-flight assistant text (for reconnect snapshot)
    this.liveTools = []; // in-flight tool calls
    this.lastUserPrompt = "";
    this._resolveTurn = null;

    this._lastActive = Date.now();
    this._lastTokenTotal = 0; // cumulative pi session tokens.total last seen, for delta billing
  }

  _write(cmd) {
    if (!this.proc || this.dead) return;
    try {
      this.proc.stdin.write(JSON.stringify(cmd) + "\n");
    } catch {}
  }

  _send(cmd) {
    const id = cmd.id || `req-${++this._reqSeq}`;
    const framed = { ...cmd, id };
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._write(framed);
      // Safety: don't hang forever waiting for a response.
      setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          resolve({ success: true, __timeout: true });
        }
      }, 10000);
    });
  }

  async start() {
    const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(this.sessionId);
    if (!session) throw new Error("Session not found");
    const space = db.prepare("SELECT local_path FROM spaces WHERE id = ?").get(this.spaceId);
    if (!space) throw new Error("Space not found");

    const model = session.model ? `fornace/${session.model}` : "fornace/fornace-fast";
    const args = [
      "--mode", "rpc",
      "--session-dir", session.pi_session_dir,
      "-c", // continue the existing pi session in this dir (each waynode session
            // has its own dir, so -c resumes the right one). Without this, every
            // spawn starts a FRESH session and the conversation history is lost.
      "--model", model,
      "-n", session.title || "New Session",
    ];

    this.proc = spawn("pi", args, {
      cwd: space.local_path,
      env: buildPiEnv(this.spaceId, { ownerId: session.owner_id }),
      stdio: ["pipe", "pipe", "pipe"],
    });

    // ── stdout: strict LF-only JSONL reader ──
    this.proc.stdout.on("data", (chunk) => {
      this._outBuf = Buffer.concat([this._outBuf, chunk]);
      while (true) {
        const idx = this._outBuf.indexOf(0x0a); // LF only
        if (idx === -1) break;
        const line = this._outBuf.subarray(0, idx);
        this._outBuf = this._outBuf.subarray(idx + 1);
        const str = line.toString("utf8");
        this._handleLine(str.endsWith("\r") ? str.slice(0, -1) : str);
      }
    });

    this.proc.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      // Surface non-trivial stderr as a status event (but don't spam).
      if (text.trim()) console.error(`[agent:${this.sessionId}] stderr:`, text.trim().slice(0, 300));
    });

    this.proc.on("exit", (code) => {
      this.dead = true;
      this.streaming = false;
      // Only surface this as a chat-visible error for genuine unexpected
      // exits. Intentional kills (idle reclaim in reclaimChat, or the idle
      // reaper below) set _intentionalKill first — those are a normal
      // process-recycling detail (pi's `-c` resume means no history is
      // lost), not a crash, so the user shouldn't see a scary error.
      if (!this._intentionalKill) {
        this.broadcast({ type: "error", message: `Agent exited (code ${code})` });
      }
      this._resolveTurn?.();
      agents.delete(this.sessionId);
    });

    // Spawn failure (e.g. `pi` not on PATH) must NOT crash the server. Without
    // this handler, Node re-throws the unhandled 'error' event and kills the
    // whole process. Degrade to a per-session error instead.
    this.proc.on("error", (err) => {
      this.dead = true;
      this.streaming = false;
      this.broadcast({ type: "error", message: `Failed to start agent: ${err.message}` });
      this._resolveTurn?.();
      agents.delete(this.sessionId);
    });
  }

  _handleLine(raw) {
    if (!raw.trim()) return;
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      return;
    }

    // Command responses (correlated by id)
    if (obj.type === "response") {
      const p = this._pending.get(obj.id);
      if (p) {
        this._pending.delete(obj.id);
        if (obj.success === false) p.reject(new Error(obj.error || "command failed"));
        else p.resolve(obj);
      }
      return;
    }

    // Extension UI dialog requests — auto-cancel so the agent never blocks.
    // (Waynode doesn't render extension dialogs yet.)
    if (obj.type === "extension_ui_request") {
      if (["select", "confirm", "input", "editor"].includes(obj.method)) {
        this._write({ type: "extension_ui_response", id: obj.id, cancelled: true });
      }
      return;
    }

    this._normalize(obj);
  }

  _normalize(e) {
    this._lastActive = Date.now();
    switch (e.type) {
      case "agent_start":
        this.streaming = true;
        this.liveText = "";
        this.liveTools = [];
        this.broadcast({ type: "start" });
        return;

      case "turn_start":
        this.broadcast({ type: "turn_start" });
        return;

      case "message_start":
        if ((e.message?.role || "assistant") === "assistant") {
          this.curMsgId = e.message?.id || rid();
          this.broadcast({ type: "message_start", messageId: this.curMsgId });
        }
        return;

      case "message_update": {
        const d = e.assistantMessageEvent;
        if (!d) return;
        const mid = e.message?.id || this.curMsgId;
        if (d.type === "text_delta") {
          const delta = d.delta || "";
          this.liveText += delta;
          this.broadcast({ type: "text_delta", messageId: mid, delta });
        } else if (d.type === "thinking_delta") {
          const delta = d.textDelta || d.delta || d.reasoningDelta || "";
          this.broadcast({ type: "thinking_delta", messageId: mid, delta });
        }
        return;
      }

      case "message_end":
        this.broadcast({ type: "message_end", messageId: e.message?.id });
        return;

      case "tool_execution_start":
        this.broadcast({
          type: "tool_start",
          messageId: this.curMsgId,
          toolCallId: e.toolCallId,
          toolName: e.toolName,
          args: e.args,
        });
        return;

      case "tool_execution_update":
        this.broadcast({
          type: "tool_delta",
          messageId: this.curMsgId,
          toolCallId: e.toolCallId,
          text: extractText(e.partialResult),
        });
        return;

      case "tool_execution_end":
        this.broadcast({
          type: "tool_end",
          messageId: this.curMsgId,
          toolCallId: e.toolCallId,
          text: extractText(e.result),
          isError: !!e.isError,
        });
        return;

      case "turn_end":
        this.broadcast({ type: "turn_end" });
        return;

      case "agent_end":
        this._onAgentEnd();
        return;

      case "auto_retry_start":
        this.broadcast({ type: "status", text: `Retrying (${e.attempt}/${e.maxAttempts})…` });
        return;

      case "compaction_start":
        this.broadcast({ type: "status", text: "Compacting context…" });
        return;

      case "extension_error":
        this.broadcast({ type: "status", text: `Extension error: ${e.error || ""}` });
        return;
    }
  }

  _onAgentEnd() {
    this.streaming = false;
    this.broadcast({ type: "end" });
    this._maybeRename();
    this._meterTokenUsage();
    const resolve = this._resolveTurn;
    this._resolveTurn = null;
    resolve?.();
  }

  /**
   * Bill the tokens consumed by the turn that just ended. pi's RPC
   * `get_session_stats` returns CUMULATIVE totals for the whole pi session
   * (tokens.total), not a per-turn delta — so we track the last-seen
   * cumulative total on the handle and only record the difference. Without
   * this, every turn would re-bill the entire conversation's tokens so far.
   */
  async _meterTokenUsage() {
    try {
      const res = await this._send({ type: "get_session_stats" });
      const total = res?.data?.tokens?.total;
      if (typeof total !== "number" || Number.isNaN(total)) return;
      const delta = total - this._lastTokenTotal;
      this._lastTokenTotal = total;
      if (delta <= 0) return;

      const space = getSpace(this.spaceId);
      if (!space?.org_id) return; // self-host / personal space with no billing org
      recordTokenUsage(space.org_id, delta);
    } catch (err) {
      console.error(`[agent:${this.sessionId}] token metering failed:`, err.message);
    }
  }

  async _maybeRename() {
    // Only rename once, and only if the user hasn't set a custom title.
    if (this._renamed) return;
    const session = db.prepare("SELECT title FROM sessions WHERE id = ?").get(this.sessionId);
    if (!session) return;
    const isDefault = !session.title || session.title === "New Session";
    if (!isDefault) {
      this._renamed = true; // user named it; never auto-rename
      return;
    }
    const title = await generateTitle(this.lastUserPrompt, this.liveText);
    if (!title) return;
    this._renamed = true;
    this.title = title;
    updateSession(this.sessionId, { title });
    // Mirror into pi's own session name for /resume consistency.
    this._send({ type: "set_session_name", name: title }).catch(() => {});
    this.broadcast({ type: "session_renamed", title });
  }

  // ── Public API ──

  /** Send a prompt; resolves when the resulting turn completes. */
  async sendPrompt(prompt, isGoal = false) {
    if (this.dead) throw new Error("Agent is dead");
    this.lastUserPrompt = prompt;
    this.streaming = true;
    this._renamed = this._renamed || false;
    const done = new Promise((resolve, reject) => {
      this._resolveTurn = resolve;
      this._rejectTurn = reject;
    });

    const full = isGoal
      ? `You must use the create_goal tool to create a goal for the following task, then work autonomously until you can call update_goal with status "complete". Task: ${prompt}`
      : prompt;

    try {
      await this._send({ type: "prompt", message: full });
    } catch (err) {
      this.streaming = false;
      this.broadcast({ type: "error", message: err.message });
      throw err;
    }

    return done; // resolves on agent_end
  }

  async abort() {
    this._send({ type: "abort" }).catch(() => {});
  }

  /** Queue a follow-up prompt while a turn is running (fires after completion). */
  queueFollowUp(prompt) {
    this.streaming = true;
    this._send({ type: "follow_up", message: prompt }).catch((err) =>
      this.broadcast({ type: "error", message: err.message })
    );
  }

  /**
   * Switch the live agent's model via pi's RPC `set_model` command. This takes
   * effect on the next LLM call (mid-turn included), so the user can change
   * models from the dropdown without respawning the process. Resolves with the
   * new Model object; rejects ({success:false}) if the model id is unknown.
   * Provider matches how the process was spawned (--model fornace/<id>).
   */
  async setModel(provider, modelId) {
    return this._send({ type: "set_model", provider, modelId });
  }

  /** Subscribe to normalized events. Returns an unsubscribe fn. */
  subscribe(fn) {
    this.subscribers.add(fn);
    // Replay current in-flight state so reconnecting clients catch up.
    if (this.streaming) {
      fn({ type: "sync", streaming: true, partialText: this.liveText, tools: this.liveTools });
    } else {
      fn({ type: "sync", streaming: false });
    }
    return () => this.subscribers.delete(fn);
  }

  broadcast(ev) {
    for (const fn of this.subscribers) {
      try {
        fn(ev);
      } catch {}
    }
  }

  getGoalStatus() {
    const session = db.prepare("SELECT pi_session_dir FROM sessions WHERE id = ?").get(this.sessionId);
    return session ? readGoalStatus(session.pi_session_dir) : null;
  }
}

/**
 * TerminalHandle
 * --------------
 * Owns a long-lived interactive `pi` (TUI) pty for a session, decoupled from
 * any WebSocket subscriber — exactly like AgentHandle owns the rpc agent.
 *
 * Closing the browser / navigating away only DETACHES the subscriber; the pty
 * keeps running server-side and can be re-attached later (buffer replay + forced
 * redraw on attach). This is what makes a terminal session survive a browser
 * close, the same way a chat turn already does. Only a deliberate switch back
 * to chat (getAgent) or the idle reaper tears it down.
 */
const TERM_BUF_CAP = 64 * 1024;

class TerminalHandle {
  constructor(session, pty) {
    this.sessionId = session.id;
    this.spaceId = session.space_id;
    this.pty = pty;
    this.dead = false;
    this.subscribers = new Set(); // fn({type:"output"|"exit", ...})
    this._buf = "";
    this.cols = 80;
    this.rows = 24;
    this._lastActive = Date.now();

    // Always listen so output is captured into the buffer even with zero WS
    // subscribers (otherwise node-pty drops it and re-attach loses history).
    pty.onData((data) => {
      this._lastActive = Date.now();
      this._buf += data;
      if (this._buf.length > TERM_BUF_CAP) this._buf = this._buf.slice(-TERM_BUF_CAP);
      this._broadcast({ type: "output", data });
    });

    pty.onExit(({ exitCode }) => {
      this.dead = true;
      this._broadcast({ type: "exit", exitCode });
      this.subscribers.clear();
      terminals.delete(this.sessionId);
    });
  }

  _broadcast(ev) {
    for (const fn of this.subscribers) {
      try { fn(ev); } catch {}
    }
  }

  /**
   * Attach an output sink. Replays the recent buffer and forces a pty resize so
   * pi's TUI redraws a clean current frame. Returns a detach fn. Detaching does
   * NOT kill the pty — it stays alive for re-attach.
   */
  attach(fn) {
    this.subscribers.add(fn);
    // Opening the tab counts as activity — don't let an idle-but-open terminal
    // get reaped just because the user stepped away without typing.
    this._lastActive = Date.now();
    if (this._buf) { try { fn({ type: "output", data: this._buf }); } catch {} }
    // Force a redraw: resize emits SIGWINCH, which pi's TUI repaints on.
    try { this.pty.resize(this.cols, this.rows); } catch {}
    return () => this.subscribers.delete(fn);
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
    try { this.pty.kill(); } catch {}
  }
}

/**
 * Reclaim a session's chat rpc agent so the terminal can take over the
 * session without two processes writing the same JSONL.
 *
 * If the agent is idle, this is safe to do unconditionally: pi's `-c` resume
 * means no history is lost, only the idle process is recycled. But if the
 * agent is mid-turn (streaming === true) it is actively doing real work
 * (running tools, writing files, etc) — per product requirement, agents must
 * keep working in the background regardless of which tab the user is
 * viewing (mirrors how TerminalHandle survives browser close/tab switches).
 * So a busy agent is NOT killed; instead this throws AgentBusyError for the
 * caller to react to.
 */
async function reclaimChat(sessionId) {
  const chat = agents.get(sessionId);
  if (!chat || chat.dead) return;
  if (chat.streaming) {
    throw new AgentBusyError(sessionId);
  }
  chat._intentionalKill = true;
  try { chat.proc?.kill(); } catch {}
  agents.delete(sessionId);
}

/**
 * SandboxedAgentHandle
 * ---------------------
 * Same subscriber/SSE contract as AgentHandle, but each message runs pi in a
 * FRESH microsandbox microVM (see runPiMessage/runInSandbox in pi-runner.mjs).
 *
 * Why a separate handle instead of an RPC bridge: pi's bash tool needs a real
 * controlling TTY (node-pty deadlocks without one — see the .tty(true) note
 * in pi-runner.mjs runInSandbox), and upstream's own docs/PRs say tty mode
 * and their non-pty streaming exec mode (execStreamWith) are alternatives,
 * not something to combine (superradcompany/microsandbox#922: "-t/--tty
 * allocates a PTY ... unsafe for line protocols"). So the exec call itself
 * stays execWith(...).tty(true), which COLLECTS the full output — one-shot
 * per turn, no token-by-token streaming yet.
 *
 * This IS a real (if unverified) path forward, not a hard SDK limitation:
 * Sandbox.logStream({ sources: ["output"], follow: true }) taps the same
 * exec session's output live, chunk by chunk, as the relay writes it to
 * exec.log (confirmed by reading microsandbox's relay.rs and TS SDK docs,
 * 2026-07-01 — see docs/TASKS.md E14 for the full trail). It has shipped
 * since 2026-05-22, well before the 0.5.7 in package.json (0.6.1, the
 * current latest, has an identical dist/{sandbox,exec}.d.ts). What's
 * unverified: running logStream({follow:true}) CONCURRENTLY with the
 * in-flight execWith(...).tty(true)) call — upstream's own examples only
 * call it after exec completes — and this dev environment has no /dev/kvm,
 * so isSandboxAvailable() is always false here and the sandboxed path can't
 * be exercised locally. See docs/TASKS.md E14 for the exact code change to
 * try and how to verify it once sandbox/KVM access is available.
 *
 * Sessions still resume across VMs because pi_session_dir lives inside the
 * bind-mounted repo (space.local_path/.waynode/sessions/<id>), so `-c` picks
 * up the prior conversation. Goal status is read from the same dir.
 */
class SandboxedAgentHandle {
  constructor(session) {
    this.sessionId = session.id;
    this.spaceId = session.space_id;
    this.session = session;
    this.streaming = false;
    this.dead = false;
    this.subscribers = new Set(); // fn(normalizedEvent)
    this.liveText = "";
    this.liveTools = [];
    this.lastUserPrompt = "";
    this._lastActive = Date.now();
    this.titleJob = null; // in-flight title generation promise, if any
    this._lastTokenTotal = 0; // cumulative tokens billed so far, for delta metering
  }

  /** No long-lived process to start — each message spawns its own VM. */
  async start() {}

  subscribe(fn) {
    this.subscribers.add(fn);
    // Replay current state so reconnecting clients catch up.
    fn({ type: "sync", streaming: this.streaming, partialText: this.liveText, tools: this.liveTools });
    return () => this.subscribers.delete(fn);
  }

  broadcast(ev) {
    for (const fn of this.subscribers) {
      try { fn(ev); } catch {}
    }
  }

  /**
   * Run one message in a fresh microVM. Serializes internally (one turn at a
   * time); concurrent calls are ignored while streaming (caller gets 409 busy
   * from the route, same contract as AgentHandle).
   */
  async sendPrompt(prompt, isGoal = false) {
    if (this.streaming) return;
    this.streaming = true;
    this.lastUserPrompt = prompt;
    this._lastActive = Date.now();

    const messageId = rid();
    this.broadcast({ type: "start" });
    this.broadcast({ type: "message_start", messageId });

    // Incremental streaming (EXPERIMENTAL, see pi-runner.mjs runInSandbox for
    // the full verified-vs-assumed trail): onChunk is called from inside the
    // sandboxed exec's concurrent logStream drain, if that path is enabled
    // and working. this.liveText accumulates streamed chunks so a reconnecting
    // client's `sync` snapshot (subscribe(), above) shows partial progress
    // instead of nothing — mirrors AgentHandle's existing liveText semantics.
    // streamedLen tracks how much of liveText came from chunks, purely to
    // detect a mismatch against the final collected text below; it is never
    // used to decide what gets persisted.
    let streamedLen = 0;
    const onChunk = (chunk) => {
      if (!chunk) return;
      this.liveText += chunk;
      streamedLen += chunk.length;
      this.broadcast({ type: "text_delta", messageId, delta: chunk });
    };

    try {
      const result = await runPiMessage({ session: this.session, prompt, isGoal, onChunk });
      const text = (result.stdout || "").trim();
      console.log(`[sandbox:${this.sessionId}] run complete (status=${result.status}, ${text.length} chars)`);
      if (streamedLen > 0) {
        // Streaming delivered *something*. The full collected `text` from
        // execWith is still the source of truth for anything persisted —
        // incremental delivery is a display nicety, not a parser. If the
        // streamed total doesn't match the final text length, something
        // went wrong with incremental delivery (dropped/duplicated log
        // entries, a partial decode, etc — see the "NOT VERIFIED" note in
        // runInSandbox). Log it, but do not treat it as fatal: correctness
        // of the final persisted message matters more than a smooth
        // streaming display, and the caller below still uses `text`
        // (never `this.liveText`) for anything that gets persisted.
        if (streamedLen !== text.length) {
          console.warn(
            `[sandbox:${this.sessionId}] streamed length (${streamedLen}) != final text length (${text.length}); using final text as source of truth`
          );
        }
      } else if (text) {
        // Streaming path didn't fire at all (disabled, unsupported SDK,
        // or logStream failed before yielding anything) — fall back to
        // exactly today's behavior: one broadcast with the whole response.
        this.liveText = text;
        this.broadcast({ type: "text_delta", messageId, delta: text });
      }
      if (result.stderr && /error|fail|exception/i.test(result.stderr)) {
        this.broadcast({ type: "error", message: result.stderr.slice(0, 500) });
      }
      this.broadcast({ type: "message_end", messageId });
    } catch (err) {
      console.error(`[sandbox:${this.sessionId}] message failed:`, err.message);
      this.broadcast({ type: "error", message: err.message || "Sandboxed run failed" });
    } finally {
      this.streaming = false;
      this.liveText = "";
      this.broadcast({ type: "end" });
    }

    this._meterTokenUsage();

    // Best-effort title generation for the first message (mirrors AgentHandle).
    this._maybeGenerateTitle(prompt);
  }

  /**
   * There's no long-lived RPC session to ask `get_session_stats` of here —
   * each turn is a fresh one-shot microVM run (see class doc above). Instead,
   * read the cumulative usage straight from the persisted session JSONL
   * (host-readable — pi_session_dir lives inside the bind-mounted repo, not
   * inside the microVM) via computeSessionTokenTotal(), which sums the same
   * fields pi's own getSessionStats() does. Delta-bill against the last-seen
   * total, exactly like AgentHandle._meterTokenUsage().
   */
  _meterTokenUsage() {
    try {
      const total = computeSessionTokenTotal(this.session.pi_session_dir);
      const delta = total - this._lastTokenTotal;
      this._lastTokenTotal = total;
      if (delta <= 0) return;

      const space = getSpace(this.spaceId);
      if (!space?.org_id) return; // self-host / personal space with no billing org
      recordTokenUsage(space.org_id, delta);
    } catch (err) {
      console.error(`[sandbox:${this.sessionId}] token metering failed:`, err.message);
    }
  }

  async _maybeGenerateTitle(userPrompt) {
    try {
      const session = db.prepare("SELECT title FROM sessions WHERE id = ?").get(this.sessionId);
      const isDefault = !session?.title || session.title === "New Session";
      if (!isDefault) return; // user named it; never auto-rename
      if (this.titleJob) return;
      this.titleJob = (async () => {
        const title = await generateTitle(userPrompt, this.liveText);
        if (!title) return;
        await updateSession(this.sessionId, { title });
        this.title = title;
        this.broadcast({ type: "session_renamed", title });
      })().catch(() => {});
    } catch {}
  }

  /** Switch model is a no-op for the sandboxed path (model is chosen per-VM
   *  via getPiArgs from session.model). Persist it for the next run. */
  async setModel(provider, modelId) {
    try { await updateSession(this.sessionId, { model: modelId }); } catch {}
    return { success: true, provider, modelId };
  }

  getGoalStatus() {
    const session = db.prepare("SELECT pi_session_dir FROM sessions WHERE id = ?").get(this.sessionId);
    return session ? readGoalStatus(session.pi_session_dir) : null;
  }
}

// ── Module API ──

export async function getAgent(session) {
  // Mutual exclusion: reclaim any terminal pty for this session before spawning
  // the chat rpc agent, so only one writer owns the session JSONL at a time.
  teardownTerminal(session.id);

  let handle = agents.get(session.id);
  if (handle && !handle.dead) return handle;

  // ── Sandboxed mode (hardware microVM isolation) ──
  // Active only on hosts with /dev/kvm + the `waynode-sandbox` image cached.
  // Each message boots a throwaway microVM; no long-lived RPC process. Falls
  // back to the RPC AgentHandle below when sandboxing is unavailable (dev,
  // or the shared cloud host without nested virt).
  if (await isSandboxAvailable()) {
    handle = new SandboxedAgentHandle(session);
    agents.set(session.id, handle);
    return handle;
  }

  handle = new AgentHandle(session);
  agents.set(session.id, handle);
  await handle.start();
  return handle;
}

/**
 * Acquire (or re-attach to) the server-owned terminal pty for a session. If a
 * chat rpc agent currently owns the session and is idle, it is reclaimed
 * first (killed) — opening the terminal is a deliberate "take over" and must
 * not leave two processes writing the same JSONL. If the chat agent is
 * mid-turn, reclaimChat() throws AgentBusyError (err.agentBusy = true) instead
 * of killing real in-progress work; that error propagates out of this
 * function for the caller (route layer) to turn into a clean rejection. The
 * pty persists across WS disconnects (browser close); only an idle-timeout
 * reap or an explicit switch back to chat tears it down.
 */
export async function getTerminal(session, spawnPty = runPiTerminal) {
  // SECURITY: in sandboxed mode, the interactive terminal is disabled by
  // default. A terminal session runs pi's full TUI (arbitrary commands) and
  // needs a long-lived bidirectional pty — which the microsandbox SDK still
  // does not expose to callers. Re-verified 2026-07-01 against the latest
  // published version (0.6.1; installed here is 0.5.7 — `sandbox.d.ts`,
  // `exec.d.ts`, and `ssh.d.ts` are byte-identical between the two, so
  // nothing changed on this front in the interim):
  //   - Sandbox.attach()/attachWith()/attachShell() and SshClient.attach()
  //     all resolve `Promise<number>` (an exit code only). They allocate a
  //     pty and hand it to the *calling process's own* stdio/tty (confirmed
  //     by upstream PR superradcompany/microsandbox#1059, "route interactive
  //     mode through a shared helper so --no-tty skips the attached PTY
  //     path" — attach is a CLI-takes-over-the-terminal primitive, not an
  //     API that yields a handle a caller can read/write over a socket).
  //   - execStream/shellStream (ExecHandle) give AsyncIterable<ExecEvent> +
  //     takeStdin() — real bidirectional bytes, but no pty: no raw mode, no
  //     window-size/SIGWINCH propagation, no escape-sequence semantics. Not
  //     sufficient for pi's TUI (cursor positioning, alt-screen, etc).
  //   - No lower-level "give me a pty fd/stream" primitive is exposed either
  //     via Sandbox or via SandboxSshOps/SshClient.
  // Running it on the host would execute untrusted code as root — exactly
  // what sandboxing exists to prevent. Override with WAYNODE_ALLOW_HOST_TERMINAL=1
  // on a trusted/single-tenant host. Re-check next time microsandbox ships a
  // minor bump; if attach()/SSH ever returns a stream/handle instead of a
  // bare exit code, that's the signal to revisit this.
  if ((await isSandboxAvailable()) && !config.allowHostTerminal) {
    const err = new Error(
      "Terminal is unavailable in sandboxed mode. Agent chat runs in an isolated microVM; " +
      "interactive terminal support is pending microsandbox SDK support for programmatic pty channels."
    );
    err.terminalDisabled = true;
    throw err;
  }

  await reclaimChat(session.id);

  let handle = terminals.get(session.id);
  if (handle && !handle.dead) return handle;

  // runPiTerminal({ session, cols, rows }) — pass the destructure wrapper so
  // the default matches the signature. (A bare `session` arg silently breaks
  // runPiTerminal, which would read session.space_id off undefined.)
  const pty = await spawnPty({ session });
  handle = new TerminalHandle(session, pty);
  terminals.set(session.id, handle);
  return handle;
}

export function getTerminalIfActive(sessionId) {
  const h = terminals.get(sessionId);
  return h && !h.dead ? h : null;
}

/** Kill and remove a session's terminal pty (no-op if none). */
export function teardownTerminal(sessionId) {
  const h = terminals.get(sessionId);
  if (h && !h.dead) {
    try { h.pty.kill(); } catch {}
  }
  terminals.delete(sessionId);
}

export function getAgentIfActive(sessionId) {
  const h = agents.get(sessionId);
  return h && !h.dead ? h : null;
}

export function listActiveAgents() {
  return [...agents.values()].filter((a) => !a.dead);
}

/**
 * Is any pi agent currently mid-turn for this space?
 * Used by the git sidebar to surface a "pi is working" banner. The user is
 * always the owner of the repo, so this is informational (soft-warn) — never
 * a hard permission gate on writes.
 */
export function isSpaceBusy(spaceId) {
  return (
    listActiveAgents().some((a) => a.spaceId === spaceId && a.streaming) ||
    [...terminals.values()].some((t) => !t.dead && t.spaceId === spaceId)
  );
}

// Periodically reap idle agents and terminals to free resources.
setInterval(() => {
  const now = Date.now();
  for (const [id, handle] of agents) {
    if (handle.dead) {
      agents.delete(id);
      continue;
    }
    if (!handle.streaming && now - handle._lastActive > IDLE_REAP_MS) {
      console.log(`[agent-manager] reaping idle agent ${id}`);
      handle._intentionalKill = true;
      try {
        handle.proc?.kill();
      } catch {}
      agents.delete(id);
    }
  }
  for (const [id, handle] of terminals) {
    if (handle.dead) {
      terminals.delete(id);
      continue;
    }
    if (now - handle._lastActive > IDLE_REAP_MS) {
      console.log(`[agent-manager] reaping idle terminal ${id}`);
      try {
        handle.pty.kill();
      } catch {}
      terminals.delete(id);
    }
  }
}, 5 * 60 * 1000).unref();
