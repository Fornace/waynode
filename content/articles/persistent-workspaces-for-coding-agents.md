---
title: Why coding agents need persistent workspaces
description: Ephemeral task runners discard branches, terminal state, and conversation context. Persistent real-repo workspaces make agent work reviewable and resumable.
category: guides
slug: persistent-workspaces-for-coding-agents
date: 2026-07-12
updated: 2026-07-12
author: Francesco Frapporti
keywords: persistent workspace coding agent, coding agent git worktree, stateful vs ephemeral ai agents
cover: /covers/persistent-workspaces-for-coding-agents.png
---

![Why coding agents need persistent workspaces Cover Image](/covers/persistent-workspaces-for-coding-agents.png)

# Why coding agents need persistent workspaces

A persistent workspace is a coding-agent environment where the repository clone, working branches, terminal state, and conversation history survive between sessions, instead of being provisioned for one task and discarded afterward. Most cloud coding agents today run in the opposite model: an ephemeral container is created per task, the agent pushes a branch or opens a pull request, and everything else is thrown away. That model works for one-shot tasks but loses exactly the context you need when work spans more than one sitting: the uncommitted diff, the half-finished branch, the shell environment, and the reasoning that led there.

**TL;DR**

- Ephemeral agent runners (per-task containers or VMs) discard the working tree, terminal state, and most conversation context once a task ends; the surviving artifact is usually just a pushed branch or PR.
- This makes multi-session work (iterating on review feedback, resuming after a day, steering mid-task from another device) awkward or impossible without re-provisioning and re-explaining.
- The persistent-workspace pattern keeps a real Git clone on disk per project, with the agent, the diff view, and the terminal all attached to that same durable directory.
- [Waynode](https://github.com/fornace/waynode) implements this pattern: each "space" is a real cloned repository, sessions survive between visits, and the Git surface (hunks, commits, branches, push) lives beside the conversation.
- Ephemeral runners remain the better fit for high-volume parallel one-shot tasks; persistent workspaces are the better fit for work you review, steer, and resume.

## What do ephemeral agent runners actually lose?

When a cloud agent runs each task in a fresh container, four kinds of state disappear at the end of the run:

1. The working tree. Uncommitted changes, stashes, generated files, and build artifacts exist only inside the container. If the agent stopped short of a pushed branch, that work is gone.
2. Branch and repo state. The agent's clone (its local branches, its view of history, any rebase-in-progress) is not the same clone next time. Every follow-up starts from a re-clone at some ref.
3. Terminal and process state. Running dev servers, watch processes, shell history, environment tweaks made during the session: none of it carries over.
4. Conversation and task context. Follow-ups either happen inside a time-limited window or start a new task where the agent must rediscover what was done and why.

Concretely, in the current generation of tools (all verified against vendor docs, July 2026):

- OpenAI Codex cloud runs each task in a container that checks out your repo at the selected branch or commit and runs your setup script; container state is cached "for up to 12 hours" to speed up follow-ups, after which a new container starts from scratch ([Codex cloud environment docs](https://learn.chatgpt.com/docs/environments/cloud-environment)).
- Cursor cloud agents run in isolated VMs that "clone your repo … and work on a separate branch, then push changes to your repo for handoff"; each agent starts from an environment configured for the repo (a saved snapshot or a Dockerfile) ([Cursor cloud agent docs](https://cursor.com/docs/cloud-agent)).
- Claude Code on the web runs every task in an isolated sandbox with network and filesystem restrictions, with Git interactions handled through a secure proxy to authorized repositories; the deliverable is the change delivered back through Git, not a durable environment you return to ([Claude Code on the web announcement](https://claude.com/blog/claude-code-on-the-web)).

None of this is a design flaw. Ephemerality is a deliberate trade: it buys strong isolation, easy parallelism, and zero cleanup. The cost is that the pushed branch becomes the *only* durable artifact, and everything upstream of it, the process, evaporates.

## Stateful vs ephemeral AI agents: when does state matter?

State matters whenever the unit of work is longer than one autonomous run. Three common situations:

Review-and-iterate loops. An agent produces a diff; you read it on your phone that evening and want two functions renamed and a test added. In an ephemeral model, that feedback spawns a new task in a new container that re-clones and re-orients. In a persistent workspace, the same session with the same working tree is still there: the agent applies the feedback to the branch it already has checked out.

Interrupted work. Real tasks get interrupted by meetings, CI failures, or better ideas. A persistent workspace tolerates this by default: the branch, the diff, and the conversation are exactly where you left them, whether you return in an hour or a week. Even general-purpose cloud dev environments acknowledge this need. GitHub Codespaces stops a codespace after an idle timeout (default 30 minutes) but *retains* the stopped codespace, by default for 30 days, precisely so work in progress is not lost ([Codespaces lifecycle docs](https://docs.github.com/en/codespaces/about-codespaces/understanding-the-codespace-lifecycle)).

Human-steered autonomy. If you want to watch a long-running goal, inspect intermediate diffs, and redirect the agent mid-flight, there has to be a stable *place* to attach to. Ephemeral runners expose a task log; a persistent workspace exposes the actual repository state at every moment.

Conversely, state is dead weight for genuinely one-shot work: "fix this lint error across 40 repos" is better served by 40 disposable containers than by 40 long-lived workspaces. Stateful and ephemeral are complements, not competitors.

## What does the persistent-workspace architecture look like?

The pattern has three load-bearing pieces. Waynode is used as the concrete example here because it implements all three in the open ([source on GitHub](https://github.com/fornace/waynode)); the pattern itself is general.

### 1. A real clone on disk, not a task container

Each workspace ("space" in Waynode) is a real cloned Git repository: a persistent worktree that exists independently of any agent run. The agent operates *inside* the clone rather than the clone existing *inside* the agent's sandbox. This inverts the ephemeral model's ownership: the repository directory is the durable object, and agent sessions, terminals, and autonomous runs all attach to it. Because it is a normal clone, everything Git can express (branches, worktrees, stashes, reflog) is available and survives across sessions.

### 2. An agent-native Git surface

If the workspace persists, the interface must show its Git state continuously, rather than only at hand-off time. In Waynode, changed files, hunks, diffs, commits, branches, and push live beside the conversation. The practical effect is a different definition of "done": an agent task is finished when the change is *ready for review*: inspectable as a diff, on a branch, one action from pushed. Ephemeral runners approximate this with an auto-opened PR; a persistent workspace lets you review and adjust *before* anything leaves the workspace.

### 3. Sessions that survive, on every device

The third piece is durable sessions: conversation, files, branches, and terminal state persist between visits, and the same workspace is reachable from any device. Waynode is mobile-first: the same workspace, session, and diff are available on a phone: follow a live task, review changed files, steer the agent, push a reviewed change. This only works because there is one canonical stateful workspace to point every client at; an ephemeral-per-task model has no equivalent object to reconnect to once the task ends.

Around these three pieces, the remaining architecture is conventional: Waynode is MIT-licensed and self-hostable (`git clone` → `docker compose up -d`), connects to GitHub and GitLab via OAuth, runs the open-source pi agent engine (with pi-codex-goal for autonomous goal runs), and offers a sandboxed microVM execution path where KVM is available. A managed option ([Waynode Cloud](/learn)) runs the same stack with a 15-day free trial; self-hosters bring their own model keys.

## How do persistent workspaces compare to the alternatives?

| Property | Ephemeral task runner (Codex cloud, Cursor cloud agents, Claude Code web) | Cloud dev environment (Codespaces) | Persistent agent workspace (Waynode) |
|---|---|---|---|
| Unit of provisioning | Per task / per session | Per developer environment | Per repository ("space") |
| Working tree after task ends | Discarded (Codex caches ≤ 12 h) | Retained while codespace exists (default retention 30 days) | Persists between sessions |
| Terminal / process state | Lost at task end | Suspended on idle timeout (default 30 min), restored on restart | Persists between visits |
| Conversation context | Task-scoped | N/A (editor, not agent-first) | Persists with the workspace |
| Primary artifact | Pushed branch / PR | The environment itself | Reviewable diff + branch, pushed when ready |
| Parallel one-shot tasks | Strong fit | Poor fit | Possible, but not the design center |
| Self-hostable | No | No | Yes (MIT) |

Sources: [Codex cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environment), [Cursor cloud agent docs](https://cursor.com/docs/cloud-agent), [Claude Code on the web](https://claude.com/blog/claude-code-on-the-web), [Codespaces lifecycle](https://docs.github.com/en/codespaces/about-codespaces/understanding-the-codespace-lifecycle).

Each column is good at its own job. Ephemeral runners win on isolation and fan-out. Codespaces wins as a full human dev environment with deep editor integration. The persistent agent workspace wins when the goal is agent work that a human reviews, steers, and resumes, because it is the only model in which the *process* itself is durable, in addition to the output.

## Does persistence weaken isolation?

No. It changes where isolation is applied. Ephemeral runners get isolation for free by discarding the environment. A persistent workspace has to isolate execution while keeping data durable, running agent commands in a sandbox that can be torn down without touching the repository clone. Waynode's approach is a sandboxed microVM execution path (when KVM is available on the host), with the operator owning the session secret and encryption key on self-hosted deployments. On the hosted plans, workspaces are isolated and secrets are encrypted. The durable clone and the disposable execution environment are separate layers, which is the same separation Git itself encourages between the object store and the working tree.

## FAQ

### What is a persistent workspace for a coding agent?

A persistent workspace is a durable, per-repository environment (a real Git clone on disk) where the agent's working tree, branches, terminal state, and conversation history survive between sessions. It contrasts with ephemeral runners that provision a fresh container per task and discard it afterward.

### Are tools like Codex cloud and Cursor cloud agents ephemeral?

Largely, yes. Codex cloud runs each task in a container and caches container state for up to 12 hours before starting fresh ([docs](https://learn.chatgpt.com/docs/environments/cloud-environment)); Cursor cloud agents run in isolated VMs that clone the repo, work on a branch, and push for handoff ([docs](https://cursor.com/docs/cloud-agent)). The durable artifact in both cases is the pushed branch or PR, not the environment.

### When is an ephemeral agent runner the better choice?

For high-volume, parallel, one-shot tasks: mass refactors across many repos, batch dependency bumps, triaging a queue of small fixes. Provisioning dozens of disposable containers is cheaper and safer than maintaining dozens of long-lived workspaces for work nobody will resume.

### How is a persistent agent workspace different from GitHub Codespaces?

Codespaces is a cloud development environment built around a human using an editor; it retains stopped environments (default retention 30 days) but is not agent-first. A persistent agent workspace like Waynode is built around the agent loop: the conversation, the diff surface, and autonomous goal runs are the primary interface, attached to a real repository clone you can also open a terminal in.

### Can I self-host a persistent agent workspace?

Yes. Waynode is MIT-licensed: clone the repository, copy `.env.example` to `.env`, and run `docker compose up -d`; the app serves on localhost:3000 with your repos, database, credentials, and LLM keys staying on your infrastructure. See the [repository](https://github.com/fornace/waynode) for setup details.
