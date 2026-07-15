/** Safe, explicitly confirmed restoration of tracked Git changes. */
import { isAbsolute, relative, resolve, sep } from "node:path";
import { getStatus, runGit, withGitLock } from "./git-ops.mjs";

export const DISCARD_FILE_CONFIRMATION = "DISCARD TRACKED FILE";
export const DISCARD_ALL_CONFIRMATION = "DISCARD ALL TRACKED CHANGES";

function requestError(message, status = 400, tag) {
  const error = new Error(message);
  error.status = status;
  if (tag) error[tag] = true;
  return error;
}

function assertConfirmation(actual, expected) {
  if (actual !== expected) {
    throw requestError(`Confirmation must exactly match ${expected}.`, 400, "confirmationRequired");
  }
}

function assertSafeRepoPath(cwd, candidate) {
  if (typeof candidate !== "string" || !candidate || candidate.includes("\0")
    || candidate.includes("\n") || candidate.includes("\r") || candidate.includes("\t")
    || isAbsolute(candidate)) {
    throw requestError("A valid repository-relative file path is required.", 400, "invalidPath");
  }
  const root = resolve(cwd);
  const target = resolve(root, candidate);
  const rel = relative(root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw requestError("The file path must stay inside the repository.", 400, "invalidPath");
  }
  return candidate;
}

/** Restore one changed tracked path in both the index and worktree. */
export function discardTrackedFile(cwd, { path, confirmation } = {}) {
  assertConfirmation(confirmation, DISCARD_FILE_CONFIRMATION);
  const safePath = assertSafeRepoPath(cwd, path);
  return withGitLock(cwd, () => {
    const entry = getStatus(cwd).files.find((file) => file.path === safePath);
    if (!entry) throw requestError("That path has no tracked change to discard.", 409, "noTrackedChange");
    if (entry.status === "untracked") {
      throw requestError("Untracked files are preserved and cannot be deleted here.", 409, "untrackedPreserved");
    }
    if (!new Set(["modified", "deleted"]).has(entry.status)) {
      throw requestError(
        `A ${entry.status} path cannot be discarded individually without risking other work.`,
        409,
        "unsupportedTrackedState",
      );
    }
    runGit(cwd, ["restore", "--source=HEAD", "--staged", "--worktree", "--", safePath], {
      literalPathspecs: true,
    });
    return { discarded: 1, path: safePath, restoredPaths: [safePath] };
  });
}

/** Restore safe tracked edits; preserve added, renamed, copied, conflicted, and untracked state. */
export function discardAllTracked(cwd, { confirmation } = {}) {
  assertConfirmation(confirmation, DISCARD_ALL_CONFIRMATION);
  return withGitLock(cwd, () => {
    const before = getStatus(cwd).files;
    const tracked = before.filter((file) => file.status !== "untracked");
    const untracked = before.filter((file) => file.status === "untracked");
    if (!tracked.length) return { discarded: 0, preservedUntracked: untracked.length };
    const restorable = tracked.filter((file) => new Set(["modified", "deleted"]).has(file.status));
    if (restorable.length) {
      runGit(cwd, [
        "restore", "--source=HEAD", "--staged", "--worktree", "--",
        ...restorable.map((file) => file.path),
      ], { literalPathspecs: true });
    }
    return {
      discarded: restorable.length,
      restoredFiles: restorable.length,
      preservedUnsupported: tracked.length - restorable.length,
      preservedUntracked: untracked.length,
    };
  });
}
