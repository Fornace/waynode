# Waynode sandbox runtime key rotation (2026-09-03)

Revoke and replace `WAYNODE_SANDBOX_LLM_KEY` in production after the value was
exposed in a diagnostic session transcript.

## Context

- Exposed credential: gateway token `waynode-sandbox-prod`, fingerprint
  `7ce22875283e`, gateway user `legacy-7ce22875283e61ff` (plan
  `legacy-litellm`, allowed models `fornace-fast|reasoning|max|vision|embed`,
  window 2_592_000 s, no token/request limit, $100 budget cap).
- Gateway: Mantice, blue slot `private-openrouter-green.service` on host
  `49.12.9.255`, control port `127.0.0.1:4012`, admin bearer in
  `/etc/fornace-llm2.env` (`ADMIN_TOKEN`).
- Production consumer: `/opt/waynode/.env` on `95.216.37.30`
  (`WAYNODE_SANDBOX_LLM_KEY`), injected into the Waynode container env; used
  only as the shared restricted runtime key fallback in
  `lib/sandbox-llm-key.mjs` (hosted sandbox chat). Per-org keys and
  Hammersmith worker keys are minted separately and are unaffected.
- Reachability: the container reaches the gateway through the host forwarder
  `waynode-llm-forward.service` (`10.200.0.1:4000 -> 127.0.0.1:4002` on
  `49.12.9.255`); the blue control port is loopback-only on that host.

## Steps

1. Mint a replacement token under gateway user `legacy-7ce22875283e61ff`
   (same label family, same allowed models and window) via
   `POST /admin/tokens` with a fresh `Idempotency-Key`. Record only the new
   fingerprint; the bearer is written straight to a root-only temp file.
2. On `95.216.37.30`, atomically replace `WAYNODE_SANDBOX_LLM_KEY=` in
   `/opt/waynode/.env` from the temp file (mode 600 preserved).
3. Recreate the container: `cd /opt/waynode && docker compose up -d --wait`
   (env comes from `.env`; image unchanged).
4. Verify: container env shows the new fingerprint's key,
   `/api/health/ready` still `{"ready":true}`, public version unchanged.
5. Disable the old token server-side: `PATCH /admin/tokens/7ce22875283e`
   `{"enabled":false}`. Verify it is disabled in `/admin/tokens`.
6. Confirm the exposed value no longer authenticates against the gateway.

## Notes

- One-off operational secret rotation, not an application deploy, so it runs
  over SSH per the emergency/ops exception; application code remains
  main-only.
- Never print the bearer values; identify tokens by fingerprint
  (first 12 hex of the gateway-side SHA-256).
- The old token had 31 requests / ~456k tokens lifetime; its window stats are
  not carried over to the replacement.
