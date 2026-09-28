/**
 * Local replica of the pack memory.
 *
 * Every node holds its own full copy. Items are identified by content hash,
 * so replicas merge by set union (plus withdrawals) with no coordinator.
 *
 * Anonymity rules enforced here:
 *  - Stored notes never record who sent them or which node they came from.
 *  - Notes created on this node are held back for a random delay before peers
 *    can pull them, so publication time does not point at the author's node.
 *  - Per-peer rate limiting uses in-memory counters only.
 *
 * Local-only state (never shared): hidden notes, usage weights, groups.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { canonicalNote, Note, NoteBody, PACK_LIMITS, Tombstone, type Note as NoteT, type NoteBody as NoteBodyT, type Tombstone as TombT } from '@werewolf-mesh/protocol';
import { z } from 'zod';
import { atomicWriteJson, readJsonIfExists } from '../util/fs.js';
import type { Logger } from '../util/log.js';

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const noteId = (b: NoteBodyT) => sha256(canonicalNote(b));
export const tombId = (noteIdHex: string) => sha256(`tomb:${noteIdHex}`);
export const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

const FileSchema = z.object({
  version: z.literal(1),
  notes: z.array(Note),
  tombs: z.array(Tombstone),
  local: z.object({
    hidden: z.array(z.string()),
    weights: z.record(z.string(), z.object({ w: z.number(), at: z.number(), uses: z.number() })),
    pending: z.record(z.string(), z.number()),
  }),
});

export type AddResult = { ok: true; id: string; isNew: boolean } | { ok: false; reason: string };

/** Weight half-life: helpfulness fades unless it is renewed. */
const HALF_LIFE_MS = 30 * 24 * 3600_000;

export class PackStore {
  readonly notes = new Map<string, NoteT>();
  /** tombId → tombstone */
  readonly tombs = new Map<string, TombT>();
  /** noteIds withdrawn (verified or awaiting their note) */
  private readonly withdrawn = new Map<string, TombT>();
  readonly hidden = new Set<string>();
  private readonly weights = new Map<string, { w: number; at: number; uses: number }>();
  /** noteId → time from which peers may pull it */
  private readonly pending = new Map<string, number>();
  private dirty = false;
  private saveTimer: NodeJS.Timeout | undefined;
  private readonly path: string;
  listeners: Array<(n: NoteT) => void> = [];

  constructor(
    dataDir: string,
    private readonly opts: { publishDelayMinMs: number; publishDelayMaxMs: number; log: Logger; now?: () => number },
  ) {
    this.path = join(dataDir, 'pack-memory.json');
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  async load(): Promise<void> {
    try {
      const raw = await readJsonIfExists(this.path);
      if (!raw) return;
      const f = FileSchema.parse(raw);
      for (const t of f.tombs) this.acceptTomb(t, false);
      for (const n of f.notes) this.acceptNote(n, 'peer', false);
      for (const h of f.local.hidden) this.hidden.add(h);
      for (const [k, v] of Object.entries(f.local.weights)) this.weights.set(k, v);
      for (const [k, v] of Object.entries(f.local.pending)) if (this.notes.has(k)) this.pending.set(k, v);
    } catch (err) {
      this.opts.log.warn({ err: (err as Error).message }, 'ignoring unreadable pack memory file');
    }
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.save();
    }, 1000);
    this.saveTimer.unref();
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    await atomicWriteJson(this.path, {
      version: 1,
      notes: [...this.notes.values()],
      tombs: [...this.tombs.values()],
      local: { hidden: [...this.hidden], weights: Object.fromEntries(this.weights), pending: Object.fromEntries(this.pending) },
    }).catch((err) => this.opts.log.warn({ err: (err as Error).message }, 'could not save pack memory'));
  }

  /** Build and add a note created through this node's HTTP API. */
  createLocal(body: Omit<NoteBodyT, 'v' | 'day'>): AddResult & { note?: NoteT } {
    const b: NoteBodyT = { v: 1, day: utcDay(this.now()), ...body };
    const parsed = NoteBody.safeParse(b);
    if (!parsed.success) return { ok: false, reason: parsed.error.issues[0]?.message ?? 'invalid note' };
    const note: NoteT = { ...parsed.data, id: noteId(parsed.data) };
    const r = this.acceptNote(note, 'local', true);
    return r.ok ? { ...r, note } : r;
  }

  /** Add a note (local or from a peer). The ID must equal the content hash. */
  acceptNote(n: NoteT, source: 'local' | 'peer', persist = true): AddResult {
    const { id, ...body } = n;
    if (noteId(body as NoteBodyT) !== id) return { ok: false, reason: 'note id does not match its content' };
    if (this.withdrawn.has(id)) {
      const t = this.withdrawn.get(id)!;
      if (sha256(t.token) === n.withdrawHash) return { ok: false, reason: 'note was withdrawn' };
      this.withdrawn.delete(id); // tombstone did not match this note: ignore it
    }
    if (this.notes.has(id)) return { ok: true, id, isNew: false };
    if (this.notes.size >= PACK_LIMITS.maxNotes) return { ok: false, reason: 'pack memory is full on this node' };
    this.notes.set(id, n);
    if (source === 'local') {
      const { publishDelayMinMs: lo, publishDelayMaxMs: hi } = this.opts;
      this.pending.set(id, this.now() + lo + Math.random() * Math.max(0, hi - lo));
    }
    if (persist) this.scheduleSave();
    for (const l of this.listeners) l(n);
    return { ok: true, id, isNew: true };
  }

  /** Withdraw: valid only if SHA-256(token) equals the note's withdrawHash. */
  acceptTomb(t: TombT, persist = true): AddResult {
    const parsed = Tombstone.safeParse(t);
    if (!parsed.success) return { ok: false, reason: 'invalid withdrawal' };
    const note = this.notes.get(t.noteId);
    if (note && sha256(t.token) !== note.withdrawHash) return { ok: false, reason: 'withdrawal token does not match' };
    const id = tombId(t.noteId);
    if (this.tombs.has(id)) return { ok: true, id, isNew: false };
    if (this.tombs.size >= PACK_LIMITS.maxTombstones) return { ok: false, reason: 'too many withdrawals stored' };
    this.tombs.set(id, t);
    this.withdrawn.set(t.noteId, t);
    if (note) {
      this.notes.delete(t.noteId);
      this.pending.delete(t.noteId);
    }
    if (persist) this.scheduleSave();
    return { ok: true, id, isNew: true };
  }

  isAvailableToPeers(id: string): boolean {
    const at = this.pending.get(id);
    if (at === undefined) return true;
    if (this.now() >= at) {
      this.pending.delete(id);
      this.scheduleSave();
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------ reconciliation helpers
  private bucketOf(id: string): number {
    return parseInt(id[0]!, 16);
  }

  private shareableNoteIds(): string[] {
    return [...this.notes.keys()].filter((id) => this.isAvailableToPeers(id));
  }

  digests(): { notes: string[]; tombs: string[] } {
    const dig = (ids: string[]) => {
      const b: string[][] = Array.from({ length: 16 }, () => []);
      for (const id of ids) b[this.bucketOf(id)]!.push(id);
      return b.map((x) => sha256(x.sort().join(',')));
    };
    return { notes: dig(this.shareableNoteIds()), tombs: dig([...this.tombs.keys()]) };
  }

  idsIn(noteBuckets: number[], tombBuckets: number[]): { notes: string[]; tombs: string[] } {
    const nb = new Set(noteBuckets);
    const tb = new Set(tombBuckets);
    return {
      notes: this.shareableNoteIds().filter((id) => nb.has(this.bucketOf(id))),
      tombs: [...this.tombs.keys()].filter((id) => tb.has(this.bucketOf(id))),
    };
  }

  getItems(noteIds: string[], tombIds: string[]): { notes: NoteT[]; tombs: TombT[] } {
    return {
      notes: noteIds.filter((id) => this.isAvailableToPeers(id)).map((id) => this.notes.get(id)).filter((n): n is NoteT => !!n),
      tombs: tombIds.map((id) => this.tombs.get(id)).filter((t): t is TombT => !!t),
    };
  }

  /** Do we still need this note ID? (not held, not withdrawn) */
  wantsNote(id: string): boolean {
    return !this.notes.has(id) && !this.withdrawn.has(id);
  }

  // ------------------------------------------------------------ local reinforcement
  weight(id: string): { w: number; uses: number } {
    const x = this.weights.get(id);
    if (!x) return { w: 0, uses: 0 };
    const decayed = x.w * Math.pow(0.5, (this.now() - x.at) / HALF_LIFE_MS);
    return { w: decayed, uses: x.uses };
  }

  reinforce(id: string, by: number, countUse: boolean): void {
    if (!this.notes.has(id)) return;
    const cur = this.weight(id);
    this.weights.set(id, { w: cur.w + by, at: this.now(), uses: cur.uses + (countUse ? 1 : 0) });
    this.scheduleSave();
  }

  setHidden(id: string, hidden: boolean): void {
    if (hidden) this.hidden.add(id);
    else this.hidden.delete(id);
    this.scheduleSave();
  }

  visible(): NoteT[] {
    return [...this.notes.values()].filter((n) => !this.hidden.has(n.id));
  }

  get pendingCount(): number {
    return [...this.pending.values()].filter((t) => t > this.now()).length;
  }
}
