// Usage: GW=http://127.0.0.1:8080 MODEL=qwen3-8b-q4_k_m EFFORTS=none,low node scripts/code-eval.mjs  (needs Docker; generated code runs with no network)
// Small coding benchmark for a mesh model. Generated code runs ONLY inside a
// network-less, memory-capped Docker container (python:3.12-slim).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const GW = process.env.GW ?? 'http://127.0.0.1:18230';
const MODEL = process.env.MODEL ?? 'qwen3-8b-q4_k_m';
const LOG = process.env.LOG ?? 'code-eval-results.jsonl';
const tasks = [
  { id: 'ipv4', prompt: 'Write a Python function is_valid_ipv4(s: str) -> bool that returns True only for dotted-decimal IPv4 addresses like "192.168.0.1": exactly four parts, each 0-255, digits only, no leading zeros (except "0" itself).',
    tests: `assert is_valid_ipv4("192.168.0.1"); assert is_valid_ipv4("0.0.0.0"); assert is_valid_ipv4("255.255.255.255")
assert not is_valid_ipv4("256.1.1.1"); assert not is_valid_ipv4("1.2.3"); assert not is_valid_ipv4("01.2.3.4"); assert not is_valid_ipv4("1.2.3.4.5"); assert not is_valid_ipv4("a.b.c.d"); assert not is_valid_ipv4("1..2.3"); assert not is_valid_ipv4(" 1.2.3.4")` },
  { id: 'intervals', prompt: 'Write a Python function merge_intervals(intervals: list[list[int]]) -> list[list[int]] that merges overlapping (or touching) closed intervals and returns them sorted by start. Example: [[1,3],[2,6],[8,10],[15,18]] -> [[1,6],[8,10],[15,18]].',
    tests: `assert merge_intervals([[1,3],[2,6],[8,10],[15,18]])==[[1,6],[8,10],[15,18]]; assert merge_intervals([[1,4],[4,5]])==[[1,5]]; assert merge_intervals([])==[]; assert merge_intervals([[5,6],[1,2]])==[[1,2],[5,6]]; assert merge_intervals([[1,10],[2,3],[4,5]])==[[1,10]]` },
  { id: 'lru', prompt: 'Write a Python class LRUCache with __init__(self, capacity: int), get(self, key) -> value or -1, and put(self, key, value). When the cache is full, put evicts the least recently used key. Both get and put count as a use. Use only the standard library.',
    tests: `c=LRUCache(2); c.put(1,1); c.put(2,2); assert c.get(1)==1; c.put(3,3); assert c.get(2)==-1; c.put(4,4); assert c.get(1)==-1; assert c.get(3)==3; assert c.get(4)==4
d=LRUCache(1); d.put("a",1); d.put("a",2); assert d.get("a")==2; d.put("b",3); assert d.get("a")==-1` },
  { id: 'csv', prompt: 'Write a Python function parse_csv_line(line: str) -> list[str] WITHOUT using the csv module. Fields are separated by commas. A field may be wrapped in double quotes, in which case it may contain commas, and a doubled double quote "" inside it means one literal double quote.',
    tests: `assert parse_csv_line('a,b,c')==['a','b','c']; assert parse_csv_line('"a,b",c')==['a,b','c']; assert parse_csv_line('"he said ""hi""",x')==['he said "hi"','x']; assert parse_csv_line('a,,c')==['a','','c']; assert parse_csv_line('')==['']; assert parse_csv_line('"",x')==['','x']` },
  { id: 'wordfreq', prompt: 'Write a Python function top_words(text: str, n: int) -> list[tuple[str, int]] returning the n most frequent words with their counts. Words are sequences of letters a-z (case-insensitive, lowercased in the result); everything else separates words. Sort by count descending, then alphabetically for ties.',
    tests: `assert top_words("The cat and the hat. THE end!", 2)==[("the",3),("and",1)]; assert top_words("b a b a c", 3)==[("a",2),("b",2),("c",1)]; assert top_words("", 3)==[]; assert top_words("It's ok, it's fine", 2)==[("it",2),("s",2)]` },
  { id: 'bugfix', prompt: 'This Python function should return the median of a non-empty list of numbers, but it is wrong for some inputs. Return a corrected version with the same name.\n\ndef median(xs):\n    xs.sort()\n    mid = len(xs) // 2\n    return xs[mid]\n',
    tests: `assert median([3,1,2])==2; assert median([4,1,3,2])==2.5; assert median([5])==5; v=[3,1,2,4]; median(v); assert v==[3,1,2,4], "must not mutate the input"; assert median([1.5,2.5])==2.0` },
];
function extract(answer) {
  const blocks = [...answer.matchAll(/```(?:python|py)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  return blocks.length ? blocks.join('\n\n') : answer;
}
function run(code, tests) {
  const dir = mkdtempSync(join(tmpdir(), 'wam-eval-'));
  writeFileSync(join(dir, 'run.py'), `${code}\n\n${tests}\nprint("PASS")\n`);
  try {
    const out = execFileSync('docker', ['run', '--rm', '--network', 'none', '--memory', '256m', '--cpus', '1', '--read-only', '-v', `${dir}:/w:ro`, 'python:3.12-slim', 'timeout', '10', 'python', '-I', '/w/run.py'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { pass: out.includes('PASS'), err: '' };
  } catch (e) {
    return { pass: false, err: String(e.stderr || e.message).trim().split('\n').slice(-1)[0].slice(0, 160) };
  }
}
for (const effort of (process.env.EFFORTS ?? 'none,low').split(',')) {
  for (const t of tasks) {
    const t0 = Date.now();
    const r = await (await fetch(`${GW}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: MODEL, reasoning_effort: effort, max_tokens: 1024, temperature: 0, mesh: { pack: false }, messages: [{ role: 'user', content: t.prompt + '\nReply with the code in one ```python block.' }] }) })).json();
    const m = r.choices?.[0]?.message ?? {};
    const res = run(extract(m.content ?? ''), t.tests);
    const row = { model: MODEL, effort, task: t.id, pass: res.pass, err: res.err, seconds: Math.round((Date.now() - t0) / 1000), completionTokens: r.usage?.completion_tokens, thinkingChars: (m.reasoning_content ?? '').length, finish: r.choices?.[0]?.finish_reason, error: r.error?.message };
    appendFileSync(LOG, JSON.stringify(row) + '\n');
    console.log(JSON.stringify(row));
  }
}
console.log('EVAL-DONE');
