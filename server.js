import express from "express";
import session from "express-session";
import cookieParser from "cookie-parser";
import cors from "cors";
import { createServer } from "http";
import { config } from "./lib/config.mjs";
import { passport } from "./lib/auth.mjs";
import { attachTerminalWebSocket } from "./routes/terminal.js";

import authRoutes from "./routes/auth.js";
import spacesRoutes from "./routes/spaces.js";
import sessionsRoutes from "./routes/sessions.js";
import secretsRoutes from "./routes/secrets.js";
import settingsRoutes from "./routes/settings.js";
import filesRoutes from "./routes/files.js";

const app = express();
const server = createServer(app);

const sessionMiddleware = session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: config.isProd,
    sameSite: config.isProd ? "none" : "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
});

app.use(cors({ origin: config.appUrl, credentials: true }));
app.use(express.json({ limit: "10mb" }));
app.use(cookieParser());
app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());

app.use(authRoutes);
app.use(spacesRoutes);
app.use(sessionsRoutes);
app.use(secretsRoutes);
app.use(settingsRoutes);
app.use(filesRoutes);

if (config.isProd) {
  const { existsSync } = await import("fs");
  const distPath = "./frontend/dist";
  if (existsSync(distPath)) {
    app.use(express.static(distPath));
    app.use((req, res, next) => {
      if (req.path.startsWith("/api/") || req.path.startsWith("/auth/") || req.path.startsWith("/ws/")) {
        return next();
      }
      res.sendFile("index.html", { root: distPath });
    });
  }
}

attachTerminalWebSocket(server, sessionMiddleware);

app.use((err, req, res, next) => {
  console.error("[error]", err.message);
  res.status(err.status || 500).json({ error: err.message || "Internal server error" });
});

server.listen(config.port, () => {
  console.log(`Waynode AI listening on :${config.port} (${config.nodeEnv})`);
  console.log(`  Repos: ${config.reposDir}`);
  console.log(`  DB:    ${config.dbPath}`);
});
