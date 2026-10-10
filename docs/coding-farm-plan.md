# Trusted coding farm implementation plan

Status: first routine release implemented (0.2.1); later milestones remain
planned. Product decision: 2026-10-08. See [farm operations](farm.md) for the
actual supported behavior and limits.

## Delivery checkpoint — 2026-10-08

- F01: strict routine schemas, explicit execution grants, versioned dedicated
  transport, durable attempts, leases/fencing and signed recipient keys are
  implemented. Agent/checkpoint schema extensions remain future work.
- F02: one-worker offline routine execution, encrypted source/results and
  histories, CLI/API/client/UI controls, cancellation, bounded resources and
  restart cleanup are implemented. Real Docker tests use two node processes on
  one Linux x64 host. This is not a separate-machine or WAN acceptance result.
- Initial source format is a bounded file manifest, not an archive; path escapes,
  duplicate/conflicting entries and content digests are validated directly.
- Declared build files are returned encrypted and digest-verified, with explicit
  output paths and a 1 MiB aggregate bound; CLI export uses a new directory.
- Current transfers are chunked but not resumable. No coding patch,
  agent checkpoint, automatic retry or automatic idle scheduling
  is implemented. Result/key expiry is supported; key rotation and history
  compaction are not. F02's broader transfer/artifact lifecycle remains open.
- F03–F07: pending. The PSM adapter has a callable routine client/API to build
  against; no PSM software was changed in this implementation.

Final checks: build/typecheck passed, and 234 unit/integration tests passed in
21 files. Detailed scope is recorded in [testing](testing.md). No live deployment or
existing node configuration is changed. Farm mode remains off by default.

Promise: **Put idle machines to work on your coding tasks.** Start with exact
verification routines, then evaluate bounded implementation using open models.
PSM owns planning, source authority, acceptance and deployment; ai-mesh supplies
approved workers. The companion [PSM plan](../../psm/docs/roadmaps/ai-mesh-provider.md)
defines the application integration after this worker foundation.

## Scope and boundaries

- First users are individuals and small groups who explicitly trust worker owners.
- Peer membership and inference approval do not authorize code execution. Farm
  mode is off by default and has its own requester allowlist and resource policy.
- Start with one explicitly selected Linux worker, one job at a time and manual
  availability. Automatic routing, idle detection and checkpoint migration follow.
- First jobs run configured tests, typechecks and builds without a language model.
  They return evidence; they do not deploy, publish, merge or receive release keys.
- Initial coding agents use catalogued, openly licensed models. More machines
  increase capacity, not reasoning quality. Benchmark before enabling a model
  for repository implementation. A CPU-only node can supply execution separately
  from a GPU model worker in a later milestone.
- Existing inference protocols and requester-local tools remain supported. This
  introduces a separately versioned execution capability; it does not silently
  turn text-generation workers into command runners.
- Commercial subscriptions remain on their authorized PSM/provider machine;
  credential pooling and subscription resale are outside this mesh plan.

## Existing foundation

Reuse authenticated Noise transport, approved peers, bounded protocols, draining,
resource monitoring, model fingerprints and measured inference routing. The
[agent design](agents-design.md) currently runs tools on the requester, and
[security assumptions](security.md) deny peers remote command execution. Update
those documents with an explicit opt-in exception when the feature is implemented.
Reuse PSM's execution hardening where appropriate, but choose one owner for each
job's durable state and retry decisions.

## Responsibility and lifecycle

For PSM-submitted work, PSM owns the durable job and dispatch attempt. ai-mesh
owns worker admission, execution records, artifacts and worker-side cancellation.
The requester-local adapter translates between them. A worker never forwards an
execution job or independently schedules a replacement attempt.

Proposed worker states: accepted → preparing → running → collecting → completed;
also rejected, failed, cancelled and interrupted. Completion means outputs were
produced, not that PSM accepted the work. Report cleanup separately. Preserve
completed artifacts until requester acknowledgement or a declared retention TTL.
If PSM is unavailable, retain bounded results and refuse work exceeding capacity.

Each job has a stable ID and each dispatch has a unique attempt ID and fencing
generation. Persist identity and state before execution; enforce duplicate
admission across restarts. Expired or revoked attempts cannot deliver an accepted
result or publish a checkpoint. Stop execution on lease loss, with a bounded
termination deadline. PSM alone decides whether retry is safe. An uncertain
external side effect stays uncertain; do not claim exactly-once execution.

## Versioned job contract

Publish a schema shared by worker, client and PSM adapter before implementation.

| Field | Required meaning |
| --- | --- |
| Identity | Schema version, job/attempt IDs, fence, requester and target peer |
| Scope | Workspace/project IDs, confirmed plan ID/revision/step where applicable |
| Source | Exact base commit plus snapshot digest; an explicit overlay digest for any included uncommitted changes |
| Runtime | Pinned image digest, architecture, working directory and prepared dependency inputs |
| Task | Routine steps, or bounded objective, relevant docs, examples and allowed file paths |
| Authority | Allowed operations, explicit network policy, no inherited host environment or credentials |
| Limits | CPU, RAM, disk, processes, output, time, steps and transfer limits |
| Verification | Required commands, expected checks and independent acceptance criteria |
| Recovery | Lease duration, cancellation, retry class, retention and checkpoint policy |
| Model | For agent jobs: exact model artifact/runtime identity, context and generation budgets |
| Outputs | Patch, logs, check results, artifact digests and optional checkpoint |

Validate before allocating disk or accepting bytes. Define concrete defaults and
maximums in the schema milestone; enforce on both requester and worker. Reject
unknown required features, incompatible architecture and unavailable images.
No image pulls, model installation or arbitrary host paths from a peer request.
Routine commands are approved executable input, not instructions extracted by a
model. Dependency preparation is a separate bounded operation: first acceptance
uses a pinned prepared environment with execution network disabled.

## Source transfer, artifacts and encryption

- Package only the selected project and task documents. Exclude credential files,
  local sessions, dependencies/build caches and unrelated workspace content.
  Show the transfer manifest; exclusions alone cannot detect every secret.
- Bound bytes/file count/path lengths and validate hashes. Reject absolute paths,
  traversal, symlinks and archive entries that escape the job directory. Transfer
  chunks with bounded resumability and cancellation outside inference frames.
- Reuse authenticated encrypted mesh transport. Add authenticated encryption for
  durable packages/checkpoints/results using vetted libraries and fresh object
  nonces, with job/attempt/source identity bound as authenticated data.
- Generate a fresh data key per job; wrap it for the selected worker using a
  vetted recipient-encryption scheme and an encryption key cryptographically
  bound to its mesh identity. Do not repurpose identity signing keys directly.
  Return results encrypted for the requester; storage/relay services get no keys.
- Define key persistence, rotation, revocation, restart recovery, expiry and
  reassignment. Reassignment requires a new authorized attempt and key grant.
  Revocation prevents future grants; it cannot retract plaintext already read.
- Decrypt only in the selected execution environment. The host administrator can
  inspect that environment: encryption does not hide executing work from them.
  Cleanup/key removal reduces retention but cannot prove no copies were made.
- Hashes/signatures establish binding and provenance, not correct code or honest
  tests. Do not spread private jobs, transcripts or outputs into pack memory.

## Execution and agent behavior

Use a disposable per-attempt workspace and hardened non-root sandbox with no
Docker socket, host namespaces, privileged mode, general host mounts or inherited
credentials. Apply CPU/RAM/disk/PID/output/time limits. Network is disabled by
default; any model connection uses a narrowly scoped broker rather than broad
LAN access. Document container/kernel escape limits.

For implementation, pin and evaluate an existing agent runtime before choosing
an adapter. The worker edits only allowed paths and returns a patch against the
exact source snapshot. It cannot push, merge, deploy or change permissions.
If scope or design is ambiguous, stop with a structured question; PSM can revise
the task and issue a new attempt. Tool logs and model assertions are untrusted
evidence. Independent verification and human/provider review live in PSM.

## Farm mode and recovery

Manual on/off, approved requesters and owner resource limits come first. Off or
draining stops admission and follows the configured cancellation/grace policy.
Automatic idle detection must be tested per supported OS; foreground ownership,
battery/power and resource demand override farm availability.

For agent jobs, checkpoint between completed tool operations: source identity,
patch/files, conversation, step state, environment identity and tool outcomes.
Requester acknowledges a durable checkpoint before an old copy is cleaned up.
Do not migrate arbitrary live processes, GPU caches or open connections. After
interruption resume a compatible checkpoint and rerun incomplete isolated tools.
First routines restart from the beginning if declared safe; checkpoint migration
is a separate milestone. Fencing rejects late results from superseded workers.

## Ordered delivery and acceptance

| Milestone | Deliverable | Acceptance gate |
| --- | --- | --- |
| F01 | Schema, permissions, lifecycle and threat model | Fixtures prove version rejection, bounds, job/attempt binding and explicit execution grants; document ownership of leases/retries |
| F02 | One-worker routine execution and encrypted transfer | Two trusted Linux nodes execute tests/typecheck/build on a disposable repo without a model; collect bounded logs/results; verify inputs; cancel and clean up |
| F03 | PSM routine adapter | Complete companion M01–M03: exact snapshot submitted from PSM, events visible, verified result collected without source/deployment mutation |
| F04 | Bounded open-model implementation | Complete M04: one small bug/test/doc task; enforce file/operation limits, return patch/question, compare against requester-owned checks |
| F05 | Durable checkpoints and manual handoff | Kill/restart requester and worker; preserve acknowledged progress, reject stale attempts, resume on a compatible approved worker without duplicated side effects |
| F06 | Automatic farm scheduling | Owner activity reclaims resources within a measured bound; revoked/unavailable workers refused; resource caps hold; compatible jobs routed without idle flapping |
| F07 | Separate execution and inference workers | Explicitly authorize both recipients, scope model traffic, measure latency/context cost and reject inference workers outside the task trust boundary |

F02 must exercise malformed archives, duplicate dispatch, lease loss, disk/output
exhaustion, blocked network/host access and missing images. F03 must exercise
source changes while a result is pending, browser closure and cancellation races.
F05 must inject failure before/after checkpoint and result acknowledgement.

Evaluate about 20 representative bounded coding tasks from pinned baselines.
Record model/quantization/context, hardware, accepted patches, independent check
outcomes, interventions, wall time, interruption loss, setup overhead and energy
where measurable. Label missing metrics. Compare the same tasks locally and
remotely; publish observed quality, not extrapolated frontier-model equivalence.
Choose explicit task-class thresholds from that evidence before broader rollout.

## Implementation map and next action

- `packages/protocol`: execution schemas, capability negotiation, bounded frames.
- `packages/client`: execution submit/events/cancel/artifact retrieval.
- `apps/node`: farm policy, execution handler, durable attempts, sandbox, transfer
  and encryption, cancellation and recovery; keep inference queues distinct.
- CLI/UI: opt-in farm controls, transfer/trust disclosure, job and cleanup status.
- Docs: update protocol/API/security/operations/testing when behavior ships.

Next action: finish F02's resumable source/build-artifact lifecycle, then implement
the PSM M01–M03 adapter (F03) against the routine API. Evaluate the coding runtime
and models before enabling F04, then deliver checkpoint/idle scheduling gates.
Record implemented, tested and integrated separately. This document authorizes
no live deployment; the delivery checkpoint distinguishes shipped behavior from
the target design below.

## Research references

Primary sources consulted 2026-10-08; recheck upstream APIs before integration:
[Salad](https://salad.com/),
[Golem providers](https://docs.golem.network/docs/providers),
[HTCondor desktop policies](https://htcondor.readthedocs.io/en/lts/admin-manual/ep-policy-configuration.html),
[OpenHands](https://www.openhands.dev/product/canvas),
[mini-SWE-agent](https://github.com/SWE-agent/mini-swe-agent),
[exo](https://github.com/exo-explore/exo),
[Petals](https://github.com/bigscience-workshop/petals).
These establish adjacent approaches, not uniqueness or suitability of a chosen
runtime. Local coding quality remains an acceptance question.
