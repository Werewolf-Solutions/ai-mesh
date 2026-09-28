/** Tiny argument parser: positionals, --flag value, --flag=value, repeated flags, --bool. */
export interface Args {
  _: string[];
  get(name: string): string | undefined;
  all(name: string): string[];
  has(name: string): boolean;
  int(name: string, def: number): number;
}

export function parseArgs(argv: string[], booleans: string[] = []): Args {
  const pos: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      let value: string;
      if (eq > 0) value = a.slice(eq + 1);
      else if (booleans.includes(name) || i + 1 >= argv.length || argv[i + 1]!.startsWith('--')) value = 'true';
      else value = argv[++i]!;
      flags.set(name, [...(flags.get(name) ?? []), value]);
    } else pos.push(a);
  }
  return {
    _: pos,
    get: (n) => flags.get(n)?.at(-1),
    all: (n) => flags.get(n) ?? [],
    has: (n) => flags.has(n) && flags.get(n)!.at(-1) !== 'false',
    int: (n, d) => {
      const v = flags.get(n)?.at(-1);
      if (v === undefined) return d;
      const x = Number(v);
      if (!Number.isInteger(x)) throw new Error(`--${n} must be an integer`);
      return x;
    },
  };
}
