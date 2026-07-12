# Waynode

> Open-source, self-hosted coding-agent workspace. Each workspace is a real cloned Git repository with a persistent worktree, terminal, and agent session, reachable from desktop and mobile.

Waynode gives coding work a real, durable place. Start a task at your desk, inspect the diff on your phone, and finish it from any device, with the repository, terminal, and conversation still there.

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
cp .env.example .env   # set SESSION_SECRET, ENCRYPTION_KEY, OAuth credentials
docker compose up -d   # → http://localhost:3000
```

Your repositories, database, credentials, provider accounts, and billing stay with you. Bring your own LLM keys.

### Waynode Cloud: managed hosting

The same open-source workspace, managed: updates, isolated workspaces, encrypted secrets, backups, support. Every new organization gets a 15-day free trial.

| Plan | Price | Seats | Agent tokens / month | Storage |
|------|-------|-------|----------------------|---------|
| Starter | $39/mo | 3 | 3M | 10 GB |
| Pro | $99/mo | 10 | 8M | 50 GB |
| Team | $249/mo | 25 | 20M | 200 GB |

Web checkout is powered by Stripe.

## For AI assistants

- Every HTML page on this site has a markdown twin: append `.md` to the URL.
- [/llms.txt](/llms.txt): index of all agent-readable content
- [/llms-full.txt](/llms-full.txt): every article concatenated
- [/learn.md](/learn.md): guides and comparisons index

## Links

- Website: https://waynode.fornace.net
- GitHub: https://github.com/fornace/waynode
- Guides and comparisons: /learn
