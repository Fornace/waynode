---
title: Running coding agents from your phone
description: How to follow, review, and steer AI coding agents from a phone, what a good mobile agent workflow requires, and where mobile honestly falls short.
category: guides
slug: coding-agents-on-your-phone
date: 2026-07-12
updated: 2026-07-12
author: Francesco Frapporti
keywords: coding agent mobile, run claude code from phone, review code on phone ai agent, mobile ai development workflow
---

# Running coding agents from your phone

You can run coding agents from a phone because the agent does not run *on* the phone: it runs in a cloud workspace or on a machine you own, and the phone is the surface where you start tasks, follow progress, review diffs, and approve or redirect the work. The major agent vendors ship some version of this today — Claude Code on the web monitored from the Claude mobile app, OpenAI Codex in the ChatGPT app, GitHub Copilot's cloud agent in GitHub Mobile, Cursor's cloud agents via an iOS app and mobile web — and self-hosted tools like Waynode do the same against your own infrastructure.

**TL;DR**

- Agents work asynchronously; a phone is enough to supervise them because supervision is reading and deciding, not typing code.
- A usable mobile agent workflow needs four things: live task following, diff review, mid-task steering, and notification when the agent finishes or gets stuck.
- Hosted options: Claude Code on the web (monitored from the Claude app), Codex in the ChatGPT mobile app, Copilot cloud agent in GitHub Mobile, Cursor cloud agents on iOS/web.
- Self-hosted option: [Waynode](https://github.com/fornace/waynode) exposes the same workspace, session, and diff view on a phone, backed by a persistent Git worktree on your own server.
- Honest limit: phones work for review and steering, poorly for deep debugging, multi-file editing, and anything requiring a real terminal for long stretches.

## Why does mobile matter for agent-driven development?

Because the economics of coding agents are asynchronous. An agent given a well-scoped task works for minutes to hours without needing you; the human's job compresses into short, bursty interventions — read the plan, glance at the diff, answer a question, approve a push. None of those interventions requires a keyboard or a 27-inch monitor. They require the same things a messaging app requires: a readable thread, a notification, and a couple of buttons.

This inverts the old assumption that mobile coding is a gimmick. Writing code on a phone remains impractical. But in an agent workflow you are rarely writing code — you are reviewing it, and review latency is what actually gates throughput. If an agent finishes a task at 6:40 pm and you don't see it until 9 am, the agent's speed bought you nothing. If you can approve or redirect from the train, the loop keeps moving.

## What does a good mobile agent workflow need?

Four capabilities, in decreasing order of how often you use them:

1. **Live task following.** A stream of what the agent is doing right now — commands run, files touched, reasoning summaries — that survives you locking the phone and coming back.
2. **Diff review.** File-by-file, hunk-by-hunk changes rendered legibly on a small screen. A wall of unified diff in a chat bubble does not count; you need changed-file lists you can drill into.
3. **Steering.** The ability to send a correction mid-task ("use the existing retry helper, don't write a new one") and have it land in the same session, not spawn a fresh context-free run.
4. **Push and hand-off.** Notification when the agent finishes or blocks, and a way to either finish the loop on the phone (approve, push, open a PR) or pick up the exact session later at a desk.

Anything missing from this list turns the phone into a read-only status page, which is better than nothing but does not close the loop.

## Which hosted agents can you supervise from a phone?

Verified against vendor documentation as of July 2026:

| Tool | Mobile surface | Start tasks | Review diffs | Steer mid-task | Notes |
|---|---|---|---|---|---|
| Claude Code on the web | Claude mobile app / claude.ai | Yes | Yes | Yes | Research preview for Pro, Max, Team, and eligible Enterprise plans; sessions persist and can be moved to the CLI with `--teleport` ([docs](https://code.claude.com/docs/en/claude-code-on-the-web)) |
| OpenAI Codex | ChatGPT app (iOS/Android) | Yes | Yes, incl. filtered diffs (staged, branch, last-turn) | Yes | Codex Remote (GA June 2026) pairs the phone to a Mac/Windows host via one-to-one QR pairing, to start or continue work, review progress, and approve actions ([changelog](https://developers.openai.com/codex/changelog)) |
| GitHub Copilot cloud agent | GitHub Mobile | Yes | Yes, as branch diffs before a PR is opened | Yes, iterate on the branch, open the PR when ready | Can research the codebase and generate an implementation plan before writing code ([changelog](https://github.blog/changelog/2026-04-08-github-mobile-research-and-code-with-copilot-cloud-agent-anywhere/)); requires a paid Copilot plan ([docs](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent)) |
| Cursor cloud agents | iOS app; cursor.com/agents web/PWA | Yes | Yes | Yes | Agents run in isolated VMs, produce PRs with screenshots and logs; Android via PWA ([docs](https://cursor.com/docs/cloud-agents)) |
| Waynode (self-hosted or cloud) | Mobile web, same workspace as desktop | Yes (chat or autonomous goal) | Yes — files, hunks, commits, branches beside the conversation | Yes, same persistent session | Open source (MIT); agent works in a real cloned Git repository that persists between visits |

The hosted tools share a design: ephemeral or vendor-managed execution environments, with GitHub as the hand-off point (the agent's output is a branch or PR). That works well when your workflow already terminates in a PR. It works less well when you want the workspace itself — the checkout, the branch state, the terminal history — to persist and be revisitable from any device.

## How does Waynode handle the mobile workflow?

Waynode's unit is a **space**: a real cloned Git repository on disk, persistent across sessions rather than recreated per task. The phone gets the same workspace as the desktop, not a companion view:

- **Follow a live task.** Chat with the agent (the engine is the open-source pi agent) or dispatch an autonomous goal via pi-codex-goal, and watch it work; the session survives closing the browser or switching devices.
- **Review changes.** Changed files, hunks, diffs, commits, and branches are rendered beside the conversation. In Waynode's model, "done" means ready for review, not merely finished running.
- **Steer.** Messages land in the same persistent session, with the same worktree state, whether sent from a laptop or a phone.
- **Push.** A reviewed change can be pushed to GitHub or GitLab (connected via OAuth) directly from the mobile view.

Because sessions persist, the desk-to-phone hand-off is simple: start a task at your desk, check the diff from your phone an hour later, resume in a terminal the next morning. Native macOS and iOS clients are planned (a native app exists in the repository).

You can self-host it for free (`git clone` → `docker compose up -d`; MIT-licensed, your repos and LLM keys stay on your infrastructure — see the [self-hosting guide](/guides/self-host-coding-agent-docker)) or use [Waynode Cloud](https://waynode.fornace.net), the managed version of the same stack, from $39/month with a 15-day free trial. For the broader self-hosted-versus-hosted decision, see [self-hosted vs cloud coding agents](/guides/self-hosted-vs-cloud-coding-agents); for a direct comparison with a hosted agent product, see [Waynode vs Cursor background agents](/compare/waynode-vs-cursor-background-agents).

## What can't you realistically do from a phone?

Candidly, a fair amount:

- **Deep debugging.** Stepping through a failure, reading long stack traces, and cross-referencing five files does not fit a 6-inch screen. Waynode exposes a full terminal in the workspace, and Codex Remote can drive a paired desktop host, but a terminal on a phone is an escape hatch, not a workflow.
- **Large-diff review.** A 40-file refactor should not be approved from a phone. Mobile review works for the shape of a change and for small-to-medium diffs; big changes deserve a desk.
- **Writing significant code yourself.** If the agent's output is wrong enough that you need to write the fix, that is a signal to defer, not to thumb-type a patch.
- **Initial task scoping for complex work.** Well-scoped tasks come from context — reading the code, checking the issue history. Phones are for dispatching tasks you already understand.

The honest framing: mobile turns agent downtime into progress by removing review latency. It does not replace the desk; it makes the time between desks productive.

## FAQ

### Can I run Claude Code from my phone?

Not the CLI itself, but Claude Code on the web runs tasks on Anthropic-managed cloud infrastructure, and you can start and monitor those sessions from the Claude mobile app. It is in research preview for Pro, Max, Team, and eligible Enterprise plans, and sessions can be handed off to the terminal with `--teleport` ([documentation](https://code.claude.com/docs/en/claude-code-on-the-web)).

### Do coding agents actually run on the phone hardware?

No. In every mainstream setup the agent executes in a cloud sandbox, a VM, or on a machine you own; the phone is a control surface for starting tasks, reviewing diffs, approving actions, and steering. This is why battery and phone compute are not limiting factors.

### Can I review and merge a pull request from my phone?

Yes. GitHub Mobile lets you review the Copilot cloud agent's changes as a branch diff, iterate, and open the pull request when ready ([changelog](https://github.blog/changelog/2026-04-08-github-mobile-research-and-code-with-copilot-cloud-agent-anywhere/)), and Waynode lets you review changed files and hunks in the workspace and push a reviewed branch to GitHub or GitLab from the mobile view. Large or risky diffs are still better reviewed at a desk.

### What makes Waynode different from Codex or Copilot on mobile?

Persistence and ownership. Hosted agents run in ephemeral vendor environments and hand results off as PRs; Waynode's agent works in a persistent cloned repository on infrastructure you control (or on Waynode Cloud), and the same session, files, branches, and terminal state are reachable from any device. It is open source under MIT.

### Do I need the Waynode Cloud plan to use it from a phone?

No. The self-hosted version is free and MIT-licensed, and the mobile web experience is part of the open-source stack. Waynode Cloud ($39–$249/month, 15-day trial) adds managed hosting, updates, encrypted secrets, and backups on top of the same code.
