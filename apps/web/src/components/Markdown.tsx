/**
 * Minimal Markdown renderer for the project's own docs (headings, paragraphs,
 * lists, tables, bold, italic, code, links). Produces React elements only —
 * no HTML strings are injected.
 */
import type { ReactNode } from 'react';

function inline(text: string, key = 0): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|\*[^*\s][^*]*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    const k = `${key}-${i++}`;
    if (t.startsWith('**')) out.push(<strong key={k}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith('`')) out.push(<code key={k} className="rounded bg-moon-soft px-1 text-[0.9em]">{t.slice(1, -1)}</code>);
    else if (t.startsWith('[')) {
      const [, label, href] = /\[([^\]]+)\]\(([^)]+)\)/.exec(t)!;
      const external = /^https?:\/\//.test(href!);
      out.push(
        external ? (
          <a key={k} href={href} target="_blank" rel="noreferrer noopener" className="underline decoration-moon underline-offset-2">
            {label}
          </a>
        ) : (
          <span key={k} className="underline decoration-rule underline-offset-2" title={`${href} (in the repository's docs/ folder)`}>
            {label}
          </span>
        ),
      );
    } else out.push(<em key={k}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const cells = (row: string) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

export function Markdown({ source }: { source: string }) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1]!.length;
      const cls = level === 1 ? 'font-display text-3xl tracking-tight mt-2 mb-3' : level === 2 ? 'font-display text-xl mt-8 mb-2' : 'font-medium mt-6 mb-1';
      const Tag = (['h1', 'h2', 'h3', 'h4'] as const)[level - 1]!;
      blocks.push(<Tag key={k++} className={cls}>{inline(h[2]!, k)}</Tag>);
      i++;
      continue;
    }
    if (line.trim().startsWith('|') && lines[i + 1]?.trim().match(/^\|?[\s:-]+\|/)) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith('|')) rows.push(cells(lines[i++]!));
      blocks.push(
        <div key={k++} className="my-3 overflow-x-auto">
          <table className="num w-full min-w-[520px] text-left text-sm">
            <thead className="text-slate">
              <tr className="border-b border-rule">{head.map((c, j) => <th key={j} className="py-2 pr-4 font-normal">{inline(c, j)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri} className="border-b border-rule/60 align-top">
                  {r.map((c, j) => <td key={j} className="py-1.5 pr-4">{inline(c, ri * 100 + j)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]!)) {
        let item = lines[i++]!.replace(/^\s*[-*]\s+/, '');
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]!) && !/^\s*[-*]\s+/.test(lines[i]!)) item += ' ' + lines[i++]!.trim();
        items.push(item);
      }
      blocks.push(<ul key={k++} className="my-2 list-disc space-y-1 pl-5">{items.map((t, j) => <li key={j}>{inline(t, j)}</li>)}</ul>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,4}\s|\s*[-*]\s|\|)/.test(lines[i]!)) para.push(lines[i++]!.trim());
    blocks.push(<p key={k++} className="my-2 max-w-[75ch]">{inline(para.join(' '), k)}</p>);
  }
  return <div>{blocks}</div>;
}
