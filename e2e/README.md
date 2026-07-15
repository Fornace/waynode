# Waynode E2E

The standard automated browser suite runs against an isolated non-production
deployment. Production never enables `DEV_AUTH_TOKEN`; production auth smoke
uses a real OAuth browser session and a dedicated test organization.

## The driver: browser.fornace.net (REST action API)

We drive a Playwright-backed headed Chromium hosted on the fornace server via
`browser.fornace.net`'s REST action API (`/tool/<name>`), authenticated with a
Bearer api-key. Despite the "MCP" naming on the landing page, it is a plain
HTTPS POST API — no MCP client, no CDP, no local Playwright.

`run-rest.mjs` is the canonical harness. `run.mjs` (local Playwright) is kept
only as an offline fallback.

To provision the same isolated local server/worktree fixture but drive it with
the locally installed Playwright browser, select the local driver explicitly:

```bash
WAYNODE_E2E_DRIVER=local ./scripts/run-local-rest-e2e.sh
```

The default remains `WAYNODE_E2E_DRIVER=rest`. The local fallback covers the
same auth, disposable session, exact chat persistence/reload/timestamp, and
model-switch contract without creating a public tunnel.

### Why this over CDP / local Playwright

- **No raw CDP on either path.** `browser.fornace.net` deliberately wraps
  Chromium behind its action API (`/json` → 404). Francesco's local Chrome
  `:9222` is real CDP but only works when his browser is open with the flag —
  not a repeatable prod standard.
- **No local install.** Runs from any machine with `node` + `curl`. The browser
  lives server-side, headed, with proxy/stealth available.
- **Isolated sessions.** Each run creates its own `BrowserContext`
  (`browser_create_session`) — own cookies/tabs/WebSocket — so concurrent runs
  never collide. **Always pass your `sessionId` to every call; the shared
  default session is a multi-tenant free-for-all and will get hijacked.**

## Automated auth model (non-production only)

- **`BROWSER_TOKEN`** = the `browser.fornace.net` api-key (`fnc_…`), from
  `~/.agent_credentials/tokens/browser-mcp-tomasipromo.env` (`BROWSER_MCP_TOKEN`).
- **`DEV_TOKEN`** = an isolated staging/local deployment's `DEV_AUTH_TOKEN`.
  The harness injects it into the page's
  `localStorage` as `waynode-dev-token`, so REST, SSE, **and the terminal
  WebSocket** all run authenticated as the dev user — no OAuth login step.

The wrapper refuses `https://waynode.fornace.net`. A bypass token grants broad
test-user access and must never be configured in production.

## Usage

```bash
BASE_URL=https://waynode-staging.example.com \
DEV_TOKEN="<staging-only token>" \
WAYNODE_NONPROD_CONFIRMED=1 \
./scripts/run-rest-e2e-nonprod.sh

# flags:
#   KEEP=1            leave the browser session alive for manual inspection
#   ONLY=auth,chat    run a subset of flows
```

For production, first require `GET /api/health/ready` to return 200. Then use a
real GitHub/GitLab OAuth session to verify login, one isolated chat turn,
reload hydration, billing visibility, and logout. Do not reintroduce a server
bypass to make this unattended.

## Flows covered

| Flow | What it asserts |
|------|-----------------|
| `auth` | dev-token authenticates → sidebar lists spaces |
| `open-session` | API-created disposable session deep-links into a ready composer |
| `chat-send` | unique exact reply streams, persists beside its user turn, reloads, and renders source timestamps |
| `model-switch` | session-menu selection persists to the session API without an error |
| `hosted-terminal-disabled` | authenticated hosted production rejects interactive terminal, shows the capability explanation, and removes the Terminal control |
| `chat-after-terminal-gate` | returning to Chat keeps the composer usable and the unsupported Terminal control hidden |

Screenshots land in `shots/`; `last-result.json` records the pass/fail summary.

## Native app auth E2E (`test-native-auth.mjs`)

A standalone server-side test that boots a throwaway Waynode instance on
port 3999 with a temp database and verifies the native-app auth layer:

```bash
node e2e/test-native-auth.mjs
```

| # | What it asserts |
|---|-----------------|
| 1 | Unauthenticated `/api/auth/me` returns configured providers (github/gitlab) |
| 2 | `createToken()` mints a `wn_`-prefixed token |
| 3 | Bearer token authenticates `/api/auth/me` and returns the user |
| 4 | Bearer tokens **cannot** create other tokens (403 escalation guard) |
| 5 | Bearer tokens **can** list their own tokens (token management) |
| 6 | SSE events endpoint accepts `?t=` bearer query param |
| 7 | Bad/unknown bearer token → 401 (not silent 200) |
| 8 | Revoked token is immediately invalid (401) |

No external services required — sets `DATA_DIR` to a temp dir, configures
`GITHUB_CLIENT_ID`, and spawns `node server.js`.

## Self-host terminal coverage

Hosted production deliberately does not execute an interactive shell. The
self-host terminal contract is covered without weakening that boundary:

- `test-sandbox-terminal.mjs` exercises bidirectional microVM TTY output,
  input, exit, and cleanup through the installed microsandbox API.
- `test-sandbox-security.mjs` asserts hosted denial and self-host allowance.
- `test-terminal-billing.mjs` covers the typed availability error and detached
  terminal metering.

## Reliability

The harness is **rate-limit-aware**: `browser.fornace.net` throttles sustained
call volume (no advertised headers — just `{error:"Rate limit exceeded"}`),
so `call()` detects that and backs off with exponential retry. Polling loops
use ≥2.5s intervals to stay under the limit. With this, the full 6-flow suite
runs green consistently (verified across consecutive runs).

The hosted suite does not accept a painted TUI as success: that would be a
security regression. It waits for the typed capability denial and verifies the
navigation control stays hidden. Polling uses ≥2.5s intervals so the hosted
browser action API does not throttle late flows.
