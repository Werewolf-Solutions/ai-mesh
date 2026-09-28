import { MeshClient, type ScoreResult } from '@werewolf-mesh/client';
import type { PeerView } from '@werewolf-mesh/protocol';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import benchmarksMd from '../../../../docs/benchmarks.md?raw';
import { usePersistent, uid, type Gateway } from '../store';
import { READING_INSTRUCTION, READING_REFERENCE, READING_TEXT, READING_TEXT_TITLE } from '../tests/readingText';
import { Markdown } from './Markdown';
import { NodeBadge } from './Moon';

type Section = 'reading' | 'benchmarks';

interface RunScores {
  /** The ideal summary this run was scored against. */
  reference: string;
  /** ROUGE-L F1, 0–1: shared wording in order. */
  wordOverlap: number;
  /** Cosine similarity of sentence embeddings, or null when the scorer model is not installed. */
  meaning: number | null;
  /** Similarity of the ideal summary to an unrelated sentence, for scale. */
  unrelated: number | null;
  model: string | null;
  scoredOn: string;
}

interface ReadingRun {
  id: string;
  at: number;
  worker: string | null;
  route: string | null;
  runtime: string | null;
  promptTokens: number | null;
  /** Worker-measured: slot start → first token. */
  readMs: number | null;
  queueMs: number | null;
  /** Browser-measured: request sent → first token (includes network, routing, queue). */
  browserFirstMs: number;
  totalMs: number;
  answerTokens: number | null;
  answer: string;
  status: 'completed' | 'interrupted' | 'failed' | 'cancelled';
  error?: string;
  scores?: RunScores;
}

interface Props {
  gateways: Gateway[];
  peers: PeerView[];
  selfPeerId: string | null;
  labels: Record<string, string>;
}

const WORDS = READING_TEXT.split(/\s+/).length;
const secs = (ms: number | null | undefined) => (ms == null ? '–' : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`);
const speed = (r: ReadingRun) => (r.readMs && r.promptTokens ? Math.round(r.promptTokens / (r.readMs / 1000)) : null);
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : null);
const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * Where the meaning score sits between "unrelated text" (0) and "identical" (1).
 * Raw cosine values of sentence embeddings rarely go near 0, so this rescaling
 * is what the bar shows; the raw number is shown beside it.
 */
function closeness(s: RunScores): number | null {
  if (s.meaning == null || s.unrelated == null) return null;
  return Math.max(0, Math.min(1, (s.meaning - s.unrelated) / (1 - s.unrelated)));
}
function verdict(c: number): string {
  // Calibrated on bge-small-en-v1.5: a faithful paraphrase ≈ 85%, a loosely related sentence ≈ 60%, off-topic ≈ 0%.
  return c >= 0.7 ? 'close to the ideal' : c >= 0.35 ? 'partly matches' : 'far from the ideal';
}

function toScores(res: ScoreResult & { gatewayUrl: string }, i: number, reference: string): RunScores {
  return {
    reference,
    wordOverlap: res.rougeL[i]!.f1,
    meaning: res.semantic.available ? res.semantic.cosine[i]! : null,
    unrelated: res.semantic.available ? res.semantic.unrelatedBaseline : null,
    model: res.semantic.available ? res.semantic.model : null,
    scoredOn: res.gatewayUrl,
  };
}

export function TestsView(props: Props) {
  const [section, setSection] = usePersistent<Section>('wam.testsSection', 'reading');
  return (
    <div className="h-full overflow-y-auto px-4 py-8 sm:px-8">
      <div className="mx-auto max-w-4xl">
        <nav className="mb-6 flex gap-1 border-b border-rule text-sm" aria-label="Test sections">
          {(
            [
              ['reading', 'Reading speed test'],
              ['benchmarks', 'Published benchmarks'],
            ] as const
          ).map(([s, name]) => (
            <button
              key={s}
              onClick={() => setSection(s)}
              aria-current={section === s ? 'page' : undefined}
              className={`-mb-px border-b-2 px-3 py-2 ${section === s ? 'border-moon text-ink' : 'border-transparent text-slate hover:text-ink'}`}
            >
              {name}
            </button>
          ))}
        </nav>
        {section === 'reading' ? <ReadingTest {...props} /> : <BenchmarksDoc />}
      </div>
    </div>
  );
}

function BenchmarksDoc() {
  return (
    <article>
      <p className="mb-4 rounded-lg border border-rule bg-sheet px-4 py-3 text-sm text-slate">
        This is <code>docs/benchmarks.md</code> as it was when this UI was built. The numbers were measured once on the development machine; use the reading test to measure your own nodes.
      </p>
      <Markdown source={benchmarksMd} />
    </article>
  );
}

type Phase = 'idle' | 'sending' | 'reading' | 'answering';

function ReadingTest({ gateways, peers, selfPeerId, labels }: Props) {
  const [showText, setShowText] = useState(false);
  const [target, setTarget] = useState('auto');
  const [count, setCount] = useState(1);
  const [runs, setRuns] = usePersistent<ReadingRun[]>('wam.readingRuns', []);
  const [reference, setReference] = usePersistent<string>('wam.readingReference.v2', READING_REFERENCE);
  const [editingRef, setEditingRef] = useState(false);
  const [refDraft, setRefDraft] = useState(reference);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [rescoring, setRescoring] = useState(false);
  const [scorer, setScorer] = useState<{ state: string; detail: string } | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<{ n: number; of: number }>({ n: 0, of: 0 });
  const [elapsed, setElapsed] = useState(0);
  const [live, setLive] = useState('');
  const ctlRef = useRef<AbortController | null>(null);
  const startRef = useRef(0);
  const client = useMemo(() => new MeshClient(gateways.map((g) => ({ url: g.url, token: g.token || g.adminToken || undefined }))), [gateways]);

  useEffect(() => {
    const g = gateways[0];
    if (!g) return;
    const headers: Record<string, string> = g.token || g.adminToken ? { authorization: `Bearer ${g.token || g.adminToken}` } : {};
    fetch(`${g.url.replace(/\/$/, '')}/v1/mesh/scorer`, { headers })
      .then((r) => (r.ok ? r.json() : null))
      .then(setScorer, () => setScorer(null));
  }, [gateways]);

  useEffect(() => {
    if (phase === 'idle') return;
    const t = setInterval(() => setElapsed(performance.now() - startRef.current), 50);
    return () => clearInterval(t);
  }, [phase]);

  // We cannot see inside the node: "reading" is shown from shortly after sending until the first word arrives.
  useEffect(() => {
    if (phase !== 'sending') return;
    const t = setTimeout(() => setPhase((p) => (p === 'sending' ? 'reading' : p)), 120);
    return () => clearTimeout(t);
  }, [phase]);

  const name = (id: string | null) => (id ? (labels[id] ?? `…${id.slice(-6)}`) : '–');
  const targets = [
    { value: 'auto', label: 'Any node (the mesh chooses)' },
    ...(selfPeerId ? [{ value: 'local', label: 'This gateway' }] : []),
    ...peers.filter((p) => p.available).map((p) => ({ value: p.peerId, label: p.label ?? `…${p.peerId.slice(-6)}` })),
  ];
  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  async function runOnce(signal: AbortSignal): Promise<ReadingRun> {
    setPhase('sending');
    setLive('');
    startRef.current = performance.now();
    setElapsed(0);
    let firstAt = 0;
    // A random tag at the start stops the node reusing its cached copy of the text from a previous run.
    const content = `[run ${uid()}] ${READING_INSTRUCTION}\n\n${READING_TEXT}`;
    let worker: string | null = null;
    const r = await client.chat({
      messages: [{ role: 'user', content }],
      maxTokens: 48,
      temperature: 0,
      target,
      signal,
      onMeta: (m) => {
        worker = m.workerPeerId;
      },
      onToken: (_t, full) => {
        if (!firstAt) {
          firstAt = performance.now();
          setPhase('answering');
        }
        setLive(full);
      },
    });
    const end = performance.now();
    const base = { id: uid(), at: Date.now(), browserFirstMs: Math.round((firstAt || end) - startRef.current), totalMs: Math.round(end - startRef.current) };
    if (r.status === 'failed') {
      return { ...base, worker: null, route: null, runtime: null, promptTokens: null, readMs: null, queueMs: null, answerTokens: null, answer: '', status: 'failed', error: r.error.message };
    }
    const meta = r.meta;
    const run: ReadingRun = {
      ...base,
      worker: meta?.workerPeerId ?? worker,
      route: meta?.route ?? null,
      runtime: meta?.runtime ?? null,
      promptTokens: r.status === 'completed' ? (r.usage?.prompt_tokens ?? null) : null,
      readMs: meta?.timings?.firstTokenMs ?? null,
      queueMs: meta?.timings?.queueMs ?? null,
      answerTokens: r.status === 'completed' ? (r.usage?.completion_tokens ?? null) : null,
      answer: r.text,
      status: r.status,
      ...(r.status === 'interrupted' ? { error: r.error.message } : {}),
    };
    if (run.answer.trim()) {
      const s = await client.score(reference, [run.answer]).catch(() => null);
      if (s) run.scores = toScores(s, 0, reference);
    }
    return run;
  }

  async function start() {
    const ctl = new AbortController();
    ctlRef.current = ctl;
    try {
      for (let n = 1; n <= count && !ctl.signal.aborted; n++) {
        setProgress({ n, of: count });
        const run = await runOnce(ctl.signal);
        setRuns((all) => [run, ...all].slice(0, 30));
        if (run.status !== 'completed') break;
      }
    } finally {
      ctlRef.current = null;
      setPhase('idle');
    }
  }

  /** Score every stored summary against the current ideal summary. */
  async function rescoreAll(ref: string) {
    setRescoring(true);
    try {
      const withText = runs.filter((r) => r.answer.trim());
      const updated = new Map<string, RunScores>();
      for (let i = 0; i < withText.length; i += 20) {
        const batch = withText.slice(i, i + 20);
        const s = await client.score(ref, batch.map((r) => r.answer));
        if (!s) break;
        batch.forEach((r, j) => updated.set(r.id, toScores(s, j, ref)));
      }
      setRuns((all) => all.map((r) => (updated.has(r.id) ? { ...r, scores: updated.get(r.id)! } : r)));
    } finally {
      setRescoring(false);
    }
  }

  const latest = runs[0];
  const done = runs.filter((r) => r.status === 'completed' && r.readMs != null);
  const med = median(done.map((r) => r.readMs!));
  const medSpeed = median(done.map((r) => speed(r)!).filter(Boolean));
  const running = phase !== 'idle';
  const stale = runs.some((r) => r.scores && r.scores.reference !== reference) || runs.some((r) => r.answer.trim() && !r.scores);

  return (
    <section aria-labelledby="reading-title">
      <h1 id="reading-title" className="font-display text-3xl tracking-tight">
        How long does a node take to read a long text?
      </h1>
      <p className="mt-2 max-w-[70ch] text-slate">
        The test sends a {WORDS.toLocaleString()}-word text to a node and asks for a one-sentence summary. The node has to read every word before it can write the
        first one, so the time until the summary starts is the reading time. The node measures that itself, so network delay is not included. Each summary is
        then compared with an ideal summary.
      </p>

      <div className="mt-6 rounded-xl border border-rule bg-sheet">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div>
            <p className="font-display text-lg">{READING_TEXT_TITLE}</p>
            <p className="num text-sm text-slate">{WORDS.toLocaleString()} words · about 1,400 tokens for this model</p>
          </div>
          <button className="rounded-md border border-rule px-3 py-1.5 text-sm" aria-expanded={showText} aria-controls="reading-text" onClick={() => setShowText((s) => !s)}>
            {showText ? 'Hide the text' : 'Show the text'}
          </button>
        </div>
        {showText && (
          <div id="reading-text" className="max-h-[26rem] overflow-y-auto border-t border-rule px-4 py-4">
            <p className="mb-3 text-sm text-slate">Instruction sent with it: “{READING_INSTRUCTION}”</p>
            {READING_TEXT.split('\n\n').map((p, i) => (
              <p key={i} className="mb-3 max-w-[70ch] font-display leading-[1.65]">
                {p}
              </p>
            ))}
          </div>
        )}
        <div className="border-t border-rule px-4 py-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm font-medium">Ideal summary</p>
            {!editingRef && (
              <button
                className="text-sm text-slate underline"
                onClick={() => {
                  setRefDraft(reference);
                  setEditingRef(true);
                }}
              >
                Edit
              </button>
            )}
          </div>
          {editingRef ? (
            <form
              className="mt-2 grid gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const v = refDraft.trim();
                if (v) setReference(v);
                setEditingRef(false);
              }}
            >
              <label htmlFor="ideal" className="sr-only">
                Ideal summary
              </label>
              <textarea id="ideal" rows={3} value={refDraft} onChange={(e) => setRefDraft(e.target.value)} className="rounded-lg border border-rule bg-paper px-3 py-2 font-display focus:border-moon focus:outline-none" />
              <div className="flex gap-2 text-sm">
                <button type="submit" className="rounded-md bg-ink px-3 py-1 text-paper">
                  Save ideal summary
                </button>
                <button type="button" className="rounded-md border border-rule px-3 py-1" onClick={() => setRefDraft(READING_REFERENCE)}>
                  Restore the original
                </button>
                <button type="button" className="px-2 text-slate" onClick={() => setEditingRef(false)}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <p className="mt-1 max-w-[70ch] font-display leading-[1.6]">{reference}</p>
          )}
          <p className="mt-2 text-xs text-slate">
            {scorer?.state === 'ready'
              ? `Summaries are scored on the gateway by ${scorer.detail}: meaning match (sentence embeddings) and word overlap (ROUGE-L).`
              : `Meaning match is off (${scorer?.detail || 'scorer not reachable'}); word overlap (ROUGE-L) still works.`}
          </p>
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-end gap-4">
        <label className="grid gap-1 text-sm">
          <span>Node that reads it</span>
          <select value={target} disabled={running} onChange={(e) => setTarget(e.target.value)} className="rounded-lg border border-rule bg-paper px-3 py-2">
            {targets.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          <span>Runs</span>
          <select value={count} disabled={running} onChange={(e) => setCount(Number(e.target.value))} className="rounded-lg border border-rule bg-paper px-3 py-2">
            {[1, 3, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        {running ? (
          <button onClick={() => ctlRef.current?.abort()} className="h-10 rounded-lg border border-ink px-5 font-medium">
            Stop test
          </button>
        ) : (
          <button onClick={() => void start()} className="h-10 rounded-lg bg-ink px-5 font-medium text-paper">
            Start test
          </button>
        )}
        {peers.length === 0 && target === 'auto' && <p className="text-xs text-slate">Add the gateway’s admin token to choose a specific node.</p>}
      </div>

      <div className="mt-8 grid gap-6 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]" aria-live="polite">
        <div>
          <p className="text-sm text-slate">
            {running
              ? `${progress.of > 1 ? `Run ${progress.n} of ${progress.of}: ` : ''}${phase === 'sending' ? 'Sending the text' : phase === 'reading' ? 'Reading' : 'Writing the summary'}`
              : latest
                ? 'Last reading time'
                : 'No runs yet. Press Start test.'}
          </p>
          {(running || latest?.status === 'completed') && (
            <p className="num font-display text-5xl tracking-tight">{running ? secs(elapsed) : secs(latest!.readMs)}</p>
          )}
          {!running && latest?.status === 'completed' && speed(latest) && (
            <p className="num mt-1 text-sm text-slate">{speed(latest)!.toLocaleString()} tokens per second</p>
          )}
          {done.length > 1 && !running && (
            <p className="num mt-3 text-sm text-slate">
              Median of {done.length} runs: {secs(med)}, {medSpeed?.toLocaleString()} tokens/s
            </p>
          )}
        </div>
        <div className="min-w-0">
          {running && live && <p className="caret font-display leading-[1.6]">{live}</p>}
          {!running && latest && <RunDetail run={latest} name={name} />}
        </div>
      </div>

      {runs.length > 0 && (
        <div className="mt-10">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-display text-xl">Earlier runs</h2>
            <div className="flex gap-4 text-sm">
              {stale && (
                <button className="text-ink underline decoration-moon underline-offset-2 disabled:opacity-40" disabled={running || rescoring} onClick={() => void rescoreAll(reference)}>
                  {rescoring ? 'Scoring…' : 'Score all against the current ideal summary'}
                </button>
              )}
              <button className="text-slate underline" onClick={() => setRuns([])} disabled={running}>
                Clear results
              </button>
            </div>
          </div>
          <div className="mt-3 overflow-x-auto">
            <table className="num w-full min-w-[760px] text-left text-sm">
              <thead className="text-slate">
                <tr className="border-b border-rule">
                  <th className="py-2 pr-4 font-normal">When</th>
                  <th className="py-2 pr-4 font-normal">Node</th>
                  <th className="py-2 pr-4 font-normal">Reading time</th>
                  <th className="py-2 pr-4 font-normal">Tokens/s</th>
                  <th className="py-2 pr-4 font-normal">Meaning match</th>
                  <th className="py-2 pr-4 font-normal">Word overlap</th>
                  <th className="py-2 pr-4 font-normal">Result</th>
                  <th className="py-2 font-normal">
                    <span className="sr-only">Summary</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => {
                  const isOpen = open.has(r.id);
                  const c = r.scores ? closeness(r.scores) : null;
                  return (
                    <Fragment key={r.id}>
                      <tr className={isOpen ? '' : 'border-b border-rule/60'}>
                        <td className="py-1.5 pr-4 text-slate">{new Date(r.at).toLocaleTimeString()}</td>
                        <td className="py-1.5 pr-4">{name(r.worker)}</td>
                        <td className="py-1.5 pr-4">{secs(r.readMs)}</td>
                        <td className="py-1.5 pr-4">{speed(r)?.toLocaleString() ?? '–'}</td>
                        <td className="py-1.5 pr-4">{c == null ? '–' : pct(c)}</td>
                        <td className="py-1.5 pr-4">{r.scores ? pct(r.scores.wordOverlap) : '–'}</td>
                        <td className={`py-1.5 pr-4 ${r.status === 'completed' ? '' : 'text-blood'}`}>{r.status === 'completed' ? 'done' : r.status}</td>
                        <td className="py-1.5 text-right">
                          {r.answer.trim() && (
                            <button className="rounded-md border border-rule px-2 py-0.5 text-xs" aria-expanded={isOpen} onClick={() => toggle(r.id)}>
                              {isOpen ? 'Hide summary' : 'Show summary'}
                            </button>
                          )}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="border-b border-rule/60">
                          <td colSpan={8} className="pb-4 pt-1">
                            <Comparison run={r} current={reference} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-2 max-w-[75ch] text-xs text-slate">
            Results are kept in this browser only. Each run adds a random tag to the text so the node cannot reuse its memory of an earlier run. Meaning match puts
            the summary on a scale from an unrelated sentence (0%) to the ideal summary itself (100%); word overlap counts shared words in order. Both are rough
            guides, not grades.
          </p>
        </div>
      )}
    </section>
  );
}

function ScoreLine({ s }: { s: RunScores }) {
  const c = closeness(s);
  return (
    <div className="grid gap-2 text-sm sm:grid-cols-2">
      <div>
        <p className="text-slate">Meaning match</p>
        {c == null ? (
          <p>Not available (the gateway has no scoring model installed)</p>
        ) : (
          <>
            <div className="mt-1 h-1.5 w-full max-w-[16rem] rounded-full bg-rule" aria-hidden>
              <div className="h-1.5 rounded-full bg-moon" style={{ width: `${Math.round(c * 100)}%` }} />
            </div>
            <p className="num mt-1">
              {pct(c)}, {verdict(c)}
              <span className="text-slate">
                {' '}
                (similarity {s.meaning!.toFixed(2)}; an unrelated sentence scores {s.unrelated!.toFixed(2)})
              </span>
            </p>
          </>
        )}
      </div>
      <div>
        <p className="text-slate">Word overlap (ROUGE-L)</p>
        <div className="mt-1 h-1.5 w-full max-w-[16rem] rounded-full bg-rule" aria-hidden>
          <div className="h-1.5 rounded-full bg-slate" style={{ width: `${Math.round(s.wordOverlap * 100)}%` }} />
        </div>
        <p className="num mt-1">{pct(s.wordOverlap)} of the wording matches</p>
      </div>
    </div>
  );
}

function Comparison({ run, current }: { run: ReadingRun; current: string }) {
  return (
    <div className="grid gap-4 rounded-lg bg-sheet p-4 md:grid-cols-2">
      <div>
        <p className="text-xs text-slate">Summary written by the node</p>
        <p className="mt-1 font-display leading-[1.6]">{run.answer}</p>
        {run.status !== 'completed' && <p className="mt-1 text-xs text-blood">Incomplete: the run was {run.status}.</p>}
      </div>
      <div>
        <p className="text-xs text-slate">Ideal summary{run.scores && run.scores.reference !== current ? ' (the one this run was scored against)' : ''}</p>
        <p className="mt-1 font-display leading-[1.6]">{run.scores?.reference ?? current}</p>
      </div>
      <div className="md:col-span-2">{run.scores ? <ScoreLine s={run.scores} /> : <p className="text-sm text-slate">Not scored yet.</p>}</div>
    </div>
  );
}

function RunDetail({ run, name }: { run: ReadingRun; name: (id: string | null) => string }) {
  const [showSummary, setShowSummary] = useState(true);
  if (run.status === 'failed') return <p className="text-blood">The test could not run: {run.error}</p>;
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {run.worker && <NodeBadge peerId={run.worker} label={name(run.worker)} route={run.route} />}
        {run.runtime === 'fake' && <span className="rounded bg-blood px-1.5 text-xs text-paper">test runtime, not a model</span>}
      </div>
      <dl className="num mt-3 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
        <dt className="text-slate">Tokens read</dt>
        <dd>{run.promptTokens?.toLocaleString() ?? '–'}</dd>
        <dt className="text-slate">Reading time (measured by the node)</dt>
        <dd>{secs(run.readMs)}</dd>
        <dt className="text-slate">Waiting for a free slot</dt>
        <dd>{secs(run.queueMs)}</dd>
        <dt className="text-slate">First word seen by this browser</dt>
        <dd>{secs(run.browserFirstMs)}</dd>
        <dt className="text-slate">Whole test, including the summary</dt>
        <dd>
          {secs(run.totalMs)}
          {run.answerTokens != null ? ` (${run.answerTokens} tokens written)` : ''}
        </dd>
      </dl>
      {run.scores && (
        <div className="mt-4">
          <ScoreLine s={run.scores} />
        </div>
      )}
      {run.answer && (
        <div className="mt-4">
          <button className="text-sm text-slate underline" aria-expanded={showSummary} onClick={() => setShowSummary((s) => !s)}>
            {showSummary ? 'Hide the summary' : 'Show the summary'}
          </button>
          {showSummary && (
            <blockquote className="mt-2 border-l-2 border-moon pl-3 font-display leading-[1.6]">
              {run.answer}
              <footer className="mt-1 font-sans text-xs text-slate">The node’s summary. SmolLM2-135M is tiny, so it may miss the point.</footer>
            </blockquote>
          )}
        </div>
      )}
      {run.status !== 'completed' && <p className="mt-3 text-sm text-blood">{run.status === 'cancelled' ? 'Stopped before it finished.' : `Interrupted: ${run.error}`}</p>}
    </div>
  );
}
