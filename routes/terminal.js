import { Router } from "express";
import { WebSocketServer } from "ws";
import { getSession } from "../lib/sessions.mjs";
import { getTerminal } from "../lib/agent-manager.mjs";
import { config } from "../lib/config.mjs";
import db from "../lib/db.mjs";
import { randomUUID } from "crypto";
import { resolveApiToken } from "../lib/auth.mjs";
import { getSpace } from "../lib/spaces.mjs";
import { billingEnabled } from "../lib/billing.mjs";

const router = Router();

let allowedOrigin = null;
try {
  if (config.appUrl) allowedOrigin = new URL(config.appUrl).origin;
} catch {}

export function attachTerminalWebSocket(server, sessionMiddleware) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    if (!req.url.startsWith("/ws/terminal")) return;

    // CSWSH guard: browsers send an Origin header on WebSocket handshakes and
    // attach cookies cross-site, so a malicious page could otherwise open a
    // terminal WS as the logged-in user. Reject anything that isn't our own
    // origin. (Non-browser clients send no Origin; they still need the session
    // cookie below, so they're unaffected.)
    const origin = req.headers.origin;
    if (origin && allowedOrigin) {
      try {
        if (new URL(origin).origin !== allowedOrigin) {
          socket.destroy();
          return;
        }
      } catch {
        socket.destroy();
        return;
      }
    }

    // Resolve the URL early so the dev-token (?t=) path can short-circuit
    // before the session-cookie requirement — mirrors the sseAuth helper on
    // the chat/clone/git SSE routes, so the terminal WS is drivable in
    // automated E2E the same way those streams are.
    const url = new URL(req.url, "http://localhost");
    const tok = url.searchParams.get("t");

    sessionMiddleware(req, {}, async () => {
      let authedUserId = null;

      // Bearer API-token path (?t=wn_...): native apps pass their personal
      // token as a query param since WebSocket/EventSource can't set headers.
      if (tok && tok.startsWith("wn_")) {
        const user = resolveApiToken(tok);
        if (user) authedUserId = user.id;
      }

      // Dev-token path (?t= == config.devToken): log in as dev-user. Used by
      // automated E2E (and dev). Same privilege model as the REST dev-token.
      if (!authedUserId && config.devToken && tok && tok === config.devToken) {
        let devUser = db.prepare("SELECT id FROM users WHERE id = ?").get("dev-user");
        if (!devUser) {
          db.prepare("INSERT INTO users (id, name) VALUES (?, ?)").run("dev-user", config.devUserName || "Dev");
        }
        authedUserId = "dev-user";
      } else if (req.session?.passport?.user) {
        authedUserId = req.session.passport.user;
      }

      if (!authedUserId) {
        socket.destroy();
        return;
      }

      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId) {
        socket.destroy();
        return;
      }

      const session = getSession(sessionId);
      if (!session) {
        socket.destroy();
        return;
      }

      const user = db.prepare("SELECT * FROM users WHERE id = ?").get(authedUserId);
        if (!user || session.owner_id !== user.id) {
          socket.destroy();
          return;
        }

      wss.handleUpgrade(req, socket, head, async (ws) => {
        // The 101 handshake response can still be in flight on the underlying
        // socket right when this callback runs — sending/closing immediately
        // raced real browsers (though not Node's own `ws` client) into
        // "Connection closed before receiving a handshake response", so the
        // graceful-rejection payload below never arrived. Waiting for the
        // 'open' readyState guarantees the handshake has actually completed
        // client-side first.
        if (ws.readyState !== ws.OPEN) {
          await new Promise((resolve) => ws.once("open", resolve));
        }

        // Acquire the SERVER-OWNED pty for this session. getTerminal reclaims
        // any chat rpc agent first (mutual exclusion), then returns the live
        // pty — spawning one only if none exists yet.
        let handle;
        try {
          // The interactive PTY can execute arbitrary commands and pi turns,
          // but it currently has no provider-side token reservation or durable
          // usage meter. Do not let a hosted org bypass its trial/subscription
          // limits through this side channel. Self-hosted terminals are
          // unaffected; re-enable hosted terminals only with a reservation and
          // execution accounting model that is at least as strict as chat.
          const space = getSpace(session.space_id);
          if (billingEnabled && space?.org_id) {
            const err = new Error("Terminal is temporarily unavailable on Waynode Cloud while usage safeguards are being completed. Use Chat for metered agent work.");
            err.terminalDisabled = true;
            throw err;
          }
          handle = await getTerminal(session);
        } catch (err) {
          // Mirror the existing terminalDisabled (sandboxed-mode) pattern:
          // tag the payload so the frontend can distinguish "agent busy, try
          // again shortly" from "sandboxed mode, terminal permanently
          // unavailable" instead of treating both as the same hard error.
          if (err.agentBusy) {
            ws.send(JSON.stringify({ type: "error", agentBusy: true, message: err.message }), () => ws.close());
          } else if (err.terminalDisabled) {
            ws.send(JSON.stringify({ type: "error", terminalDisabled: true, message: err.message }), () => ws.close());
          } else {
            ws.send(JSON.stringify({ type: "error", message: err.message }), () => ws.close());
          }
          return;
        }

        const wsId = randomUUID().slice(0, 8);
        console.log(`[terminal:${wsId}] attached to pty for session ${sessionId}`);

        // Attach this WS as a subscriber to the live pty. On attach the handle
        // replays recent output and forces a redraw.
        const detach = handle.attach((ev) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(ev));
        });

        ws.on("message", (msg) => {
          try {
            const parsed = JSON.parse(msg.toString());
            if (parsed.type === "input") {
              handle.input(parsed.data);
            } else if (parsed.type === "resize") {
              handle.resize(parsed.cols || 80, parsed.rows || 24);
            }
          } catch {}
        });

        ws.on("close", () => {
          // CRITICAL: only DETACH. The pty stays alive in AgentManager so that
          // closing the browser/navigating away does NOT kill the session —
          // reopening the tab re-attaches to the same live pty. Only a switch
          // back to chat (getAgent) or the idle reaper tears it down.
          console.log(`[terminal:${wsId}] detached (pty stays alive)`);
          detach();
        });
      });
    });
  });

  return wss;
}

export default router;
