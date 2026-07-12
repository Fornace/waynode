---
title: "Self-hosted vs cloud coding agents: how to choose"
description: A decision framework for choosing between self-hosted and cloud coding agents, covering data control, cost structure, maintenance, and compliance.
category: guides
slug: self-hosted-vs-cloud-coding-agents
date: 2026-07-12
updated: 2026-07-12
author: Francesco Frapporti
keywords: self-hosted vs cloud ai coding agent, should i self-host coding agent, coding agent data privacy
---

# Self-hosted vs cloud coding agents: how to choose

Choose a cloud coding agent when you want zero setup and someone else operating the infrastructure; choose a self-hosted agent when your code, credentials, and LLM spend must stay under your control, and you can accept the operational work that comes with running it. The decision is rarely about agent quality — most self-hostable agents call the same frontier models via API — and mostly about where your repository is cloned, who holds the keys, and how you pay for tokens.

**TL;DR**

- **Cloud agents** (OpenAI Codex cloud tasks, Devin, Cursor cloud agents, GitHub Copilot coding agent) clone your repo into vendor-operated sandboxes. Fast to adopt, subscription-priced, but your source and Git credentials transit third-party infrastructure.
- **Self-hosted agents** run on hardware you control. Your repos, database, and API keys never leave your network, and you pay model providers directly (BYO keys) — but you patch, back up, and secure the deployment yourself.
- Cost models differ structurally: cloud is subscription plus metered credits; self-hosted is infrastructure cost plus raw API token prices with no markup.
- Compliance-constrained teams (regulated industries, client-code agencies, air-gapped environments) usually need self-hosting or a vendor VPC deployment.
- Some tools offer both modes — Devin has a VPC enterprise option, and open-source workspaces like [Waynode](https://github.com/fornace/waynode) can be self-hosted free or used as managed hosting.

## What is the actual difference?

A **cloud coding agent** is a managed service: the vendor clones your repository into a sandbox on their infrastructure, runs the agent there, and returns a pull request. You grant it access to your GitHub or GitLab account, and the vendor operates everything — compute, secrets, model routing, updates.

A **self-hosted coding agent** runs the same loop on machines you control — a workstation, an on-prem server, or your own cloud account. The repository is cloned to your disk, the agent process runs under your OS, and model calls go directly from your network to the LLM provider (or to a local model). Nothing about your code or credentials passes through the agent vendor.

Terminal-based agents like Claude Code blur the line: the agent process runs locally on your machine, but code context is sent to Anthropic's API for inference, and its subscription plans (Pro $20/mo, Max $100–$200/mo, per [claude.com/pricing](https://claude.com/pricing)) bill through Anthropic. "Self-hosted" in the strict sense means the whole workspace — repo storage, session state, execution sandbox — lives on your infrastructure, with only inference (optionally) leaving it.

## Comparison: self-hosted vs cloud coding agents

| Dimension | Cloud agent | Self-hosted agent |
|---|---|---|
| **Where your repo is cloned** | Vendor-operated sandbox/VM | Your own disk or server |
| **Git credentials** | OAuth grant held by vendor | Stay in your deployment |
| **LLM keys and billing** | Vendor's keys; you buy credits/subscription | Your keys; you pay API list price |
| **Setup effort** | Minutes (sign in, connect repo) | Hours (Docker/compose, env config, OAuth apps) |
| **Maintenance** | None (vendor updates) | Yours: updates, backups, TLS, secrets |
| **Model choice** | Vendor's menu, sometimes locked | Any provider or local models |
| **Cost structure** | Subscription + metered credits | Infra cost + raw token spend |
| **Compliance/data residency** | Vendor's certifications and DPA | Whatever you enforce; data never leaves |
| **Failure mode** | Vendor outage/policy change | Your ops mistake |

## Who sees your code with a cloud coding agent?

With any cloud agent, at minimum two parties process your source: the agent vendor (whose sandbox clones the repo) and the model provider (who receives code context in prompts). Sometimes they are the same company, sometimes not — Cursor's cloud agents run on Cursor infrastructure but call third-party frontier models; its privacy mode commits that "we will not train on your data" with contractual controls on model providers ([cursor.com/security](https://cursor.com/security)). OpenAI states there is no training on business data by default for ChatGPT Business/Enterprise plans that include Codex ([Codex pricing docs](https://developers.openai.com/codex/pricing)).

Training opt-outs are not the whole story. The practical exposure surface also includes:

- **Git credentials**: the OAuth token that lets the agent push branches is held and exercised by the vendor.
- **Secrets in the repo or environment**: `.env` files, internal URLs, and infrastructure details visible to the sandbox.
- **Retention and logs**: prompts, diffs, and terminal output may be retained per the vendor's policy, which you should read rather than assume.

Self-hosting collapses this surface to one party: the model provider you choose to send prompts to. If you run local models, it collapses to zero. This is the core answer to "should I self-host a coding agent" — self-host when reducing that surface is a requirement, not a preference.

## How do the cost structures compare?

Cloud agents are subscription-first with metered usage on top. Current published pricing (July 2026):

| Product | Entry price | Metering |
|---|---|---|
| OpenAI Codex (via ChatGPT) | Free tier; Plus $20/mo; Pro from $100/mo; Business $20/user/mo annual | Token-based credits since April 2026 ([source](https://developers.openai.com/codex/pricing)) |
| Devin (Cognition) | Free tier; Pro $20/mo; Max $200/mo; Teams $80/mo + $40/seat | Consumption-based on model and task; Enterprise adds VPC deployment ([source](https://devin.ai/pricing/)) |
| Cursor | Individual from $20/mo; Teams $40/user/mo | Cloud agents bill usage-based on top of plans ([source](https://cursor.com/pricing)) |
| GitHub Copilot coding agent | Pro $10/mo ($15 credits); Pro+ $39/mo ($70); Max $100/mo ($200) | AI Credits, 1 credit = $0.01; agent on paid plans ([source](https://github.com/features/copilot/plans)) |
| Claude Code | Pro $20/mo; Max $100–$200/mo | Plan rate limits; API pay-as-you-go alternative ([source](https://claude.com/pricing)) |

Self-hosting inverts the structure: the software is often free (open source), and you pay two real costs — infrastructure (a VPS or spare machine running Docker is typically $5–$40/mo, or effectively zero on hardware you own) and model API usage at list price with no intermediary margin. For heavy agent use, BYO keys is usually cheaper per token than vendor credits; for light use, a flat subscription can be cheaper than the discipline of managing keys. There is also an unpriced cost: your time operating the deployment.

## What maintenance does self-hosting actually require?

Be honest about the burden before choosing it:

- **Initial setup**: cloning, environment configuration, creating GitHub/GitLab OAuth apps, DNS/TLS if you expose it beyond localhost. Budget an afternoon, not five minutes.
- **Updates**: you pull new images and migrate when releases ship; nobody does it for you.
- **Backups**: workspace state, database, and secrets are yours to back up and restore.
- **Security**: session secrets and encryption keys are operator-owned — a genuine control and a genuine responsibility. Sandboxing agent execution (e.g. microVMs where KVM is available) is on you to enable.

If your team has no one willing to own this, a managed offering is the more truthful choice even if self-hosting looks free on paper.

## When should you choose each?

**Choose a cloud agent when:**

- You want to try agentic coding today with zero infrastructure work.
- Your code is not subject to residency, client-confidentiality, or regulatory constraints.
- Usage is light enough that a flat subscription beats managing API keys.
- You value vendor-managed sandboxing and updates over control.

**Choose self-hosted when:**

- Source code, credentials, or client IP must not transit third-party infrastructure.
- You need model freedom — a specific provider, a cheaper model, or local inference.
- Agent usage is heavy enough that raw API pricing beats credit markups.
- Compliance requires you to point at exactly where data lives (self-hosting makes the answer "our server").

**Consider a hybrid** when different repos have different sensitivity: cloud agents for open-source and low-risk work, self-hosted for the crown jewels. Devin's enterprise VPC option ([devin.ai/pricing](https://devin.ai/pricing/)) is one vendor-managed version of this.

## Where does Waynode fit?

[Waynode](https://github.com/fornace/waynode) is one example of a tool built to offer both modes with the same open-source (MIT) stack. Self-hosted, it runs via `docker compose up -d`; each workspace is a real cloned Git repository on disk, your database and LLM keys stay with you, and you bring your own model keys. [Waynode Cloud](/learn) is the managed version of the same stack — updates, isolated workspaces, encrypted secrets, and backups handled for you, from $39/mo (Starter: 3 seats, 3M agent tokens/mo, 10 GB) up to $249/mo (Team: 25 seats, 20M tokens, 200 GB), with a 15-day free trial for new organizations. Because both modes run the same open-source stack, teams can start managed and move to self-hosting (or the reverse) without changing tools. It does not currently offer SSO or compliance certifications, so enterprises with those requirements should evaluate accordingly. Feature-level comparisons against specific cloud agents are collected at [/learn](/learn).

## FAQ

### Is a self-hosted coding agent more private than a cloud one?

Structurally yes: self-hosting removes the agent vendor from the data path, leaving only the model provider you send prompts to (or no one, with local models). A cloud agent's privacy depends on its retention, training, and access policies, which vary by vendor and plan.

### Is self-hosting a coding agent cheaper?

For heavy usage, usually — you pay raw API token prices plus modest infrastructure costs instead of subscription credits with margin. For light or occasional use, a $10–$20/mo cloud subscription is often cheaper than the time spent operating your own deployment.

### Can I use frontier models like GPT or Claude with a self-hosted agent?

Yes. Self-hosted agents typically use bring-your-own API keys, so you can point them at OpenAI, Anthropic, or any provider — code execution and repository storage stay local while only inference requests leave your network.

### Do cloud coding agents train on my code?

Major vendors default to no training for business plans — OpenAI states no training on ChatGPT Business/Enterprise data by default, and Cursor's privacy mode commits to no training with contractual controls on model providers. Check the specific plan's policy; consumer tiers can differ.

### What is the minimum setup to self-host a coding agent workspace?

For Waynode: `git clone`, copy `.env.example` to `.env`, run `docker compose up -d`, and open localhost:3000, plus a GitHub or GitLab OAuth app for repo access and an LLM API key. Comparable open-source tools have similar Docker-based setups; expect an afternoon including OAuth configuration.
