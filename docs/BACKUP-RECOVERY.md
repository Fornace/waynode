# Waynode backup and recovery

Waynode's product state is the Docker data volume plus the deployment `.env`.
The volume contains SQLite, real Git worktrees, and pi session files. The
environment contains the encryption key required to decrypt stored secrets.
Neither is useful as a complete recovery set without the other.

## Production schedule

Install the included systemd timer on the serving host:

```bash
cd /opt/waynode
COMPOSE_FILE=/opt/waynode/docker-compose.ffrapposerver.yml \
  BACKUP_DIR=/var/backups/waynode \
  ./scripts/waynode-backup.sh install-timer
systemctl start waynode-backup.service
journalctl -u waynode-backup.service --since today
```

The timer runs nightly with a randomized delay. It briefly stops the exact
running container, archives the full data volume, copies `.env` with mode 0600,
writes SHA-256 checksums, restarts the same container, and restores the archive
into a disposable Docker volume. The drill runs SQLite `PRAGMA quick_check` and
requires both the database and repository directory. Successful production
deployments also install or refresh this timer, so a missing or failed timer is
a deployment/monitoring incident rather than an optional setup step.

Local retention defaults to 14 days. Set `RETENTION_DAYS` in
`/etc/waynode-backup.env` to change it. A local backup does not survive loss of
the host. Configure encrypted off-host Restic storage and then enable upload:

```dotenv
# /etc/waynode-backup.env — root:root, mode 0600
WAYNODE_BACKUP_RESTIC=1
RESTIC_REPOSITORY=...
RESTIC_PASSWORD_FILE=/root/.config/restic/waynode-password
RESTIC_KEEP_DAILY=14
RESTIC_KEEP_WEEKLY=8
RESTIC_KEEP_MONTHLY=12
# Provider-specific Restic credentials also belong here.
```

After configuring Restic, run the service once and prove the new snapshot is
visible with `restic snapshots --tag waynode`. Alert on a failed systemd unit;
the timer alone does not send notifications. After each successful upload,
Waynode applies this retention to snapshots tagged `waynode`, grouping by host
and tag because the archive paths change each day, and runs Restic pruning. Use
a dedicated repository or reserve that tag for Waynode.

## Manual backup and drill

```bash
COMPOSE_FILE=docker-compose.ffrapposerver.yml \
  BACKUP_DIR=/var/backups/waynode \
  ./scripts/waynode-backup.sh backup

COMPOSE_FILE=docker-compose.ffrapposerver.yml \
  BACKUP_DIR=/var/backups/waynode \
  ./scripts/waynode-backup.sh drill latest
```

Every deployment creates a matching recovery set before changing source,
images, data, or the production environment. It lives under
`/var/backups/waynode/deployments/<revision>-<run>/` and contains the full
pre-deploy source archive and checksum, stop-consistent data and environment
backup, reconciliation metadata, and the prior sandbox image. The previous
server and sandbox images are also given rollback tags. A deployment refuses
to proceed if either image is missing or if the recorded source revision and
digest do not match what is actually on the host.

The first deployment from a legacy, unversioned host has an explicit one-time
bootstrap path. It is accepted only when the running image has no revision
label and only after the complete legacy source has been archived. Later
deployments fail closed when revision manifests are absent or the source was
changed out of band.

The transaction remains rollback-capable until both local and public HTTPS
readiness report the exact requested Git revision. If the replacement could
have opened the database, rollback restores the matching old source, exact
environment, data volume, server image, and sandbox image together. If any
rollback step fails, the service is deliberately left stopped and the recovery
set path is printed; serving an unknown source/data combination is not allowed.
The transaction also restores the prior backup service/timer files and their
enabled and active state. Successful recovery sets older than 30 days are
removed after a later successful deployment; failed transactions are retained
for diagnosis and manual recovery.

## Restore

1. Isolate the host from customer traffic.
2. Check out the Waynode revision that created the backup.
3. Retrieve the matching `.data.tar.gz`, `.env`, and `.sha256` files from
   encrypted off-host storage.
4. Run the disposable restore drill first.
5. Restore only after the drill passes:

```bash
COMPOSE_FILE=docker-compose.ffrapposerver.yml \
  BACKUP_DIR=/var/backups/waynode \
  ./scripts/waynode-backup.sh restore \
  /var/backups/waynode/waynode-YYYYmmddTHHMMSSZ.data.tar.gz
```

The command requires typing `RESTORE`, preserves the current `.env` as
`.env.before-restore-*`, replaces all volume data, installs the backup's
matching `.env`, strips any historic `DEV_AUTH_TOKEN`, and waits for Docker
readiness. The unmodified pre-restore environment remains protected in the
`.env.before-restore-*` copy for forensic recovery.

After restore, verify `/api/health/ready`, real GitHub and GitLab OAuth, several
representative repositories and diffs, one small agent turn, Stripe entitlement
state, and an authenticated native reconnect. Record the achieved recovery time
and the age of the restored data. A checksum or SQLite check alone is not an
application-level recovery test.

For deployment-transaction recovery, use the source revision and all artifacts
from the same transaction directory. `restore-offline` exists for automation
while the service is stopped; it deliberately has no interactive prompt. The
deployment rollback sets `WAYNODE_RESTORE_EXACT_ENV=1` because old source, old
data, and old environment must move as a unit. Operators performing a manual
restore normally use `restore`, which strips a historic `DEV_AUTH_TOKEN`.
