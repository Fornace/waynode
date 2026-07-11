import { Router } from "express";
import { requireAuth } from "../lib/auth.mjs";
import { isOrgMember } from "../lib/orgs.mjs";
import { appStoreEnabled } from "../lib/config.mjs";
import {
  createAppAccountToken,
  getAppStoreEntitlement,
  recordUnverifiedNotification,
  submitUnverifiedTransaction,
} from "../lib/app-store.mjs";

const router = Router();

// Keep this whole ingress surface inert until Apple JWS verification is
// configured and independently tested. This avoids turning unverified payload
// storage into an unauthenticated database-amplification endpoint on either
// self-hosted or ordinary hosted Stripe deployments.
router.use((req, res, next) => {
  const isAppStoreRoute =
    req.path.startsWith("/api/app-store/") ||
    (req.path.startsWith("/api/orgs/") && req.path.includes("/app-store/"));
  if (!appStoreEnabled && isAppStoreRoute) {
    return res.status(404).json({ error: "App Store billing is not configured on this deployment" });
  }
  next();
});

function requireOrgAdmin(req, res, next) {
  const member = isOrgMember(req.params.orgId, req.user.id);
  if (!member || member.role !== "admin") return res.status(403).json({ error: "Admin required" });
  next();
}

// Only an organization admin may obtain the stable token used to bind native
// purchases. It is intentionally generated server-side, never accepted from
// a client, and is safe to request repeatedly.
router.post("/api/orgs/:orgId/app-store/account-token", requireAuth, requireOrgAdmin, (req, res) => {
  const appAccountToken = createAppAccountToken(req.params.orgId, req.user.id);
  res.status(201).json({ appAccountToken });
});

router.get("/api/orgs/:orgId/app-store/entitlement", requireAuth, requireOrgAdmin, (req, res) => {
  res.json(getAppStoreEntitlement(req.params.orgId));
});

// Native clients may submit a StoreKit signed transaction for the server to
// verify later. 202 is intentional: receipt delivery is not proof of payment.
router.post("/api/orgs/:orgId/app-store/transactions", requireAuth, requireOrgAdmin, (req, res) => {
  try {
    const transaction = submitUnverifiedTransaction({
      orgId: req.params.orgId,
      signedTransactionInfo: req.body?.signedTransactionInfo,
      submittedBy: req.user.id,
    });
    res.status(202).json({ ...transaction, active: false });
  } catch (error) {
    res.status(error instanceof RangeError ? 413 : 400).json({ error: error.message });
  }
});

// Notifications are accepted idempotently for audit and later verification.
// A response here never acknowledges an entitlement: the payload has not yet
// been cryptographically verified against Apple's signing infrastructure.
router.post("/api/app-store/notifications", (req, res) => {
  try {
    const notification = recordUnverifiedNotification(req.body?.signedPayload);
    res.status(202).json({ received: true, verified: false, duplicate: notification.duplicate });
  } catch (error) {
    res.status(error instanceof RangeError ? 413 : 400).json({ error: error.message });
  }
});

export default router;
