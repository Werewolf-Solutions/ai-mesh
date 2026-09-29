/**
 * Page text for the model: the main text of an HTML page (readability-style,
 * without a DOM), split into passages, and the passages most relevant to the
 * question chosen by BM25 so a page fits the model's context.
 */

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®', deg: '°', middot: '·', bull: '•', euro: '€', pound: '£', times: '×' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function stripBlocks(html: string, tags: string[]): string {
  let out = html;
  for (const t of tags) out = out.replace(new RegExp(`<${t}\\b[^>]*>[\\s\\S]*?</${t}\\s*>`, 'gi'), ' ');
  return out;
}

function innerOf(html: string, tag: string): string | null {
  const all = [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}\\s*>`, 'gi'))].map((m) => m[1]!);
  if (!all.length) return null;
  return all.sort((a, b) => b.length - a.length)[0]!;
}

function toText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(br|hr)\b[^>]*>/gi, '\n')
      .replace(/<\/?(p|div|section|li|ul|ol|h[1-6]|tr|table|blockquote|pre|dd|dt|figcaption|article|main)\b[^>]*>/gi, '\n')
      .replace(/<(td|th)\b[^>]*>/gi, ' ')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t\f\v ]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

/** Title and main text of a page. Menus, scripts, forms, headers and footers are dropped. */
export function extractText(body: string, contentType: string): { title: string; text: string } {
  if (/^text\/plain/i.test(contentType)) return { title: '', text: body.replace(/\r/g, '').trim() };
  const title = decodeEntities(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1] ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  let html = body.replace(/<!--[\s\S]*?-->/g, ' ');
  html = stripBlocks(html, ['script', 'style', 'noscript', 'svg', 'template', 'iframe', 'head', 'nav', 'footer', 'aside', 'form', 'button', 'select']);
  // <header> inside an article often holds its title; outside, it is site chrome.
  const main = innerOf(html, 'article') ?? innerOf(html, 'main');
  const scope = main && toText(main).length > 400 ? main : stripBlocks(innerOf(html, 'body') ?? html, ['header']);
  const lines = toText(scope)
    .split('\n')
    // Short fragments are usually menus, buttons and breadcrumbs.
    .filter((l) => l.split(' ').length >= 4 || /[.!?:]$/.test(l));
  return { title, text: lines.join('\n') };
}

const STOP = new Set(
  'a an and are as at be but by for from has have how i in is it its of on or that the this to was were what when where which who why will with you your do does did can could should would about into than then there these those they them their our we not no yes also just more most some any all been being over under up down out very'.split(
    ' ',
  ),
);

export function terms(s: string): string[] {
  return (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1 && !STOP.has(w));
}

/** Split text into passages of roughly `size` characters, on line boundaries where possible. */
export function passages(text: string, size = 700): string[] {
  const out: string[] = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (line.length > size * 1.5) {
      if (cur) out.push(cur), (cur = '');
      for (let i = 0; i < line.length; i += size) out.push(line.slice(i, i + size));
      continue;
    }
    if (cur.length + line.length + 1 > size && cur) {
      out.push(cur);
      cur = '';
    }
    cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * The passages most relevant to `query` (BM25), within `budgetChars`, returned
 * in page order. The page's opening passage is kept when it fits: it usually
 * says what the page is about.
 */
export function selectPassages(text: string, query: string, budgetChars: number): string {
  // Passages small enough that several fit, so the best one is never skipped for being too big.
  const ps = passages(text, Math.max(200, Math.min(700, Math.floor(budgetChars / 3))));
  if (!ps.length) return '';
  if (ps.reduce((n, p) => n + p.length, 0) <= budgetChars) return ps.join('\n');
  const q = [...new Set(terms(query))];
  const docs = ps.map((p) => terms(p));
  const avg = docs.reduce((n, d) => n + d.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const k1 = 1.2;
  const b = 0.75;
  const score = docs.map((d) => {
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    let s = 0;
    for (const t of q) {
      const f = tf.get(t);
      if (!f) continue;
      const idf = Math.log(1 + (docs.length - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avg)));
    }
    return s;
  });
  const chosen = new Set<number>();
  let used = 0;
  if (ps[0]!.length <= budgetChars / 3) {
    chosen.add(0);
    used += ps[0]!.length;
  }
  for (const i of ps.map((_, i) => i).sort((x, y) => score[y]! - score[x]! || x - y)) {
    if (chosen.has(i)) continue;
    if (used + ps[i]!.length > budgetChars) continue;
    chosen.add(i);
    used += ps[i]!.length;
  }
  const order = [...chosen].sort((x, y) => x - y);
  // Mark gaps so the model knows the text is excerpted.
  return order.map((i, k) => (k > 0 && order[k - 1] !== i - 1 ? '…\n' : '') + ps[i]).join('\n');
}
