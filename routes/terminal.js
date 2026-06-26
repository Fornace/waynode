import { Router } from "express";
import { WebSocketServer } from "ws";
import { getSession } from "../lib/sessions.mjs";
import { getTerminal } from "../lib/agent-manager.mjs";
import { config } from "../lib/config.mjs";
import db from "../lib/db.mjs";
import { randomUUID } from "crypto";

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

    sessionMiddleware(req, {}, async () => {
      if (!req.session || !req.session.passport?.user) {
        socket.destroy();
        return;
      }

      const url = new URL(req.url, "http://localhost");
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

      const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.session.passport.user);
      if (!user || session.owner_id !== user.id) {
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, async (ws) => {
        // Acquire the SERVER-OWNED pty for this session. getTerminal reclaims
        // any chat rpc agent first (mutual exclusion), then returns the live
        // pty — spawning one only if none exists yet.
        let handle;
        try {
          handle = await getTerminal(session);
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", message: err.message }));
          ws.close();
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
