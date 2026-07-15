# Waynode Cloud launch gate

Use this runbook before enabling paid hosting. It intentionally separates a
safe self-hosted install from an explicit Waynode Cloud deployment.

## Legal identity and counsel gate — blocks charging customers

The public trust pages intentionally identify the operator only by the known
public trading name **Fornace**, Italy, and `info@fornacestudio.com`. Do not
enable paid checkout or collect a customer charge until all of the following
have been supplied from authoritative business records and reviewed in the
rendered purchase flow:

- the registered legal operator identity and geographic postal address;
- VAT/tax registration details and invoice treatment, where applicable;
- counsel review of the Privacy notice, Terms, EU withdrawal/refund workflow,
  checkout consent language, processor list, and international-transfer basis;
- a tested support path for cancellation, withdrawal, privacy requests, and
  security reports; and
- confirmation that the exact price, currency, taxes, term, renewal, trial,
  cancellation, and withdrawal information appears before purchase.

No placeholder company number, registered address, VAT number, certification,
SLA, or automatic withdrawal exception may be inferred from the code or added
as marketing copy. This is a pre-charge blocker even when Stripe is technically
configured and readiness otherwise passes.

## Immutable release and source reconciliation

CI packages the exact `GITHUB_SHA`; it does not pull a moving branch on the
server. The server and sandbox images carry that revision in the OCI
`org.opencontainers.image.revision` label, and Compose injects the same value
into the running service. Verify provenance through:

```bash
curl --fail https://waynode.fornace.net/api/health/version
curl --fail https://waynode.fornace.net/api/health/ready
docker inspect waynode \
  --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}'
```

The version response and image label must identify the requested revision, and
public readiness must pass. Readiness intentionally returns only a boolean so
the public status surface does not disclose dependency or topology detail. A
generic public `200` is not release verification.

The serving host must have a backed-up, reconciled source tree and use the same
Compose topology as CI. `.waynode-revision` records the deployed revision and
`.waynode-source.sha256` records a deterministic digest of deployable source.
Deployment stops before overwrite when the image label, revision marker,
recorded digest, and live source disagree. Reconcile the change intentionally;
do not edit deployed source in place.

The workflow permits the documented legacy bootstrap only when no prior image
revision exists. It preserves the complete legacy source before accepting that
one-time transition. Never use `git reset --hard` or ad-hoc rsync to erase
unknown production changes.

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

`DEV_AUTH_TOKEN` must be absent. Automated bypass-token browser tests run only
against non-production. The deployment workflow removes a historic value and
fails readiness if the replacement container still exposes one.

The host-specific Compose file binds application HTTP to `127.0.0.1`; nginx on
the same host is the only public origin. Both Docker and the deployment check
`/api/health/ready`, which includes SQLite/data access and hosted KVM, OAuth,
sandbox-credential, and billing prerequisites.

Deployment remains inside its rollback transaction until the public HTTPS
version and readiness endpoints pass. A failure restores the matching old
source, exact environment, data, server image, and sandbox image. An incomplete
rollback leaves Waynode stopped for operator recovery instead of starting a
mixed-version service. See [Backup and recovery](BACKUP-RECOVERY.md).

Install and prove the backup schedule in [Backup and recovery](BACKUP-RECOVERY.md)
before accepting customer work. A pre-deploy backup is not a substitute for
encrypted off-host retention and a scheduled restore drill.

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

App Store commerce remains a release blocker, not a completed integration. The
iPhone and iPad app must remain read-only for server plan/status and must not
show Stripe checkout, billing-portal, or external purchase links. Enabling an
external offer in EU storefronts requires Apple's External Purchase Link
Entitlement, required StoreKit APIs, and transaction reporting; otherwise ship
  a compliant, server-verified StoreKit purchase flow. Native account deletion
  is implemented with typed confirmation and a fresh, nonce-bound OAuth grant;
  release still requires signed-device verification against production OAuth on
  iPhone, iPad, and Mac. The inert App Store routes satisfy none of the commerce
  requirements above.

## Production E2E

Use the isolated browser REST runner described in `e2e/README.md` against
staging. Production smoke testing uses real OAuth and a dedicated organization,
space, active entitlement, and bounded fixture. Do not use a shared customer
workspace or configure a production bypass for browser E2E.
