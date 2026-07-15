# Waynode

> Open-source durable worktrees for coding agents. Each worktree is a real cloned Git repository with a persistent branch, agent session, terminal, and review surface, reachable from desktop and mobile.

Waynode gives coding work a real, durable place. Start a task at your desk, inspect the diff on your phone, and finish it from any device, with the repository, branch, terminal, and conversation still there.

## What Waynode is

- A persistent repo workspace, not a coding chat. Every space is a real cloned GitHub or GitLab repository on disk.
- An agent-native Git surface: changed files, hunks, commits, branches, and push live beside the conversation. "Done" means ready for review, not merely finished running.
- Mobile-first: the same workspace, session, and diff on your phone. Follow a live task, review changed files, send the next instruction.
- Open source (MIT) and self-hostable with Docker. The agent engine is [pi](https://github.com/anthropics/pi), with pi-codex-goal for autonomous goals.

## Two ways to run it

### Self-host: free and yours

```bash
git clone https://github.com/fornace/waynode.git
cd waynode
./scripts/self-host.sh setup
```

The guided installer requires Docker Compose v2, one GitHub or GitLab OAuth
application, and a supported model-provider key. It generates the server
secrets, validates the configuration, and starts Waynode on loopback by
default. See the [self-hosting guide](https://github.com/fornace/waynode/blob/main/docs/SELF-HOSTING.md)
for HTTPS, upgrades, backup, and restore.

Your repositories, database, credentials, provider accounts, and billing stay with you. Bring your own LLM keys.

### Waynode Cloud: managed hosting

The same open-source product, managed: server operation, updates, encrypted
secrets, hardware-isolated agent runs, and Stripe billing. Every new
organization gets a 15-day trial. Hosted worktrees include chat and goals plus
Git review, commit, and push. Interactive terminal access is deliberately
self-hosted only. Hosted plan, quota, and subscription details appear inside
the organization billing settings rather than as public plan cards.

## For AI assistants

- Every HTML page on this site has a markdown twin: append `.md` to the URL.
- [/llms.txt](/llms.txt): index of all agent-readable content
- [/llms-full.txt](/llms-full.txt): every article concatenated
- [/learn.md](/learn.md): guides and comparisons index

## Links

- Website: https://waynode.fornace.net
- GitHub: https://github.com/fornace/waynode
- Guides and comparisons: /learn
