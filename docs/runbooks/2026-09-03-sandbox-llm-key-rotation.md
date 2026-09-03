# Waynode sandbox runtime key rotation (2026-09-03)

Revoke and replace `WAYNODE_SANDBOX_LLM_KEY` in production after the value was
exposed in a diagnostic session transcript.

## Context

- Exposed credential: gateway token `waynode-sandbox-prod`, fingerprint
  `7ce22875283e`, gateway user `legacy-7ce22875283e61ff` (plan
  `legacy-litellm`, allowed models `fornace-fast|reasoning|max|vision|embed`,
  window 2_592_000 s, no token/request limit, $100 budget cap).
- Gateway: Mantice on host `49.12.9.255`. Administrative requests use the
  active local gateway and the admin bearer from `/etc/fornace-llm2.env`
  (`ADMIN_TOKEN`).
- Production consumer: `/opt/waynode/.env` on `95.216.37.30`
  (`WAYNODE_SANDBOX_LLM_KEY`), injected into the Waynode container env; used
  only as the shared restricted runtime key fallback in
  `lib/sandbox-llm-key.mjs` (hosted sandbox chat). Per-org keys and
  Hammersmith worker keys are minted separately and are unaffected.
- Reachability: the container reaches the gateway through
  `waynode-llm-forward.service` on `49.12.9.255`. The stable route is
  `10.200.0.1:4000` to `127.0.0.1:4022`, then Nginx proxies through
  `llm_rust_gateway` to the active blue or green inference slot. The
  forwarder must never name a slot port directly.

## Steps

1. Mint a replacement token under gateway user `legacy-7ce22875283e61ff`
   (same label family, same allowed models and window) via
   `POST /admin/tokens` with a fresh `Idempotency-Key`. Record only the new
   fingerprint; the bearer is written straight to a root-only temp file.
2. On `95.216.37.30`, atomically replace `WAYNODE_SANDBOX_LLM_KEY=` in
   `/opt/waynode/.env` from the temp file (mode 600 preserved).
3. Recreate the container with the hosted Compose contract while preserving
   the deployed revision:
   `cd /opt/waynode && export WAYNODE_REVISION="$(cat .waynode-revision)" &&
   docker compose -f docker-compose.ffrapposerver.yml up -d --wait waynode`.
   The generic Compose file omits `/dev/kvm` and must not be used on this host.
4. Verify that the container uses the new fingerprint, retains the exact image,
   environment, and host-marker revision, exposes `/dev/kvm`, and returns
   `{"ready":true}` internally and publicly.
5. Disable the old token server-side: `PATCH /admin/tokens/7ce22875283e`
   `{"enabled":false}`. Verify it is disabled in `/admin/tokens`.
6. Confirm the exposed value no longer authenticates against the gateway.

## Notes

- One-off operational secret rotation, not an application deploy, so it runs
  over SSH per the emergency/ops exception; application code remains
  main-only.
- Never print the bearer values; identify tokens by fingerprint
  (first 12 hex of the gateway-side SHA-256).
- Completed result: replacement fingerprint `d67ae5f10e4f` is active; old
  fingerprint `7ce22875283e` is disabled and returns HTTP 401. The replacement
  completed a real `fornace-fast` request. The staged key and pre-rotation
  environment backup were securely removed.
