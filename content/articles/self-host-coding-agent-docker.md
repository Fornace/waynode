---
title: How to self-host a coding agent with Docker
description: Step-by-step guide to running a self-hosted AI coding agent on your own server with Docker Compose, HTTPS, OAuth, and your own LLM keys.
category: guides
slug: self-host-coding-agent-docker
date: 2026-07-12
updated: 2026-07-14
author: Francesco Frapporti
keywords: self-host coding agent, self-hosted ai coding assistant docker, run coding agent on your own server
cover: /covers/self-host-coding-agent-docker.png
---

![How to self-host a coding agent with Docker Cover Image](/covers/self-host-coding-agent-docker.png)

# How to self-host a coding agent with Docker

Self-hosting a coding agent means running the agent's server, workspaces, and credentials on infrastructure you control rather than an agent vendor's SaaS. If you use a hosted model API, prompts and selected code context still go directly to that provider. A Docker-packaged agent workspace such as [Waynode](https://github.com/fornace/waynode) (open source, MIT) still needs real operator configuration: a Git provider OAuth app, model-provider credentials, HTTPS for remote access, and a backup plan. Waynode's guided installer handles the local secrets and Docker Compose validation; this guide walks through the remaining decisions end to end. The pattern (container + secrets + OAuth + reverse proxy + your own model keys) applies to any self-hosted AI coding assistant.

**TL;DR**

- Prerequisites: a Linux host with Docker Engine and Docker Compose v2, a GitHub or GitLab OAuth app, a supported model-provider key, and a domain if you want remote/mobile access.
- Install: `git clone` → `./scripts/self-host.sh setup`. The interactive installer generates the server secrets, records OAuth and model configuration, validates Compose, and starts on loopback.
- Expose it safely with a reverse proxy (Caddy or nginx) terminating HTTPS, and set `APP_URL` to the public URL so OAuth callbacks work.
- You bring your own model key; Waynode's hosted billing and usage limits are disabled in self-host mode, while your model provider bills its API usage directly.
- Keep `.env` out of Git and protect it as a credential; never expose the app over plain HTTP beyond localhost.

## What do you need before you start?

Four things:

1. A Linux host with Docker Engine and Docker Compose v2: a home server or a VPS. A coding agent workspace clones real Git repositories to disk, so budget disk space for the repos you plan to work on plus the container image and session history.
2. A Git provider OAuth app. Waynode authenticates users and clones repositories via GitHub or GitLab OAuth. You create the OAuth app in your own GitHub/GitLab account, so tokens are issued to *your* deployment, not to a vendor.
3. An LLM API key and model ID. The guided path supports Anthropic, OpenAI, Google Gemini, or OpenRouter. The agent engine is pi (open source), with pi-codex-goal for autonomous goal-driven runs.
4. Optionally, a domain name. Only needed if you want HTTPS access from outside the machine, which is most of the point if you want to steer the agent from a phone.

The default Compose deployment is intended for a trusted individual or small team. Agent commands run inside the Waynode container, whose data volume contains every worktree; it does not provide hardware isolation between users. The separate KVM/microsandbox deployment is an advanced operator path, not a property of the default installer.

## How do you install the agent with Docker Compose?

Clone the repository and run the interactive installer:

```bash
git clone https://github.com/fornace/waynode.git
cd waynode
./scripts/self-host.sh setup
```

Before running it, create a GitHub or GitLab OAuth application and have a supported provider key plus provider-local model ID ready. The installer prints the exact OAuth callbacks, generates different 256-bit session and encryption secrets, writes a mode-`0600` `.env`, validates Compose, builds the service, and waits for its auth endpoint to report healthy. It refuses to overwrite an existing `.env`.

With the default local URL, the app comes up on `http://localhost:3000`. The Compose file defines a single service with a named volume for persistent data: workspaces, database, and terminal/session state live in that volume, which is what makes sessions durable across container restarts.

Before updating, record the current commit and take a stop-consistent data backup plus a protected copy of `.env`. Then use `git pull --ff-only`, `docker compose up -d --build`, and `./scripts/self-host.sh check`. The data volume is not replaced by a normal rebuild, but database migrations may make rollback require restoring the pre-upgrade archive. See the [complete self-hosting runbook](https://github.com/fornace/waynode/blob/main/docs/SELF-HOSTING.md).

## Which environment variables matter?

The installer writes `.env`; manual installation remains available through `.env.example`. The security-relevant variables are:

| Variable | Purpose | How to set it |
|---|---|---|
| `SESSION_SECRET` | Signs session cookies | `openssl rand -hex 32` (random, unique per deployment) |
| `ENCRYPTION_KEY` | Encrypts stored secrets at rest | `openssl rand -hex 32` (different from `SESSION_SECRET`) |
| `APP_URL` | Public base URL; used for OAuth callbacks | `http://localhost:3000` locally, `https://agent.example.com` in production |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub OAuth app | Created in GitHub → Settings → Developer settings → OAuth Apps |
| `GITLAB_CLIENT_ID` / `GITLAB_CLIENT_SECRET` / `GITLAB_BASE_URL` | GitLab OAuth (gitlab.com or self-managed) | Created in GitLab → User Settings → Applications |
| `PI_DEFAULT_PROVIDER` / `PI_DEFAULT_MODEL` | Which LLM the agent uses by default | Your provider and model id; you supply the API key |
| `PI_PROVIDER_API_KEY` | One-time first-boot provider credential | The installer encrypts it into Waynode's global secret vault |

Two rules that prevent most self-hosting incidents:

- Never reuse or commit the secrets. If `SESSION_SECRET` leaks, sessions can be forged; if `ENCRYPTION_KEY` leaks alongside a database copy, stored credentials can be decrypted. Keep `.env` out of Git and, for production, load these from a secret manager.
- Do not set `WAYNODE_DEPLOYMENT=hosted` or enable hosted Stripe variables. The self-host installer writes `WAYNODE_DEPLOYMENT=self-hosted` and refuses the hosted value; hosted billing, payment collection, and Waynode usage limits stay disabled.

## How do you set up GitHub or GitLab OAuth?

Create an OAuth app in the provider, pointing back at your deployment:

- GitHub: Settings → Developer settings → OAuth Apps → New OAuth App. Set the callback URL to `${APP_URL}/auth/github/callback`.
- GitLab: User Settings → Applications. Set the redirect URI to `${APP_URL}/auth/gitlab/callback`. For self-managed GitLab, also set `GITLAB_BASE_URL`.

The callback URL must match `APP_URL` exactly: scheme, host, and port. This is the most common setup failure: the app works on localhost, then OAuth breaks after moving behind a domain because the OAuth app still points at `http://localhost:3000`. When you add HTTPS (next section), update both `APP_URL` and the provider-side callback URL, then restart the container.

## How do you add a reverse proxy and HTTPS?

Keep the app off the public interface and put a TLS-terminating proxy in front. The default Compose file binds `127.0.0.1:3000`, so only a proxy on the same host can reach it. Set `WAYNODE_BIND_ADDRESS=0.0.0.0` only when another host must reach the Docker port and a firewall restricts access. With [Caddy](https://caddyserver.com/) the whole proxy config is:

```
agent.example.com {
    reverse_proxy localhost:3000
}
```

Caddy provisions and renews Let's Encrypt certificates automatically. With nginx, use a standard `proxy_pass http://127.0.0.1:3000` server block plus certbot, and make sure WebSocket upgrade headers (`Upgrade`, `Connection`) are forwarded, since the live agent stream and the in-browser terminal depend on them.

Set `APP_URL=https://agent.example.com` during setup so the printed OAuth callbacks are correct. If the URL changes later, update `.env`, update the provider-side callback, and restart with `docker compose up -d`. From this point the same workspace, session, and diff view are reachable from any device. Waynode's UI is mobile-first, so following a running task or reviewing changed files from a phone works against your own server.

Do not expose port 3000 directly to the internet. A coding agent has your repo credentials and can execute code; plain HTTP plus a public port is the one configuration to categorically avoid.

## How do you bring your own LLM keys?

Self-hosting means the model relationship is also yours: you pay your provider directly at API rates, with no Waynode per-seat markup or hosted token quota. During setup, choose Anthropic, OpenAI, Google Gemini, or OpenRouter; enter a provider-local model ID and the corresponding API key. On first boot, Waynode maps `PI_PROVIDER_API_KEY` to the provider's exact key name, encrypts it into the global secret vault, and removes the bootstrap names from the live process before starting an agent. Later restarts do not overwrite the encrypted value.

The bootstrap value remains in the root-readable `.env` for disaster recovery. After a verified prompt, you may blank it if the key is stored elsewhere; later rotation and worktree-scoped overrides belong in Settings → Secrets. The installer validates that configuration is present, but only a real prompt can prove the model ID and credential entitlement.

This is the main economic difference from managed agent products: your spend tracks actual usage on your provider bill. The trade-off is that you own capacity planning and cost monitoring yourself: there is no built-in quota to stop a runaway autonomous run except your provider's own limits.

## What are the security basics for a self-hosted coding agent?

A minimal checklist:

- Let the installer generate different `SESSION_SECRET` and `ENCRYPTION_KEY` values; store a protected copy of `.env`; never commit it, OAuth client secrets, or provider tokens.
- Use HTTPS at the reverse proxy for anything beyond localhost. OAuth flows and repo tokens must never cross plain HTTP.
- An agent workspace holds cloned repos and can run commands. Treat every invited user and repository as trusted on the default Compose deployment; run it on a dedicated host or VM where possible.
- Grant the OAuth app only the scopes your provider flow requires, and keep it pointed at your deployment's exact callback URL.
- Back up with `./scripts/self-host.sh backup`, keep `.env` separately, copy both off-host, and test restores. The helper stops the service for a consistent archive but does not encrypt, upload, rotate, or validate it for you.

## Does this recipe work for other self-hosted coding agents?

Broadly, yes. Other open-source agents follow the same shape: a container, a port, mounted persistent state, and your own model key. [OpenHands](https://github.com/OpenHands/OpenHands), for example, runs its GUI from a single `docker run` of `ghcr.io/openhands/agent-canvas` on port 8000 with `~/.openhands` and a projects directory mounted, and supports bring-your-own-model configuration ([OpenHands repository](https://github.com/OpenHands/OpenHands), retrieved July 2026).

The architectural difference to check when choosing a tool is what a "workspace" is. OpenHands mounts a projects directory into task sandboxes; Waynode's unit is a persistent cloned Git repository: a real worktree with its own branches, terminal state, and an agent-native Git surface (diffs, hunks, commits, push) beside the conversation, all of which survive between visits. If your workflow is "start an agent task at your desk, review and push from your phone later," that persistence is the feature to select for. For a comparison of self-hosting versus managed cloud agents, see [/learn](/learn).

## FAQ

### How much does it cost to self-host a coding agent?

The software is free: Waynode is MIT-licensed, with hosted billing and Waynode usage limits disabled on self-hosted installs. Your costs are the server (disk scales with your repos) and your LLM provider's API usage, paid directly at provider rates.

### Can I run a self-hosted coding agent without a domain name?

Yes, on `http://localhost:3000` with `APP_URL` left at its default, which is fine for a single machine. You need a domain and HTTPS only for remote or mobile access, and OAuth callbacks must then match the public URL exactly.

### What happens to my code and API keys when I self-host?

Repositories and stored credentials stay on your infrastructure. Repositories are cloned to a Docker volume on your host, and credentials are encrypted at rest with your own `ENCRYPTION_KEY`. LLM requests go directly from your server to the model provider you configured, so that provider receives the prompts and selected code context needed for inference; Waynode is not an intermediary in that path.

### Do I need a GPU to self-host a coding agent?

No. The agent workspace itself is a lightweight web application; the language model runs at your API provider. A GPU only becomes relevant if you separately choose to serve a local model and point the agent's provider configuration at it.

### What is the difference between self-hosting Waynode and using Waynode Cloud?

Same open-source stack. Self-host is free and everything (repos, database, keys, billing) stays with you; Waynode Cloud operates the server, updates, encrypted secrets, and Stripe billing from $39/mo (Starter: 3 seats, 3M agent tokens/mo, 10 GB), with a 15-day free trial for new organizations. Interactive terminal access is currently self-hosted only.
