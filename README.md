# Waynode AI

Open-source, self-hosted coding-agent workspace. Each workspace is a real cloned repo. [pi](https://github.com/anthropics/pi) is the engine, with [pi-codex-goal](https://github.com/fitchmultz/pi-codex-goal) as a first-class citizen.

**Mobile-first. Small-team ready. macOS + iOS clients planned.**

## Choose your Waynode

### Self-host — free and yours

Run Waynode on infrastructure you control. Your repositories, database,
credentials, provider accounts, and billing stay with you. Self-hosted installs
do **not** enable Waynode hosted billing, usage limits, or payment collection.

### Waynode Cloud — managed hosting

Waynode Cloud runs the same open-source workspace with managed server operation,
updates, isolated workspaces, encrypted secrets, and Stripe billing. New cloud
organizations get a 15-day trial; choose Starter, Pro, or Team only when you are
ready to keep using the service. Native App Store billing is intentionally not
enabled until its server-verified entitlement flow is shipped; never enter
Stripe credentials into a native client.

> Operators: hosted billing is deliberately disabled unless
> `WAYNODE_DEPLOYMENT=hosted` is set alongside the Stripe configuration. Do not
> set that flag on a self-host deployment.

## Quick Start

### Self-host (Docker)

```bash
git clone https://github.com/fornace/waynode.git
cd waynode
./scripts/self-host.sh setup
```

The guided setup requires Docker Compose v2, one GitHub or GitLab OAuth app, and
a supported model-provider key. It generates both server secrets, prints the
exact OAuth callback URLs, records the selected pi provider and model, encrypts
the model key into Waynode's secret vault on first boot, validates Compose, and
starts on loopback by default.

Requirements, reverse-proxy setup, upgrades, and stop-consistent backup/restore
instructions are in [Self-hosting Waynode](docs/SELF-HOSTING.md).

### Local Development

```bash
# Terminal 1: backend
npm install
cp .env.example .env
# Fill the required server secrets, OAuth app, provider, and model values.
npm run dev

# Terminal 2: frontend (hot reload)
cd frontend
npm install
npm run dev
```

## Developer Setup

To push to this repo you need a GitHub token with the **`workflow`** scope
(it is separate from `repo`, and is required to push any change that touches
`.github/workflows/`). Without it, `git push` will be rejected with:
`refusing to allow an OAuth App to create or update workflow … without workflow scope`.

```bash
gh auth login                                      # first time
gh auth refresh -h github.com -s workflow          # add the workflow scope
```

End-user login via GitHub OAuth (see *OAuth Setup* below) only needs
`read:user` / `repo`-type scopes — pushing workflows is a developer action,
so end-user tokens never need the `workflow` scope.

## OAuth Setup

### GitHub

1. Go to **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App**
2. Set **Authorization callback URL** to `https://your-domain/auth/github/callback`
3. Copy the **Client ID** and generate a **Client Secret**
4. Put them in `.env` as `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`

### GitLab

1. Go to **GitLab → User Settings → Applications → New Application**
2. Set **Redirect URI** to `https://your-domain/auth/gitlab/callback`
3. Scopes: `read_user`, `read_api`, `read_repository`
4. Put them in `.env` as `GITLAB_CLIENT_ID` / `GITLAB_CLIENT_SECRET`

## Deployment

Pushes to `main` trigger `.github/workflows/deploy.yml`, which rsyncs the
source to the server and rebuilds the Docker container (`docker compose build
--no-cache`). The live site is <https://waynode.fornace.net>.

It requires three **GitHub Actions secrets** (repo → Settings → Secrets and
variables → Actions):

| Secret | Value |
|--------|-------|
| `DEPLOY_HOST` | The host currently serving `waynode.fornace.net` |
| `DEPLOY_USER` | SSH user (e.g. `root`) |
| `DEPLOY_SSH_KEY` | Private SSH key authorized on the server |

Set them once with the CLI:

```bash
gh secret set DEPLOY_HOST   --body '<serving-host>'
gh secret set DEPLOY_USER   --body 'root'
gh secret set DEPLOY_SSH_KEY < ~/.ssh/waynode_deploy_key
```

The Dockerfile is a multi-stage build: it compiles the frontend
(`npm run build`) then installs pi + the `pi-codex-goal` / `pi-lean-ctx`
plugins and configures the fornace LLM provider, so `frontend/dist` does not
need to be committed.

Before treating a deployment as successful, confirm the container on
`DEPLOY_HOST` was actually replaced (not merely that the public domain answers
HTTP). The compose file used by CI and the compose file running on the host
must be the same topology. For Waynode Cloud, configure the hosted-only Stripe
variables in the host's root-owned `.env` (mode `0600`), then verify
`/api/billing/enabled` returns `{"enabled":true}` and complete a signed-webhook
and isolated authenticated E2E run. See [pricing operations](docs/PRICING.md).
Use [the hosted launch gate](docs/HOSTED-LAUNCH.md) for the complete
reconciliation and payment-verification checklist.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Clients: Web (React) │ macOS (Tauri) │ iOS      │
├─────────────────────────────────────────────────┤
│  Express server                                 │
│  • GitHub + GitLab OAuth                        │
│  • Space = cloned repo on disk                  │
│  • Session = pi session (JSONL-backed)          │
│  • Persistent `pi --mode rpc` agents, streamed over SSE       │
│  • Agent lives in server, survives client navigation           │
│  • SQLite: secrets, metadata, session index     │
│  • Terminal: node-pty → WebSocket → xterm.js   │
├─────────────────────────────────────────────────┤
│  pi runtime (per-space working directory)        │
│  • pi-codex-goal preinstalled                    │
│  • AGENTS.md + skills/ per space                 │
└─────────────────────────────────────────────────┘
```

## Key Concepts

| Concept | Description |
|---------|-------------|
| **Space** | A cloned git repository. Each space has its own AGENTS.md, skills, and sessions. |
| **Session** | A conversation within a space. Backed by pi's JSONL session format. |
| **Chat tab** | Conversation via a persistent `pi --mode rpc` agent, token-streamed over SSE. Survives navigation. |
| **Terminal tab** | Full pi TUI via node-pty → WebSocket → xterm.js. For `/goal`, model switching, raw power. |
| **Goal mode** | Send-as-Goal wraps your prompt to instruct pi to use `create_goal` and run autonomously. |
| **Secrets** | AES-256 encrypted, stored in SQLite. Scoped globally or per-space. Injected as env vars to pi. |

## License

MIT
