# Trusted routine execution

The first coding-farm implementation runs exact tests, checks and builds on one
approved peer. It does not use a model or change your local source. Farm mode is
off by default. Inference membership alone never permits command execution.
The [implementation plan](coding-farm-plan.md) tracks subsequent coding agents,
PSM integration, checkpoints and automatic idle scheduling.

## Trust and requirements

Use only computers whose owners you trust with the submitted project. Noise
encrypts peer traffic. Packages/results are additionally encrypted for their
recipient with X25519, HKDF-SHA256 and AES-256-GCM; encryption keys are signed by
the node's existing Ed25519 identity. Durable job records are encrypted with a
separate node-local storage key. Keys live under `data/<node>/farm/`, owner-only.
This protects stored copies against parties without keys, not against the owner
of the worker executing your source. Protect/backup the key files with the node;
losing them makes encrypted history unreadable. Do not rotate them manually
while attempts or retained results depend on them.

Initial execution supports Linux x64/arm64 and requires Docker on the worker.
Select an operator-installed image pinned by digest, containing Node and
`/bin/sh`, with any required tools/dependencies already prepared. Peer requests
never pull images. The default is:

```text
node:22-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9
```

Install this exact image yourself with `docker pull` before enabling its use.
For npm projects that require dependencies, prepare a suitable digest-pinned
image with dependencies in a location the routine can use; the basic Node image
does not contain your project's dependencies. No installation/network phase is
implicitly performed, and host `node_modules` is excluded from packages.

The sandbox has no network, Docker socket, host source mount, host namespaces,
inherited credentials or privileged mode. It uses non-root execution, a
read-only root, dropped capabilities, memory/CPU/PID/descriptor limits and a
size-limited `/work` tmpfs. Source arrives on stdin and exists only inside that
temporary workspace. `/tmp` is a separate 16 MB tmpfs. Tmpfs usage also consumes
the container's memory budget. Containers are owner-labelled for restart cleanup.
Container/kernel flaws remain outside the claimed isolation guarantee.

## Enable one trusted worker

Approve membership mutually as described in [operations](operations.md). Then
on worker B, using requester A's peer ID:

```bash
./mesh farm on <A-peer-id> --cpus 1 --memory 512 --disk 64 --timeout 600000
./mesh farm status
```

This replaces B's farm requester list. These are CPU cores, memory/work-disk MB
and timeout milliseconds. An explicit `--image repository@sha256:…` replaces the
offered image list; repeat it for several images. Requests exceeding the owner's
limits or using an unavailable image/architecture are rejected.

`./mesh farm off` stops new admission and cancels current work. Saving a changed
farm policy also cancels current work so new owner limits take effect. It is manual
owner priority; automatic keyboard/idle detection is not implemented. The UI's
**Farm** page offers the same policy, source/command review, submission, status,
cancellation and acknowledgement. Use an admin token; ordinary chat tokens do
not have farm authority. Disable loopback trust on shared hosts.

## Prepare, review and submit

On requester A, prepare a small Git project with a committed baseline:

```bash
./mesh farm discover <B-peer-id>
./mesh farm prepare --source /absolute/path/to/project --target <B-peer-id> \
  --command 'node --test' --command 'node --check index.js' \
  --out /tmp/project-routine.json
```

Preparation exports a bounded snapshot and prints its file manifest and exact
commands; it does not send or execute anything. It excludes `.git`, credentials,
provider sessions, dependencies, build output and caches, and rejects symlinks
and special files. Read the output package: exclusions cannot identify every
secret. The JSON review file contains plaintext source and is written mode 0600;
store/remove it accordingly. Source file executable modes are not preserved;
invoke checked-in scripts through their interpreter.

The snapshot binds a base commit, content digest and an overlay digest when Git
reports local changes. Commands run against that exported snapshot, not a fresh
checkout of a moving branch. Limits default to 1 CPU, 512 MB memory, 64 MB work
disk, 10 minutes and 64 KiB combined routine output. Override with the same
resource flags when preparing; the worker independently checks its policy.

Review the source, commands and target owner, then:

```bash
./mesh farm run /tmp/project-routine.json --yes
./mesh farm job /tmp/project-routine.json
./mesh farm cancel /tmp/project-routine.json
```

`--yes` expresses source-export and command-execution consent for this reviewed
package. Repeat `farm job` to collect status and bounded per-step output. A
completed job means all routines returned zero without timeout/truncation; it
does not prove the tests are sufficient or the worker is honest. No files are
applied, published, merged or deployed. To return build files, declare each
exact path with `--output dist/index.html` while preparing (repeat for several
files). At most 16 files and 1 MiB combined may be returned. Symlinks and path
escapes are refused; returned content is digest-verified against the declared
output paths. Export collected artifacts into a new directory with:

```bash
./mesh farm artifacts /tmp/project-routine.json --out /tmp/returned-build
```

Outputs are explicitly requested generated files; source exclusions do not apply
to them. Inspect their contents before using them. Returned artifacts do not
constitute a deployment or a verified PSM release candidate.

After the requester has collected a terminal result, acknowledge it:

```bash
./mesh farm ack /tmp/project-routine.json
```

The requester persists results before acknowledgement; the worker discards its
retained encrypted result. Cancelled/interrupted attempts may also be acknowledged.
Worker results otherwise expire after the configured retention period (default
24 hours after completion). Cleanup is reported independently and never claimed
as proof that an owner made no copies.

## Failure behavior and bounds

- The worker admits one routine at a time. Requesters allow at most four
  unresolved attempts. There is no farm queue, automatic routing or failover.
- Requester nodes renew 30-second worker leases. Browser closure is harmless;
  requester loss expires the lease and cancels execution. Cancellation intent
  is durable and retried as cancellation, not heartbeat renewal.
- Workers persist admission before executing and deduplicate attempts across
  restarts. A repeated attempt with different content is refused. A new attempt
  for the same requester/job needs a strictly higher fence. No automatic retry
  occurs, even when a routine declares isolated retry eligibility.
- A lost submission reply is shown as uncertain and queried by attempt ID.
  Do not assume it did not run. Partial transfer is discarded and never executed;
  chunk resumption is not implemented. Use a new authorized attempt only after
  reconciling/cancelling the earlier attempt.
- Worker restart removes its labelled containers and marks unfinished attempts
  interrupted, without replay. If cleanup cannot be verified, admission stays
  disabled; restore Docker access and restart to retry cleanup.
- Source: at most 512 files, 1 MiB per file, 4 MiB combined content. Chunk size:
  64 KiB; total serialized encrypted request/reply: 8 MiB. Each RPC has a
  15-second deadline and at most four inbound streams. The v1 transport is aimed
  at small projects on reliable links, not large repositories.
- Output: protocol ceiling 128 KiB, shared across steps. Excess output fails the
  job as truncated; commands stop at the first failing step. Work-disk/PID/memory
  exhaustion and timeouts fail the attempt rather than expanding host access.
- Worker/requester encrypted histories each retain at most 128 records, including
  deduplication tombstones. Full history refuses admission rather than evicting
  replay protection. Automated history compaction is a future extension; do not
  delete records manually to bypass this bound on an active node.

Private jobs and their outputs never enter pack memory or earn inference reward
receipts. Encryption does not make status metadata anonymous.

## API and client contract

All HTTP operations require operator/admin authority:

| Endpoint | Meaning |
| --- | --- |
| `GET /admin/farm` | Policy, worker history and requester job summaries |
| `POST /admin/farm/policy` | Validate/persist the complete farm policy |
| `GET /admin/farm/peers/:peerId` | Direct authenticated capability/key discovery |
| `POST /admin/farm/jobs` | Submit `FarmSubmit` (target plus source package), up to 8 MiB |
| `POST /admin/farm/jobs/status` | Retrieve locally persisted status/result for `FarmRef` |
| `POST /admin/farm/jobs/cancel` | Persist cancellation intent and request cancellation |
| `POST /admin/farm/jobs/ack` | Acknowledge durably collected terminal results |

`FarmClient` in `@werewolf-mesh/client` exposes discover, submit, status, cancel
and acknowledge. It uses one explicitly configured gateway and never fails over
or replays submissions. Schemas/defaults are in `packages/protocol/src/farm.ts`.
Peer execution speaks `/werewolf-mesh/farm/1.0.0`, independently of inference v2.
Membership is checked on every RPC; worker policy separately grants admission.
For PSM integration, use the requester-local node and preserve PSM's source,
permission, independent verification and release policies.
