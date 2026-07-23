---
title: Waynode vs GitHub Codespaces
description: How GitHub Codespaces (cloud dev environments for humans) compares to Waynode, a persistent self-hosted workspace where a coding agent works.
category: compare
slug: waynode-vs-github-codespaces
date: 2026-07-12
updated: 2026-07-12
author: Francesco Frapporti
keywords: waynode vs github codespaces, github codespaces alternative, self-hosted codespaces alternative
cover: /covers/waynode-vs-github-codespaces.png
---

![Waynode vs GitHub Codespaces Cover Image](/covers/waynode-vs-github-codespaces.png)

# Waynode vs GitHub Codespaces

GitHub Codespaces is a managed cloud development environment: it spins up a container so a human developer can code in VS Code from a browser or desktop, billed per core-hour. Waynode is an open-source (MIT), self-hostable workspace where a coding agent does the work inside a real cloned Git repository, and you review diffs, steer the agent, and push from any device, including a phone. They overlap on "your repo, in the cloud, reachable from anywhere," but they answer different questions: Codespaces asks *where do I type?*; Waynode asks *where does the agent work, and where do I review?*

**TL;DR**

- **Codespaces** = ephemeral, metered compute for a human editing in VS Code. Stops after 30 minutes of inactivity by default; stopped codespaces are deleted after 30 days by default.
- **Waynode** = a durable "space" that is a persistent Git worktree on disk. The agent session, files, branches, and terminal state survive between visits.
- In Codespaces, you drive; in Waynode, an agent does (the open-source pi engine, with pi-codex-goal for autonomous goal runs): you chat, assign goals, or drop into a terminal.
- Codespaces is GitHub-hosted only. Waynode has a guided Docker Compose installer for your own hardware (free), or Waynode Cloud from $39/mo.
- Codespaces bills usage: $0.18/hr for a 2-core machine, $0.07/GB-month storage. Waynode self-host is free (bring your own model keys); Waynode Cloud is a flat monthly plan with token quotas.
- They are complementary more than competitive: many teams will keep Codespaces for hands-on-keyboard work and use Waynode for delegated agent work.

## What is GitHub Codespaces?

GitHub Codespaces provides on-demand development containers running in GitHub's cloud, configured via `devcontainer.json` and accessed through VS Code (web or desktop), JetBrains IDEs, or SSH. Compute is billed per core-hour: $0.18/hour for a 2-core machine, scaling linearly to $2.88/hour at 32 cores, plus $0.07 per GB-month of storage ([GitHub Codespaces billing docs](https://docs.github.com/en/billing/concepts/product-billing/github-codespaces)). Personal accounts get a free monthly quota (120 core hours and 15 GB-month on GitHub Free, 180 core hours and 20 GB-month on GitHub Pro), while organization and enterprise plans include no free Codespaces quota at all; org usage is paid from the first minute ([billing docs](https://docs.github.com/en/billing/concepts/product-billing/github-codespaces)).

Lifecycle is deliberately ephemeral: a codespace stops after 30 minutes of inactivity by default, and stopped codespaces are auto-deleted after 30 days by default ([codespace lifecycle docs](https://docs.github.com/en/codespaces/about-codespaces/the-codespace-lifecycle)). Saved changes in `/workspaces` persist across stop/restart, but changes outside it are cleared on rebuild, and uncommitted work is lost if the codespace is deleted before you push. Storage is billed for as long as the codespace exists, including while it is stopped ([billing docs](https://docs.github.com/en/billing/concepts/product-billing/github-codespaces)).

## What is Waynode?

[Waynode](https://github.com/fornace/waynode) is an open-source (MIT), self-hosted coding-agent workspace. Each workspace, called a "space," is a real cloned Git repository on disk: a persistent worktree, not a disposable task container. The agent engine is pi, with pi-codex-goal for autonomous goal-driven runs; you can chat with the agent, hand it a goal, or open a full terminal in the workspace yourself.

The Git surface is agent-native: changed files, hunks, diffs, commits, branches, and push live beside the conversation, so "done" means ready for review rather than merely finished running. Sessions persist: conversation, files, branches, and terminal state survive between visits, so you can start at your desk and resume from a phone. Repos connect via GitHub or GitLab OAuth. It runs two ways: self-hosted (free: clone the repo and run `./scripts/self-host.sh setup`, providing an OAuth app and model-provider key during setup; your repos, database, credentials, and LLM keys stay with you) or Waynode Cloud, managed hosting of the same stack with a 15-day free trial. For background, see [/learn](/learn).

## How do they compare?

| | GitHub Codespaces | Waynode |
|---|---|---|
| Primary user | Human developer in an IDE | Coding agent, supervised by a human |
| Environment lifetime | Ephemeral; stops after 30 min idle, deleted after 30 days stopped (defaults) ([docs](https://docs.github.com/en/codespaces/about-codespaces/the-codespace-lifecycle)) | Persistent worktree; session, files, branches, terminal state survive between visits |
| What a workspace is | Dev container built from `devcontainer.json` | Real cloned Git repository on disk |
| Interface | VS Code (web/desktop), JetBrains, SSH | Chat + goals + diffs/commits/push beside the conversation; full terminal; mobile-first web |
| Hosting | GitHub's cloud only | Self-host (Docker Compose) or Waynode Cloud |
| Source availability | Proprietary service | MIT, open source |
| Repo providers | GitHub | GitHub and GitLab (OAuth) |
| Pricing model | Usage: $0.18/hr (2-core) to $2.88/hr (32-core) + $0.07/GB-month; free personal quota 120-180 core hrs/mo; no free org quota ([docs](https://docs.github.com/en/billing/concepts/product-billing/github-codespaces)) | Self-host free (BYO model keys); Cloud: Starter $39/mo (3 seats, 3M tokens, 10 GB) · Pro $99/mo · Team $249/mo |
| AI assistance | GitHub Copilot via editor extension, a separate product ([docs](https://docs.github.com/en/codespaces/reference/using-github-copilot-in-github-codespaces)) | Built in: the workspace is operated by an agent |
| Mobile review | Editing UX is desktop-oriented | Same workspace, session, and diff on a phone |

## Is Waynode a self-hosted Codespaces alternative?

Partially, and only for a specific use. If what you want from Codespaces is *a full IDE in the browser for a human* (devcontainer builds, extensions, port forwarding into a live editor), Waynode does not replace that; self-hosted cloud IDE platforms like Coder or Gitpod/Ona are the closer substitutes. What Waynode self-host does give you is the piece Codespaces doesn't offer at all: a durable, self-owned workspace where an agent works in your actual repository, with an operator-owned encryption key and session secret, per-deployment OAuth apps, and your own LLM keys. The default Compose deployment is for a trusted individual or small team and does not provide hardware isolation between its users; a separate KVM/microsandbox deployment is an advanced operator path. There is no per-hour Waynode meter; the cost is your hardware plus your model usage.

## When is Codespaces the better choice?

- You are writing and debugging code yourself and want a full VS Code environment with extensions, port forwarding, and devcontainer reproducibility.
- You want deep GitHub integration: one-click environments from any GitHub repo or pull request, prebuilds, org-level policies.
- Your use is occasional and bursty on a personal account. The free quota (120 core hours/month on GitHub Free) covers a lot of casual use before any bill appears ([docs](https://docs.github.com/en/billing/concepts/product-billing/github-codespaces)).
- You have no appetite for infrastructure. There is nothing to operate; GitHub runs everything.

## When is Waynode the better choice?

- You want to hand a goal to an agent, close the laptop, and come back to a reviewable branch, not keep an editor session alive.
- You review from anywhere: following a live task, reading diffs, steering the agent, and pushing a reviewed change from a phone is the designed-for path, not an afterthought.
- You need continuity. The 30-minute idle stop and 30-day deletion defaults that make Codespaces cheap to operate are exactly what you don't want for long-running, resumable agent sessions. A Waynode space just stays.
- You want self-hosting and data control: MIT-licensed, runs on your Docker host, GitLab as well as GitHub, and no usage meter.
- You want predictable team cost. Since orgs get no free Codespaces quota, per-core-hour billing for a team is open-ended; Waynode Cloud is a flat monthly plan, and self-host is free.

Both tools can coexist: Codespaces for the code you write, Waynode for the code you delegate. For adjacent comparisons, see [/compare/waynode-vs-gitpod](/compare/waynode-vs-gitpod) and [/compare/waynode-vs-coder](/compare/waynode-vs-coder).

## FAQ

### Can GitHub Codespaces run coding agents?

Codespaces is built for interactive human use; GitHub's own Copilot coding agent runs in its own ephemeral environment powered by GitHub Actions, not in your codespace ([Copilot coding agent docs](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent)). You can run a CLI agent inside a codespace manually, but the environment still stops after 30 minutes of inactivity by default and is deleted after 30 days stopped, so long-lived agent sessions work against its lifecycle model ([lifecycle docs](https://docs.github.com/en/codespaces/about-codespaces/the-codespace-lifecycle)).

### Is Waynode free?

Self-hosted Waynode is free and MIT-licensed: clone the repo and run the guided `./scripts/self-host.sh setup` installer. You need Docker Compose v2, an OAuth app, and your own LLM API key. Waynode Cloud, the managed option, starts at $39/month (Starter: 3 seats, 3M agent tokens, 10 GB) with a 15-day free trial.

### Does Codespaces charge while a codespace is stopped?

Compute charges stop, but storage is billed for as long as the codespace exists: $0.07 per GB-month until it is deleted ([billing docs](https://docs.github.com/en/billing/concepts/product-billing/github-codespaces)).

### Does Waynode work with GitLab?

Yes. Waynode connects to both GitHub and GitLab via OAuth, whereas Codespaces is GitHub-only.

### Do I lose work when a codespace is deleted?

Uncommitted changes exist only inside the codespace; if it is deleted (by default, 30 days after it was stopped) without pushing to a remote, that work is lost ([lifecycle docs](https://docs.github.com/en/codespaces/about-codespaces/the-codespace-lifecycle)). Waynode's model avoids this class of loss by making the workspace itself persistent.
