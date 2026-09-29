/**
 * The code pipeline with the real Docker sandbox: escape attempts against the
 * sandbox itself, then write → test → fix through a node, with a stand-in
 * engine scripted to write a wrong solution first.
 * Skipped when Docker or the pinned image is missing (./mesh code setup).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PYTHON_SANDBOX_IMAGE } from '../../apps/node/src/config.js';
import { runPython, sandboxStatus } from '../../apps/node/src/agent/sandbox.js';
import { buildProgram, outcomeOf } from '../../apps/node/src/agent/code.js';
import { chat, makeCluster, startNode, type TestCluster, type TestNode } from '../harness.js';
import { startStandInEngine, type StandIn } from '../standin-engine.js';

const ready = sandboxStatus(PYTHON_SANDBOX_IMAGE).image;
const opts = { image: PYTHON_SANDBOX_IMAGE, timeoutMs: 5000, memoryMb: 128, cpus: 1, maxOutputBytes: 4096 };

describe.skipIf(!ready)('sandbox escapes', () => {
  it('has no network, not even DNS or the Docker host', async () => {
    const r = await runPython(
      [
        'import socket',
        'for host, port in [("1.1.1.1", 53), ("172.17.0.1", 2375), ("169.254.169.254", 80)]:',
        '    try:',
        '        socket.create_connection((host, port), timeout=1); print("open", host)',
        '    except OSError: print("blocked", host)',
        'try:',
        '    socket.getaddrinfo("example.com", 80); print("dns works")',
        'except OSError: print("no dns")',
      ].join('\n'),
      opts,
    );
    expect(r.stdout).not.toMatch(/open|dns works/);
    expect(r.stdout.match(/blocked/g)).toHaveLength(3);
  });

  it('cannot write outside a small no-exec /tmp, and sees no host files', async () => {
    const r = await runPython(
      [
        'import os, subprocess',
        'for p in ["/x", "/usr/local/lib/x", "/home/x"]:',
        '    try: open(p, "w"); print("wrote", p)',
        '    except OSError: print("blocked")',
        'open("/tmp/t.sh", "w").write("#!/bin/sh\\necho ran")',
        'os.chmod("/tmp/t.sh", 0o755)',
        'try: subprocess.run(["/tmp/t.sh"], check=True); print("exec from tmp")',
        'except (OSError, subprocess.CalledProcessError): print("noexec")',
        'print("uid", os.getuid(), "mounts", sum(1 for l in open("/proc/mounts") if "/home" in l))',
      ].join('\n'),
      opts,
    );
    expect(r.stdout).not.toMatch(/wrote|exec from tmp/);
    expect(r.stdout).toContain('noexec');
    expect(r.stdout).toContain('uid 65534 mounts 0');
  });

  it('stops endless loops, fork bombs and memory hogs', async () => {
    const loop = await runPython('while True: pass', { ...opts, timeoutMs: 2000 });
    expect(loop.timedOut).toBe(true);
    expect(loop.ms).toBeLessThan(10_000);

    const fork = await runPython('import os\nn = 0\ntry:\n    while True:\n        if os.fork() == 0:\n            import time; time.sleep(30)\n        n += 1\nexcept OSError:\n    print("limited at", n)', { ...opts, timeoutMs: 3000 });
    const n = Number(/limited at (\d+)/.exec(fork.stdout)?.[1] ?? 999);
    expect(n).toBeLessThan(64);

    const mem = await runPython('x = bytearray(512 * 2**20)\nprint("allocated")', opts);
    expect(mem.stdout).not.toContain('allocated');
    expect(mem.exitCode).not.toBe(0);
  });

  it('keeps only the first bytes of a flood of output', async () => {
    const r = await runPython('import sys\nfor _ in range(100000): sys.stdout.write("x" * 100)', opts);
    expect(r.stdout.length).toBe(4096);
  });

  it('can be cancelled', async () => {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 500);
    const t0 = Date.now();
    await runPython('import time\ntime.sleep(60)', { ...opts, timeoutMs: 60_000, signal: ctl.signal });
    expect(Date.now() - t0).toBeLessThan(10_000);
  });
});

describe.skipIf(!ready)('test harness in the sandbox', () => {
  const check = async (code: string, tests: string, fixed = '') => outcomeOf(await runPython(buildProgram(code, tests, fixed, 'NONCE-1'), opts), 'NONCE-1');

  it('runs every test, and shows both sides of a failing ==', async () => {
    const o = await check('def add(a, b):\n    return a - b', 'assert add(2, 0) == 2\nassert add(1, 2) == 3; assert add(2, 2) == 4\nassert add(5, 5) > 1');
    expect(o).toMatchObject({ passed: false, testsPassed: 1, testsTotal: 4 });
    expect(o.report).toContain('FAILED your test, line 2: assert add(1, 2) == 3\n  -> AssertionError: left side is -1, right side is 3');
    expect(o.report).toContain('left side is 0, right side is 4');
    expect(o.report).toContain('line 3: assert add(5, 5) > 1');
  });

  it("points at the solution line that raised, and runs the user's tests too", async () => {
    const o = await check('def inv(x):\n    return 1 / x', 'assert inv(2) == 0.5', 'assert inv(0) == 0');
    expect(o).toMatchObject({ passed: false, testsPassed: 1, testsTotal: 2 });
    expect(o.failure).toMatch(/FAILED the user's test, line 1: assert inv\(0\) == 0 → ZeroDivisionError: division by zero \(raised at solution.py line 2: return 1 \/ x\)/);
  });

  it('reports a test that uses a wrong API, and stops a block at a failing setup line', async () => {
    // put() returns None: the test, not the solution, is wrong, and the report makes that visible.
    const o = await check('class C:\n    def put(self, v): self.v = v', 'c = C().put(1)\nassert c.v == 1\nassert True');
    expect(o).toMatchObject({ passed: false, testsPassed: 1, testsTotal: 2 });
    expect(o.failure).toBe("FAILED your test, line 2: assert c.v == 1 → AttributeError: 'NoneType' object has no attribute 'v'");
    const e = await check('class C:\n    pass', 'c = C()\nc.missing()\nassert True');
    expect(e).toMatchObject({ passed: false, testsPassed: 0, testsTotal: 1 });
    expect(e.failure).toMatch(/^ERROR your test, line 2: c.missing\(\) → AttributeError/);
  });

  it('passes a correct solution, and not one that exits early or fails to load', async () => {
    expect(await check('def f():\n    return 1', 'assert f() == 1\nx = f()\nassert x')).toMatchObject({ passed: true, testsPassed: 2, testsTotal: 2 });
    expect((await check('import sys\nsys.exit(0)', 'assert False')).passed).toBe(false);
    const bad = await check('def f(:\n    pass', 'assert f() == 1');
    expect(bad.passed).toBe(false);
    expect(bad.report).toMatch(/failed before the tests ran[\s\S]*SyntaxError/);
  });
});

describe.skipIf(!ready)('code pipeline through a node', () => {
  let c: TestCluster;
  let n: TestNode;
  let engine: StandIn;
  const ID = 'coder';
  const wrong = '```python\ndef median(xs):\n    xs = sorted(xs)\n    return xs[len(xs) // 2]\n```\n```python\nassert median([3, 1, 2]) == 2\nassert median([4, 1, 3, 2]) == 2.5\n```\nSorts and takes the middle.';
  const right = '```python\ndef median(xs):\n    xs = sorted(xs)\n    m = len(xs) // 2\n    return xs[m] if len(xs) % 2 else (xs[m - 1] + xs[m]) / 2\n```\n```python\nassert median([3, 1, 2]) == 2\nassert median([4, 1, 3, 2]) == 2.5\n```\nAverages the two middle values for even lengths.';

  beforeAll(async () => {
    engine = await startStandInEngine({
      script: (body) => {
        const last = body.messages.at(-1).content as string;
        if (!/median/i.test(JSON.stringify(body.messages))) return undefined;
        return last.startsWith('The node ran your solution') ? right : wrong;
      },
    });
    c = await makeCluster({ nodes: 2, patch: () => ({ runtime: { fakeTokenDelayMs: 1 } }) });
    n = c.nodes[0]!;
    await startNode(n);
    const r = await fetch(`${n.url}/admin/engines`, {
      method: 'POST',
      headers: { authorization: `Bearer ${n.adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id: ID, name: 'Coder', url: engine.url }),
    });
    expect(r.status).toBe(200);
  });
  afterAll(async () => {
    await c?.cleanup();
    await engine?.close();
  });

  it('writes, finds the failing test in the sandbox, fixes it, and says so', async () => {
    const r = await chat(n, 'Write a Python function median(xs).', { token: n.adminToken, extra: { model: ID, reasoning_effort: 'none', mesh: { code: 'on' } } });
    expect(r.error).toBeNull();
    expect(r.done).toBe(true);
    const steps = r.chunks.filter((ch) => ch.mesh?.agent?.step).map((ch) => `${ch.mesh.agent.step.kind}:${ch.mesh.agent.step.status}`);
    expect(steps).toEqual(['write:running', 'write:done', 'test:running', 'test:failed', 'fix:running', 'fix:done', 'test:running', 'test:done']);
    expect(r.chunks.find((ch) => ch.mesh?.agent?.code)?.mesh.agent.code).toMatchObject({ passed: true, rounds: 2 });
    expect(r.text).toContain('Averages the two middle values');
    expect(r.text).toMatch(/all 2 tests passed after 1 fix/);
    // The fix round saw which test failed, and with what value.
    const fixReq = engine.requests.at(-1);
    expect(fixReq.messages.at(-1).content).toContain('assert median([4, 1, 3, 2]) == 2.5\n  -> AssertionError: left side is 3, right side is 2.5');
    // Usage covers both rounds.
    expect(r.chunks.at(-1).usage.prompt_tokens).toBe(84);
  });

  it('non-streaming returns the same answer with the result in mesh.code', async () => {
    const r = await chat(n, 'Write a Python function median(xs).', { stream: false, token: n.adminToken, extra: { model: ID, reasoning_effort: 'none', mesh: { code: 'on' } } });
    expect(r.status).toBe(200);
    expect(r.body.mesh.code).toMatchObject({ passed: true, rounds: 2 });
    expect(r.body.mesh.code.steps).toHaveLength(8);
  });

  it('is for the operator only by default, and cannot be combined with web "on"', async () => {
    const denied = await chat(n, 'Write a Python function median(xs).', { extra: { model: ID, mesh: { code: 'on' } } });
    expect(denied.status).toBe(403);
    // "auto" for a client token quietly answers without running anything.
    const before = engine.requests.length;
    const auto = await chat(n, 'Write a Python function median(xs).', { stream: false, extra: { model: ID, reasoning_effort: 'none', mesh: { code: 'auto' } } });
    expect(auto.status).toBe(200);
    expect(auto.body.mesh.code).toBeUndefined();
    expect(engine.requests.length).toBe(before + 1);
    const both = await chat(n, 'x', { token: n.adminToken, extra: { model: ID, mesh: { code: 'on', web: 'on' } } });
    expect(both.status).toBe(400);
  });

  it('"auto" runs for a Python request and not for other questions', async () => {
    const yes = await chat(n, 'Write a Python function median(xs).', { stream: false, token: n.adminToken, extra: { model: ID, reasoning_effort: 'none', mesh: { code: 'auto' } } });
    expect(yes.body.mesh.code?.passed).toBe(true);
    const no = await chat(n, 'What is a median?', { stream: false, token: n.adminToken, extra: { model: ID, reasoning_effort: 'none', mesh: { code: 'auto' } } });
    expect(no.body.mesh.code).toBeUndefined();
  });
});
