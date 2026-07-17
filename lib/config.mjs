import dotenv from "dotenv";
dotenv.config();

const required = ["SESSION_SECRET", "ENCRYPTION_KEY"];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`FATAL: ${key} is required. Check your .env file.`);
    process.exit(1);
  }
}

export const config = {
  port: parseInt(process.env.PORT || "3000", 10),
  nodeEnv: process.env.NODE_ENV || "development",
  isProd: process.env.NODE_ENV === "production",
  revision: process.env.WAYNODE_REVISION || "development",

  sessionSecret: process.env.SESSION_SECRET,
  encryptionKey: process.env.ENCRYPTION_KEY,
  appUrl: process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`,

  dataDir: process.env.DATA_DIR || "./data",
  reposDir: `${process.env.DATA_DIR || "./data"}/repos`,
  dbPath: `${process.env.DATA_DIR || "./data"}/waynode.db`,
  // Portable git credential helper: git invokes this to get the right token
  // for the space's provider (GitHub/GitLab). Written at startup.
  gitAskpassPath: `${process.env.DATA_DIR || "./data"}/git-askpass.sh`,

  github: {
    clientId: process.env.GITHUB_CLIENT_ID || "",
    clientSecret: process.env.GITHUB_CLIENT_SECRET || "",
  },

  gitlab: {
    clientId: process.env.GITLAB_CLIENT_ID || "",
    clientSecret: process.env.GITLAB_CLIENT_SECRET || "",
    baseUrl: process.env.GITLAB_BASE_URL || "https://gitlab.com",
  },

  pi: {
    defaultModel: process.env.PI_DEFAULT_MODEL || "fornace-fast",
    defaultProvider: process.env.PI_DEFAULT_PROVIDER || "fornace",
  },

  llm: {
    baseUrl: process.env.LLM_BASE_URL || "http://fornace-llm:4000",
    apiKey: process.env.LLM_API_KEY || "",
    // Hosted microVMs may receive only this separately provisioned,
    // model/rate-limited virtual key. Never set this to the gateway admin key.
    sandboxRuntimeKey: process.env.WAYNODE_SANDBOX_LLM_KEY || "",
    model: process.env.LLM_MODEL || "fornace-fast",
  },

  devToken: process.env.DEV_AUTH_TOKEN || "",
  devUserName: process.env.DEV_USER_NAME || "Developer",

  // Sandboxed chat streaming (EXPERIMENTAL, off by default): taps
  // Sandbox.logStream({follow:true}) concurrently with the in-flight
  // execWith(...).tty(true) call in lib/pi-runner.mjs, to deliver output
  // incrementally instead of only after the whole turn completes. This is
  // UNVERIFIED against real hardware — see the long comment above
  // SandboxedAgentHandle in lib/agent-manager.mjs and docs/TASKS.md E14 for
  // the full trail of what's confirmed-by-reading-source vs. assumed. Kept
  // behind a flag so a bad interaction with the tty exec session can never
  // regress the default (already-working) whole-response behavior — flip
  // WAYNODE_SANDBOX_STREAM=1 only on a host with real KVM to try it, and be
  // ready to flip it back if it misbehaves.
  sandboxStreamEnabled: process.env.WAYNODE_SANDBOX_STREAM === "1",

  // Billing is deliberately opt-in twice. A Stripe key alone must never turn
  // a self-hosted install into a hosted, billable service (environment
  // inheritance mistakes happen). Only a deployment explicitly labelled
  // "hosted" can activate these routes.
  deployment: process.env.WAYNODE_DEPLOYMENT || "self-hosted",

  hammersmith: {
    executable: process.env.HAMMERSMITH_BIN || "hammersmith",
    jobDir: `${process.env.DATA_DIR || "./data"}/hammersmith`,
    maxAttempts: 2,
    timeoutSeconds: 2400,
  },

  // Hosted billing. Every field defaults to empty/undefined, and
  // lib/billing.mjs no-ops (or throws a clear "billing not configured" error
  // on write paths) unless this is an explicit hosted deployment with a
  // complete Stripe configuration. Self-host images ship with none of this
  // set, so the Billing UI stays hidden and nothing here is ever required to
  // boot.
  //
  // Fill these in from the real Stripe Dashboard (test or live mode) to turn
  // billing on:
  //   STRIPE_SECRET_KEY      — sk_test_... / sk_live_...
  //   STRIPE_WEBHOOK_SECRET  — whsec_... (Dashboard → Webhooks → your endpoint)
  //   STRIPE_PRICE_STARTER / STRIPE_PRICE_PRO / STRIPE_PRICE_TEAM
  //                          — price_... ids for each recurring monthly Price
  //                            (see docs/PRICING.md for the tier definitions)
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || "",
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",
    priceIds: {
      starter: process.env.STRIPE_PRICE_STARTER || "",
      pro: process.env.STRIPE_PRICE_PRO || "",
      team: process.env.STRIPE_PRICE_TEAM || "",
    },
  },
};

// True only for an explicitly hosted deployment with every key needed for a
// usable Checkout flow. Do not loosen this to just a secret key: a leaked or
// inherited key must not accidentally make a self-host instance bill users.
export const billingEnabled = config.deployment === "hosted"
  && !!config.stripe.secretKey
  && !!config.stripe.webhookSecret
  && Object.values(config.stripe.priceIds).every(Boolean);

// App Store ingestion is a separate, deliberately disabled surface. A hosted
// Stripe setup alone must not start accepting unauthenticated Apple webhook
// payloads before the production verifier and notification credentials exist.
export const appStoreEnabled = config.deployment === "hosted"
  && process.env.WAYNODE_APP_STORE_ENABLED === "1";
