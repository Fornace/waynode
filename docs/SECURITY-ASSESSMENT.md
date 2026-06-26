# Security Assessment — Waynode AI

**Date:** 2026-06-26
**Scope:** `server.js`, `lib/`, `routes/`, `frontend/`

> ## ✅ STATUS: All 6 findings RESOLVED (2026-06-26)
> Every finding below has been fixed, locally verified, and deployed to prod.
> Summary of fixes:
> - **#1 path traversal** — `routes/files.js` GET+PUT now enforce `assertInsideSpace()`
>   (separator-aware `path.resolve` containment). Verified: traversal→400,
>   nested legit read/PUT→200, no escape on disk.
> - **#2 clone-URL RCE** — `assertSafeRepoUrl()` allowlist (http(s)/git/ssh/SCP),
>   rejects `ext::`, `file:`, leading `-`. Gated at `POST /api/spaces` + both
>   clone paths. Verified: `ext::`/`file://`→400, valid schemes pass.
> - **#3 CSWSH** — `/ws/terminal` upgrade now rejects non-`APP_URL` `Origin`.
>   Verified: foreign origin handshake rejected.
> - **#4 secret IDOR** — global secrets admin-only; `DELETE /api/secrets/:id`
>   enforces access based on the secret's own scope (admin for global,
>   `requireSpaceAccess` for space).
> - **#5 upload traversal** — multer `filename` sanitized via `path.basename()`.
>   Verified: traversal filename lands as basename inside the space, no escape.
> - **#6 CSP** — restrictive `helmet` CSP shipped (`script-src 'self'`, etc.);
>   inline boot script relocated to `main.tsx` so no inline-script exception.
>   Verified: header emitted, 0 inline scripts in built bundle.

**Note:** The PWA safe-area fix and settings-UI redesign (the other two asks
from the same session) shipped alongside these fixes.

Findings are ranked by severity. Severities assume the documented deployment model
(self-hosted, "small-team ready", multiple orgs/users on one server). For a strict
single-tenant install where the only user already has host SSH, several of these
collapse to low/no risk.

---

## 🔴 Critical

### 1. Path traversal in the files API — arbitrary host file read/write
**File:** `routes/files.js` (GET + PUT `/api/spaces/:spaceId/files`)

```js
const relPath = req.query.path || "";          // GET
const absPath = join(spacePath, relPath);      // ← never checked to stay inside spacePath
```
`path.join('/data/repos/<uuid>', '../../../etc/passwd')` resolves outside the repo.
There is **no containment check** (no `absPath.startsWith(spacePath)` guard).

- **GET** → any authenticated space member can read any file the process can read
  (`/etc/passwd`, other spaces' repos, `data/waynode.db`, source files).
- **PUT** → any *editor* can **write/overwrite** arbitrary host files
  (`../../app/server.js`, drop an executable, clobber `data/waynode.db`).
  This breaks space isolation **and** is a direct server-compromise primitive.

This is the single most important issue. It is reachable by any logged-in user who
is a member of *any* space (the `:spaceId` is checked, but the *path* is not).

**Fix shape:**
```js
const absPath = path.resolve(spacePath, relPath);
if (absPath !== spacePath && !absPath.startsWith(spacePath + path.sep)) {
  return res.status(400).json({ error: "Invalid path" });
}
```
Apply to both GET and PUT, and to the upload handler (see #5).

---

## 🟠 High

### 2. Remote code execution via attacker-controlled clone URL (`git` transports)
**File:** `lib/spaces.mjs` — `cloneRepo` / `cloneRepoStreaming` / `resolveCloneUrl`

`repoUrl` comes straight from `POST /api/spaces` body and is passed to
`git clone <url>`. Git supports pseudo-transports that **execute commands**:

- `ext::sh -c 'touch /tmp/pwned' %s …` → arbitrary command execution.
- `file://` and other transports can also surprise (hooks, `--upload-pack` option
  injection when the URL starts with `-`).

`spawn("git", [..., cloneUrl, ...])` correctly avoids *shell* injection, but git
itself interprets the URL. Any org **editor** can create a space, so in a multi-user
deploy this is RCE on the shared host. (Single-tenant: the user owns the box anyway.)

**Fix shape:** validate the scheme before cloning — allow only `http://`, `https://`,
`git://`, `ssh://`, and `git@host:`; reject anything containing `ext::`, `file://`,
or a URL beginning with `-`. Consider `GIT_PROTOCOL=` allowlist and
`git -c protocol.ext.allow=never`.

### 3. Cross-Site WebSocket Hijacking (CSWSH) on the terminal
**File:** `routes/terminal.js` — `attachTerminalWebSocket`

The `/ws/terminal` upgrade authenticates via the session cookie (good) but **never
checks the `Origin` header**. Browsers send cookies on cross-site `WebSocket`
handshakes, so a malicious page visited by a logged-in user can do:

```js
new WebSocket("wss://waynode.fornace.net/ws/terminal?sessionId=<id>")
```
…and get a live `pi` shell inside the victim's space — typing commands, reading
output. Session IDs are 8-hex short IDs (lower entropy than the full UUID), which
makes guessing/brute-force somewhat easier too.

**Fix shape:** in the `upgrade` handler, compare `req.headers.origin` against the
configured `config.appUrl` (and the deployment origin); reject on mismatch.

---

## 🟡 Medium

### 4. Secret authorization gaps (IDOR)
**File:** `routes/secrets.js`

```js
router.delete("/api/secrets/:id", requireAuth, …)          // no ownership/scope check
router.get("/api/secrets/global", requireAuth, …)          // any user reads all global secret *names*
router.post("/api/secrets/global", requireAuth, …)         // any user adds a global secret
```
- `DELETE /api/secrets/:id` accepts only `requireAuth`. Any logged-in user can delete
  **any** secret by id (global or any space's), including other orgs' secrets.
- Global endpoints let any user read all global secret key names and **add** global
  secrets — which are then injected into *every* space's pi environment
  (`getSecretsEnv`). A malicious user could plant a key like `LD_PRELOAD` /
  `HTTP_PROXY` / a `PI_*` override to influence or exfiltrate from all spaces.

Space-scoped secrets (`/api/spaces/:spaceId/secrets`) are correctly protected by
`requireSpaceAccess`. The gaps are the global + delete-by-id paths.

**Fix shape:** restrict global-secret read/write to admins; on delete, look up the
secret's scope/space and require matching access (admin for global,
`requireSpaceAccess` for space).

### 5. Upload path traversal via `originalname`
**File:** `routes/spaces.js` — `multer.diskStorage`

```js
filename: (req, file, cb) => { cb(null, file.originalname); }   // user-controlled
destination: … => cb(null, getSpacePath(req.params.spaceId));
```
`originalname` like `../../../../app/server.js` writes outside the space dir. Same
class as #1 (write traversal), scoped to editors.

**Fix shape:** sanitize to a basename (`path.basename(originalname)`) and/or generate
a safe name, then verify the resolved path stays within the space dir.

### 6. Content-Security-Policy disabled
**File:** `server.js` — `helmet({ contentSecurityPolicy: false, … })`

The chat renders LLM/pi output as Markdown. If any rendering path ever permits raw
HTML (now or later), there is **no CSP backstop** to limit XSS damage. With CSP off,
a single stored XSS can read session cookies is `httpOnly` (good) but can still drive
authenticated requests / read the DOM / hit the terminal WS.

**Fix shape:** ship a restrictive CSP (`default-src 'self'`, allow inline styles only
where needed, `connect-src 'self'`). React + Vite can run under a tight policy.

---

## 🟢 Low / Hardening

### 7. OAuth tokens stored in plaintext
`users.github_token` / `users.gitlab_token` are stored unencrypted in SQLite, then
embedded into clone URLs. Consider encrypting at rest with the existing AES-GCM
helper (`lib/secrets.mjs`). DB file compromise = provider token compromise.

### 8. Token leakage into process list / git output
Clone URLs of the form `https://<token>@github.com/…` are passed as argv → briefly
visible in `ps`, and may appear in git error messages. The code already scrubs
`repo_full_name` when it contains `@` (good). Consider `-c credential.helper` /
env-based auth instead of URL embedding.

### 9. `DEV_TOKEN` OAuth bypass — operational guard
`requireAuth` and `sseAuth` accept `x-dev-token` / `?t=` == `DEV_TOKEN` and log in as
a full-privileged `dev-user`. This is fine **only if `DEV_TOKEN` is unset in prod**.
Ensure the production env/deploy never sets it. (It's the classic "dev backdoor left
on" risk.)

### 10. Org-settings PATCH accepts arbitrary keys
**File:** `routes/orgs.js` — `PATCH /api/orgs/:orgId/settings` loops
`Object.entries(req.body)` into settings with no allowlist. An editor can write
arbitrary setting keys. Low impact (org-scoped k/v) but validate against a known set.

### 11. GitLab "link provider" is dead code
**File:** `lib/auth.mjs` GitLab verify callback references `req?.user`, but `req` is
not a parameter of the passport verify callback `((accessToken, refreshToken, profile,
done))`. The account-linking branch never runs (silently). Not a security hole, but
the intended "link GitLab to existing session" feature is non-functional.

---

## ✅ Things done well (worth keeping)

- **SQL injection:** every query uses `db.prepare(...).run/get/all` parameterized
  statements — no string concatenation into SQL. ✔
- **Secret crypto:** AES-256-GCM with random 12-byte IV + auth tag, correct
  encrypt/decrypt. Secret *values* are never sent to the client (only key names). ✔
- **Session cookies:** `httpOnly: true`, `secure` in prod, `sameSite: "lax"`. ✔
- **Rate limiting:** API (500/15m) and auth (20/15m) limiters in place. ✔
- **CORS:** restricted to `config.appUrl` with credentials. ✔
- **Org authorization:** org routes consistently check `isOrgMember` + role
  (admin/editor/viewer) per action. ✔
- **Space access:** `requireSpaceAccess` middleware applied to space routes with
  owner/member + role enforcement. ✔
- **Git without shell:** uses `spawn`/`spawnSync` arg arrays (no `exec` shell). ✔
  (Note: this does not save you from #2 — git interprets the URL itself.)

---

## Suggested priority

1. **#1 path traversal** — fix immediately; trivial guard, severe impact.
2. **#3 CSWSH** + **#2 clone URL RCE** — next; both enable server-side abuse by any
   org editor / any attacker who can lure a logged-in user.
3. **#4 secret IDOR** + **#6 CSP** — then.
4. Everything in Low as hardening.
