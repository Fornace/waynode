---
title: Waynode vs Gitpod (Ona)
description: How Waynode's self-hosted persistent agent workspaces compare with Ona (formerly Gitpod): product, pricing, self-hosting, and the OpenAI acquisition.
category: compare
slug: waynode-vs-gitpod
date: 2026-07-12
updated: 2026-07-12
author: Francesco Frapporti
keywords: waynode vs gitpod, gitpod alternative, ona alternative, self-hosted gitpod alternative
---

# Waynode vs Gitpod (Ona)

Gitpod no longer exists as a standalone product: it rebranded to Ona in September 2025, pivoted from cloud dev environments to AI agent orchestration, and OpenAI announced its acquisition of Ona in June 2026 to power long-running Codex tasks. Waynode is an open-source (MIT), self-hostable coding-agent workspace where each workspace is a real cloned Git repository that persists between visits. The practical choice today: Ona if you want managed, ephemeral agent environments inside a large-vendor ecosystem; Waynode if you want a durable agent workspace you run yourself, with your own model keys and no dependence on a vendor's roadmap.

**TL;DR**

- Gitpod rebranded to [Ona](https://ona.com/stories/gitpod-is-now-ona) on September 2, 2025; the classic Gitpod pay-as-you-go product [was sunset on October 15, 2025](https://ona.com/stories/gitpod-classic-payg-sunset).
- [OpenAI announced it is acquiring Ona](https://siliconangle.com/2026/06/11/openai-acquires-ai-agent-orchestration-startup-ona/) on June 11, 2026; the team joins the Codex organization. The standalone platform's long-term future is undisclosed.
- Ona pricing: a Free tier (3 parallel environments, up to 4 vCPU, per the [sunset announcement](https://ona.com/stories/gitpod-classic-payg-sunset)), Core from $20/month, Enterprise custom; usage billed in Ona Compute Units ([pricing page](https://ona.com/pricing)).
- Ona self-hosting is Enterprise-only (customer-managed VPC on AWS or GCP, custom pricing). Gitpod [ended free self-hosted support in December 2022](https://devclass.com/2022/12/09/gitpod-abandons-self-hosted-product-in-favor-of-dedicated-cloud/).
- Waynode is MIT-licensed and self-hosts with `docker compose up -d`; workspaces are persistent Git worktrees, not ephemeral containers. Hosted plans start at $39/month.

## What happened to Gitpod?

Gitpod spent years as a cloud development environment (CDE) product: one-click, ephemeral workspaces for humans. On September 2, 2025 the company [rebranded to Ona](https://ona.com/stories/gitpod-is-now-ona) and repositioned around three components: **Ona Agents** (software-engineering agents managed through a conversational interface, browser VS Code, or desktop IDEs), **Ona Environments** (ephemeral, sandboxed cloud workspaces configured via `devcontainer.json` and `automations.yml`), and **Ona Guardrails** (enterprise controls: RBAC, SSO/OIDC, command deny lists, audit trails, VPC deployment).

The legacy product, "Gitpod Classic," [stopped accepting logins and new environments for pay-as-you-go users on October 15, 2025](https://ona.com/stories/gitpod-classic-payg-sunset). Migration required moving from `.gitpod.yml` to `devcontainer.json` and signing up for a new account at app.ona.com; enterprise customers received custom migration timelines.

Then, on June 11, 2026, [OpenAI announced it is acquiring Ona](https://siliconangle.com/2026/06/11/openai-acquires-ai-agent-orchestration-startup-ona/). Terms were not disclosed; OpenAI stated the technology will improve Codex's ability to run tasks that span hours or days, and the Ona team joins OpenAI's Codex team. As of July 2026, ona.com still sells the standalone platform, but its roadmap independence is an open question anyone evaluating it should weigh.

## What is Waynode?

[Waynode](https://github.com/fornace/waynode) is an open-source (MIT), self-hosted coding-agent workspace. Each workspace ("space") is a **real cloned Git repository on disk**, a persistent worktree, not a disposable task container. The agent engine is pi (open source), with pi-codex-goal for autonomous goal-driven runs; you can chat with the agent, send it an autonomous goal, or open a full terminal in the workspace.

Two properties distinguish it from the CDE lineage Gitpod came from:

- **Persistence.** The conversation, files, branches, and terminal state survive between visits. Start at your desk, resume from a phone. Ona Environments are ephemeral by design (Core-plan environments auto-delete after 7 days of inactivity, per the [pricing page](https://ona.com/pricing)).
- **An agent-native Git surface.** Changed files, hunks, diffs, commits, branches, and push live beside the conversation. "Done" means ready for review, not merely finished running.

Waynode connects to GitHub and GitLab via OAuth, and a sandboxed microVM execution path exists when KVM is available.

## Waynode vs Ona: comparison table

| | Waynode | Ona (formerly Gitpod) |
|---|---|---|
| Product category | Persistent coding-agent workspace | Agent orchestration + ephemeral cloud environments |
| Workspace model | Persistent Git worktree on disk; sessions survive between visits | Ephemeral, sandboxed environments; 7-day auto-delete on Core ([source](https://ona.com/pricing)) |
| License | MIT, fully open source | Core source under AGPL (proprietary license removed after the 2022 self-hosted shutdown); the platform is a commercial service ([source](https://devclass.com/2022/12/09/gitpod-abandons-self-hosted-product-in-favor-of-dedicated-cloud/)) |
| Self-hosting | Free: `git clone` → `docker compose up -d` | Enterprise plan only: customer-managed VPC on AWS/GCP, custom pricing ([source](https://ona.com/pricing)) |
| Entry price (hosted) | Starter $39/mo (3 seats, 3M agent tokens, 10 GB) | Core from $20/mo, usage in OCUs (80–2,200 OCUs/mo included; add-ons from $10/40 OCUs) ([source](https://ona.com/pricing)) |
| Models | Hosted: fast/reasoning/max tiers (Fornace, GLM, Qwen). Self-host: bring your own keys | Private LLM access with MCP support; model flexibility via AWS Bedrock, Google Vertex, or private APIs ([source](https://ona.com/stories/gitpod-is-now-ona)) |
| Workspace setup | OAuth to GitHub or GitLab; workspace is a clone of your repo | Declarative, via `devcontainer.json` and `automations.yml` ([source](https://ona.com/stories/gitpod-is-now-ona)) |
| Mobile | Mobile-first web; same workspace/session/diff on a phone; native macOS/iOS clients planned | Browser VS Code and desktop IDE handoff ([source](https://ona.com/stories/gitpod-is-now-ona)) |
| Enterprise controls | Operator-owned secrets/encryption keys; per-deployment OAuth apps | SSO/OIDC, audit trails, RBAC, command deny lists (Guardrails) ([source](https://ona.com/stories/gitpod-is-now-ona)) |
| Vendor status | Independent open-source project | Acquisition by OpenAI announced June 2026 ([source](https://siliconangle.com/2026/06/11/openai-acquires-ai-agent-orchestration-startup-ona/)) |

## How does pricing actually compare?

They meter different things. Ona bills in **Ona Compute Units (OCUs)**, a normalized measure covering both agent token usage and infrastructure: roughly 1 OCU for a small codebase explanation, 1 OCU for one hour of a standard VM, 7 OCUs/hour for a GPU VM. There is a Free tier (3 parallel environments, up to 4 vCPU); Core starts at $20/month with 80–2,200 OCUs included depending on configuration; add-ons cost from $10 per 40 OCUs; Enterprise is custom ([ona.com/pricing](https://ona.com/pricing)).

Waynode hosted plans bundle seats, agent tokens, and storage at a flat rate: Starter $39/mo (3 seats, 3M agent tokens/mo, 10 GB), Pro $99/mo (10 seats, 8M tokens, 50 GB), Team $249/mo (25 seats, 20M tokens, 200 GB), with a 15-day free trial for new organizations (5M trial tokens, 2 GB storage, 1 seat). Self-hosting is free under MIT; you pay only your own infrastructure and model API keys.

If your workload is bursty compute (big builds, GPU jobs), Ona's usage metering can be efficient. If your workload is sustained agent work on repositories, flat per-seat pricing (or free self-hosting with your own keys) is easier to forecast.

## Is there a self-hosted Gitpod alternative?

This is the sharpest difference. Gitpod [dropped its free self-hosted product in December 2022](https://devclass.com/2022/12/09/gitpod-abandons-self-hosted-product-in-favor-of-dedicated-cloud/), and under Ona, self-hosting exists only as an **Enterprise** feature: a deployment inside your VPC on AWS or GCP, at custom pricing ([ona.com/pricing](https://ona.com/pricing)). There is no supported way for an individual or small team to run Ona on their own hardware.

Waynode self-hosts by design: `git clone` the [repo](https://github.com/fornace/waynode), `cp .env.example .env`, `docker compose up -d`, open localhost:3000. Your repos, database, credentials, LLM keys, and billing stay with you; no hosted-billing code is active on self-host. If "self-hosted Gitpod alternative" is your search, note that you are really choosing between two categories: Waynode replaces the *agent workspace* part, not the full CDE feature set (fleet-scale ephemeral environments, standardized dev containers) that Gitpod was known for.

## When is Ona the better choice?

- **Fleet-scale ephemeral environments.** Ona inherits years of CDE engineering; if you want many parallel, disposable, `devcontainer.json`-standardized environments, that is what the platform is built for.
- **Enterprise compliance out of the box.** Guardrails ships SSO/OIDC, audit trails, RBAC, and command deny lists ([source](https://ona.com/stories/gitpod-is-now-ona)). Waynode does not claim these; its security posture is operator-owned keys and per-deployment OAuth.
- **Big machines on demand.** Core supports up to 32 cores / 128 GB RAM / 200 GB disk and GPUs ([source](https://ona.com/pricing)).
- **Codex-centric teams.** Post-acquisition, Ona's technology is set to become the execution layer for long-running Codex tasks; if you are committed to OpenAI's agent stack, that alignment works in your favor.

## When is Waynode the better choice?

- **You want the workspace to outlive the task.** Waynode sessions (conversation, branches, terminal) persist between visits and across devices, versus Ona's ephemeral model.
- **You want real self-hosting without an enterprise contract.** MIT license, Docker Compose, your keys.
- **You review from a phone.** The same workspace, session, and diff render mobile-first; you can follow a live task, steer the agent, and push a reviewed change from a phone.
- **You want vendor independence.** Gitpod users have absorbed a rebrand, a forced migration, a product sunset, and an acquisition announcement within ten months. An MIT-licensed stack you run yourself cannot be sunset out from under you.
- **You care about the Git surface.** Diffs, hunks, commits, and push live beside the agent conversation; the unit of "done" is a reviewable change.

See [/learn](/learn) for how Waynode workspaces work.

## FAQ

### Is Gitpod still available?

No. Gitpod rebranded to Ona on September 2, 2025, and the classic pay-as-you-go product stopped accepting logins and new environments on October 15, 2025 ([source](https://ona.com/stories/gitpod-classic-payg-sunset)). Enterprise customers had custom migration timelines to the Ona platform.

### Did OpenAI buy Gitpod?

OpenAI announced on June 11, 2026 that it is acquiring Ona, the company formerly known as Gitpod, to improve Codex's ability to run tasks spanning hours or days ([source](https://siliconangle.com/2026/06/11/openai-acquires-ai-agent-orchestration-startup-ona/)). Terms were not disclosed, and the standalone Ona platform's long-term roadmap has not been publicly stated.

### Can I self-host Ona for free?

No. Ona's self-hosted option (customer-managed VPC on AWS or GCP) is available only on the custom-priced Enterprise plan ([source](https://ona.com/pricing)); Gitpod ended free self-hosted support in December 2022. Waynode self-hosts for free under the MIT license via Docker Compose.

### Is Waynode a drop-in Gitpod replacement?

Not exactly. Gitpod/Ona is built around ephemeral, fleet-scale dev environments and enterprise guardrails; Waynode is a persistent agent workspace where each space is a real cloned Git repository with an agent, terminal, and Git review surface. Teams that mainly want an agent working durably in their repo, reviewable from anywhere, fit Waynode; teams that want disposable standardized environments at scale fit Ona.

### How do Waynode and Ona pricing models differ?

Ona meters usage in Ona Compute Units covering agent tokens plus infrastructure (Core from $20/month with 80–2,200 OCUs included; add-ons from $10/40 OCUs). Waynode hosted plans are flat: $39, $99, or $249 per month for bundled seats, agent tokens, and storage, and self-hosting costs nothing beyond your own infrastructure and model keys.
