# Waynode Cloud launch gate

Use this runbook before enabling paid hosting. It intentionally separates a
safe self-hosted install from an explicit Waynode Cloud deployment.

## Do not deploy over a dirty host

The serving host must have a backed-up, reconciled working tree and must use
the same compose topology as CI. A public `200` is not proof that the image
just built is the image serving Waynode.

Before deployment, record the current tree and container image, then either
preserve its patch for manual reconciliation or obtain explicit approval to
replace it. Never use `git reset --hard` or rsync to erase unknown production
changes.

## Hosted environment

Only the serving host's root-owned `.env` may contain these values (mode
`0600`; never commit them or put them in frontend builds):

```dotenv
WAYNODE_DEPLOYMENT=hosted
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_STARTER=price_...
STRIPE_PRICE_PRO=price_...
STRIPE_PRICE_TEAM=price_...
```

All existing runtime settings must remain present: HTTPS `APP_URL`, session and
encryption secrets, OAuth credentials, and the LLM endpoint/key. Leaving any
Stripe value out keeps web billing disabled. Self-hosted operators should omit
all of the variables above.

## Stripe verification

1. Ensure exactly three configured recurring monthly prices map to Starter,
   Pro, and Team.
2. Configure `https://waynode.fornace.net/api/billing/webhook` with the
   subscription lifecycle events handled by `lib/billing.mjs`.
3. Confirm `GET /api/billing/enabled` returns `{"enabled":true}`.
4. Run an isolated checkout, deliver its signed webhook, then verify the
   organization plan is derived from the configured price ID—not metadata.
5. Verify trial expiry, cancellation, duplicate delivery, stale delivery, seat
   limit, storage limit, and token limit before accepting real customers.

## App Store gate

Keep `WAYNODE_APP_STORE_ENABLED` unset. It may only be enabled after Apple JWS
verification, bundle/product allowlists, notification validation, and sandbox
end-to-end tests are implemented. The current App Store endpoints intentionally
record unverified payloads without granting entitlement.

## Production E2E

Use the isolated browser REST runner described in `e2e/README.md`. Give its
dev/test user a dedicated organization, space, active entitlement, and bounded
test fixture. Rotate or remove the production dev bypass after automated
testing; do not use a shared customer workspace for browser E2E.
