# Public product capture provenance

The landing-page images are captures of the production-built Waynode React
application, not composited mockups. They use a temporary local server and a
temporary Git repository so no production user, repository, token, or URL is
present in public assets.

## Seeded state

- Organization: `Waynode Lab`
- Repository: `example/checkout-service`
- Branch: `main`
- Session: `Recover checkout retries`
- User instruction: make checkout retries idempotent and add timeout coverage
- Worktree: three tracked files changed after a real initial Git commit
- Review: the source diff is loaded through Waynode's Git API and inspector

The assistant transcript is fixed seeded content. That keeps the capture
deterministic; it is not presented as a live run or a benchmark result. Every
visible repository, branch, file count, changed file, and diff comes from the
same temporary worktree.

## Assets

| Asset | Viewport | Product state |
|---|---:|---|
| `worktree-session-desktop.png` | 1440 × 900 | Session, repository identity, and three-file Review affordance |
| `worktree-session-phone.png` | 390 × 844 | The same session in the compact web workbench |
| `worktree-review-tablet.png` | 768 × 1024 | Full-screen Review with one of the three real diffs open |

The capture gate asserts that every viewport has no page-level horizontal
overflow. `e2e/test-content.mjs` prevents a landing change from referencing a
missing image and keeps public plan cards out of the page.

## Recapture requirements

Any replacement must:

1. Build the current frontend first.
2. Use an isolated non-production repository and account.
3. Capture the actual app DOM and actual Git API output.
4. Keep the transcript, changed-file count, file list, and diff consistent.
5. Check desktop, compact phone, and tablet Review separately.
6. Inspect every exported image before committing it.
