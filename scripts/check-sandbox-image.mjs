import { readFileSync } from "node:fs";

const defaultPath = new URL("../sandbox/Dockerfile", import.meta.url);
const target = process.argv[2] || defaultPath;
const source = readFileSync(target, "utf8");

// LiteLLM/OpenAI-style keys have a strict machine format. Never print a
// matched value: CI logs must not become a second credential disclosure.
if (/sk-[A-Za-z0-9_-]{12,}/.test(source)) {
  throw new Error("Sandbox image source contains a literal API credential");
}

if (!source.includes('"apiKey": "$WAYNODE_LLM_KEY"')) {
  throw new Error("Sandbox provider apiKey must reference $WAYNODE_LLM_KEY");
}

console.log("Sandbox image credential check passed.");
