import { Router } from "express";
import { WebSocketServer } from "ws";
import { getSession } from "../lib/sessions.mjs";
import { runPiTerminal } from "../lib/pi-runner.mjs";
import db from "../lib/db.mjs";
import { randomUUID } from "crypto";

const router = Router();

export function attachTerminalWebSocket(server, sessionMiddleware) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    if (!req.url.startsWith("/ws/terminal")) return;

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
        let term;
        try {
          term = await runPiTerminal({ session });
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", message: err.message }));
          ws.close();
          return;
        }

        const wsId = randomUUID().slice(0, 8);
        console.log(`[terminal:${wsId}] pi started for session ${sessionId}`);

        term.onData((data) => {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: "output", data }));
          }
        });

        term.onExit(({ exitCode }) => {
          console.log(`[terminal:${wsId}] pi exited (${exitCode})`);
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: "exit", exitCode }));
            ws.close();
          }
        });

        ws.on("message", (msg) => {
          try {
            const parsed = JSON.parse(msg.toString());
            if (parsed.type === "input") {
              term.write(parsed.data);
            } else if (parsed.type === "resize") {
              term.resize(parsed.cols || 80, parsed.rows || 24);
            }
          } catch {}
        });

        ws.on("close", () => {
          console.log(`[terminal:${wsId}] ws closed, killing pi`);
          try { term.kill(); } catch {}
        });
      });
    });
  });

  return wss;
}

export default router;
