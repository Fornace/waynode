# Waynode E2E

The standard way to test waynode in prod, as the user (authenticated), through a
real browser — **no local browser install required**.

## The driver: browser.fornace.net (REST action API)

We drive a Playwright-backed headed Chromium hosted on the fornace server via
`browser.fornace.net`'s REST action API (`/tool/<name>`), authenticated with a
Bearer api-key. Despite the "MCP" naming on the landing page, it is a plain
HTTPS POST API — no MCP client, no CDP, no local Playwright.

`run-rest.mjs` is the canonical harness. `run.mjs` (local Playwright) is kept
only as an offline fallback.

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

## Auth model

- **`BROWSER_TOKEN`** = the `browser.fornace.net` api-key (`fnc_…`), from
  `~/.agent_credentials/tokens/browser-mcp-tomasipromo.env` (`BROWSER_MCP_TOKEN`).
- **`DEV_TOKEN`** = waynode's `DEV_AUTH_TOKEN` (read from the prod container:
  `ssh root@49.12.9.255 'docker exec $(docker ps -q --filter name=waynode)
  printenv DEV_AUTH_TOKEN'`). The harness injects it into the page's
  `localStorage` as `waynode-dev-token`, so REST, SSE, **and the terminal
  WebSocket** all run authenticated as the dev user — no OAuth login step.

⚠️ `DEV_AUTH_TOKEN` being set in prod is itself security finding #9. It's what
makes fully-automated E2E possible here, but it should be rotated/gated.

## Usage

```bash
cd e2e
npm install                       # one-time (installs nothing browser-side)
DEV=$(ssh root@49.12.9.255 'docker exec $(docker ps -q --filter name=waynode) printenv DEV_AUTH_TOKEN')
BROWSER_TOKEN="fnc_…" DEV_TOKEN="$DEV" node run-rest.mjs

# flags:
#   KEEP=1            leave the browser session alive for manual inspection
#   ONLY=auth,chat    run a subset of flows
```

## Flows covered

| Flow | What it asserts |
|------|-----------------|
| `auth` | dev-token authenticates → sidebar lists spaces |
| `open-session` | expanding a space + new session renders the chat/tabs |
| `chat-send` | "Reply with exactly: E2E-OK" → assistant replies with it |
| `model-switch` | dropdown → Fornace Reasoning, no error |
| `terminal-open` | Terminal tab mounts xterm, pi TUI paints |
| `terminal-survival` | **the marquee:** `browser_clear_session` + re-navigate → re-attaches to the *same* server pty (proves the terminal survives a browser close) |
| `mutex` | switching back to Chat reclaims the terminal |

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

## Reliability

The harness is **rate-limit-aware**: `browser.fornace.net` throttles sustained
call volume (no advertised headers — just `{error:"Rate limit exceeded"}`),
so `call()` detects that and backs off with exponential retry. Polling loops
use ≥2.5s intervals to stay under the limit. With this, the full 7-flow suite
runs green consistently (verified across consecutive runs).

Earlier "terminal-open is flaky" notes are obsolete — the root cause was always
the rate limiter eating the late flows, not the terminal or the mutex. The
server-side pty/terminal is separately verified by the in-container real-pty
E2E (`getTerminal` path).
