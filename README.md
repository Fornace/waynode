# Waynode AI

Open-source, self-hosted coding-agent workspace. Each workspace is a real cloned repo. [pi](https://github.com/anthropics/pi) is the engine, with [pi-codex-goal](https://github.com/fitchmultz/pi-codex-goal) as a first-class citizen.

**Mobile-first. Small-team ready. macOS + iOS clients planned.**

## Quick Start

### Self-host (Docker)

```bash
git clone https://github.com/fornace/waynode.git
cd waynode
cp .env.example .env
# Edit .env — set SESSION_SECRET, ENCRYPTION_KEY, and OAuth credentials
docker compose up -d
# → http://localhost:3000
```

### Local Development

```bash
# Terminal 1: backend
npm install
cp .env.example .env
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
| `DEPLOY_HOST` | Deploy server IP (e.g. `49.12.9.255`) |
| `DEPLOY_USER` | SSH user (e.g. `root`) |
| `DEPLOY_SSH_KEY` | Private SSH key authorized on the server |

Set them once with the CLI:

```bash
gh secret set DEPLOY_HOST   --body '49.12.9.255'
gh secret set DEPLOY_USER   --body 'root'
gh secret set DEPLOY_SSH_KEY < ~/.ssh/waynode_deploy_key
```

The Dockerfile is a multi-stage build: it compiles the frontend
(`npm run build`) then installs pi + the `pi-codex-goal` / `pi-lean-ctx`
plugins and configures the fornace LLM provider, so `frontend/dist` does not
need to be committed.

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
