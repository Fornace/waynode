---
title: What is Waynode? The self-hosted coding-agent workspace explained
description: Waynode is an open-source, self-hosted workspace where a coding agent works inside real cloned Git repos, with persistent sessions on any device.
category: guides
slug: what-is-waynode
date: 2026-07-12
updated: 2026-07-12
author: Francesco Frapporti
keywords: what is waynode, waynode ai, waynode review, coding agent workspace
cover: /covers/what-is-waynode.png
---

![What is Waynode? The self-hosted coding-agent workspace explained Cover Image](/covers/what-is-waynode.png)

# What is Waynode? The self-hosted coding-agent workspace explained

Waynode is an open-source (MIT), self-hosted **coding-agent workspace**: a place where an AI coding agent works inside a real cloned Git repository, and where the conversation, files, branches, and terminal state persist between visits and across devices. You can run it yourself with Docker Compose for free, or use Waynode Cloud, a managed hosting of the same open-source stack.

**TL;DR**

- Each workspace ("space") is a **real cloned Git repository** on disk: a persistent worktree, not a disposable task container.
- The agent engine is **pi** (open source), with **pi-codex-goal** for autonomous goal-driven runs. You can chat with the agent, send it an autonomous goal, or open a full terminal.
- An **agent-native Git surface** (changed files, hunks, diffs, commits, branches, push) lives beside the conversation. "Done" means ready for review, not merely finished running.
- **Persistent, mobile-first sessions**: start at your desk, resume from a phone; the same workspace, session, and diff everywhere.
- **Self-host free** (MIT, `docker compose up -d`) or **Waynode Cloud** from $39/mo with a 15-day free trial.
- Source: [github.com/fornace/waynode](https://github.com/fornace/waynode).

## What problem does Waynode solve?

Coding agents and cloud dev environments each solve part of the loop, but the loop itself is fragmented. Cloud agents such as [Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web) run tasks on Anthropic-managed cloud infrastructure. That is effective for firing off parallel tasks, but the environment belongs to the provider and is scoped to the session, not a durable workspace you own. Cloud dev environments such as [GitHub Codespaces](https://docs.github.com/billing/managing-billing-for-github-codespaces/about-billing-for-github-codespaces) or [Ona](https://ona.com/pricing) (formerly Gitpod) give you a full machine, but the agent workflow is not the organizing principle, and on Ona's Core tier environments auto-delete after 7 days of inactivity.

Waynode sits in the gap: a **durable, self-hostable place** where an agent works in your actual repository, the work survives between sessions, and you can return from any device, desktop browser or phone, to review, steer, and push. It is not better at everything; it is specifically built for the review-and-return loop around agent work.

## How does Waynode work?

### Spaces are real cloned repositories

When you create a space, Waynode clones your repository (GitHub or GitLab, via OAuth) onto disk. The space is a persistent worktree: the files, branches, uncommitted changes, and terminal state remain exactly as the agent (or you) left them. There is no "re-hydrate the container" step and no chat attachment pretending to be a codebase. This is the core design decision everything else follows from.

### The pi agent engine

The agent inside each space is **pi**, an open-source engine, with **pi-codex-goal** handling autonomous goal-driven runs. Three interaction modes cover the spectrum of control:

1. **Chat**: converse with the agent about the code, iteratively.
2. **Goal**: hand the agent an autonomous objective and let it run.
3. **Terminal**: open a full terminal in the workspace and do it yourself.

Because all three operate on the same persistent worktree, you can mix them freely: start a goal, watch it in chat, drop to the terminal to fix something by hand, then resume.

### The Git surface: "done" means reviewable

Waynode treats Git as a first-class part of the agent UI, not an export step. Changed files, hunks, diffs, commits, branches, and push live beside the conversation. When an agent run finishes, what you see is a reviewable change: you inspect the diff, adjust, commit, and push from the same screen. The standard Waynode framing: **"done" means ready for review, not merely finished running.**

### Mobile: the same workspace on a phone

The same space, session, and diff render on a phone. In practice this means you can follow a live agent task from anywhere, review the changed files, steer the agent mid-run, and push a reviewed change without opening a laptop. macOS and iOS native clients are planned (a native app exists in the repository).

## Who is Waynode for?

- **Developers who want agent work to be durable.** If you dislike that a cloud-agent task's environment evaporates when the task ends, spaces-as-real-repos is the fix.
- **Teams with self-hosting requirements.** Repos, database, credentials, and LLM keys stay on your infrastructure. No Stripe or hosted-billing code is active on self-host.
- **People who review agent output on the go.** The mobile-first session model is aimed at the "agent finished while I was away from my desk" moment.

It is a weaker fit if you mainly want many short, parallel, fire-and-forget tasks with zero infrastructure; a managed cloud agent is simpler for that (see the comparison pages under [/learn](/learn) for specific matchups).

## Self-host vs Waynode Cloud

| | Self-host | Waynode Cloud |
|---|---|---|
| Price | Free (MIT license) | Starter $39/mo · Pro $99/mo · Team $249/mo |
| Setup | `git clone` → `cp .env.example .env` → `docker compose up -d` → localhost:3000 | Sign up; 15-day free trial (5M trial tokens, 2 GB storage, 1 seat) |
| Data | Repos, database, credentials, LLM keys, billing all stay with you | Managed: updates, isolated workspaces, encrypted secrets, backups, support |
| Models | Bring your own model keys | Hosted fast/reasoning/max tiers (Fornace models, GLM, Qwen) |
| Code | Same open-source stack | Same open-source stack |

Hosted plan limits: Starter includes 3 seats, 3M agent tokens/mo, and 10 GB storage; Pro includes 10 seats, 8M tokens, 50 GB; Team includes 25 seats, 20M tokens, 200 GB. Billing is via Stripe web checkout.

On the security side, the session secret and encryption key are operator-owned, OAuth apps are configured per deployment, and a sandboxed microVM execution path exists when KVM is available.

## How does Waynode compare to other tools?

These categories overlap but optimize for different things. Competitor figures below are from their public pages as of July 2026.

| Tool | Category | Workspace model | Self-hostable | Entry price |
|---|---|---|---|---|
| **Waynode** | Coding-agent workspace | Persistent cloned repo (space), any device | Yes (MIT) | Free self-host; Cloud $39/mo |
| [Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web) | Cloud coding agent | Session-scoped, Anthropic-managed cloud environment | No (agent CLI is local; cloud sessions are managed) | Included in Pro, Max, and Team plans (research preview) |
| [Devin](https://devin.ai/pricing) | Autonomous AI engineer | Provider-managed cloud agents | No | Free tier; Pro $20/mo; Teams $80/mo + $40/mo per dev seat |
| [GitHub Codespaces](https://docs.github.com/billing/managing-billing-for-github-codespaces/about-billing-for-github-codespaces) | Cloud dev environment | On-demand VM, usage-billed | No | $0.18/hr (2-core) + $0.07/GB-mo storage; free monthly quota on personal accounts |
| [Ona](https://ona.com/pricing) (ex-Gitpod) | Agent + cloud dev environment | Managed environments; Core tier auto-deletes after 7 days idle | Enterprise VPC option | Core from $20/mo |
| [Coder](https://coder.com/pricing) | Self-hosted dev environments | Template-provisioned workspaces on your infra | Yes (open source) | Free Community edition; Premium priced annually per user |

Honest read: Devin and Claude Code are stronger for hands-off autonomous task volume on managed infrastructure. Codespaces, Ona, and Coder are stronger as general-purpose dev machines. Waynode's distinct offer is the combination: an agent-first workspace that is also a real, persistent repo you own, reachable from any device. Detailed matchups live under [/learn](/learn).

## How do I get started?

Self-host:

```bash
git clone https://github.com/fornace/waynode
cd waynode
cp .env.example .env   # add your model keys and secrets
docker compose up -d   # open localhost:3000
```

Then connect GitHub or GitLab via OAuth and create your first space. For the managed route, Waynode Cloud offers a 15-day free trial for new organizations. See [/learn](/learn) for guides.

## FAQ

### Is Waynode free?

Yes. Waynode is MIT-licensed and free to self-host; your repos, database, credentials, and LLM keys stay on your infrastructure. Waynode Cloud, the managed option, starts at $39/mo (Starter) after a 15-day free trial.

### What is a Waynode "space"?

A space is a real cloned Git repository on disk: a persistent worktree where the agent works. Files, branches, conversation, and terminal state survive between visits, unlike disposable per-task containers.

### What AI agent does Waynode use?

Waynode runs the open-source **pi** engine, with **pi-codex-goal** for autonomous goal-driven runs. You interact via chat, autonomous goals, or a full terminal in the workspace. Self-hosters bring their own model keys; Waynode Cloud includes hosted fast/reasoning/max model tiers (Fornace models, GLM, Qwen).

### Does Waynode work on mobile?

Yes. The same workspace, session, and diff are usable from a phone: you can follow a live task, review changed files, steer the agent, and push a reviewed change. Native macOS and iOS clients are planned.

### Which Git providers does Waynode support?

GitHub and GitLab, connected via OAuth configured per deployment. The Git surface (diffs, commits, branches, push) is built into the workspace next to the agent conversation.
