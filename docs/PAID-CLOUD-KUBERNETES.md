# ADR: paid-cloud Kubernetes architecture

- **Status:** Proposed
- **Date:** 2026-07-14
- **Scope:** Waynode Cloud only

## Decision

Waynode Cloud will separate a stateless control plane from stateful, isolated
worktree runtimes. The control plane will run as replicated Kubernetes
Deployments backed by PostgreSQL. Each worktree will have one active runtime
owner and one persistent volume containing its real Git clone and agent session
files. Runtime pods will use a hardware-isolating `RuntimeClass`.

Docker Compose remains the default and supported self-host path. This decision
does not make Kubernetes, PostgreSQL, K3s, or a cloud storage driver a
self-hosting requirement.

## Current truth

The present application is a good single-host product, but it is not yet this
target architecture:

- `server.js` combines HTTP, SSE, WebSocket, authentication, and runtime
  orchestration in one Node process.
- `lib/db.mjs` stores product metadata, encrypted secrets, billing state, and
  API-token hashes in a local SQLite database.
- Express sessions use the process-local default session store.
- `lib/spaces.mjs` assumes each worktree is a directory under the server's
  local data volume.
- `lib/agent-manager.mjs` owns active agents and terminals in process-local
  maps. A client disconnect does not kill work, but a server restart does lose
  that ownership record.
- The hosted KVM path can execute agent work in microsandbox microVMs, while
  the default Compose path deliberately targets a trusted single host.

The migration must preserve the current product contract: a worktree is a
durable real repository, a session can reconnect, and browser disconnects do
not cancel running work.

## Target topology

```text
Internet
   |
Ingress / load balancer
   |
   +-- Control plane replicas -------------------- PostgreSQL
   |     auth, orgs, billing, metadata, leases       source of truth
   |     runtime lookup and stream proxying
   |
   +-- Runtime controller
           |
           +-- Worktree runtime A -- PVC A
           +-- Worktree runtime B -- PVC B
           +-- Worktree runtime C -- PVC C

All runtime pods: hardware-isolating RuntimeClass + restricted network policy
All PVCs: CSI snapshots + encrypted off-cluster backup policy
```

### Stateless control plane

Control-plane pods may contain no correctness-critical local state. They serve
REST, OAuth, billing webhooks, native-client authentication, and the public
site; authorize requests; acquire runtime leases; and proxy session traffic to
the worktree's current runtime owner.

PostgreSQL becomes the source of truth for users, organizations, memberships,
worktrees, sessions, entitlements, metering, encrypted secret records,
idempotency records, and runtime ownership. Browser sessions also move to a
shared PostgreSQL-backed store. Database migrations must be explicit,
transactional where possible, and compatible with a rolling deployment.

Static assets can continue to be served by the application initially and move
to a CDN later. That choice is independent of runtime correctness.

### Per-worktree runtime and storage

One worktree has at most one writable runtime owner. The runtime owns:

- the cloned repository and its Git index;
- pi session files and generated artifacts;
- active agent processes and terminal processes;
- file, Git, chat, and terminal operations for that worktree.

Its PVC is mounted read-write by only that runtime. Sessions in the same
worktree share the runtime and filesystem; unrelated worktrees never share a
volume or runtime identity. An idle worktree may terminate its pod while
retaining its PVC. Opening it again creates a runtime and remounts the volume.

The controller records a generation-numbered lease in PostgreSQL before a
runtime becomes writable. A replacement runtime must fence the old generation
before mounting or accepting mutations. This prevents two pods from running
Git or agent commands against the same worktree after a partition or slow
shutdown.

### Routing and reconnects

Ordinary control-plane REST requests can land on any replica. Routes that
touch a worktree resolve `worktree_id -> runtime generation -> internal
endpoint` and are proxied to the current owner.

Ingress should use cookie affinity for long-lived SSE and WebSocket connections
during the first migration stages. Affinity is an optimization, not the source
of truth: reconnecting through a different control-plane pod must resolve the
same runtime from PostgreSQL. Session IDs and worktree IDs, not a particular
control-plane pod, identify work.

During a rollout, a draining control-plane pod stops accepting new streams,
keeps existing streams for a bounded grace period, and lets clients reconnect.
During a runtime replacement, the UI reports reconnecting until the new lease
is active; it must not silently start a second agent.

### Runtime isolation

Paid runtimes must specify a hardware-isolating `RuntimeClass` backed by a
maintained VM-based container runtime. Scheduling is restricted to labeled,
tainted worker nodes with virtualization support. A runtime pod does not
receive Kubernetes credentials, control-plane database credentials, Stripe
credentials, or an LLM management credential.

Each runtime also receives:

- a dedicated service account with no Kubernetes API permissions;
- a restricted pod security context and read-only base image;
- an explicit CPU, memory, process, and ephemeral-storage limit;
- a default-deny network policy with only required DNS, Git-provider, and
  controlled model-broker destinations;
- short-lived, worktree-scoped Git credentials and model authorization.

GitHub and GitLab egress means any secret exposed inside a runtime can be
exfiltrated. Network policy alone is therefore not a credential boundary. The
durable model-access design is a host-side broker that authorizes the runtime
identity and injects upstream credentials without returning them to the guest.

### Snapshots and recovery

The storage class must support dynamic provisioning, expansion, topology-aware
attachment, and Kubernetes `VolumeSnapshot` resources. Snapshot policy:

1. acquire the worktree mutation lock;
2. stop or checkpoint active writers;
3. flush filesystem buffers and record the runtime generation;
4. create the CSI snapshot;
5. record snapshot metadata in PostgreSQL;
6. release the lock after the snapshot is ready.

A snapshot taken without quiescing is only crash-consistent and must be labeled
as such. PostgreSQL backups are separate from PVC snapshots; restoring one does
not imply the other was restored to the same logical point.

Scheduled snapshots and pre-destructive-operation snapshots are retained under
a documented policy and exported to encrypted off-cluster storage. Restore
creates a new PVC first. Promotion to the live worktree requires `git fsck`,
`git status`, representative session reads, and an application-level smoke
test. Destructive in-place restore is not the default.

## HA K3s requirements

A production K3s installation is acceptable only when it has:

- at least three server nodes using embedded etcd, spread across independent
  failure domains, behind a stable API/load-balancer address;
- a separate runtime worker pool with hardware virtualization, labels, taints,
  and enough spare capacity to reschedule one failed node;
- an HA PostgreSQL service with tested point-in-time recovery outside the K3s
  control-plane datastore;
- a CSI driver supporting the required PVC and `VolumeSnapshot` behavior;
- a CNI that actually enforces ingress and egress `NetworkPolicy`;
- an ingress controller proven with WebSocket upgrades, SSE buffering disabled,
  long idle timeouts, affinity, and graceful draining;
- PodDisruptionBudgets, topology spreading, resource requests, and controlled
  node maintenance for control-plane and runtime-controller workloads;
- external secret management, encrypted transport, certificate automation,
  centralized logs, metrics, traces, and audit retention;
- tested backups for etcd, PostgreSQL, and worktree volumes, plus a documented
  full-cluster restore exercise.

A single-server K3s installation is a development environment, not the paid
cloud HA topology. Three control-plane nodes do not make worktree storage HA
unless the CSI layer and recovery process also tolerate node loss.

## Failure semantics

| Failure | Required behavior |
|---|---|
| Control-plane pod exits | Clients reconnect through another replica; runtime work continues. |
| Browser or native app disconnects | The runtime retains the agent and its stream buffer. |
| Runtime pod exits | The lease expires or is fenced; a replacement remounts the PVC and resumes from durable session state. |
| Runtime node disappears | Storage is detached or fenced before rescheduling; no dual writer is allowed. |
| PostgreSQL is unavailable | New writes and leases fail closed; existing runtime processes may finish but cannot invent durable control-plane state. |
| Snapshot service fails | Work continues, an alert fires, and the failed snapshot is never reported as restorable. |
| Model broker is unavailable | Agent work pauses with a retryable state; no broader credential is injected as fallback. |

## Staged migration

### Stage 0 — preserve the product contract

Keep Docker Compose and SQLite as the self-host default. Define storage,
database, runtime, stream, and lease interfaces around the existing code. Add
contract tests before changing deployment topology.

### Stage 1 — externalize control-plane state

Add PostgreSQL schema and migration tooling for hosted deployments. Move auth
sessions, metadata, billing idempotency, metering, and runtime ownership out of
process. Run SQLite and PostgreSQL implementations against the same behavioral
tests; do not make PostgreSQL mandatory for Compose.

### Stage 2 — split the runtime boundary

Move filesystem, Git, agent, and terminal operations behind an authenticated
runtime API. Initially run one runtime worker and one storage class in a single
cluster. Add generation leases, stream replay cursors, idempotent commands, and
sticky routing. Prove that restarting every control-plane replica does not stop
an active agent.

### Stage 3 — one PVC and isolated runtime per worktree

Introduce the runtime controller, hardware `RuntimeClass`, per-worktree PVCs,
default-deny networking, suspend/resume, and snapshot/restore. Hosted traffic
does not move to this stage until node-loss and split-brain tests pass.

### Stage 4 — HA K3s and operational hardening

Deploy the three-server K3s topology, dedicated runtime workers, HA PostgreSQL,
off-cluster backups, observability, disruption policies, capacity alerts, and
restore drills. Load-test reconnect storms, rolling upgrades, and concurrent
worktree activation before enabling paid organizations.

### Stage 5 — Agent Sandbox evaluation

Keep runtime lifecycle behind a Waynode-owned adapter. Evaluate the Kubernetes
Agent Sandbox APIs when their lifecycle, isolation, networking, persistence,
and project maturity meet Waynode's requirements. Adoption should replace the
controller implementation, not leak a new abstraction into product code or
make the self-host Compose path depend on Kubernetes.

## Release gates

Paid-cloud Kubernetes is not ready until all of these are automated and pass:

- no control-plane pod writes correctness-critical data to its local disk;
- a rolling control-plane restart preserves authentication and active work;
- repeated create, retry, and delete commands are idempotent;
- a forced network partition cannot produce two writable runtime generations;
- SSE and WebSocket clients reconnect through a different replica without
  losing durable output;
- runtime node loss recovers within the declared objective and preserves Git
  and session integrity;
- PostgreSQL point-in-time restore and PVC restore are tested together;
- namespace, runtime, credential, and network isolation pass adversarial tests;
- billing quotas remain correct under concurrent replicas and duplicate events;
- the standard Docker Compose installation and its backup/restore tests remain
  green.

## Explicit non-decisions

This ADR does not select a managed Kubernetes vendor, CSI implementation,
PostgreSQL vendor, VM runtime, or Agent Sandbox implementation. Those choices
require measured compatibility and failure tests. It also does not authorize a
multi-region active-active filesystem, shared writable NFS worktrees, or one
ephemeral worktree per chat message.
