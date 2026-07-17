import { Router } from "express";
import { WebSocketServer } from "ws";
import { getSession } from "../lib/sessions.mjs";
import { getTerminal } from "../lib/agent-manager.mjs";
import { config } from "../lib/config.mjs";
import db from "../lib/db.mjs";
import { randomUUID } from "crypto";
import { resolveApiToken } from "../lib/auth.mjs";
import { getSpace } from "../lib/spaces.mjs";
import { billingEnabled, checkQuota } from "../lib/billing.mjs";
import { enforceTerminalAvailability } from "../lib/pi-runner.mjs";
import { assertHammersmithLeaseAvailable } from "../lib/hammersmith-lease.mjs";

const router = Router();

let allowedOrigin = null;
try {
  if (config.appUrl) allowedOrigin = new URL(config.appUrl).origin;
} catch {}

export function terminalBillingRejection(session) {
  // Defense in depth only: getTerminal/enforceTerminalAvailability rejects
  // every hosted terminal before a PTY is acquired. Therefore there is no
  // hosted terminal lifecycle to reserve; self-host terminals bypass billing.
  if (!billingEnabled) return null;
  const space = getSpace(session.space_id);
  if (!space?.org_id) return null;
  const quota = checkQuota(space.org_id);
  if (!["active", "trialing"].includes(quota.status)) {
    return "This Waynode Cloud trial or subscription is not active. Ask an organization admin to update billing.";
  }
  if (quota.tokens.exceeded) {
    return "This organization has reached its monthly included agent usage. Ask an organization admin to update billing.";
  }
  return null;
}

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
    // automated E2E the same way those streams are. Native URLSession clients
    // use Authorization instead: URL query tokens leak into proxy access logs.
    const url = new URL(req.url, "http://localhost");
    const queryToken = url.searchParams.get("t");
    const authorization = req.headers.authorization || "";
    const bearerToken = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : null;
    const tok = bearerToken || queryToken;

    sessionMiddleware(req, {}, async () => {
      let authedUserId = null;

      // Bearer API-token path: native URLSession clients send an Authorization
      // header; the query form remains only for browser/dev compatibility.
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
          // Capability denial precedes billing and PTY acquisition so hosted
          // clients always receive the truthful deployment-level decision.
          enforceTerminalAvailability();
          assertHammersmithLeaseAvailable(session.space_id);
          const billingRejection = terminalBillingRejection(session);
          if (billingRejection) {
            const error = new Error(billingRejection);
            error.billingBlocked = true;
            throw error;
          }
          // getTerminal rejects hosted deployments before reclaiming chat or
          // starting a process. Interactive terminal stays self-hosted until
          // a broker can issue narrowly scoped, revocable guest credentials.
          handle = await getTerminal(session);
        } catch (err) {
          // Mirror the existing terminalDisabled (sandboxed-mode) pattern:
          // tag the payload so the frontend can distinguish "agent busy, try
          // again shortly" from "sandboxed mode, terminal permanently
          // unavailable" instead of treating both as the same hard error.
          if (err.billingBlocked) {
            ws.send(JSON.stringify({ type: "error", billingBlocked: true, message: err.message }), () => ws.close());
          } else if (err.hammersmithBusy) {
            ws.send(JSON.stringify({ type: "error", hammersmithBusy: true, message: err.message }), () => ws.close());
          } else if (err.agentBusy) {
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
