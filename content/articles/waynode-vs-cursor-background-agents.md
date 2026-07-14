---
title: Waynode vs Cursor background agents
description: How Waynode's self-hosted agent workspaces compare with Cursor's cloud agents on hosting, persistence, mobile review, and pricing.
category: compare
slug: waynode-vs-cursor-background-agents
date: 2026-07-12
updated: 2026-07-12
author: Francesco Frapporti
keywords: waynode vs cursor, cursor background agents alternative, cursor cloud agent self-hosted
cover: /covers/waynode-vs-cursor-background-agents.png
---

![Waynode vs Cursor background agents Cover Image](/covers/waynode-vs-cursor-background-agents.png)

# Waynode vs Cursor background agents

Cursor's background agents (now called Cloud Agents) run coding tasks in isolated VMs managed by Cursor and hand you back a branch or pull request; they are a feature of the Cursor IDE and its subscription. Waynode is an open-source (MIT), self-hosted workspace where the agent works inside a persistent clone of your repository, with the diff, branches, and terminal living beside the conversation on desktop and mobile. Choose Cursor if you live in its IDE and want managed fire-and-forget task execution; choose Waynode if you want the agent's workspace on your own infrastructure and a place you can return to from any device.

**TL;DR**

- Cursor Cloud Agents run in "isolated VMs in the cloud with full development environments" on Cursor's infrastructure by default; execution can be delegated to your machines, but orchestration and model inference stay on Cursor's servers ([Cursor docs](https://cursor.com/docs/cloud-agent), [self-hosted docs](https://cursor.com/docs/cloud-agent/self-hosted)).
- Waynode is fully self-hostable: repos, database, credentials, and LLM keys stay with you (guided Docker Compose setup), or use Waynode Cloud managed hosting from $39/mo.
- Cursor's agent workspaces are per-task; Waynode spaces are persistent Git worktrees where conversation, files, branches, and terminal state survive between visits.
- Both offer mobile access. Cursor exposes agents via Cursor Web and an iOS app; Waynode is mobile-first around the same workspace, session, and diff, with an agent-native Git review surface.
- Cursor plans: Hobby free, Individual $20/mo, Teams $40/user/mo, Enterprise custom; Cloud Agents billed at API pricing on top ([cursor.com/pricing](https://cursor.com/pricing)).

## What are Cursor background agents (Cloud Agents)?

Cursor Cloud Agents, the current name for what launched as background agents, are asynchronous coding agents that run in isolated cloud VMs rather than on your laptop. An agent clones your repository from GitHub, GitLab, Azure DevOps, or Bitbucket Cloud, works on a separate branch, and pushes changes back to your repo, typically as a pull request ([Cursor Cloud Agent docs](https://cursor.com/docs/cloud-agent)).

Agents can be started from the Cursor desktop IDE (selecting the "Cloud" option), from Cursor Web at cursor.com/agents, from the Cursor iOS app, from Slack, GitHub, Bitbucket, or Linear via `@cursor` mentions, or through an API. Execution environments are defined per repo through agent-led setup, saved snapshots, or a Dockerfile referenced from `.cursor/environment.json` ([Cursor docs](https://cursor.com/docs/cloud-agent)).

Billing is separate from the editor subscription's included usage: "Cloud Agents are charged at API pricing for the selected model," with spend limits set on first use ([Cursor docs](https://cursor.com/docs/cloud-agent)). The underlying plans are Hobby (free, limited agent requests), Individual at $20/month, Teams at $40 per user/month, and Enterprise at custom pricing ([cursor.com/pricing](https://cursor.com/pricing)).

## What is Waynode?

Waynode is an open-source (MIT) coding-agent workspace you host yourself. Each workspace, called a "space", is a real cloned Git repository on disk: a persistent worktree, not a disposable task container. The agent engine is pi (open source), with pi-codex-goal for autonomous goal-driven runs; you can chat with the agent, send it an autonomous goal, or open a full terminal in the workspace.

The Git surface is agent-native: changed files, hunks, diffs, commits, branches, and push live beside the conversation, so "done" means ready for review rather than merely finished running. Sessions persist: conversation, files, branches, and terminal state survive between visits, so you can start at your desk and resume from a phone. Repo providers are GitHub and GitLab via OAuth. Source: [github.com/fornace/waynode](https://github.com/fornace/waynode).

There are two ways to run it. Self-hosting is free: clone the repo and run `./scripts/self-host.sh setup`; the guided installer collects the required OAuth and model-provider credentials, generates the server secrets, validates Compose, and starts on loopback. Your repos, database, credentials, LLM keys, and billing stay with you. Waynode Cloud is managed hosting of the same open-source stack: Starter $39/mo (3 seats, 3M agent tokens/mo, 10 GB), Pro $99/mo (10 seats, 8M tokens, 50 GB), Team $249/mo (25 seats, 20M tokens, 200 GB), with a 15-day free trial for new organizations.

## Where does the code actually run?

This is the sharpest difference between the two.

With Cursor Cloud Agents, the default is Cursor-managed VMs. Cursor does offer self-hosted execution modes ("My Machines" for individuals and "Self-Hosted Pool" for Enterprise teams), but these delegate only tool execution (terminal commands, file edits, browser actions) to your infrastructure. Agent orchestration and model inference remain on Cursor's servers, and "file chunks the model reads during inference" are still sent to Cursor. As the docs put it, self-hosted pools "do not move the agent loop out of Cursor's cloud." Self-Hosted Pool additionally requires an Enterprise plan, with capacity limits of 10 workers per user and 50 per team ([Cursor self-hosted docs](https://cursor.com/docs/cloud-agent/self-hosted)).

With self-hosted Waynode, the entire stack runs on your infrastructure: the web app, the workspaces, the Git credentials, and the database. You bring your own model keys, so inference goes to the configured provider under your own account. Hosted billing is disabled on self-host. The default Compose deployment assumes trusted users; KVM/microsandbox deployment is a separate advanced operator path. If you want someone else to run it, Waynode Cloud operates the server, updates, encrypted secrets, and Stripe billing. Interactive terminal access is currently self-hosted only.

In short: Cursor's "self-hosted" is hybrid: your machines execute, Cursor's cloud orchestrates and does inference. Waynode's self-hosted is the whole product.

## Comparison table

| | Cursor Cloud Agents | Waynode |
|---|---|---|
| What it is | Agent feature of the Cursor IDE/platform | Standalone coding-agent workspace |
| License | Proprietary | MIT, open source |
| Where code runs | Cursor-managed VMs by default; hybrid self-hosted execution (orchestration and inference stay on Cursor's servers) ([docs](https://cursor.com/docs/cloud-agent/self-hosted)) | Fully on your infrastructure (self-host) or Waynode Cloud |
| Workspace model | Per-task VM from a per-repo environment snapshot/Dockerfile ([docs](https://cursor.com/docs/cloud-agent)) | Persistent Git worktree per space; sessions survive between visits |
| Repo providers | GitHub, GitLab, Azure DevOps, Bitbucket Cloud ([docs](https://cursor.com/docs/cloud-agent)) | GitHub, GitLab (OAuth) |
| Review surface | Branch or pull request pushed to your repo | Diffs, hunks, commits, branches, push beside the conversation |
| Terminal access | No interactive workspace terminal documented ([docs](https://cursor.com/docs/cloud-agent)) | Full terminal in the workspace |
| Mobile | Cursor Web and iOS app to start and monitor agents ([docs](https://cursor.com/docs/cloud-agent)) | Mobile-first: same workspace, session, and diff; steer and push from a phone |
| Models | Frontier model catalog, agents billed at API pricing ([pricing](https://cursor.com/pricing)) | Bring your own keys (self-host); fast/reasoning/max tiers on Cloud (Fornace models, GLM, Qwen) |
| Pricing | Hobby free; Individual $20/mo; Teams $40/user/mo; Enterprise custom; agents billed at API pricing on top ([pricing](https://cursor.com/pricing)) | Self-host free; Cloud $39/$99/$249 per month with token allowances |

## Where Cursor is the better choice

Cursor is first an IDE, and its agents benefit from that. If your team already writes code in Cursor, Cloud Agents are one click away in the editor and can be triggered from Slack, Linear, GitHub, and Bitbucket ([docs](https://cursor.com/docs/cloud-agent)). The managed VMs come with full development environments, infrastructure you never have to operate. Support for Azure DevOps and Bitbucket Cloud is broader than Waynode's GitHub/GitLab. For fire-and-forget tasks with a clear definition of done ("add tests, run them, open a PR"), a managed per-task VM is exactly the right shape, and you review the result as an ordinary pull request.

## Where Waynode is the better choice

Waynode fits when the constraint is ownership or the workflow is longer than one task. If code cannot leave your infrastructure, self-hosted Waynode keeps everything, including which model provider sees your code, under your control, which Cursor's hybrid modes do not. If a piece of work spans days, a persistent worktree beats a fresh VM per task: the branch, the conversation, and the terminal state are still there when you come back. And if you review on the move, Waynode's mobile surface is built around the diff itself: follow a live task, read changed files hunk by hunk, steer the agent, and push a reviewed change from a phone. See [/learn](/learn) for the underlying model.

The honest caveat in the other direction: Waynode is not an IDE. If you want tab completion and in-editor agents while you type, Cursor does that and Waynode does not try to. Some teams run both: Cursor as the editor, Waynode as the durable place where longer agent work lives.

## FAQ

### Can Cursor background agents run fully self-hosted?

No. Cursor's My Machines and Self-Hosted Pool modes run tool execution on your machines, but agent orchestration and model inference remain on Cursor's servers, and file chunks read by the model are sent to Cursor ([Cursor docs](https://cursor.com/docs/cloud-agent/self-hosted)). Fully self-hosted operation, including model keys, requires a tool like Waynode.

### How much do Cursor Cloud Agents cost?

Cloud Agents are billed at API pricing for the selected model, on top of a Cursor plan: Hobby is free with limited agent requests, Individual is $20/month, Teams is $40 per user/month, and Enterprise is custom ([cursor.com/pricing](https://cursor.com/pricing)). Waynode is free to self-host; Waynode Cloud starts at $39/month with 3M agent tokens included.

### Is Waynode a replacement for the Cursor IDE?

No. Waynode is a workspace for agent-driven work (chat, autonomous goals, terminal, and Git review in one place), not an editor with completions. Teams can use Cursor for in-editor coding and Waynode for persistent, self-hosted agent sessions.

### Do Cursor agents keep a persistent workspace between tasks?

Cursor agents start from a per-repo environment (snapshot or Dockerfile) and work per task, pushing results to a branch ([Cursor docs](https://cursor.com/docs/cloud-agent)). Waynode spaces are persistent worktrees: the conversation, files, branches, and terminal state survive between visits and across devices.

### Which is better for reviewing agent work on a phone?

Both have mobile access. Cursor Web and the Cursor iOS app let you start and monitor agents, with review typically landing in a pull request ([Cursor docs](https://cursor.com/docs/cloud-agent)). Waynode is mobile-first around the workspace itself: the same session and diff appear on the phone, and you can steer the agent and push a reviewed change directly.
