/**
 * Bounded, expiring set of recently admitted request keys. Used by a worker
 * to refuse a second execution of the same request from the same origin.
 * This reduces, but cannot eliminate, duplicate work across DIFFERENT workers
 * (a gateway may time out on worker A and retry on worker B while A is still
 * running). The mesh does not provide exactly-once execution.
 */
export class DedupCache {
  private readonly map = new Map<string, number>();
  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns false if `key` was seen within the TTL; otherwise records it and returns true. */
  claim(key: string): boolean {
    const t = this.now();
    const seen = this.map.get(key);
    if (seen !== undefined && t - seen < this.ttlMs) return false;
    this.map.delete(key);
    this.map.set(key, t);
    this.evict(t);
    return true;
  }

  private evict(t: number): void {
    for (const [k, ts] of this.map) {
      if (this.map.size > this.maxEntries || t - ts >= this.ttlMs) this.map.delete(k);
      else break; // insertion order == time order
    }
  }

  get size(): number {
    return this.map.size;
  }
}
