import { scrub, type NoteKind } from '@werewolf-mesh/protocol';
import { useMemo, useState } from 'react';
import { PackApi, titleFrom } from '../pack';
import type { Gateway } from '../store';

const KINDS: Array<[NoteKind, string]> = [
  ['solution', 'A solved problem'],
  ['howto', 'A how-to'],
  ['idea', 'An idea'],
];

/**
 * Turns one question + answer into an anonymous pack note. The person edits
 * it down to the "how" before sharing; personal data is removed on the way.
 */
export function ShareCard({ gateways, question, answer, onDone, onCancel }: {
  gateways: Gateway[];
  question: string;
  answer: string;
  onDone: (r: { id: string; title: string; removed: string[] }) => void;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<NoteKind>('solution');
  const [title, setTitle] = useState(titleFrom(question));
  const [problem, setProblem] = useState(question.slice(0, 1000));
  const [solution, setSolution] = useState(answer.slice(0, 2000));
  const [tags, setTags] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const removed = useMemo(() => [...new Set([title, problem, solution].flatMap((t) => scrub(t).removed))], [title, problem, solution]);

  async function share() {
    setBusy(true);
    setError(null);
    try {
      const r = await new PackApi(gateways).share({
        kind,
        title,
        problem,
        solution,
        tags: tags.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 5),
      });
      onDone({ id: r.id, title: r.note.title, removed: r.removed });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const field = 'rounded-lg border border-rule bg-paper px-3 py-2 focus:border-moon focus:outline-none';
  return (
    <form
      className="mt-3 grid gap-3 rounded-xl border border-moon/60 bg-sheet p-4 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        void share();
      }}
    >
      <div>
        <p className="font-display text-lg">Share how you solved it with the pack</p>
        <p className="text-slate">
          Keep only what helps someone else: the problem and the way to solve it. The note carries no name, no node and no exact time, and it spreads to every node in the
          pack. Only this browser can withdraw it later.
        </p>
      </div>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Kind of note">
        {KINDS.map(([k, label]) => (
          <button type="button" key={k} role="radio" aria-checked={kind === k} onClick={() => setKind(k)} className={`rounded-full border px-3 py-1 ${kind === k ? 'border-ink bg-ink text-paper' : 'border-rule text-slate'}`}>
            {label}
          </button>
        ))}
      </div>
      <label className="grid gap-1">
        <span>Title</span>
        <input className={field} value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} required minLength={3} />
      </label>
      <label className="grid gap-1">
        <span>{kind === 'idea' ? 'What it is about' : 'The problem'}</span>
        <textarea className={field} rows={3} value={problem} maxLength={1000} onChange={(e) => setProblem(e.target.value)} />
      </label>
      <label className="grid gap-1">
        <span>{kind === 'idea' ? 'The idea' : 'How to solve it'}</span>
        <textarea className={field} rows={6} value={solution} maxLength={2000} onChange={(e) => setSolution(e.target.value)} required minLength={3} />
      </label>
      <label className="grid gap-1">
        <span>Tags (optional, comma separated)</span>
        <input className={field} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="linux, docker" />
      </label>
      {removed.length > 0 && <p className="text-slate">Will be removed before sharing: {removed.join(', ')}.</p>}
      {error && <p className="text-blood">Not shared: {error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="rounded-lg bg-ink px-4 py-2 font-medium text-paper disabled:opacity-40">
          {busy ? 'Sharing…' : 'Share anonymously'}
        </button>
        <button type="button" onClick={onCancel} className="rounded-lg px-3 py-2 text-slate">
          Not now
        </button>
      </div>
    </form>
  );
}
