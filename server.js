import express from "express";
import session from "express-session";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { createServer } from "http";
import { config } from "./lib/config.mjs";
import { passport } from "./lib/auth.mjs";
import { ensureGitAskpass } from "./lib/git-creds.mjs";
import { ensurePiProviderConfig } from "./lib/pi-config.mjs";
import { attachTerminalWebSocket } from "./routes/terminal.js";

import authRoutes from "./routes/auth.js";
import spacesRoutes from "./routes/spaces.js";
import sessionsRoutes from "./routes/sessions.js";
import secretsRoutes from "./routes/secrets.js";
import settingsRoutes from "./routes/settings.js";
import filesRoutes from "./routes/files.js";
import reposRoutes from "./routes/repos.js";
import adminRoutes from "./routes/admin.js";
import orgRoutes from "./routes/orgs.js";
import resolveRoutes from "./routes/resolve.js";
import gitRoutes from "./routes/git.js";
import apiTokenRoutes from "./routes/api-tokens.js";
import billingRoutes, { webhookRouter as billingWebhookRoutes } from "./routes/billing.js";

const app = express();
app.set("trust proxy", 1);
const server = createServer(app);

// Write the portable git credential helper (provider-aware token routing).
ensureGitAskpass();

// Write pi's fornace LLM provider config from runtime env (LLM_API_KEY),
// never baked into the Docker image — see lib/pi-config.mjs.
ensurePiProviderConfig();

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      // Inline styles: the boot-screen <style> block in index.html + React
      // inline style attributes. Styles are not an XSS escalation vector.
      styleSrc: ["'self'", "'unsafe-inline'"],
      // Avatars come from GitHub/GitLab over https; allow data: URIs too.
      imgSrc: ["'self'", "data:", "https:", "http:"],
      fontSrc: ["'self'"],
      // All API, SSE (EventSource) and WebSocket traffic is same-origin.
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: "Too many auth attempts, try again later" },
});

app.use("/auth/", authLimiter);
app.use("/api/", apiLimiter);
app.use(cors({ origin: config.appUrl, credentials: true }));

const sessionMiddleware = session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: config.isProd,
    sameSite: config.isProd ? "lax" : "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
});

app.use(cors({ origin: config.appUrl, credentials: true }));

// Stripe webhook needs the raw, untouched request body for signature
// verification — must be mounted BEFORE express.json() and scoped to this
// exact path only (raw parsing must not swallow the body of every other
// route). No-ops with 404 when billing isn't configured (routes/billing.js).
app.use((req, res, next) => {
  if (req.path === "/api/billing/webhook") return express.raw({ type: "application/json" })(req, res, next);
  next();
}, billingWebhookRoutes);

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
app.use(reposRoutes);
app.use(adminRoutes);
app.use(orgRoutes);
app.use(resolveRoutes);
app.use(gitRoutes);
app.use(apiTokenRoutes);
app.use(billingRoutes);

// Model listing endpoint
app.get("/api/models", (req, res) => {
  const models = [
    { id: "fornace-fast", name: "Fornace Fast", desc: "Quick responses, lower cost" },
    { id: "fornace-reasoning", name: "Fornace Reasoning", desc: "Balanced quality and speed" },
    { id: "fornace-max", name: "Fornace Max", desc: "Best quality, slower" },
    { id: "fornace-vision", name: "Fornace Vision", desc: "Image understanding" },
    { id: "glm-5.2-fast", name: "GLM 5.2 Fast", desc: "Zhipu GLM fast" },
    { id: "glm-5.2-reasoning", name: "GLM 5.2 Reasoning", desc: "Zhipu GLM reasoning" },
    { id: "glm-5.2-max", name: "GLM 5.2 Max", desc: "Zhipu GLM max quality" },
    { id: "qwen-flash", name: "Qwen Flash", desc: "Alibaba Qwen fast" },
  ];
  res.json({ models, configured: !!(config.llm.baseUrl && config.llm.apiKey) });
});

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
  console.error("[error]", err.message, err.stack);
  res.status(err.status || 500).json({ error: err.message || "Internal server error" });
});

server.listen(config.port, () => {
  console.log(`Waynode AI listening on :${config.port} (${config.nodeEnv})`);
  console.log(`  Repos: ${config.reposDir}`);
  console.log(`  DB:    ${config.dbPath}`);
});
