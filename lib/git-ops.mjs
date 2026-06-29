/**
 * lib/git-ops.mjs — read + write git helpers for a space's working tree.
 *
 * Design notes (see the git-sidebar design discussion):
 *  - Every git invocation passes `--no-optional-locks` so the read poller never
 *    contends with pi's own writes on `.git/index.lock`. Write ops still take
 *    the real lock (that's correct — it serializes mutations).
 *  - `core.quotepath=false` so paths with spaces/unicode come through raw and
 *    match between `status` (porcelain=v2) and `diff --numstat`.
 *  - A per-space async mutex serializes user writes (commit/switch/create/pull)
 *    so a rapid double-submit can't race on the index lock.
 *  - The user is the OWNER of the repo. Nothing here hard-blocks on pi being
 *    busy; that's surfaced as `piBusy` in the snapshot for the UI to soft-warn.
 */
import { spawnSync } from "child_process";
import { gitConfigArgs } from "./git-identity.mjs";
import { credsEnvForCwd } from "./git-creds.mjs";

const NO_LOCK = "--no-optional-locks";

/** Run a git command in cwd. Throws on non-zero exit with stderr as message. */
function run(cwd, args, { maxBuffer = 20 * 1024 * 1024, configs = [], auth = false } = {}) {
  const confArgs = ["-c", "core.quotepath=false"];
  for (const c of configs) { confArgs.push("-c", c); }
  const env = auth ? { ...process.env, ...credsEnvForCwd(cwd) } : undefined;
  const r = spawnSync("git", ["-C", cwd, ...confArgs, NO_LOCK, ...args], {
    encoding: "utf8",
    maxBuffer,
    env,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    const msg = (r.stderr || "").trim() || (r.stdout || "").trim() || `git ${args[0]} exited ${r.status}`;
    const e = new Error(msg);
    e.gitExit = r.status;
    throw e;
  }
  return (r.stdout || "").trimEnd();
}

// ── Per-space write mutex ──
const locks = new Map(); // cwd -> Promise chain
function withLock(cwd, fn) {
  const prev = locks.get(cwd) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(cwd, next.catch(() => {}));
  return next;
}

// ── Reads ──

/** Branch + per-file status + ahead/behind. */
export function getStatus(cwd) {
  const out = run(cwd, ["status", "--porcelain=v2", "-b"]);
  let currentBranch = null;
  let upstream = null;
  let ahead = 0;
  let behind = 0;
  const files = [];

  for (const line of out.split("\n")) {
    if (!line) continue;
    if (line.startsWith("# branch.head ")) currentBranch = line.slice("# branch.head ".length);
    else if (line.startsWith("# branch.upstream ")) upstream = line.slice("# branch.upstream ".length);
    else if (line.startsWith("# branch.ab ")) {
      const m = line.slice("# branch.ab ".length).match(/\+(\d+) -(\d+)/);
      if (m) { ahead = +m[1]; behind = +m[2]; }
    } else if (line[0] === "?") {
      files.push({ path: line.slice(2), staged: "untracked", worktree: "untracked", status: "untracked" });
    } else if (line[0] === "u") {
      const parts = line.split("\t");
      files.push({ path: parts[parts.length - 1], staged: "conflict", worktree: "conflict", status: "conflict" });
    } else if (line[0] === "1" || line[0] === "2") {
      // type 1: "1 XY sub mH mI mW hH hI path"        (8 fixed fields, then path)
      // type 2: "2 XY sub mH mI mW hH hI score path\torig" (rename)
      // core.quotepath=false leaves spaces in paths RAW (not quoted), so we
      // must rejoin every field after the fixed prefix (JS split() truncates,
      // it does NOT keep the remainder like Python).
      const parts = line.split(" ");
      const isRename = line[0] === "2";
      const xy = parts[1];
      let pathField = parts.slice(isRename ? 9 : 8).join(" ");
      const tabIdx = pathField.indexOf("\t"); // rename: "newpath\toldpath"
      if (tabIdx >= 0) pathField = pathField.slice(0, tabIdx);
      const x = xy[0];
      const y = xy[1];
      files.push({
        path: pathField,
        staged: x === " " ? " " : x,
        worktree: y === " " ? " " : y,
        status: classify(x, y),
      });
    }
  }

  return {
    currentBranch,
    upstream,
    ahead,
    behind,
    detached: currentBranch === "(detached)",
    hasUncommittedChanges: files.length > 0,
    files: annotateStats(cwd, files),
  };
}

function classify(x, y) {
  if (x === "?" || y === "?") return "untracked";
  if (x === "A" || y === "A") return "added";
  if (x === "D" || y === "D") return "deleted";
  if (x === "R" || y === "R") return "renamed";
  if (x === "C" || y === "C") return "copied";
  if (x === "U" || y === "U") return "conflict";
  return "modified";
}

/** Attach +adds/-dels per file from `git diff --numstat HEAD` (vs last commit). */
function annotateStats(cwd, files) {
  const stats = new Map();
  try {
    const out = run(cwd, ["diff", "--numstat", "HEAD"]);
    for (const line of out.split("\n")) {
      if (!line) continue;
      const m = line.match(/^(-?\d+|-)\t(-?\d+|-)\t(.+)$/);
      if (m) stats.set(m[3], { additions: m[1] === "-" ? null : +m[1], deletions: m[2] === "-" ? null : +m[2] });
    }
  } catch { /* no HEAD yet (empty repo) — leave stats null */ }
  return files.map((f) => {
    const s = stats.get(f.path);
    return { ...f, additions: s?.additions ?? null, deletions: s?.deletions ?? null };
  });
}

/** Recent commits: {hash, shortHash, author, date, subject, body}. */
export function getCommits(cwd, n = 12) {
  const sep = "\x1f";
  const fmt = ["%H", "%h", "%an", "%cr", "%s"].join(sep);
  let out;
  try {
    out = run(cwd, ["log", `-n`, String(n), `--pretty=format:${fmt}`]);
  } catch {
    return []; // empty repo
  }
  return out.split("\n").filter(Boolean).map((line) => {
    const [hash, shortHash, author, date, subject] = line.split(sep);
    return { hash, shortHash, author, date, subject };
  });
}

/** Local + remote branches with metadata for categorization. */
export function getBranches(cwd) {
  const sep = "\x1f";
  const fmt = ["%(refname:short)", "%(objectname:short)", "%(committerdate:relative)", "%(upstream:short)"].join(sep);
  let out;
  try {
    out = run(cwd, ["for-each-ref", `--format=${fmt}`, "refs/heads", "refs/remotes"]);
  } catch {
    return { defaultBranch: null, branches: [] };
  }
  let defaultBranch = null;
  try {
    const sym = run(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    defaultBranch = sym.split("/").pop(); // "origin/main" -> "main"
  } catch { /* no origin HEAD — fall back below */ }

  const branches = out.split("\n").filter(Boolean).map((line) => {
    const [name, sha, date, upstream] = line.split(sep);
    const isRemote = name.startsWith("origin/") || name.includes("/");
    return {
      name,
      shortName: name.replace(/^origin\//, ""),
      sha,
      date,
      upstream,
      isRemote,
    };
  });

  if (!defaultBranch) {
    defaultBranch = branches.find((b) => b.name === "main" || b.name === "master")?.shortName || null;
  }
  return { defaultBranch, branches };
}

/** Inline diff text for a single file (vs HEAD for tracked, full for untracked). */
export function getFileDiff(cwd, path) {
  // Untracked files aren't in HEAD; show full content as "new file".
  return run(cwd, ["diff", "HEAD", "--", path], { maxBuffer: 5 * 1024 * 1024 });
}

// ── Full snapshot (one payload for the sidebar) ──

export function getSnapshot(cwd) {
  const status = getStatus(cwd);
  const { defaultBranch, branches } = getBranches(cwd);
  const commits = getCommits(cwd, 12);
  return {
    currentBranch: status.currentBranch,
    detached: status.detached,
    upstream: status.upstream,
    ahead: status.ahead,
    behind: status.behind,
    hasUncommittedChanges: status.hasUncommittedChanges,
    files: status.files,
    commits,
    branches: branches.map((b) => ({
      ...b,
      isDefault: b.shortName === defaultBranch,
    })),
    defaultBranch,
  };
}

// ── Writes ──

/** Commit an explicit list of files (never `git add -A`). */
export function commitSelected(cwd, { files, summary, description, identity }) {
  if (!summary?.trim()) throw new Error("Commit summary is required");
  if (!files?.length) throw new Error("No files selected");
  const cfg = gitConfigArgs(identity).filter((_, i) => i % 2 === 1); // ["user.name=..", "user.email=.."]
  return withLock(cwd, () => {
    run(cwd, ["add", "--", ...files], { configs: cfg });
    const args = ["commit", "-m", summary.trim()];
    if (description?.trim()) args.push("-m", description.trim());
    run(cwd, args, { configs: cfg });
    return { committed: files.length };
  });
}

/**
 * Switch branch.
 *  mode 'stash' — leave changes on the current branch (git stash), then checkout.
 *  mode 'carry' — checkout directly; git carries compatible changes, errors on conflict.
 *  mode 'clean' — tree is clean, just checkout.
 */
export function switchBranch(cwd, { branchName, mode }) {
  if (!branchName) throw new Error("branchName required");
  const target = branchName.replace(/^origin\//, "");
  return withLock(cwd, () => {
    if (mode === "stash") {
      run(cwd, ["stash", "push", "-u", "-m", `waynode: stashed before switching to ${target}`]);
    }
    // 'carry' and 'clean' both just checkout; git refuses if changes conflict.
    run(cwd, ["checkout", target]);
    return { switched: target, mode };
  });
}

/** Create + checkout a new branch from baseBranch (defaults to current). */
export function createBranch(cwd, { branchName, baseBranch }) {
  if (!branchName) throw new Error("branchName required");
  return withLock(cwd, () => {
    const args = ["checkout", "-b", branchName];
    if (baseBranch) args.push(baseBranch);
    run(cwd, args);
    return { created: branchName };
  });
}

/**
 * Pull from upstream. `identity` (optional) attributes any merge/rebase commit
 * to the acting user.
 *  mode 'ff-only' (default) — fast-forward only; throws {diverged:true} if
 *    local and remote have diverged, so the UI can offer merge/rebase.
 *  mode 'merge'  — create a merge commit (--no-rebase).
 *  mode 'rebase' — rebase local commits on top of upstream.
 * Returns { mode, output, conflicts? }.
 */
export function pull(cwd, { mode = "ff-only", identity } = {}) {
  const cfg = identity ? gitConfigArgs(identity).filter((_, i) => i % 2 === 1) : [];
  return withLock(cwd, () => {
    try {
      if (mode === "merge") {
        const out = run(cwd, ["pull", "--no-rebase", "--no-edit"], { configs: cfg, auth: true });
        return { mode, output: out };
      }
      if (mode === "rebase") {
        const out = run(cwd, ["pull", "--rebase"], { configs: cfg, auth: true });
        if (/CONFLICT|could not apply/i.test(out)) {
          const conflicts = run(cwd, ["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean);
          run(cwd, ["rebase", "--abort"]);
          return { mode, output: out, aborted: true, conflicts };
        }
        return { mode, output: out };
      }
      const out = run(cwd, ["pull", "--ff-only"], { configs: cfg, auth: true });
      return { mode: "ff-only", output: out };
    } catch (e) {
      if (/not possible to fast-forward/i.test(e.message)) {
        const err = new Error("The remote has diverged — pull would create a merge or rebase.");
        err.diverged = true;
        throw err;
      }
      throw e;
    }
  });
}

/**
 * Push the current branch to its upstream.
 *  setUpstream — `git push -u origin HEAD` (for branches with no upstream yet).
 * Throws {pushRejected} on non-fast-forward, {noUpstream} when unset.
 */
export function push(cwd, { setUpstream = false } = {}) {
  return withLock(cwd, () => {
    const args = ["push"];
    if (setUpstream) args.push("-u", "origin", "HEAD");
    try {
      run(cwd, args, { auth: true });
      return { pushed: true };
    } catch (e) {
      if (/non-fast-forward|fetch first|rejected/i.test(e.message)) {
        const err = new Error("Push rejected — the remote has commits you don't. Pull first.");
        err.pushRejected = true;
        throw err;
      }
      if (/has no upstream branch|no upstream/i.test(e.message)) {
        const err = new Error("This branch has no upstream. Set it and push to origin?");
        err.noUpstream = true;
        throw err;
      }
      throw e;
    }
  });
}

/**
 * Merge another branch into the current branch (git default: ff when possible).
 * `identity` attributes the merge commit to the acting user. On conflict,
 * aborts the merge and reports the conflicted files so the repo is never left
 * in a half-merged state the sidebar can't escape. Returns { merged } on
 * success or { aborted, conflicts } on conflict.
 */
export function mergeBranch(cwd, { branchName, identity }) {
  if (!branchName) throw new Error("branchName required");
  const target = branchName.replace(/^origin\//, "");
  const cfg = identity ? gitConfigArgs(identity).filter((_, i) => i % 2 === 1) : [];
  return withLock(cwd, () => {
    try {
      const out = run(cwd, ["merge", target, "-m", `Merge ${target}`], { configs: cfg });
      return { merged: target, output: out };
    } catch (e) {
      if (/conflict|automatic merge failed|merge conflict/i.test(e.message)) {
        let conflicts = [];
        try { conflicts = run(cwd, ["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean); } catch {}
        try { run(cwd, ["merge", "--abort"]); } catch {}
        return { aborted: true, conflicts, target };
      }
      throw e;
    }
  });
}
