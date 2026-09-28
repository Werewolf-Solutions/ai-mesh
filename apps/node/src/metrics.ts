/** Minimal in-process counters and bounded recent-sample windows. No external metrics service. */
export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly windows = new Map<string, number[]>();

  inc(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  sample(name: string, value: number, keep = 50): void {
    const w = this.windows.get(name) ?? [];
    w.push(Math.round(value * 10) / 10);
    if (w.length > keep) w.shift();
    this.windows.set(name, w);
  }

  snapshot(): { counters: Record<string, number>; windows: Record<string, number[]> } {
    return { counters: Object.fromEntries(this.counters), windows: Object.fromEntries([...this.windows].map(([k, v]) => [k, [...v]])) };
  }
}
