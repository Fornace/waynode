import { config } from "./config.mjs";
import db from "./db.mjs";

export const TRIAL_DAYS = 15;

/** Must be called inside the organization-creation transaction. */
export function claimHostedTrial(userId, orgId) {
  if (config.deployment !== "hosted") return false;
  const result = db.prepare(`
    INSERT OR IGNORE INTO hosted_trial_claims (user_id, org_id, started_at, ends_at)
    VALUES (?, ?, datetime('now'), datetime('now', '+15 days'))
  `).run(userId, orgId);
  return result.changes === 1;
}

function parseSqliteDate(value) {
  if (!value) return null;
  const normalized = value.includes(" ") ? `${value.replace(" ", "T")}Z` : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function getOrgTrialWindow(orgId) {
  const row = db.prepare(`
    SELECT started_at, ends_at FROM hosted_trial_claims
    WHERE org_id = ? ORDER BY started_at ASC LIMIT 1
  `).get(orgId);
  if (!row) return { startsAt: null, endsAt: null };
  return { startsAt: parseSqliteDate(row.started_at), endsAt: parseSqliteDate(row.ends_at) };
}
