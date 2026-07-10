# App Store subscriptions: entitlement contract

This document is deliberately a contract, not a client-only implementation.
Waynode runs a hosted developer workspace: the thing being purchased is a
server-side organization entitlement, not a local feature. A successful
StoreKit transaction must therefore be verified and recorded by Waynode before
it changes server access.

## Current state (audited 2026-07-10)

- The iOS target has **no StoreKit dependency**, StoreKit configuration file,
  App Store product identifiers, or in-app purchase capability.
- `AuthStore` stores a Waynode bearer token in Keychain. That token identifies
  a *user*; `AppModel` loads the user's organizations and spaces.
- Hosted billing is organization-scoped in the service (`org_subscriptions`),
  whereas API tokens are user-scoped. A purchase must never be attached merely
  to whichever user is signed in when an asynchronous notification arrives.
- The existing native API surface only exposes account, organization, space,
  session, and token operations. It has no authoritative entitlement endpoint
  and no way to bind an App Store transaction to an organization.

**Decision:** do not add a Purchase button, `Transaction.currentEntitlements`,
or a `StoreKit` import yet. Those would produce a misleading local "paid"
state while the hosted service remains unable to grant, revoke, restore, or
support the entitlement.

## Required server contract before enabling StoreKit

The App Store routes are disabled by default, even on Waynode Cloud. Enable
`WAYNODE_APP_STORE_ENABLED=1` only after the JWS verifier, Apple key material,
bundle/product allowlist, and App Store Server Notification configuration are
all deployed and covered by sandbox tests. Storing a signed payload is not
verification and must never activate an entitlement.

All endpoints below are hosted-only and require an authenticated, active
organization administrator. They must remain absent or return `404` on
self-hosted deployments, just like Stripe billing.

| Endpoint | Purpose | Security invariant |
| --- | --- | --- |
| `POST /api/orgs/:orgId/app-store/purchase-intent` | Create a short-lived, single-use purchase intent and return a UUID `appAccountToken`. | Server generates and stores the token with `org_id`, requesting user, expiry, and unused status. The client never chooses an org ID in transaction metadata. |
| `POST /api/orgs/:orgId/app-store/transactions` | Submit StoreKit's verified transaction JWS after purchase or restore. | Verify JWS signature, bundle ID, environment, product ID, and the transaction's `appAccountToken`; persist a unique transaction ID before granting access. |
| `GET /api/orgs/:orgId/entitlement` | Return the server's current plan, status, source, renewal/expiry, and limits. | This is the only entitlement state the app renders as authoritative. |
| `POST /api/app-store/notifications` | Receive App Store Server Notifications V2. | Verify the signed payload and update the same transaction/subscription records idempotently. Never trust notification order or client state. |

The transaction table should retain at minimum: `transaction_id` (unique),
`original_transaction_id`, `web_order_line_item_id`, `product_id`,
`app_account_token`, `environment`, `signed_date`, `expires_date`,
`revocation_date`, `ownership_type`, `org_id`, and the signed JWS for audit.
Keep a separate immutable notification/event ledger keyed by Apple notification
UUID. This makes retries harmless and permits reconciliation.

## Organization mapping and plan policy

The purchase sheet must require an administrator to choose one organization
*before* purchase. The server creates the `appAccountToken` for that exact
organization; the native app passes it in StoreKit's purchase options.

- One active App Store subscription maps to one hosted organization.
- A transfer to another organization is a server-side support/admin operation,
  never a client-side "restore" action.
- App Store products must map through an allowlist held on the server, not
  client product display names. Match them to the same three hosted plan
  limits as Stripe (`starter`, `pro`, `team`).
- Do not combine Stripe and App Store subscriptions for one organization.
  An admin must cancel/expire one provider before activating the other, or use
  a deliberate migration workflow that preserves the later paid-through date.
- Trials are organization-level and are consumed once. A restore or a second
  Apple ID must not restart the 15-day hosted trial.
- Seat, token, and storage limits continue to be checked by the service. A
  local StoreKit entitlement must not bypass any quota.

## Native implementation sequence

Once the server contract exists, add a small `@MainActor` purchase store in
`WaynodeCore`:

1. Fetch products by a compile-time product-ID allowlist and display only
   products returned by StoreKit.
2. Start a detached listener over `Transaction.updates` at app launch, and
   sync `Transaction.currentEntitlements` on activation/restore. Both flows
   submit only `VerificationResult.verified` transactions to the server.
3. Call `finish()` only after the server acknowledges idempotent ingestion;
   retry safely when offline. Treat client verification as a defense-in-depth
   check, not the grant of service access.
4. Render `GET .../entitlement` as the source of truth. When the server is
   unavailable, show a neutral "checking subscription" state rather than
   extending access locally.
5. Include a **Restore purchases** action and a clear link to manage the
   subscription in Apple account settings. Do not provide a custom cancellation
   or refund path that claims it can alter App Store billing.

Do not store transaction JWS, original transaction IDs, purchase intent
tokens, or App Store credentials in UserDefaults or Keychain beyond the
duration needed to retry submission. The server's database is the audit
record; the existing Keychain token remains solely an authentication secret.

## Operational and test gate

Before shipping an IAP build, configure App Store Server Notifications V2 for
both sandbox and production, and ensure the hosted deployment has the Apple
key material and notification endpoint available. Apple documents that
notifications are server-to-server and that the server must interpret them;
StoreKit supplies cryptographically verified transactions to the app, but
that does not replace service-side entitlement accounting.

Minimum test matrix:

- new purchase for each plan; pending/Ask to Buy; cancel before completion;
  and double-tap/retry;
- restore after reinstall and on a second device; no duplicate org grant;
- renewal, failed renewal/grace period, expiration, refund, revocation, and
  upgrade/downgrade; notifications arriving late, twice, and out of order;
- an administrator purchasing for org A while switching to org B; non-admin
  attempting to create an intent; and self-hosted endpoint probing;
- live entitlement reconciliation against App Store Server API, with alerting
  for an Apple transaction that has no Waynode org mapping.

References: [StoreKit Transaction](https://developer.apple.com/documentation/storekit/transaction)
and [App Store Server Notifications](https://developer.apple.com/documentation/appstoreservernotifications).
