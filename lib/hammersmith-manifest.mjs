import { basename, dirname, join, resolve } from "node:path";

const MUTATING_CHECK = "git diff --check && if [ -f package.json ]; then npm test --if-present && npm run build --if-present; fi";
const HOSTED_TASK_KEY = "space-repository";
const ENGINE_ALLOWLIST = new Set(["pi", "codex", "opencode", "grok"]);

export function deriveSelfHostedTaskLayout(repositoryPath) {
  if (typeof repositoryPath !== "string" || !repositoryPath) throw new TypeError("repository path required");
  const taskdir = resolve(repositoryPath);
  const taskKey = basename(taskdir);
  const workdir = dirname(taskdir);
  if (!taskKey || taskKey === "." || taskKey === ".." || resolve(join(workdir, taskKey)) !== taskdir) {
    throw new TypeError("repository path cannot be represented as a safe Hammersmith task directory");
  }
  return { workdir, taskKey, taskdir };
}

export function hostedTaskLayout() {
  return { workdir: "/workspace", taskKey: HOSTED_TASK_KEY, taskdir: `/workspace/${HOSTED_TASK_KEY}` };
}

function operationalSpec(jobDescription) {
  return [
    "You are operating directly in the Waynode Space repository mounted as your current task directory.",
    "Preserve existing message and goal behavior. Do not commit, push, rewrite Git history, or modify .git.",
    "Complete the user's job below, keep changes scoped to that job, and leave the repository ready for the server-owned check.",
    "",
    "--- USER JOB DESCRIPTION (VERBATIM) ---",
    jobDescription,
    "--- END USER JOB DESCRIPTION ---",
    "",
    "The server, not the user text, owns these operational boundaries and the verification command.",
  ].join("\n");
}

export function normalizeHammersmithEngine(value, { hosted = false } = {}) {
  if (hosted) return "pi";
  return ENGINE_ALLOWLIST.has(value) ? value : "pi";
}

export class ManifestFactory {
  constructor({ maxAttempts = 2, timeoutSeconds = 2400 } = {}) {
    this.maxAttempts = Math.max(1, Math.min(3, Number(maxAttempts) || 2));
    this.timeoutSeconds = Math.max(60, Math.min(3600, Number(timeoutSeconds) || 2400));
  }

  build({ jobId, jobDescription, workdir, taskKey = HOSTED_TASK_KEY, engine = "pi", mutating = true }) {
    if (typeof jobDescription !== "string" || !jobDescription.trim()) {
      throw new TypeError("job description required");
    }
    if (jobDescription.length > 100_000) throw new TypeError("job description is too long");
    if (typeof workdir !== "string" || !workdir) throw new TypeError("workdir required");
    if (typeof taskKey !== "string" || !taskKey || taskKey.includes("/") || taskKey.includes("\\") || [".", ".."].includes(taskKey)) {
      throw new TypeError("safe task key required");
    }
    if (!ENGINE_ALLOWLIST.has(engine)) throw new TypeError("unsupported Hammersmith engine");

    return {
      run_name: `waynode-${jobId}`,
      workdir,
      max_parallel: 1,
      worktrees: false,
      project: "Waynode Space",
      tasks: [{
        key: taskKey,
        engine,
        task_type: mutating ? "code-feature" : "probe",
        timeout_s: this.timeoutSeconds,
        max_attempts: this.maxAttempts,
        full_access: false,
        layout_policy: "flexible",
        owned_paths: [],
        forbidden_paths: [".git"],
        required_inputs: [],
        expected_outputs: [],
        // Hammersmith keeps raw worker logs in its orchestration workdir,
        // outside the repository task directory.
        expect_files: [],
        verified: mutating
          ? "The server-owned repository check found no whitespace errors and, when package.json exists, the declared npm tests and build passed."
          : "The server-owned check confirmed the repository remained unchanged.",
        spec: operationalSpec(jobDescription),
        check: mutating ? MUTATING_CHECK : "git diff --exit-code && git diff --cached --exit-code",
      }],
    };
  }

  serialize(input) {
    return JSON.stringify(this.build(input), null, 2) + "\n";
  }
}

export const hammersmithChecks = Object.freeze({ mutating: MUTATING_CHECK });
