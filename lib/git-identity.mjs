/**
 * lib/git-identity.mjs — resolve a user's git identity for attributing commits.
 *
 * CRITICAL invariant: the human is ALWAYS credited, never a bot.
 *  - Sidebar commits: per-commit `-c user.name/email` flags from req.user.
 *  - pi commits (delegated merges): GIT_AUTHOR and GIT_COMMITTER env vars set
 *    from the SESSION OWNER (the delegating human), so pi's work is attributed
 *    to the person who delegated it. The repo is never configured to a fixed
 *    identity, because that would misattribute other members.
 *  - Container global git config ("Waynode" / fornace noreply) exists only as a
 *    bare-commit safety net; it should never win over a real user.
 *
 * Email fallback chain (GitHub/GitLab don't always share a primary email):
 *   user.email → {github_id}+{login}@users.noreply.github.com →
 *   waynode-{userid}@waynode.fornace.net
 * The GitHub noreply form links commits back to the account without exposing a
 * real address; the fornace form is the always-valid last resort.
 */
import db from "./db.mjs";

export const FALLBACK_NAME = "Waynode User";
export const FALLBACK_EMAIL_DOMAIN = "waynode.fornace.net";

/**
 * Resolve {name, email} for a user row (the one stored from OAuth).
 * Pure function — no DB lookup. Callers pass the row from req.user / a query.
 */
export function identityForUser(user) {
  if (!user) {
    return { name: "Waynode", email: `waynode@${FALLBACK_EMAIL_DOMAIN}` };
  }
  const name = (user.name && user.name.trim()) || FALLBACK_NAME;
  const email = resolveEmail(user);
  return { name, email };
}

function resolveEmail(user) {
  if (user.email && user.email.trim()) return user.email.trim();
  // GitHub noreply:  {id}+{login}@users.noreply.github.com
  if (user.github_id) {
    const login = (user.name || "").trim().replace(/\s+/g, "-").toLowerCase() || "user";
    return `${user.github_id}+${login}@users.noreply.github.com`;
  }
  // GitLab has no universal noreply; fall through to the fornace address.
  return `waynode-${user.id}@${FALLBACK_EMAIL_DOMAIN}`;
}

/**
 * Resolve identity for a user ID (DB lookup). Used by the pi env builder where
 * we only have the session owner_id.
 */
export function identityForUserId(userId) {
  if (!userId) return identityForUser(null);
  const user = db.prepare("SELECT id, name, email, github_id, gitlab_id FROM users WHERE id = ?").get(userId);
  return identityForUser(user);
}

/** git `-c` config args for a one-shot command, e.g. ["-c","user.name=X","-c","user.email=Y"]. */
export function gitConfigArgs(identity) {
  if (!identity) return [];
  return [
    "-c", `user.name=${identity.name}`,
    "-c", `user.email=${identity.email}`,
  ];
}
