/**
 * The code pipeline (docs/agents-design.md, "Fixed pipelines before free
 * agency"): write → run the tests in the sandbox → fix, up to N rounds.
 *
 * Like web research it runs on the node the person asked, and the node decides
 * every action: the model only writes text (a solution, tests, an explanation),
 * and the node runs that text in the network-less sandbox (sandbox.ts). The
 * model's output is untrusted wherever it came from, so the sandbox's limits,
 * not the prompt, are what keep this computer safe.
 */
import type { ChatMessage } from '@werewolf-mesh/protocol';
import { randomBytes } from 'node:crypto';
import type { AgentStep } from './research.js';
import type { SandboxResult } from './sandbox.js';

export interface CodeDeps {
  /** One model call with the person's chosen effort; returns the answer text (thinking left out). */
  generate: (messages: ChatMessage[], signal: AbortSignal) => Promise<string>;
  /** Runs a Python program in the sandbox. */
  run: (program: string, signal: AbortSignal) => Promise<SandboxResult>;
  onStep: (step: AgentStep) => void;
  maxRounds: number;
  /** Model name for the step texts. */
  modelName: string;
}

export interface CodeResult {
  /** The model's reply that did best: solution, tests and explanation. Empty if it wrote nothing usable. */
  reply: string;
  /** null = no test run (the model wrote no code, or the sandbox is unavailable). */
  passed: boolean | null;
  /** The solution ran, but there were no tests to check it. */
  untested: boolean;
  /** Rounds run in total. */
  rounds: number;
  /** The round whose reply is returned. */
  bestRound: number;
  testsPassed: number;
  testsTotal: number;
  /** The first failure, short, for the note under the answer. */
  failure: string | null;
}

/** Does this message ask for Python code to be written or fixed? Conservative: it must say "python". */
export function wantsCode(text: string): boolean {
  const t = text.toLowerCase();
  if (!/\bpython\b|```py(thon)?\b/.test(t)) return false;
  return /\b(write|implement|create|make|build|generate|fix|debug|correct|refactor)\b/.test(t);
}

const BLOCK_RE = /```(?:python|py|python3)?[ \t]*\n([\s\S]*?)```/gi;

/** Python code blocks in a text, in order. */
export function codeBlocks(text: string): string[] {
  return [...text.matchAll(BLOCK_RE)].map((m) => m[1]!.replace(/\s+$/, '')).filter((b) => b.trim());
}

const isTests = (block: string) => {
  const lines = block.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  return lines.length > 0 && lines.filter((l) => /^assert\b/.test(l)).length >= Math.ceil(lines.length / 3);
};

/**
 * A reply's solution and tests: the first block is the solution, a later block
 * made mostly of asserts is the tests. A single block may carry its own asserts.
 */
export function parseReply(text: string): { code: string | null; tests: string } {
  const blocks = codeBlocks(text);
  if (!blocks.length) return { code: null, tests: '' };
  const [first, ...rest] = blocks;
  const tests = rest.filter(isTests);
  const extra = rest.filter((b) => !isTests(b));
  return { code: [first!, ...extra].join('\n\n'), tests: tests.join('\n\n') };
}

/** Tests the person wrote themselves (python blocks of asserts in their message). They are run unchanged every round. */
export function userTests(text: string): string {
  return codeBlocks(text).filter(isTests).join('\n\n');
}

/**
 * The program the sandbox runs: the solution, then each test statement on its
 * own, so one failing assert doesn't hide the others. For `assert a == b` it
 * reports both values, which is what lets the model tell a wrong solution from
 * a wrong test.
 *
 * The pass marker is a random nonce printed at the very end, so a solution
 * that exits early by mistake (sys.exit(0)) is not a pass. It is a check
 * against accidents, not against hostile code: code in the same process could
 * find the nonce. Containment is the sandbox's job.
 */
export function buildProgram(code: string, tests: string, fixedTests: string, nonce: string): string {
  const s = JSON.stringify;
  return `import ast as _ast, sys as _sys, traceback as _tb
_SOL = ${s(code)}
_g = {"__name__": "__main__"}
exec(compile(_SOL, "solution.py", "exec"), _g)
def _where(e):
    fr = [f for f in _tb.extract_tb(e.__traceback__) if f.filename == "solution.py"]
    if not fr: return ""
    ln = _SOL.splitlines()[fr[-1].lineno - 1].strip() if fr[-1].lineno <= len(_SOL.splitlines()) else ""
    return f" (raised at solution.py line {fr[-1].lineno}: {ln})"
_total = _bad = 0
for _who, _src in (("your test", ${s(tests)}), ("the user's test", ${s(fixedTests)})):
    _tree = _ast.parse(_src, filename=_who)
    for _node in _tree.body:
        _seg = (_ast.get_source_segment(_src, _node) or "").strip()
        if isinstance(_node, _ast.Assert):
            _total += 1
            try:
                _t = _node.test
                if isinstance(_t, _ast.Compare) and len(_t.ops) == 1 and isinstance(_t.ops[0], _ast.Eq):
                    _l = eval(compile(_ast.Expression(_t.left), _who, "eval"), _g)
                    _r = eval(compile(_ast.Expression(_t.comparators[0]), _who, "eval"), _g)
                    if not (_l == _r):
                        raise AssertionError(f"left side is {_l!r:.300}, right side is {_r!r:.300}")
                else:
                    exec(compile(_ast.Module(body=[_node], type_ignores=[]), _who, "exec"), _g)
            except Exception as _e:
                _bad += 1
                print(f"FAILED {_who}, line {_node.lineno}: {_seg[:300]}\\n  -> {type(_e).__name__}: {str(_e)[:400]}{_where(_e)}", file=_sys.stderr)
        else:
            try:
                exec(compile(_ast.Module(body=[_node], type_ignores=[]), _who, "exec"), _g)
            except Exception as _e:
                _total += 1
                _bad += 1
                print(f"ERROR {_who}, line {_node.lineno}: {_seg[:300]}\\n  -> {type(_e).__name__}: {str(_e)[:400]}{_where(_e)}", file=_sys.stderr)
                break
print(f"TESTS {_total - _bad}/{_total}", file=_sys.stderr)
if _bad:
    _sys.exit(1)
print(${s(nonce)})
`;
}

export interface Outcome {
  passed: boolean;
  testsPassed: number;
  testsTotal: number;
  /** The first failure, short. */
  failure: string | null;
  /** What the model gets back for a fix: every failing test, or the traceback. */
  report: string;
}

/** What a sandbox run means. */
export function outcomeOf(r: SandboxResult, nonce: string): Outcome {
  const tally = /^TESTS (\d+)\/(\d+)$/m.exec(r.stderr);
  const testsPassed = Number(tally?.[1] ?? 0);
  const testsTotal = Number(tally?.[2] ?? 0);
  const ok = !r.error && !r.timedOut && r.exitCode === 0 && r.stdout.includes(nonce);
  if (ok) return { passed: true, testsPassed, testsTotal, failure: null, report: '' };
  const tail = (s: string, n: number) => (s.length > n ? `…${s.slice(-n)}` : s);
  const failed = r.stderr.split(/\n(?=FAILED |ERROR |TESTS )/).filter((b) => /^(FAILED|ERROR) /.test(b));
  let failure: string;
  let report: string;
  if (r.error) failure = report = r.error;
  else if (r.timedOut) failure = report = 'the program ran too long and was stopped (an endless loop, or waiting for input?)';
  else if (r.exitCode === 137) failure = report = 'the program was killed (out of memory?)';
  else if (failed.length) {
    failure = failed[0]!.replace(/\n\s*->/, ' →').replace(/\s+/g, ' ').trim().slice(0, 300);
    report = [`${testsPassed} of ${testsTotal} tests passed. Failing:`, ...failed.slice(0, 6).map((f) => f.trim())].join('\n');
  } else if (r.stderr.trim()) {
    // Not a test: the solution itself failed to load (syntax error, error at import time, …).
    failure = r.stderr.trim().split('\n').filter(Boolean).at(-1)!.slice(0, 300);
    report = `The program failed before the tests ran:\n${tail(r.stderr.trim(), 1500)}`;
  } else if (r.exitCode === 0) failure = report = 'the program stopped before the tests finished (sys.exit or os._exit?)';
  else failure = report = `the program exited with code ${r.exitCode}`;
  if (r.stdout.trim() && !ok) report += `\n\nIts output:\n${tail(r.stdout.trim(), 600)}`;
  return { passed: false, testsPassed, testsTotal, failure, report };
}

function systemPrompt(fixedTests: string): string {
  return [
    'You write Python 3.12 code for the user. This node will run your code and your tests in an offline sandbox: standard library only, no network, no files, no input().',
    'Reply in this format:',
    '1. One ```python block with the complete solution.',
    '2. One ```python block with tests: plain assert statements that check what the user asked for, including edge cases. No unittest, no pytest, no if __name__ == "__main__", no print. Work out each expected value carefully from the request.',
    '3. One or two sentences explaining the solution.',
    ...(fixedTests ? ['', 'The user wrote these tests; they will also be run, unchanged, after yours:', '```python', fixedTests, '```'] : []),
  ].join('\n');
}

const countAsserts = (s: string) => (s.match(/^\s*assert\b|;\s*assert\b/gm) ?? []).length;

export async function codePipeline(history: ChatMessage[], deps: CodeDeps, signal: AbortSignal): Promise<CodeResult> {
  const question = [...history].reverse().find((m) => m.role === 'user')?.content ?? '';
  const fixed = userTests(question);
  const own = history.filter((m) => m.role === 'system').map((m) => m.content);
  const system: ChatMessage = { role: 'system', content: [systemPrompt(fixed), ...own].join('\n\n') };
  let messages: ChatMessage[] = [system, ...history.filter((m) => m.role !== 'system')];
  let best: CodeResult | null = null;
  const none: CodeResult = { reply: '', passed: null, untested: false, rounds: 0, bestRound: 0, testsPassed: 0, testsTotal: 0, failure: null };

  for (let round = 1; round <= deps.maxRounds; round++) {
    const kind = round === 1 ? 'write' : 'fix';
    deps.onStep({ kind, status: 'running', text: round === 1 ? `Writing the code with ${deps.modelName}` : `Fixing the code (round ${round} of ${deps.maxRounds})` });
    const reply = await deps.generate(messages, signal);
    const { code, tests } = parseReply(reply);
    if (!code) {
      deps.onStep({ kind, status: 'failed', text: 'The model wrote no Python code block' });
      // Keep the best reply that had code; otherwise answer with what the model said.
      return best ? { ...best, rounds: round } : { ...none, reply, rounds: round, bestRound: round };
    }
    const nTests = countAsserts(tests) + countAsserts(fixed);
    deps.onStep({ kind, status: 'done', text: `${round === 1 ? 'Wrote' : 'Rewrote'} the code${nTests ? ` and ${nTests} test${nTests > 1 ? 's' : ''}` : ' (no tests)'}` });

    deps.onStep({ kind: 'test', status: 'running', text: nTests ? 'Running the tests in the sandbox' : 'Running the code in the sandbox' });
    const nonce = `ALL-TESTS-PASSED-${randomBytes(8).toString('hex')}`;
    const r = await deps.run(buildProgram(code, tests, fixed, nonce), signal);
    if (r.error) {
      deps.onStep({ kind: 'test', status: 'failed', text: r.error });
      return { ...none, reply, rounds: round, bestRound: round, failure: r.error };
    }
    const o = outcomeOf(r, nonce);
    const secs = (r.ms / 1000).toFixed(1);
    const res: CodeResult = { reply, passed: o.passed, untested: o.passed && o.testsTotal === 0, rounds: round, bestRound: round, testsPassed: o.testsPassed, testsTotal: o.testsTotal, failure: o.failure };
    deps.onStep({
      kind: 'test',
      status: o.passed ? 'done' : 'failed',
      text: o.passed ? (o.testsTotal ? `All ${o.testsTotal} tests passed (${secs} s)` : `Ran without errors (${secs} s)`) : `${o.testsTotal ? `${o.testsPassed} of ${o.testsTotal} tests passed. ` : ''}${o.failure}`,
    });
    // The best round wins: a fix that makes things worse is not the answer.
    const score = (x: CodeResult) => (x.passed ? 2 : 0) + (x.testsTotal ? x.testsPassed / x.testsTotal : 0);
    if (!best || score(res) >= score(best)) best = res;
    if (o.passed) return { ...best, rounds: round };

    // Fix round: same conversation plus the failure, so the worker can reuse its cache (session affinity).
    messages = [
      ...messages,
      { role: 'assistant', content: reply },
      {
        role: 'user',
        content: [
          'The node ran your solution and tests in the sandbox:',
          '```',
          o.report,
          '```',
          fixed
            ? "Find the cause and fix the solution. The user's own tests are correct and must pass unchanged. If one of your own tests is wrong, fix that test."
            : 'For each failing test, check against the request which side is wrong. If the solution is wrong, fix the solution. If the test expects the wrong value (it contradicts what the user asked for), fix the test instead.',
          'Reply in the same format: the complete solution, the complete tests, then a short explanation.',
        ].join('\n'),
      },
    ];
  }
  return { ...best!, rounds: deps.maxRounds };
}

/** The node's note under the answer, so every client (not only the web UI) sees whether the code was tested. */
export function resultNote(r: CodeResult): string {
  if (r.passed === null) return r.failure ? `\n\n---\n*Not tested: ${r.failure}.*` : '';
  if (r.untested) return "\n\n---\n*Ran without errors in this node's offline Python sandbox, but there were no tests.*";
  const fixes = r.bestRound - 1;
  if (r.passed) return `\n\n---\n*Tested by this node in an offline Python sandbox: all ${r.testsTotal} tests passed${fixes ? ` after ${fixes} fix${fixes > 1 ? 'es' : ''}` : ''}.*`;
  const tally = r.testsTotal ? `${r.testsPassed} of ${r.testsTotal} tests passed` : 'the code failed';
  return `\n\n---\n*Tested by this node in an offline Python sandbox: ${tally} after ${r.rounds} rounds. Still failing: \`${(r.failure ?? '').replace(/`/g, "'")}\`. The test itself may be wrong; check before using the code.*`;
}
