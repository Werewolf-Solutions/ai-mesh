/**
 * ROUGE-L (longest common subsequence) between a candidate and a reference.
 * Model-free and deterministic: it measures shared wording in order, so a
 * correct paraphrase with different words scores low. Use together with the
 * embedding similarity, which measures meaning.
 */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function lcs(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  let cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length]!;
}

/** ROUGE-L F1 in [0, 1]. */
export function rougeL(candidate: string, reference: string): { precision: number; recall: number; f1: number } {
  const c = words(candidate);
  const r = words(reference);
  const l = lcs(c, r);
  if (l === 0) return { precision: 0, recall: 0, f1: 0 };
  const precision = l / c.length;
  const recall = l / r.length;
  return { precision, recall, f1: (2 * precision * recall) / (precision + recall) };
}
