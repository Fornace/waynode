# Self-hosting Waynode

The default Docker Compose setup is standalone: it creates its own Docker
network and persistent volume, and does not require any Fornace infrastructure.
It is designed for a trusted individual or small team on one Linux host.

## Requirements

- Linux host with Docker Engine and Docker Compose v2
- A domain with HTTPS for access outside the host
- One GitHub or GitLab OAuth application
- An API key and model ID for Anthropic, OpenAI, Google Gemini, or OpenRouter
- Enough disk for every cloned repository plus session history

The default container does not provide hardware isolation between users. Agent
commands run inside the Waynode container, whose data volume contains the
deployment's worktrees. Treat every invited user and repository as trusted.
The separate KVM/microsandbox deployment is an advanced operator path, not a
security property of the default Compose file.

## Guided installation

```bash
git clone https://github.com/fornace/waynode.git
cd waynode
./scripts/self-host.sh setup
```

The setup command:

1. generates different 256-bit session and encryption secrets;
2. asks for the public URL and binds Docker to `127.0.0.1` by default;
3. prints the exact OAuth callbacks before asking for the client credentials;
4. records a pi provider, provider-local model ID, and one-time bootstrap key;
5. writes `.env` with mode `0600` and refuses to replace an existing file;
6. validates Compose, builds the service, and waits for its readiness endpoint
   to confirm SQLite and data-volume access.

Re-run the non-destructive validation at any time:

```bash
./scripts/self-host.sh check
docker compose ps
docker compose logs -f waynode
```

If you prefer manual configuration, copy `.env.example` to `.env`, fill every
required value, run `chmod 600 .env`, then run the check above.

## OAuth callbacks

`APP_URL` must be the public origin only: no trailing path, query, or fragment.
For `APP_URL=https://waynode.example.com`, register exactly:

| Provider | Callback URL |
|---|---|
| GitHub | `https://waynode.example.com/auth/github/callback` |
| GitLab | `https://waynode.example.com/auth/gitlab/callback` |

GitHub: Settings → Developer settings → OAuth Apps → New OAuth App. Set the
homepage to `APP_URL` and the authorization callback to the GitHub URL above.

GitLab: Preferences → Applications. Set the redirect URI to the GitLab URL
above and enable `read_user`, `read_api`, and `read_repository`.

Changing `APP_URL` later also requires changing the callback at the provider.

## HTTPS and network binding

Compose publishes Waynode on `127.0.0.1:3000` by default. Put a TLS-terminating
reverse proxy on the same host. For example, a minimal Caddy site is:

```caddyfile
waynode.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Set `APP_URL=https://waynode.example.com` before creating the OAuth app. Set
`WAYNODE_BIND_ADDRESS=0.0.0.0` only when the Docker port must be reachable from
another host and a firewall restricts who can connect. Do not expose plain HTTP
with OAuth cookies or repository credentials.

## First model run

On first self-host boot, Waynode maps `PI_PROVIDER_API_KEY` to the selected
provider's exact environment key, encrypts it into the global secret vault, and
removes both names from the server process environment before an agent starts.
Later restarts never overwrite the encrypted value. Hosted deployments ignore
the bootstrap variable.

| Provider | `PI_DEFAULT_PROVIDER` | Encrypted secret name |
|---|---|---|
| Fornace gateway | `fornace` | `FORNACE_API_KEY` |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` |
| OpenAI | `openai` | `OPENAI_API_KEY` |
| Google Gemini | `google` | `GEMINI_API_KEY` |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` |

The model value must be a provider-local model ID supported by the installed pi
version. The installer validates that both values are present and forms one
canonical `provider/model` selection; it cannot prove that the model exists or
that a private key has access to it. After login, clone a worktree and send a
small prompt as the end-to-end credential and entitlement check. Add the
provider's named key in a worktree's Settings → Secrets when that worktree
needs a later rotation or a scoped override.

The bootstrap value remains in the root-readable `.env` so a fresh data volume
can be initialized after disaster recovery. Waynode still removes it from the
live server environment before spawning agents. If your recovery process stores
the key elsewhere, you may blank `PI_PROVIDER_API_KEY` after the first verified
prompt; `./scripts/self-host.sh check` will then expect the encrypted secret to
already exist.

## Backups

Waynode state lives in the Compose `waynode-data` volume. The helper stops the
service when it is running, archives the whole volume, then restarts it:

```bash
./scripts/self-host.sh backup
# or choose an output path
./scripts/self-host.sh backup /secure/waynode-$(date +%F).tar.gz
```

This creates a stop-consistent archive of Waynode's SQLite database, cloned
worktrees, and session files. It is not a complete disaster-recovery system:

- `.env`, reverse-proxy configuration, TLS material, and external OAuth or LLM
  accounts are not in the archive;
- repository remotes can change independently after the backup;
- the helper does not upload, encrypt, rotate, or test the archive for you.

Store a protected copy of `.env` separately. Losing `ENCRYPTION_KEY` makes the
encrypted secrets in the database unusable. Protect both files as credentials,
copy them off-host, and periodically test a restore on a disposable instance.

## Restore

Check out the same Waynode revision that created the backup and restore the
matching `.env` first. Then run:

```bash
./scripts/self-host.sh restore /secure/waynode-2026-07-14.tar.gz
docker compose up -d
./scripts/self-host.sh check
```

Restore requires typing `RESTORE`, replaces every file in the current data
volume, and restarts Waynode only if it was running beforehand. Afterward,
verify login, open representative worktrees, inspect `git status`, and run a
small agent prompt. A successful `tar` extraction alone is not application-level
restore validation.

## Upgrade and rollback

Record the current commit and take both backups before changing versions:

```bash
git rev-parse HEAD
./scripts/self-host.sh backup
install -m 600 .env /secure/waynode.env
git pull --ff-only
docker compose up -d --build
./scripts/self-host.sh check
docker compose logs --tail=100 waynode
```

Review release notes and database migrations before upgrading. For rollback,
check out the recorded commit, rebuild, restore the pre-upgrade `.env` and data
archive, then perform the same application-level checks. Restoring only the old
image against a database already migrated by a newer version is not guaranteed.

## Cloud-specific Compose

Self-hosters should use only `docker-compose.yml`. `docker-compose.cloud.yml`
is an optional Waynode Cloud/Fornace override that attaches the service to the
external `fornace-llm_default` network:

```bash
docker compose -f docker-compose.yml -f docker-compose.cloud.yml up -d
```

Do not create that external network for an ordinary install. The deployment-
specific `docker-compose.ffrapposerver.yml` is also not a self-host quick start.
