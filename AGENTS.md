# AGENTS.md — Waynode AI

Open-source, self-hosted coding-agent workspace. Each space is a real cloned repo. pi is the engine. Mobile-first. Small-team ready.

## Architecture

- **server.js** — Express backend. GitHub/GitLab OAuth, space management (git clone), session management, SSE streaming for chat, WebSocket for terminal, encrypted secrets.
- **lib/db.mjs** — SQLite via Node built-in `node:sqlite` (DatabaseSync). Schema: users, spaces, space_members, sessions, messages, secrets, settings.
- **lib/auth.mjs** — Passport.js strategies (GitHub + GitLab). Session-based auth. `requireAuth` + `requireSpaceAccess` middleware.
- **lib/spaces.mjs** — Git clone/pull/delete. Each space = a directory under `data/repos/<space-id>/`.
- **lib/sessions.mjs** — Session CRUD + message persistence in SQLite.
- **lib/pi-runner.mjs** — Headless `pi -p` for chat (streams stdout via SSE), node-pty for terminal mode. Goal status read from pi session JSONL.
- **lib/secrets.mjs** — AES-256-GCM encrypted secrets (global + per-space). Injected as env vars when pi runs.
- **routes/** — auth, spaces, sessions (SSE message streaming), secrets, settings, terminal (WebSocket upgrade).
- **frontend/** — Vite + React + TS SPA. Collapsible sidebar (Spaces → Sessions), Chat tab (dual send: normal + goal), Terminal tab (xterm.js via WebSocket, lazy-loaded).

## Key concepts

| Concept | Description |
|----------|-------------|
| **Space** | A cloned git repo. Working directory for pi. |
| **Session** | A conversation within a space. Backed by pi JSONL + SQLite messages table. |
| **Chat tab** | Headless `pi -p` per message, streamed over SSE. Mobile-friendly. |
| **Terminal tab** | Full pi TUI via node-pty → WebSocket → xterm.js. Lazy-loaded, PTY killed on unmount. |
| **Goal mode** | Send-as-Goal wraps prompt to instruct pi to use `create_goal` + run autonomously until `update_goal(complete)`. |

## Deploy

Deploy on fornace-deploy server. AWS Route53 points `waynode.fornace.net` → server IP.

```bash
git push origin main
gh run list --workflow deploy.yml --limit 3
gh run watch <run-id> --exit-status
```

## Environment variables

| Var | Required | Source |
|-----|----------|--------|
| `SESSION_SECRET` | yes | `openssl rand -hex 32` |
| `ENCRYPTION_KEY` | yes | `openssl rand -hex 32` |
| `GITHUB_CLIENT_ID` | yes | GitHub OAuth App |
| `GITHUB_CLIENT_SECRET` | yes | GitHub OAuth App |
| `GITLAB_CLIENT_ID` | no | GitLab OAuth App |
| `GITLAB_CLIENT_SECRET` | no | GitLab OAuth App |
| `APP_URL` | no | Default: `http://localhost:3000` |
| `PI_DEFAULT_MODEL` | no | Default: `anthropic/claude-sonnet-4-20250514` |
| `PI_DEFAULT_PROVIDER` | no | Default: `anthropic` |

## Dependency Versions (HARD RULE)

ALWAYS check and use the latest stable version of every package. Never guess version numbers. Run `npm view <pkg> version` before touching any package.json.

## E2E Testing & Scripts

- Always use timeouts on any fetch, page.wait, or CDP operation.
- Always make things observable — log state at each step.
- Always clean up — close PTYs, abort streams, release locks in finally blocks.

### Standard prod E2E

The canonical way to test waynode in prod as the authenticated user is
`e2e/run-rest.mjs`, driving the Playwright-backed hosted browser at
`browser.fornace.net` over its REST action API (`/tool/<name>`, Bearer
`fnc_…` key). No local browser install, no CDP, no MCP client. See
`e2e/README.md` for full details.

```bash
cd e2e && npm install
DEV=$(ssh root@95.216.37.30 'docker exec $(docker ps -q --filter name=waynode) printenv DEV_AUTH_TOKEN')
BROWSER_TOKEN="fnc_…" DEV_TOKEN="$DEV" node run-rest.mjs   # ONLY=auth,chat for a subset
```

Covers 6 hosted flows: auth, open-session, chat-send, model-switch,
hosted-terminal-disabled, and chat-after-terminal-gate. Self-host terminal
mechanics are covered by the focused sandbox terminal/security regressions.
`BROWSER_TOKEN` = the browser.fornace.net api-key (`~/.agent_credentials/tokens/browser-mcp-tomasipromo.env`).
`DEV_TOKEN` = waynode `DEV_AUTH_TOKEN` (injected into `localStorage` so REST +
SSE + the terminal WS all run authed). The `call()` helper is rate-limit-aware
(browser.fornace.net throttles sustained call volume) — keep polling intervals
≥2.5s when adding flows. Always create + pin an isolated `sessionId`; the
shared default session is multi-tenant and gets hijacked.

`e2e/run.mjs` (local Playwright) is kept as an offline fallback.
