/**
 * Concurrency slots plus a bounded FIFO wait queue.
 *
 * `admit()` is synchronous, so check-and-reserve is atomic on Node's single
 * thread: two simultaneous requests can never both take the last queue place.
 */
import { MeshError } from '@werewolf-mesh/protocol';

interface Waiter {
  grant: () => void;
  fail: (e: MeshError) => void;
}

export class Ticket {
  private state: 'queued' | 'running' | 'released' = 'queued';
  private waiter: Waiter | undefined;
  private granted = false;
  readonly enqueuedAt = Date.now();
  startedAt = 0;

  constructor(
    private readonly pool: WorkerPool,
    readonly position: number,
  ) {}

  /** @internal */
  _grant(): void {
    this.granted = true;
    this.state = 'running';
    this.startedAt = Date.now();
    this.waiter?.grant();
  }

  /** Wait for a slot. Rejects with queue_timeout or cancelled and frees the queue place. */
  wait(timeoutMs: number, signal: AbortSignal): Promise<void> {
    if (this.granted) return Promise.resolve();
    if (this.state === 'released') return Promise.reject(new MeshError('cancelled', 'ticket released'));
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.waiter = undefined;
      };
      const timer = setTimeout(() => {
        cleanup();
        this.release();
        reject(new MeshError('queue_timeout', `waited ${timeoutMs} ms in worker queue`));
      }, timeoutMs);
      const onAbort = () => {
        cleanup();
        this.release();
        reject(new MeshError('cancelled', 'cancelled while queued'));
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiter = {
        grant: () => {
          cleanup();
          resolve();
        },
        fail: (e) => {
          cleanup();
          reject(e);
        },
      };
    });
  }

  /** Idempotent. Frees the running slot or queue place. */
  release(): void {
    if (this.state === 'released') return;
    const wasRunning = this.state === 'running';
    this.state = 'released';
    this.pool._release(this, wasRunning);
  }

  get isRunning(): boolean {
    return this.state === 'running';
  }
}

export class WorkerPool {
  private active = 0;
  private readonly queue: Ticket[] = [];
  draining = false;
  /** Rolling average job duration, used for Retry-After hints. */
  private avgJobMs = 5_000;

  constructor(
    readonly maxConcurrency: number,
    readonly maxQueue: number,
  ) {}

  get activeCount(): number {
    return this.active;
  }
  get queuedCount(): number {
    return this.queue.length;
  }

  retryAfterMs(): number {
    return Math.round(Math.min(60_000, Math.max(500, this.avgJobMs * (1 + this.queue.length / this.maxConcurrency))));
  }

  /** Synchronous, atomic admission. */
  admit(): Ticket | MeshError {
    if (this.draining) return new MeshError('draining', 'worker is draining', 1000);
    if (this.active < this.maxConcurrency && this.queue.length === 0) {
      const t = new Ticket(this, 0);
      this.active++;
      t._grant();
      return t;
    }
    if (this.queue.length >= this.maxQueue) {
      return new MeshError('busy', `worker queue full (${this.maxQueue} waiting)`, this.retryAfterMs());
    }
    const t = new Ticket(this, this.queue.length + 1);
    this.queue.push(t);
    return t;
  }

  /** @internal */
  _release(t: Ticket, wasRunning: boolean): void {
    if (wasRunning) {
      this.active--;
      const dur = Date.now() - t.startedAt;
      this.avgJobMs = this.avgJobMs * 0.8 + dur * 0.2;
    } else {
      const i = this.queue.indexOf(t);
      if (i >= 0) this.queue.splice(i, 1);
    }
    while (this.active < this.maxConcurrency && this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.active++;
      next._grant();
    }
  }
}
