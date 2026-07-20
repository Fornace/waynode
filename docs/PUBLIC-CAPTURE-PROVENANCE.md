# Public product capture provenance — retirement note

The raster landing-page captures described by this document were **retired in
the flagship release** and deleted from `frontend/public/marketing/`. The
landing no longer shows screenshots. It teaches with explanatory pure-CSS/SVG
frames — mockups that explain rather than imitate, per the Public web section
of `docs/CRAFT_DIRECTION.md`.

## What replaced the captures

One continuous narrative — the life of a single job — in five frames:
composer with the `message | goal | hammersmith` tri-selector, a verified
Hammersmith run with plain-text check counts, the session beside its review
inspector and one simplified diff, the same session on desktop and phone
outlines, and the deployment facts.

The seeded cast documented below lives on inside those frames:

- Organization: `Waynode Lab`
- Repository: `example/checkout-service`
- Branch: `main`
- Session: `Recover checkout retries`
- Job: make checkout retries idempotent and add timeout coverage
- Worktree: three changed files

## Historical record

Before retirement, the landing used real captures of the production-built
React app, taken against a temporary local server and a temporary Git
repository so no production user, repository, token, or URL appeared in
public assets. The assistant transcript was fixed seeded content — never
presented as a live run or a benchmark.

| Retired asset | Viewport | Product state |
|---|---:|---|
| `worktree-session-desktop.png` | 1440 × 900 | Session, repository identity, and three-file Review affordance |
| `worktree-session-phone.png` | 390 × 844 | The same session in the compact web workbench |
| `worktree-review-tablet.png` | 768 × 1024 | Full-screen Review with one of the three real diffs open |
| `screenshot-chat.png`, `screenshot-spaces.png`, `screenshot-terminal.png` | — | Earlier marketing captures, unused at retirement |

## If raster captures ever return

Any future public capture must follow the original recapture requirements:

1. Build the current frontend first.
2. Use an isolated non-production repository and account.
3. Capture the actual app DOM and actual Git API output.
4. Keep the transcript, changed-file count, file list, and diff consistent.
5. Check desktop, compact phone, and tablet Review separately.
6. Inspect every exported image before committing it.
