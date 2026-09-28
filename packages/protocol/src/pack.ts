/**
 * Pack memory: anonymous, shared "how I solved it" notes.
 *
 * A note never carries an author, a node ID or an exact time. It is identified
 * by the SHA-256 of its canonical content, so every node agrees on its ID
 * without a coordinator. The author's browser keeps a random withdrawal token;
 * the note stores only its SHA-256 (`withdrawHash`). Revealing the token later
 * proves the right to withdraw without revealing who the author is.
 */
import { z } from 'zod';

export const PACK_LIMITS = {
  titleChars: 120,
  problemChars: 1000,
  solutionChars: 2000,
  tags: 5,
  tagChars: 24,
  maxNotes: 5000,
  maxTombstones: 5000,
  /** New items accepted from one peer per hour (in memory only; never stored). */
  perPeerPerHour: 200,
  /** Items per sync request. */
  batch: 50,
} as const;

export const MEMORY_PROTOCOL = '/werewolf-mesh/memory/1.0.0';

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

export const NoteKind = z.enum(['solution', 'idea', 'howto']);
export type NoteKind = z.infer<typeof NoteKind>;

/** The fields that make up a note's identity (hashed in canonical order). */
export const NoteBody = z.strictObject({
  v: z.literal(1),
  kind: NoteKind,
  title: z.string().min(3).max(PACK_LIMITS.titleChars),
  problem: z.string().max(PACK_LIMITS.problemChars),
  solution: z.string().min(3).max(PACK_LIMITS.solutionChars),
  tags: z.array(z.string().min(1).max(PACK_LIMITS.tagChars).regex(/^[\p{L}\p{N} _-]+$/u)).max(PACK_LIMITS.tags),
  /** UTC day, YYYY-MM-DD. Deliberately coarse. */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** SHA-256 (hex) of the author's secret withdrawal token. */
  withdrawHash: hex64,
});
export type NoteBody = z.infer<typeof NoteBody>;

export const Note = NoteBody.extend({ id: hex64 });
export type Note = z.infer<typeof Note>;

/** Withdrawal: reveals the token whose SHA-256 is the note's withdrawHash. */
export const Tombstone = z.strictObject({
  v: z.literal(1),
  noteId: hex64,
  token: z.string().regex(/^[A-Za-z0-9_-]{32,64}$/),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type Tombstone = z.infer<typeof Tombstone>;

/** Canonical JSON used for hashing: fixed key order, no whitespace. */
export function canonicalNote(b: NoteBody): string {
  return JSON.stringify({
    v: b.v,
    kind: b.kind,
    title: b.title,
    problem: b.problem,
    solution: b.solution,
    tags: b.tags,
    day: b.day,
    withdrawHash: b.withdrawHash,
  });
}

// ---------------------------------------------------------------------------
// Sync protocol frames (pull-based set reconciliation over 16 hex buckets)
// ---------------------------------------------------------------------------

export const MemoryFrame = z.discriminatedUnion('type', [
  /** Digest of every bucket (SHA-256 of the sorted item IDs in it). */
  z.strictObject({ v: z.literal(1), type: z.literal('digests'), notes: z.array(hex64).length(16), tombs: z.array(hex64).length(16) }),
  /** Ask for the IDs in some buckets. */
  z.strictObject({ v: z.literal(1), type: z.literal('list'), noteBuckets: z.array(z.number().int().min(0).max(15)).max(16), tombBuckets: z.array(z.number().int().min(0).max(15)).max(16) }),
  z.strictObject({ v: z.literal(1), type: z.literal('ids'), notes: z.array(hex64).max(PACK_LIMITS.maxNotes), tombs: z.array(hex64).max(PACK_LIMITS.maxTombstones) }),
  z.strictObject({ v: z.literal(1), type: z.literal('get'), notes: z.array(hex64).max(PACK_LIMITS.batch), tombs: z.array(hex64).max(PACK_LIMITS.batch) }),
  z.strictObject({ v: z.literal(1), type: z.literal('items'), notes: z.array(Note).max(PACK_LIMITS.batch), tombs: z.array(Tombstone).max(PACK_LIMITS.batch) }),
  z.strictObject({ v: z.literal(1), type: z.literal('done') }),
]);
export type MemoryFrame = z.infer<typeof MemoryFrame>;

// ---------------------------------------------------------------------------
// Privacy scrubbing (runs in the browser preview AND on the server)
// ---------------------------------------------------------------------------

const REDACTIONS: Array<{ name: string; re: RegExp; with: string }> = [
  { name: 'email address', re: /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu, with: '[email]' },
  { name: 'link parameters', re: /(https?:\/\/[^\s?#]+)[?#][^\s)]*/g, with: '$1' },
  { name: 'IP address', re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, with: '[ip]' },
  { name: 'phone number', re: /(?<![\p{L}\p{N}])\+?\d[\d ().-]{7,}\d(?![\p{L}\p{N}])/gu, with: '[number]' },
  { name: 'long number', re: /\b\d{6,}\b/g, with: '[number]' },
  { name: 'secret-looking token', re: /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}\b/g, with: '[secret]' },
];

/** Remove common personal data. Returns the cleaned text and what was removed. */
export function scrub(text: string): { text: string; removed: string[] } {
  let out = text;
  const removed = new Set<string>();
  for (const r of REDACTIONS) {
    const next = out.replace(r.re, r.with);
    if (next !== out) removed.add(r.name);
    out = next;
  }
  return { text: out.replace(/[ \t]+\n/g, '\n').trim(), removed: [...removed] };
}

/** True when a chat message asks to share the previous answer with the pack. */
export function isShareIntent(message: string): boolean {
  let m = message.trim().toLowerCase().replace(/\s+/g, ' ');
  // Questions are not commands ("how do wolves share food in a pack?"),
  // except polite requests ("can you share this with the pack?").
  if (m.endsWith('?')) {
    if (!/^(?:can|could|would|will) you /.test(m)) return false;
    m = m.slice(0, -1);
  }
  if (m.length > 160) return false;
  const verb = '(?:please )?(?:can you |could you )?(?:share|save|add|send|post|give)';
  const what = '(?:this|it|that|the (?:last )?(?:answer|solution|reply|idea|fix|how-?to))';
  const where = '(?:with|to|in|into) (?:the |my |our )?(?:pack|hive|swarm)';
  return (
    new RegExp(`^${verb} ${what}(?: [^.!]{0,30})? ${where}\\b`).test(m) ||
    new RegExp(`^${verb} ${where}\\b`).test(m) ||
    /^(?:please )?share (?:it|this)[.!]*$/.test(m)
  );
}
