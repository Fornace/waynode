# Pi component updates

Reviewed: 2026-08-29

Waynode keeps pi and its runtime packages current through a daily, tested,
reproducible update workflow. Production images never install floating versions.

## Current component set

The source of truth is `config/pi-components.json`:

- `@earendil-works/pi-coding-agent` 0.84.4
- `pi-codex-goal` 0.2.0
- `pi-lean-ctx` 3.9.20
- standalone `lean-ctx` 3.9.20 for Linux x86_64 and aarch64

The manifest records npm SRI values and the official GitHub release SHA-256
values. Both `Dockerfile` and `sandbox/Dockerfile` consume the same manifest
through `scripts/install-pi-components.sh`, so the server and hosted microVM
cannot drift.

## Update flow

`.github/workflows/update-pi-components.yml` runs every day at 06:17 UTC and
supports manual dispatch. It:

1. creates an isolated global npm prefix and Pi agent directory;
2. installs the currently pinned component set;
3. runs `pi update` to update pi itself;
4. converts the isolated package sources to unpinned sources;
5. runs `pi update --extensions` to update every installed Pi package;
6. records exact resolved versions and integrity metadata;
7. runs the full Waynode test suite and frontend build;
8. installs the set in a clean Linux target and verifies its checksums;
10. builds both runtime images and loads `/goal` and `/lean-ctx` through Pi
    RPC in each, and verifies every recorded release asset digest for all
    architectures;
11. creates and merges one update PR.

The PR merge uses the repository secret `PI_UPDATE_TOKEN`. GitHub suppresses
workflow events caused by its built-in `GITHUB_TOKEN`, which would prevent the
required push-to-main deployment workflow from running. The dedicated token's
merge produces a normal `main` push, so `.github/workflows/deploy.yml` remains
the only production deployment path. The token is scoped to the branch push,
PR creation, and merge steps only; package installation and the test suite run
without it, and the checkout does not persist credentials into the workspace.

Any failed update, test, package integrity check, binary checksum, RPC smoke,
or image build leaves the current production pins unchanged. The workflow does
not merge partial updates.

## Manual operation

Resolve updates locally without deploying:

```bash
npm run update:pi-components
```

If the manifest changes, run the regular validation suite. Production changes
only after the resulting commit reaches `main` and the deployment workflow
passes.

## Reproducibility

The image installer verifies:

- the packed pi npm artifact matches the manifest's version and SRI;
- every installed Pi package matches its exact version and npm lock integrity;
- the standalone lean-ctx archive matches its official SHA-256 for the
  running architecture, and the daily workflow re-verifies every recorded
  architecture digest;
- each installed executable reports the expected version.

`npm_config_save_exact=true` prevents Pi's package workspace from replacing an
exact package version with a caret range. Rebuilding an old Waynode revision
therefore installs the same component bytes even after newer releases exist.
Package installs run with `--ignore-scripts` where the package manager exposes
it, so freshly resolved code does not execute during image builds.

The server runtime keeps its own agent directory on the data volume
(`DATA_DIR/pi-agent`). At startup, `lib/pi-component-seed.mjs` copies each
manifest package from the image's baked agent directory into that runtime
directory and verifies the result, repairing stale or partially written
volumes on every boot. Production images set `PI_COMPONENTS_REQUIRED=1`, so an
absent, malformed, empty, or image-inconsistent manifest stops startup. Local
source-only and CI runs may omit the manifest; startup then reports the
explicit `manifest absent` skip result without trying to seed. Hosted microVMs
use the baked directory directly.

## Compatibility receipt

Sources reviewed on 2026-08-29:

- Pi packages and update commands:
  <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md>
- Pi 0.84.4 changelog:
  <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md>
- pi-codex-goal 0.2.0 release source:
  <https://github.com/fitchmultz/pi-codex-goal/releases/tag/v0.2.0>
- lean-ctx 3.9.20 release assets:
  <https://github.com/yvgude/lean-ctx/releases/tag/v3.9.20>
- GitHub workflow token behavior:
  <https://docs.github.com/actions/using-workflows/triggering-a-workflow>

Pi 0.84 changed RPC `message_update` to delta-only events. Waynode already
assembles `assistantMessageEvent` deltas between message boundaries in
`lib/agent-rpc-events.mjs`. pi-codex-goal 0.2.0 explicitly audits the Pi 0.84
breaking changes and requires Pi 0.84 or newer. A no-model RPC smoke loads the
exact extension path Waynode uses and confirms the `/goal` command is present.
