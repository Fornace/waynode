---
title: How to self-host a coding agent with Docker
description: Step-by-step guide to running a self-hosted AI coding agent on your own server with Docker Compose, HTTPS, OAuth, and your own LLM keys.
category: guides
slug: self-host-coding-agent-docker
date: 2026-07-12
updated: 2026-07-12
author: Francesco Frapporti
keywords: self-host coding agent, self-hosted ai coding assistant docker, run coding agent on your own server
---

# How to self-host a coding agent with Docker

Self-hosting a coding agent means running the agent's server, workspaces, and credentials on infrastructure you control, so your repositories and LLM API keys never pass through a third-party SaaS. With a Docker-packaged agent workspace such as [Waynode](https://github.com/fornace/waynode) (open source, MIT), the whole process is: clone the repo, fill in a `.env` file, run `docker compose up -d`, and put a reverse proxy with HTTPS in front. This guide walks through that end to end, using Waynode as the worked example; the pattern (container + secrets + OAuth + reverse proxy + your own model keys) applies to any self-hosted AI coding assistant.

**TL;DR**

- Prerequisites: a Linux server (or local machine) with Docker and Docker Compose, a domain name if you want remote/mobile access, and an LLM API key.
- Install: `git clone` → `cp .env.example .env` → set `SESSION_SECRET`, `ENCRYPTION_KEY`, OAuth credentials → `docker compose up -d` → app on `localhost:3000`.
- Expose it safely with a reverse proxy (Caddy or nginx) terminating HTTPS, and set `APP_URL` to the public URL so OAuth callbacks work.
- You bring your own model keys; nothing about your code or usage is billed or metered by anyone else. Self-hosted Waynode has no billing code active.
- Generate both secrets with `openssl rand -hex 32`, keep them out of Git, and never expose the app over plain HTTP beyond localhost.

## What do you need before you start?

Four things:

1. **A host with Docker.** Any machine that runs Docker Engine and Docker Compose v2: a home server, a VPS, or your laptop for a first test. A coding agent workspace clones real Git repositories to disk, so budget disk space for the repos you plan to work on plus the container image.
2. **A Git provider OAuth app.** Waynode authenticates users and clones repositories via GitHub or GitLab OAuth. You create the OAuth app in your own GitHub/GitLab account, so tokens are issued to *your* deployment, not to a vendor.
3. **An LLM API key.** Self-hosted deployments bring their own model provider key (for example an Anthropic key for the default configuration). The agent engine is pi (open source), with pi-codex-goal for autonomous goal-driven runs.
4. **Optionally, a domain name.** Only needed if you want HTTPS access from outside the machine — which is most of the point if you want to steer the agent from a phone.

For sandboxed execution, Waynode has a microVM execution path that activates when KVM is available on the host; it is optional, not a prerequisite.

## How do you install the agent with Docker Compose?

The whole install is four commands:

```bash
git clone https://github.com/fornace/waynode.git
cd waynode
cp .env.example .env
# edit .env (next section), then:
docker compose up -d
```

The app comes up on `http://localhost:3000`. The Compose file defines a single service with a named volume for persistent data — workspaces, database, and terminal/session state live in that volume, which is what makes sessions durable across container restarts.

To update later: `git pull`, then `docker compose up -d --build`. The data volume is untouched by rebuilds.

## Which environment variables matter?

Everything is configured through `.env`. The security-relevant variables:

| Variable | Purpose | How to set it |
|---|---|---|
| `SESSION_SECRET` | Signs session cookies | `openssl rand -hex 32` — random, unique per deployment |
| `ENCRYPTION_KEY` | Encrypts stored secrets at rest | `openssl rand -hex 32` — different from `SESSION_SECRET` |
| `APP_URL` | Public base URL; used for OAuth callbacks | `http://localhost:3000` locally, `https://agent.example.com` in production |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub OAuth app | Created in GitHub → Settings → Developer settings → OAuth Apps |
| `GITLAB_CLIENT_ID` / `GITLAB_CLIENT_SECRET` / `GITLAB_BASE_URL` | GitLab OAuth (gitlab.com or self-managed) | Created in GitLab → User Settings → Applications |
| `PI_DEFAULT_PROVIDER` / `PI_DEFAULT_MODEL` | Which LLM the agent uses by default | Your provider and model id; you supply the API key |

Two rules that prevent most self-hosting incidents:

- **Never reuse or commit the secrets.** If `SESSION_SECRET` leaks, sessions can be forged; if `ENCRYPTION_KEY` leaks alongside a database copy, stored credentials can be decrypted. Keep `.env` out of Git and, for production, load these from a secret manager.
- **Do not enable hosted-billing variables.** The Stripe variables in `.env.example` exist only for the managed waynode.fornace.net deployment. Left unset, the billing UI is hidden and billing routes 404 — a self-hosted install has no payment or metering code active.

## How do you set up GitHub or GitLab OAuth?

Create an OAuth app in the provider, pointing back at your deployment:

- **GitHub:** Settings → Developer settings → OAuth Apps → New OAuth App. Set the callback URL to `${APP_URL}/auth/github/callback`.
- **GitLab:** User Settings → Applications. Set the redirect URI to `${APP_URL}/auth/gitlab/callback`. For self-managed GitLab, also set `GITLAB_BASE_URL`.

The callback URL must match `APP_URL` exactly — scheme, host, and port. This is the most common setup failure: the app works on localhost, then OAuth breaks after moving behind a domain because the OAuth app still points at `http://localhost:3000`. When you add HTTPS (next section), update both `APP_URL` and the provider-side callback URL, then restart the container.

## How do you add a reverse proxy and HTTPS?

Keep the app off the public interface and put a TLS-terminating proxy in front. The default Compose file maps `3000:3000`, which binds all interfaces; on an internet-facing server, change the port mapping to `127.0.0.1:3000:3000` so only the proxy can reach it. With [Caddy](https://caddyserver.com/) the whole proxy config is:

```
agent.example.com {
    reverse_proxy localhost:3000
}
```

Caddy provisions and renews Let's Encrypt certificates automatically. With nginx, use a standard `proxy_pass http://127.0.0.1:3000` server block plus certbot — make sure WebSocket upgrade headers (`Upgrade`, `Connection`) are forwarded, since the live agent stream and the in-browser terminal depend on them.

Then set `APP_URL=https://agent.example.com` in `.env`, update the OAuth callback URLs, and `docker compose up -d` to restart. From this point the same workspace, session, and diff view are reachable from any device — Waynode's UI is mobile-first, so following a running task or reviewing changed files from a phone works against your own server.

Do not expose port 3000 directly to the internet. A coding agent has your repo credentials and can execute code; plain HTTP plus a public port is the one configuration to categorically avoid.

## How do you bring your own LLM keys?

Self-hosting means the model relationship is also yours: you pay your provider directly at API rates, with no per-seat markup and no token quota imposed by a middleman. Set `PI_DEFAULT_PROVIDER` and `PI_DEFAULT_MODEL` in `.env` and supply the corresponding API key; the default configuration targets Anthropic models, and the model can also be chosen per session.

This is the main economic difference from managed agent products: your spend tracks actual usage on your provider bill. The trade-off is that you own capacity planning and cost monitoring yourself — there is no built-in quota to stop a runaway autonomous run except your provider's own limits.

## What are the security basics for a self-hosted coding agent?

A minimal checklist:

- **Secrets:** generate `SESSION_SECRET` and `ENCRYPTION_KEY` with `openssl rand -hex 32`; store them in a secret manager; never commit `.env`, OAuth client secrets, or provider tokens.
- **Transport:** HTTPS at the reverse proxy for anything beyond localhost. OAuth flows and repo tokens must never cross plain HTTP.
- **Blast radius:** an agent workspace holds cloned repos and can run commands. Run it on a dedicated host or VM where possible; enable the KVM-backed microVM sandbox path if your host supports it.
- **OAuth hygiene:** grant the OAuth app only the scopes your provider flow requires, and keep it pointed at your deployment's exact callback URL.
- **Updates:** the stack is a normal Git repo — `git pull` and rebuild on your own schedule, and read the diff first, which is the audit ability self-hosting buys you.

## Does this recipe work for other self-hosted coding agents?

Broadly, yes. Other open-source agents follow the same shape — a container, a port, mounted persistent state, and your own model key. [OpenHands](https://github.com/OpenHands/OpenHands), for example, runs its GUI from a single `docker run` of `ghcr.io/openhands/agent-canvas` on port 8000 with `~/.openhands` and a projects directory mounted, and supports bring-your-own-model configuration ([OpenHands repository](https://github.com/OpenHands/OpenHands), retrieved July 2026).

The architectural difference to check when choosing a tool is what a "workspace" is. OpenHands mounts a projects directory into task sandboxes; Waynode's unit is a persistent cloned Git repository — a real worktree with its own branches, terminal state, and an agent-native Git surface (diffs, hunks, commits, push) beside the conversation, all of which survive between visits. If your workflow is "start an agent task at your desk, review and push from your phone later," that persistence is the feature to select for. For a comparison of self-hosting versus managed cloud agents, see [/learn](/learn).

## FAQ

### How much does it cost to self-host a coding agent?

The software is free: Waynode is MIT-licensed with no billing code active on self-hosted installs. Your costs are the server (a small VPS suffices for the app; disk scales with your repos) and your LLM provider's API usage, paid directly at provider rates.

### Can I run a self-hosted coding agent without a domain name?

Yes — on `http://localhost:3000` with `APP_URL` left at its default, which is fine for a single machine. You need a domain and HTTPS only for remote or mobile access, and OAuth callbacks must then match the public URL exactly.

### What happens to my code and API keys when I self-host?

They stay on your infrastructure. Repositories are cloned to a Docker volume on your host, credentials are encrypted at rest with your own `ENCRYPTION_KEY`, and LLM calls go from your server to your model provider with your key — no intermediary sees code or traffic.

### Do I need a GPU to self-host a coding agent?

No. The agent workspace itself is a lightweight web application; the language model runs at your API provider. A GPU only becomes relevant if you separately choose to serve a local model and point the agent's provider configuration at it.

### What is the difference between self-hosting Waynode and using Waynode Cloud?

Same open-source stack. Self-host is free and everything (repos, database, keys, billing) stays with you; Waynode Cloud is managed hosting with updates, isolated workspaces, encrypted secrets, backups, and support, from $39/mo (Starter: 3 seats, 3M agent tokens/mo, 10 GB), with a 15-day free trial for new organizations.
