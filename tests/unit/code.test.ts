/** Code pipeline: parsing replies, the write → test → fix loop, the pass marker, and when to run. */
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@werewolf-mesh/protocol';
import { buildProgram, codePipeline, outcomeOf, parseReply, resultNote, userTests, wantsCode, type CodeDeps } from '../../apps/node/src/agent/code.js';
import type { AgentStep } from '../../apps/node/src/agent/research.js';
import { sandboxArgs, type SandboxResult } from '../../apps/node/src/agent/sandbox.js';

const py = (s: string) => '```python\n' + s + '\n```';
const ok = (stdout: string): SandboxResult => ({ exitCode: 0, timedOut: false, stdout, stderr: '', ms: 300 });
const fail = (stderr: string): SandboxResult => ({ exitCode: 1, timedOut: false, stdout: '', stderr, ms: 300 });
const FAILED = 'FAILED your test, line 1: assert add(1, 2) == 3\n  -> AssertionError: left side is -1, right side is 3\nTESTS 0/1\n';

/** Runs a fake sandbox: passes when the program contains `good`, reporting as the real harness does. */
function fakeRun(good: RegExp) {
  const programs: string[] = [];
  const run: CodeDeps['run'] = async (program) => {
    programs.push(program);
    const nonce = /print\("(ALL-TESTS-PASSED-[0-9a-f]+)"\)/.exec(program)![1]!;
    return good.test(program) ? { ...ok(`${nonce}\n`), stderr: 'TESTS 1/1\n' } : fail(FAILED);
  };
  return { run, programs };
}

function deps(replies: string[], run: CodeDeps['run'], maxRounds = 3) {
  const steps: AgentStep[] = [];
  const calls: ChatMessage[][] = [];
  const d: CodeDeps = {
    maxRounds,
    modelName: 'Test model',
    onStep: (s) => steps.push(s),
    generate: async (m) => {
      calls.push(m);
      return replies.shift() ?? 'no more replies';
    },
    run,
  };
  return { d, steps, calls };
}

const ask: ChatMessage[] = [{ role: 'user', content: 'Write a Python function add(a, b).' }];

describe('parsing a reply', () => {
  it('takes the first block as the solution and an assert block as the tests', () => {
    const r = parseReply(`Here:\n${py('def add(a, b):\n    return a + b')}\nTests:\n${py('assert add(1, 2) == 3\nassert add(0, 0) == 0')}\nDone.`);
    expect(r.code).toBe('def add(a, b):\n    return a + b');
    expect(r.tests).toBe('assert add(1, 2) == 3\nassert add(0, 0) == 0');
  });
  it('keeps a later non-test block as part of the solution, and finds no code in prose', () => {
    expect(parseReply(`${py('import math')}\n${py('def f(): return math.pi')}`).code).toBe('import math\n\ndef f(): return math.pi');
    expect(parseReply('I cannot help with that.').code).toBeNull();
  });
  it("finds the person's own tests", () => {
    expect(userTests(`Make it pass:\n${py('assert add(2, 2) == 4')}`)).toBe('assert add(2, 2) == 4');
    expect(userTests(`Fix this:\n${py('def add(a,b): return a-b')}`)).toBe('');
  });
});

describe('when to run the pipeline', () => {
  it.each(['Write a Python function that reverses a list', 'fix this python code please', 'Implement quicksort in Python'])('yes: %s', (t) => expect(wantsCode(t)).toBe(true));
  it.each(['What is Python?', 'Write a poem about snakes', 'Write a JavaScript function'])('no: %s', (t) => expect(wantsCode(t)).toBe(false));
});

describe('reading a run', () => {
  it('passes only with exit 0 and the nonce printed after the tests', () => {
    const p = buildProgram('import sys\nsys.exit(0)', 'assert False', '', 'N123');
    expect(p.indexOf('print("N123")')).toBeGreaterThan(p.indexOf('assert False'));
    expect(outcomeOf({ ...ok('N123\n'), stderr: 'TESTS 3/3\n' }, 'N123')).toMatchObject({ passed: true, testsPassed: 3, testsTotal: 3 });
    // Exiting early with 0 skips the marker: not a pass.
    expect(outcomeOf(ok(''), 'N123')).toMatchObject({ passed: false, failure: expect.stringMatching(/stopped before the tests finished/) });
    expect(outcomeOf({ ...ok('N123'), timedOut: true }, 'N123').passed).toBe(false);
  });
  it('lists the failing tests with their values', () => {
    const o = outcomeOf(fail(`${FAILED.replace('TESTS 0/1', 'FAILED your test, line 2: assert add(0, 0) == 0\n  -> AssertionError: left side is 1, right side is 0\nTESTS 1/3')}`), 'x');
    expect(o).toMatchObject({ passed: false, testsPassed: 1, testsTotal: 3, failure: 'FAILED your test, line 1: assert add(1, 2) == 3 → AssertionError: left side is -1, right side is 3' });
    expect(o.report).toMatch(/^1 of 3 tests passed. Failing:\nFAILED your test, line 1[\s\S]*line 2: assert add\(0, 0\) == 0/);
  });
  it('shows the traceback when the solution fails before the tests', () => {
    const o = outcomeOf(fail('Traceback…\n  File "solution.py", line 3\nZeroDivisionError: division by zero'), 'x');
    expect(o.failure).toBe('ZeroDivisionError: division by zero');
    expect(o.report).toMatch(/failed before the tests ran/);
  });
});

describe('the loop', () => {
  it('stops after the first round when the tests pass', async () => {
    const { run, programs } = fakeRun(/a \+ b/);
    const { d, steps } = deps([`${py('def add(a, b):\n    return a + b')}\n${py('assert add(1, 2) == 3')}\nAdds.`], run);
    const r = await codePipeline(ask, d, new AbortController().signal);
    expect(r).toMatchObject({ passed: true, untested: false, rounds: 1, bestRound: 1, testsTotal: 1, failure: null });
    expect(programs).toHaveLength(1);
    expect(steps.map((s) => `${s.kind}:${s.status}`)).toEqual(['write:running', 'write:done', 'test:running', 'test:done']);
    expect(steps[3]!.text).toMatch(/All 1 tests passed/);
    expect(resultNote(r)).toMatch(/all 1 tests passed\./);
  });

  it('feeds the failure back and keeps the conversation for the fix round', async () => {
    const { run } = fakeRun(/a \+ b/);
    const { d, steps, calls } = deps([`${py('def add(a, b):\n    return a - b')}\n${py('assert add(1, 2) == 3')}`, `${py('def add(a, b):\n    return a + b')}\n${py('assert add(1, 2) == 3')}\nFixed the sign.`], run);
    const r = await codePipeline(ask, d, new AbortController().signal);
    expect(r).toMatchObject({ passed: true, rounds: 2, bestRound: 2 });
    expect(r.reply).toContain('Fixed the sign.');
    expect(steps.map((s) => `${s.kind}:${s.status}`)).toEqual(['write:running', 'write:done', 'test:running', 'test:failed', 'fix:running', 'fix:done', 'test:running', 'test:done']);
    // Round 2 extends round 1's messages (same prefix: the worker can reuse its cache).
    expect(calls[1]!.slice(0, calls[0]!.length)).toEqual(calls[0]);
    expect(calls[1]!.at(-1)!.content).toMatch(/left side is -1, right side is 3/);
    expect(resultNote(r)).toMatch(/after 1 fix\./);
  });

  it('gives up after maxRounds and says the code still fails', async () => {
    const { run, programs } = fakeRun(/never/);
    const bad = `${py('def add(a, b):\n    return 0')}\n${py('assert add(1, 2) == 3')}`;
    const { d } = deps([bad, bad, bad, bad], run, 3);
    const r = await codePipeline(ask, d, new AbortController().signal);
    expect(r).toMatchObject({ passed: false, rounds: 3, testsPassed: 0, testsTotal: 1, failure: expect.stringMatching(/left side is -1/) });
    expect(programs).toHaveLength(3);
    expect(resultNote(r)).toMatch(/0 of 1 tests passed after 3 rounds. Still failing/);
  });

  it('answers with the best round, not the last', async () => {
    let n = 0;
    const tallies = ['TESTS 3/4', 'TESTS 1/4', 'TESTS 2/4'];
    const run: CodeDeps['run'] = async () => fail(`FAILED your test, line 1: assert f() == 1\n  -> AssertionError: left side is 0, right side is 1\n${tallies[n++]}\n`);
    const { d } = deps([`${py('def f(): return 0')}\nfirst`, `${py('def f(): return 0')}\nsecond`, `${py('def f(): return 0')}\nthird`], run);
    const r = await codePipeline(ask, d, new AbortController().signal);
    expect(r).toMatchObject({ rounds: 3, bestRound: 1, testsPassed: 3, testsTotal: 4 });
    expect(r.reply).toContain('first');
  });

  it("always runs the person's own tests, unchanged", async () => {
    const { run, programs } = fakeRun(/a \+ b/);
    const q: ChatMessage[] = [{ role: 'user', content: `Write add in Python.\n${py('assert add(40, 2) == 42')}` }];
    const { d, calls } = deps([`${py('def add(a, b):\n    return a + b')}\n${py('assert add(1, 1) == 2')}`], run);
    await codePipeline(q, d, new AbortController().signal);
    expect(programs[0]).toContain('assert add(40, 2) == 42');
    expect(calls[0]![0]!.content).toContain('assert add(40, 2) == 42');
  });

  it('answers with the text when the model writes no code, and never runs anything', async () => {
    const { run, programs } = fakeRun(/x/);
    const { d, steps } = deps(['Sorry, I cannot do that.'], run);
    const r = await codePipeline(ask, d, new AbortController().signal);
    expect(r).toMatchObject({ passed: null, reply: 'Sorry, I cannot do that.' });
    expect(programs).toHaveLength(0);
    expect(steps.at(-1)).toMatchObject({ kind: 'write', status: 'failed' });
  });

  it('reports a missing sandbox instead of calling it a test failure', async () => {
    const run: CodeDeps['run'] = async () => ({ exitCode: null, timedOut: false, stdout: '', stderr: '', ms: 5, error: 'the Python sandbox is not installed (run: ./mesh code setup)' });
    const { d } = deps([py('print(1)')], run);
    const r = await codePipeline(ask, d, new AbortController().signal);
    expect(r).toMatchObject({ passed: null, rounds: 1 });
    expect(resultNote(r)).toMatch(/Not tested: the Python sandbox is not installed/);
  });
});

describe('sandbox arguments', () => {
  it('has every restriction', () => {
    const a = sandboxArgs('n', { image: 'img@sha256:x', timeoutMs: 10_000, memoryMb: 256, cpus: 1 }).join(' ');
    for (const flag of ['--network none', '--read-only', '--pull never', '--memory 256m', '--memory-swap 256m', '--pids-limit 64', '--cap-drop ALL', '--security-opt no-new-privileges', '--user 65534:65534', 'timeout -k 1 10 python -I -']) {
      expect(a).toContain(flag);
    }
    // Nothing from the host is mounted.
    expect(a).not.toMatch(/\s(-v|--volume|--mount)\s/);
  });
});
