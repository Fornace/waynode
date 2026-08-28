import { Router } from "express";
import { getAgentIfActive } from "./agent-manager.mjs";
import { SubmissionLedger } from "./agent-submissions.mjs";
import { resumeSession } from "./session-recovery.mjs";

/**
 * Live-state and manual-recovery routes. Inject auth/ownership from the main
 * sessions router so this module stays policy-free and independently small.
 */
export function createSessionRecoveryRouter({ requireAuth, ownSession }) {
  const router = Router();

  router.get("/api/sessions/:sessionId/state", requireAuth, (req, res) => {
    const session = ownSession(req, res);
    if (!session) return;
    const handle = getAgentIfActive(session.id);
    const active = !!(handle && handle.streaming);
    res.json({
      active,
      done: !active,
      submissions: handle?.getSubmissionSnapshot?.() || [],
      interrupted: active ? [] : SubmissionLedger.recoverableRows(session.id),
    });
  });

  router.post("/api/sessions/:sessionId/resume", requireAuth, async (req, res) => {
    const session = ownSession(req, res);
    if (!session) return;
    const handle = getAgentIfActive(session.id);
    if (handle?.streaming) return res.status(409).json({ error: "A turn is already running" });
    const rows = SubmissionLedger.recoverableRows(session.id);
    if (rows.length === 0) return res.status(404).json({ error: "Nothing to resume" });
    res.json({ ok: await resumeSession(session, rows[0], { reason: "manual" }), submissionId: rows[0].id });
  });

  return router;
}
