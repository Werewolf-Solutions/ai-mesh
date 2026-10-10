import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  FARM_LIMITS, FarmPackage, FarmPolicy, FarmResult, FarmStatus,
  type FarmCapabilities, type FarmEnvelope, type FarmKey, type FarmRef,
  type FarmReply, type FarmRequest, type FarmResult as Result, type FarmStatus as Status,
  type FarmPolicy as Policy, type FarmPackage as Package,
} from '@werewolf-mesh/protocol';
import type { Identity } from '../identity.js';
import { atomicWriteFile, atomicWriteJson, readJsonIfExists } from '../util/fs.js';
import { encryptFor, FarmCrypto, verifyFarmKey } from './crypto.js';
import { validateSource, sha256 } from './source.js';
import { cleanupFarmContainers, farmImageAvailable, runFarmSandbox } from './sandbox.js';

export const DEFAULT_FARM_IMAGE = 'node:22-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9';
export const farmContext = (ref: FarmRef, kind: 'source' | 'result') => `farm-v1/${ref.jobId}/${ref.attemptId}/${ref.fence}/${kind}`;
export const farmRecordId = (peer: string, ref: FarmRef) => sha256(`${peer}\0${ref.jobId}\0${ref.attemptId}\0${ref.fence}`);
const active = (s: Status['state']) => ['accepted', 'preparing', 'running', 'collecting'].includes(s);
const refOf = (s: FarmRef): FarmRef => ({ jobId: s.jobId, attemptId: s.attemptId, fence: s.fence });

interface WorkerRecord { status: Status; packageDigest: string; leaseUntil: number; expiresAt: number; envelope?: FarmEnvelope; resultKey: FarmKey; result?: FarmEnvelope; container: string }
export interface FarmJobView { ref: FarmRef; targetPeerId: string; state: 'submitting' | 'uncertain' | 'rejected' | Status['state']; status?: Status; error?: string; result?: Result }
interface Outgoing { view: FarmJobView; packageDigest: string; sourceDigest: string; image: string; outputs: string[]; cancelRequested?: boolean; envelope?: FarmEnvelope; result?: Result }
class RemoteFarmError extends Error {}
export type FarmExecutor = (pkg: Package, label: string, name: string, signal: AbortSignal) => Promise<Result>;

/** Worker and requester state are encrypted separately from source envelopes. */
export class FarmService {
  private policy: Policy = FarmPolicy.parse({});
  private crypto!: FarmCrypto;
  private readonly records = new Map<string, WorkerRecord>();
  private readonly outgoing = new Map<string, Outgoing>();
  private running: { id: string; controller: AbortController; promise: Promise<void> } | undefined;
  private timer: NodeJS.Timeout | undefined;
  private polling = false;
  private stopping = false;
  private queue: Promise<unknown> = Promise.resolve();
  private callRemote: ((peer: string, request: FarmRequest) => Promise<FarmReply>) | undefined;
  private cleanupReady = true;
  constructor(private readonly opts: { dataDir: string; identity: Identity; authorized: (peer: string) => boolean; executor?: FarmExecutor; cleanup?: (label: string) => Promise<void>; imageAvailable?: (image: string, architecture: string) => Promise<boolean> }) {}
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn); this.queue = next.catch(() => undefined); return next;
  }
  private path(kind: 'worker' | 'outgoing', id: string) { return join(this.opts.dataDir, 'farm', kind, `${id}.sealed`); }
  private async save(kind: 'worker' | 'outgoing', id: string, value: unknown) {
    await atomicWriteFile(this.path(kind, id), this.crypto.sealRecord(value, `${kind}/${id}`));
  }
  private permitted(peer: string) { return !this.stopping && this.policy.enabled && this.opts.authorized(peer) && this.policy.requesters.includes(peer); }
  async init(): Promise<void> {
    this.crypto = await FarmCrypto.load(this.opts.dataDir, this.opts.identity);
    this.policy = FarmPolicy.parse(await readJsonIfExists(join(this.opts.dataDir, 'farm-policy.json')) ?? {});
    for (const kind of ['worker', 'outgoing'] as const) {
      const dir = join(this.opts.dataDir, 'farm', kind);
      const names = await readdir(dir).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return []; throw e; });
      if (names.length > FARM_LIMITS.records) throw new Error('farm durable record quota exceeded');
      for (const name of names) {
        if (!/^[a-f0-9]{64}\.sealed$/.test(name)) continue;
        const id = name.slice(0, -7), bytes = await readFile(join(dir, name));
        if (bytes.length > FARM_LIMITS.transferBytes * 2) throw new Error('farm record exceeds limit');
        const value = this.crypto.openRecord(bytes, `${kind}/${id}`);
        if (kind === 'worker') {
          const r = value as WorkerRecord; r.status = FarmStatus.parse(r.status);
          if (farmRecordId(r.status.requesterPeerId, r.status) !== id) throw new Error('worker record identity mismatch');
          if (active(r.status.state)) { r.status.state = 'interrupted'; r.status.detail = 'worker restarted; no automatic replay'; r.status.cleanup = 'pending'; r.status.updatedAt = Date.now(); }
          this.records.set(id, r);
        } else {
          const r = value as Outgoing;
          if (farmRecordId(this.opts.identity.peerId, r.view.ref) !== id) throw new Error('requester record identity mismatch');
          this.outgoing.set(id, r);
        }
      }
    }
    // Only contact Docker when recovering farm work. A disabled inference node
    // must continue to start without Docker.
    if ([...this.records.values()].some((r) => r.status.cleanup !== 'done')) {
      try {
        await (this.opts.cleanup ?? cleanupFarmContainers)(this.opts.identity.peerId);
        for (const [id, r] of this.records) if (r.status.cleanup !== 'done') { r.status.cleanup = 'done'; await this.save('worker', id, r); }
      } catch { this.cleanupReady = false; }
    }
    this.timer = setInterval(() => { void this.tick().catch(() => undefined); }, 1000);
    this.timer.unref();
  }
  connect(call: (peer: string, request: FarmRequest) => Promise<FarmReply>): void { this.callRemote = call; }
  capabilities(peer: string): FarmCapabilities {
    return { v: 1, key: this.crypto.announcement, enabled: this.policy.enabled && !this.stopping && this.cleanupReady,
      permitted: this.permitted(peer) && this.cleanupReady, architecture: process.arch, images: this.policy.images,
      active: !!this.running, limits: { ...this.policy, requesters: [] } };
  }
  localView() { return { policy: this.policy, key: this.crypto.announcement, active: !!this.running, cleanupReady: this.cleanupReady, jobs: [...this.records.values()].map((r) => r.status), outgoing: this.jobs() }; }
  async setPolicy(raw: unknown): Promise<Policy> {
    return this.locked(async () => {
      const next = FarmPolicy.parse(raw);
      if (next.enabled && next.requesters.some((p) => !this.opts.authorized(p))) throw new Error('farm requesters must already be approved peers');
      const changed = JSON.stringify(next) !== JSON.stringify(this.policy);
      await atomicWriteJson(join(this.opts.dataDir, 'farm-policy.json'), next); this.policy = next;
      if (this.running) {
        const record = this.records.get(this.running.id)!;
        if (changed || !this.permitted(record.status.requesterPeerId)) this.running.controller.abort();
      }
      return next;
    });
  }
  async handle(remote: string, raw: FarmRequest): Promise<FarmReply> {
    if (!this.opts.authorized(remote)) return { type: 'error', code: 'forbidden', message: 'peer is not approved' };
    try {
      if (raw.op === 'discover') return { type: 'capabilities', value: this.capabilities(remote) };
      return await this.locked(async () => {
        if (raw.op === 'submit') return this.accept(remote, raw);
        const id = farmRecordId(remote, raw.ref), record = this.records.get(id);
        if (!record) return { type: 'error', code: 'not_found', message: 'unknown execution attempt' } as FarmReply;
        if (raw.op === 'heartbeat' && active(record.status.state)) {
          if (this.permitted(remote)) record.leaseUntil = Date.now() + FARM_LIMITS.leaseMs;
          else if (this.running?.id === id) this.running.controller.abort();
          await this.save('worker', id, record);
        }
        if (raw.op === 'cancel' && this.running?.id === id) this.running.controller.abort();
        if (raw.op === 'result') {
          if (record.status.state !== 'completed' && record.status.state !== 'failed') return { type: 'error', code: 'conflict', message: 'no result for this state' } as FarmReply;
          if (!record.result) return { type: 'error', code: 'not_found', message: 'result acknowledged or expired' } as FarmReply;
          return { type: 'result', value: record.result } as FarmReply;
        }
        if (raw.op === 'ack') {
          if (active(record.status.state)) return { type: 'error', code: 'conflict', message: 'cannot acknowledge a running job' } as FarmReply;
          record.status.acknowledged = true; record.envelope = undefined; record.result = undefined;
          record.status.resultAvailable = false;
          await this.save('worker', id, record);
        }
        return { type: 'status', value: record.status } as FarmReply;
      });
    } catch { return { type: 'error', code: 'bad_request', message: 'invalid farm request or encrypted package' }; }
  }
  private async accept(remote: string, req: Extract<FarmRequest, { op: 'submit' }>): Promise<FarmReply> {
    if (!this.permitted(remote) || !this.cleanupReady) return { type: 'error', code: 'forbidden', message: 'farm execution is not granted to this peer' };
    if (process.platform !== 'linux') return { type: 'error', code: 'unavailable', message: 'farm execution currently requires Linux' };
    await verifyFarmKey(req.resultKey, remote);
    const pkg = FarmPackage.parse(JSON.parse(this.crypto.decrypt(req.envelope, req.envelope.context).toString('utf8')));
    const spec = pkg.spec;
    if (spec.requesterPeerId !== remote || spec.targetPeerId !== this.opts.identity.peerId || req.envelope.context !== farmContext(spec, 'source')) throw new Error('job binding mismatch');
    validateSource(pkg.source, spec.source.digest);
    if (new Set(spec.outputs).size !== spec.outputs.length) throw new Error('duplicate artifact path');
    const id = farmRecordId(remote, spec), previous = this.records.get(id);
    if (previous) {
      if (previous.packageDigest !== sha256(JSON.stringify(pkg))) return { type: 'error', code: 'conflict', message: 'attempt reused with different inputs' };
      return { type: 'status', value: previous.status };
    }
    for (const r of this.records.values()) if (r.status.requesterPeerId === remote && r.status.jobId === spec.jobId && r.status.fence >= spec.fence) return { type: 'error', code: 'conflict', message: 'fence must exceed earlier attempts' };
    if (this.running || this.records.size >= FARM_LIMITS.records) return { type: 'error', code: 'busy', message: 'worker busy or durable history quota reached' };
    if (spec.architecture !== process.arch || !this.policy.images.includes(spec.image)) return { type: 'error', code: 'unavailable', message: 'image or architecture is not offered by this worker' };
    for (const field of ['cpus', 'memoryMb', 'diskMb', 'timeoutMs'] as const) if (spec.limits[field] > this.policy[field]) return { type: 'error', code: 'forbidden', message: `job exceeds owner ${field} limit` };
    if (!(await (this.opts.imageAvailable ?? farmImageAvailable)(spec.image, spec.architecture))) return { type: 'error', code: 'unavailable', message: 'pinned image must be installed locally before admission' };
    if (!this.permitted(remote)) return { type: 'error', code: 'forbidden', message: 'farm permission revoked during admission' };
    const now = Date.now();
    const record: WorkerRecord = {
      status: { ...refOf(spec), requesterPeerId: remote, targetPeerId: spec.targetPeerId, sourceDigest: spec.source.digest,
        state: 'accepted', createdAt: now, updatedAt: now, cleanup: 'pending', detail: 'accepted; not yet verified', acknowledged: false, resultAvailable: false },
      packageDigest: sha256(JSON.stringify(pkg)), leaseUntil: now + FARM_LIMITS.leaseMs, expiresAt: now + this.policy.retentionMs,
      envelope: req.envelope, resultKey: req.resultKey, container: `werewolf-farm-${id.slice(0, 24)}`,
    };
    await this.save('worker', id, record); this.records.set(id, record);
    const controller = new AbortController();
    // Schedule after admission is durable, without holding the mutation lock.
    const promise = Promise.resolve().then(() => this.execute(id, pkg, controller)).catch(() => undefined);
    this.running = { id, controller, promise };
    return { type: 'status', value: { ...record.status } };
  }
  private async execute(id: string, pkg: Package, controller: AbortController): Promise<void> {
    const record = this.records.get(id)!;
    const update = async (state: Status['state'], detail: string) => this.locked(async () => {
      record.status.state = state; record.status.detail = detail; record.status.updatedAt = Date.now(); await this.save('worker', id, record);
    });
    try {
      await update('preparing', 'preparing pinned offline sandbox');
      if (controller.signal.aborted || !this.permitted(record.status.requesterPeerId)) { controller.abort(); throw new Error('cancelled'); }
      await update('running', 'running verification routines');
    const result = FarmResult.parse(await (this.opts.executor ?? runFarmSandbox)(pkg, this.opts.identity.peerId, record.container, controller.signal));
      validateSource({ files: result.artifacts }, undefined, false);
      if (result.artifacts.reduce((n, f) => n + Buffer.from(f.data, 'base64').length, 0) > FARM_LIMITS.artifactBytes || result.artifacts.some((f) => !pkg.spec.outputs.includes(f.path))) throw new Error('artifact scope/size mismatch');
      if (controller.signal.aborted || record.leaseUntil <= Date.now() || !this.permitted(record.status.requesterPeerId)) throw new Error('lease lost or cancelled');
      await update('collecting', 'collecting encrypted evidence');
      const passed = result.steps.length === pkg.spec.steps.length && result.steps.every((s) => s.exitCode === 0) && !result.timedOut && !result.truncated;
      await this.locked(async () => {
        if (controller.signal.aborted || record.leaseUntil <= Date.now() || !this.permitted(record.status.requesterPeerId)) throw new Error('lease lost or cancelled before result commit');
        record.result = encryptFor(record.resultKey, Buffer.from(JSON.stringify(result)), farmContext(record.status, 'result'));
        record.status.resultAvailable = true;
        record.status.state = passed ? 'completed' : 'failed';
        record.status.detail = passed ? 'routines completed; requester verification required' : 'routine failed, timed out or output truncated';
        record.status.updatedAt = Date.now();
        await this.save('worker', id, record);
      });
    } catch (err) {
      await update(controller.signal.aborted ? 'cancelled' : 'failed', controller.signal.aborted ? 'cancelled or lease revoked' : (err as Error).message.slice(0, 500));
    } finally {
      await this.locked(async () => {
        // Executor returns only after container cleanup; failure may leave state
        // uncertain, so perform an owner-labelled sweep before accepting work.
        try { await (this.opts.cleanup ?? cleanupFarmContainers)(this.opts.identity.peerId); record.status.cleanup = 'done'; }
        catch { record.status.cleanup = 'failed'; this.cleanupReady = false; }
        record.envelope = undefined; record.expiresAt = Date.now() + this.policy.retentionMs;
        await this.save('worker', id, record); this.running = undefined;
      });
    }
  }
  private async remote(peer: string, request: FarmRequest): Promise<FarmReply> {
    if (!this.callRemote) throw new Error('farm transport not connected');
    const reply = await this.callRemote(peer, request);
    if (reply.type === 'error') throw new RemoteFarmError(`${reply.code}: ${reply.message}`);
    return reply;
  }
  async discover(peer: string): Promise<FarmCapabilities> {
    const reply = await this.remote(peer, { op: 'discover' });
    if (reply.type !== 'capabilities' || reply.value.key.peerId !== peer) throw new Error('invalid farm capabilities');
    await verifyFarmKey(reply.value.key, peer); return reply.value;
  }
  jobs(): FarmJobView[] { return [...this.outgoing.values()].map((r) => ({ ...r.view, result: undefined })); }
  job(ref: FarmRef): FarmJobView {
    const record = this.outgoing.get(farmRecordId(this.opts.identity.peerId, ref));
    if (!record) throw new Error('unknown requester job');
    return { ...record.view, result: record.result };
  }
  async submit(raw: Package, target: string): Promise<FarmJobView> {
    const pkg = FarmPackage.parse(raw);
    validateSource(pkg.source, pkg.spec.source.digest);
    if (pkg.spec.requesterPeerId !== this.opts.identity.peerId || pkg.spec.targetPeerId !== target) throw new Error('requester/target identity mismatch');
    const id = farmRecordId(this.opts.identity.peerId, pkg.spec), digest = sha256(JSON.stringify(pkg));
    const old = this.outgoing.get(id);
    if (old) { if (old.packageDigest !== digest) throw new Error('attempt reused with different inputs'); return this.job(pkg.spec); }
    if (this.outgoing.size >= FARM_LIMITS.records) throw new Error('requester history quota reached');
    if ([...this.outgoing.values()].filter((r) => active(r.view.state as Status['state']) || ['submitting', 'uncertain'].includes(r.view.state)).length >= 4) throw new Error('requester has four unresolved attempts; reconcile or cancel before submitting more');
    const cap = await this.discover(target);
    if (!cap.permitted || !cap.enabled) throw new Error('target has not granted farm execution');
    const record: Outgoing = { view: { ref: refOf(pkg.spec), targetPeerId: target, state: 'submitting' }, packageDigest: digest, sourceDigest: pkg.spec.source.digest, image: pkg.spec.image, outputs: pkg.spec.outputs,
      envelope: encryptFor(cap.key, Buffer.from(JSON.stringify(pkg)), farmContext(pkg.spec, 'source')) };
    // Re-check after discovery because concurrent submissions may use the same ID.
    await this.locked(async () => {
      if (this.outgoing.has(id)) throw new Error('execution attempt already exists');
      if (this.outgoing.size >= FARM_LIMITS.records) throw new Error('requester history quota reached');
      if ([...this.outgoing.values()].filter((r) => active(r.view.state as Status['state']) || ['submitting', 'uncertain'].includes(r.view.state)).length >= 4) throw new Error('requester unresolved attempt limit reached');
      await this.save('outgoing', id, record); this.outgoing.set(id, record);
    });
    try {
      const reply = await this.remote(target, { op: 'submit', envelope: record.envelope!, resultKey: this.crypto.announcement });
      if (reply.type !== 'status') throw new Error('invalid submission reply');
      await this.locked(async () => { this.bindStatus(record, reply.value); await this.save('outgoing', id, record); });
    } catch (err) {
      await this.locked(async () => {
        if (!record.view.status) record.view.state = err instanceof RemoteFarmError ? 'rejected' : 'uncertain';
        record.view.error = (err as Error).message.slice(0, 500); await this.save('outgoing', id, record);
      });
    }
    return this.job(pkg.spec);
  }
  private bindStatus(record: Outgoing, status: Status) {
    const ref = record.view.ref;
    if (status.jobId !== ref.jobId || status.attemptId !== ref.attemptId || status.fence !== ref.fence || status.sourceDigest !== record.sourceDigest || status.requesterPeerId !== this.opts.identity.peerId || status.targetPeerId !== record.view.targetPeerId) throw new Error('remote status binding mismatch');
    if ((record.view.status?.updatedAt ?? 0) > status.updatedAt || (record.view.status?.acknowledged && !status.acknowledged)) return;
    if (record.view.status && !active(record.view.status.state) && active(status.state)) return;
    record.view.status = status; record.view.state = status.state; record.view.error = undefined;
  }
  async action(ref: FarmRef, op: 'cancel' | 'ack'): Promise<FarmJobView> {
    const id = farmRecordId(this.opts.identity.peerId, ref), record = this.outgoing.get(id);
    if (!record) throw new Error('unknown requester job');
    if (op === 'ack' && record.view.status?.resultAvailable && !record.result && !record.view.status?.acknowledged) throw new Error('retrieve and persist the result before acknowledgement');
    if (op === 'cancel') await this.locked(async () => { record.cancelRequested = true; await this.save('outgoing', id, record); });
    const reply = await this.remote(record.view.targetPeerId, { op, ref });
    if (reply.type !== 'status') throw new Error('invalid farm action reply');
    await this.locked(async () => {
      this.bindStatus(record, reply.value);
      if (op === 'ack') record.envelope = undefined;
      await this.save('outgoing', id, record);
    });
    return this.job(ref);
  }
  private async tick(): Promise<void> {
    if (this.stopping) return;
    if (this.running) {
      const record = this.records.get(this.running.id)!;
      if (!this.permitted(record.status.requesterPeerId) || record.leaseUntil <= Date.now()) this.running.controller.abort();
    }
    await this.locked(async () => {
      for (const [id, record] of this.records) if (!active(record.status.state) && record.expiresAt < Date.now() && (record.result || record.envelope)) {
        record.result = undefined; record.envelope = undefined; record.status.resultAvailable = false; await this.save('worker', id, record);
      }
    });
    if (this.polling || !this.callRemote) return;
    this.polling = true;
    try {
      // Terminal states still need their encrypted result collected after a
      // requester restart. Never replay an ambiguous submission.
      await Promise.all([...this.outgoing].map(async ([id, record]) => {
        const state = record.view.state;
        if (record.view.status?.acknowledged || record.result || ['cancelled', 'interrupted', 'rejected'].includes(state)) return;
        if (state === 'failed' && !record.view.status) return;
        if (record.view.status && !active(record.view.status.state) && !record.view.status.resultAvailable) return;
        try {
          const reply = await this.remote(record.view.targetPeerId, { op: record.cancelRequested ? 'cancel' : state === 'uncertain' || state === 'submitting' ? 'status' : 'heartbeat', ref: record.view.ref });
          if (reply.type !== 'status') throw new Error('invalid status reply');
          this.bindStatus(record, reply.value);
          if (reply.value.resultAvailable && ['completed', 'failed'].includes(reply.value.state)) {
            try {
              const result = await this.remote(record.view.targetPeerId, { op: 'result', ref: record.view.ref });
              if (result.type !== 'result') throw new Error('invalid result reply');
              const value = FarmResult.parse(JSON.parse(this.crypto.decrypt(result.value, farmContext(record.view.ref, 'result')).toString('utf8')));
              if (value.image !== record.image || value.sourceDigest !== record.sourceDigest || value.jobId !== reply.value.jobId || value.attemptId !== reply.value.attemptId || value.fence !== reply.value.fence) throw new Error('result binding mismatch');
              validateSource({ files: value.artifacts }, undefined, false);
              if (value.artifacts.some((f) => !record.outputs.includes(f.path)) || value.artifacts.reduce((n, f) => n + Buffer.from(f.data, 'base64').length, 0) > FARM_LIMITS.artifactBytes) throw new Error('returned artifact scope/size mismatch');
              record.result = value; record.envelope = undefined;
            } catch (err) { record.view.error = (err as Error).message.slice(0, 500); }
          }
          await this.locked(async () => this.save('outgoing', id, record));
        } catch (err) {
          record.view.error = (err as Error).message.slice(0, 500);
          await this.locked(async () => this.save('outgoing', id, record));
        }
      }));
    } finally { this.polling = false; }
  }
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.running?.controller.abort();
    await this.running?.promise;
    await this.queue;
  }
}
