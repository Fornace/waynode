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
    model: process.env.LLM_MODEL || "fornace-fast",
  },

  devToken: process.env.DEV_AUTH_TOKEN || "",
  devUserName: process.env.DEV_USER_NAME || "Developer",
};
