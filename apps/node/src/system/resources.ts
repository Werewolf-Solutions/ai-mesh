/**
 * This computer's resources: CPU, memory, GPU, temperatures, fans, disk, and
 * what Werewolf itself uses (the node process and each llama.cpp runtime).
 *
 * Local only: served to this node's operator (GET /admin/system, ./mesh
 * resources) and never sent to peers. Everything is read from the kernel
 * (/proc, /sys/class/hwmon, /sys/class/drm) and nvidia-smi; a reading the
 * machine cannot provide is null rather than guessed. On non-Linux systems
 * only the portable parts (CPU use, memory, load, disk) are filled in.
 */
import { execFile } from 'node:child_process';
import { readdir, readFile, statfs } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { SystemView } from '@werewolf-mesh/protocol';

const run = promisify(execFile);
/** Kernel clock ticks per second for /proc/<pid>/stat (USER_HZ; 100 on every mainstream Linux build). */
const CLK_TCK = 100;

type Gpu = SystemView['gpus'][number];
type Temp = SystemView['sensors']['temps'][number];
type Fan = SystemView['sensors']['fans'][number];

export interface RuntimeProcess {
  name: string;
  pid: number | undefined;
  accel: string;
}

// ------------------------------------------------------------------ parsers (pure, unit-tested)

/** `nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit,fan.speed,clocks.gr --format=csv,noheader,nounits` */
export function parseNvidiaGpus(stdout: string): Gpu[] {
  const num = (x: string | undefined) => {
    const n = Number(x?.trim());
    return x === undefined || x.trim() === '' || /N\/A|Not Supported|\[/i.test(x) || !Number.isFinite(n) ? null : n;
  };
  return stdout
    .trim()
    .split('\n')
    .filter((l) => l.trim())
    .map((line) => {
      const f = line.split(',');
      return {
        name: f[0]?.trim() || 'NVIDIA GPU',
        vendor: 'nvidia' as const,
        utilPct: num(f[1]),
        memUsedMB: num(f[2]),
        memTotalMB: num(f[3]),
        tempC: num(f[4]),
        powerW: num(f[5]),
        powerLimitW: num(f[6]),
        fanPct: num(f[7]),
        clockMHz: num(f[8]),
      };
    });
}

/** `nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits` → pid → MiB. */
export function parseNvidiaApps(stdout: string): Map<number, number> {
  const m = new Map<number, number>();
  for (const line of stdout.trim().split('\n')) {
    const [pid, mem] = line.split(',').map((x) => Number(x.trim()));
    if (Number.isInteger(pid) && Number.isFinite(mem)) m.set(pid!, (m.get(pid!) ?? 0) + mem!);
  }
  return m;
}

/** /proc/meminfo → kB values by key. */
export function parseMeminfo(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split('\n')) {
    const m = /^(\w+(?:\(\w+\))?):\s+(\d+)/.exec(line);
    if (m) out[m[1]!] = Number(m[2]);
  }
  return out;
}

/** CPU ticks (utime + stime) from /proc/<pid>/stat. The command name may contain spaces or parentheses. */
export function parsePidStat(text: string): { ticks: number } | null {
  const rest = text.slice(text.lastIndexOf(')') + 2).split(' ');
  // rest[0] is field 3 (state); utime/stime are fields 14/15.
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  if (!Number.isFinite(utime) || !Number.isFinite(stime) || rest.length < 13) return null;
  return { ticks: utime + stime };
}

/**
 * The sensor that best represents "the CPU temperature", by driver:
 * AMD k10temp/zenpower (Tctl/Tdie), Intel coretemp (Package), ARM cpu_thermal,
 * then motherboard "CPU Temperature", then ACPI.
 */
export function pickCpuTemp(temps: Temp[]): Temp | null {
  const rank = (t: Temp): number => {
    const s = t.source.toLowerCase();
    const l = t.label.toLowerCase();
    if ((s === 'k10temp' || s === 'zenpower') && /tdie/.test(l)) return 1;
    if ((s === 'k10temp' || s === 'zenpower') && /tctl/.test(l)) return 2;
    if (s === 'coretemp' && /package/.test(l)) return 1;
    if (s === 'cpu_thermal' || s === 'cpu-thermal' || s === 'soc_thermal') return 3;
    if (s === 'k10temp' || s === 'zenpower' || s === 'coretemp') return 4;
    if (/^cpu (temperature|temp)$/.test(l)) return 5;
    if (s === 'acpitz') return 6;
    return 99;
  };
  const best = [...temps].sort((a, b) => rank(a) - rank(b))[0];
  return best && rank(best) < 99 ? best : null;
}

// ------------------------------------------------------------------ readers

async function readText(p: string): Promise<string | null> {
  return readFile(p, 'utf8').then(
    (s) => s.trim(),
    () => null,
  );
}

async function readNum(p: string): Promise<number | null> {
  const s = await readText(p);
  const n = s === null ? NaN : Number(s);
  return Number.isFinite(n) ? n : null;
}

/** All temperature and fan sensors under /sys/class/hwmon (GPU drivers excluded: GPUs are reported separately). */
async function readHwmon(): Promise<{ temps: Temp[]; fans: Fan[] }> {
  const temps: Temp[] = [];
  const fans: Fan[] = [];
  let dirs: string[] = [];
  try {
    dirs = await readdir('/sys/class/hwmon');
  } catch {
    return { temps, fans };
  }
  for (const d of dirs) {
    const base = join('/sys/class/hwmon', d);
    const source = (await readText(join(base, 'name'))) ?? d;
    if (source === 'amdgpu' || source === 'nouveau' || source === 'i915' || source === 'xe') continue;
    let files: string[] = [];
    try {
      files = await readdir(base);
    } catch {
      continue;
    }
    for (const f of files) {
      const m = /^(temp|fan)(\d+)_input$/.exec(f);
      if (!m) continue;
      const v = await readNum(join(base, f));
      if (v === null) continue;
      const label = (await readText(join(base, `${m[1]}${m[2]}_label`))) ?? `${m[1] === 'temp' ? 'Temperature' : 'Fan'} ${m[2]}`;
      if (m[1] === 'temp') {
        const c = v / 1000;
        if (c > 0 && c < 150) temps.push({ source, label, c: Math.round(c * 10) / 10 });
      } else if (v > 0) {
        fans.push({ label, rpm: v });
      }
    }
  }
  // Same label from two drivers (e.g. an NVMe's three sensors): keep them, they are distinct readings.
  return { temps, fans };
}

async function readNvidia(): Promise<{ gpus: Gpu[]; apps: Map<number, number> } | null> {
  try {
    const q = await run(
      'nvidia-smi',
      ['--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit,fan.speed,clocks.gr', '--format=csv,noheader,nounits'],
      { timeout: 4000 },
    );
    const gpus = parseNvidiaGpus(q.stdout);
    const apps = await run('nvidia-smi', ['--query-compute-apps=pid,used_memory', '--format=csv,noheader,nounits'], { timeout: 4000 }).then(
      (r) => parseNvidiaApps(r.stdout),
      () => new Map<number, number>(),
    );
    return { gpus, apps };
  } catch {
    return null;
  }
}

/** AMD (amdgpu) and Intel GPUs from sysfs. AMD exposes load, VRAM, temperature, power and fan; Intel only its presence. */
async function readDrmGpus(): Promise<Gpu[]> {
  const out: Gpu[] = [];
  let cards: string[] = [];
  try {
    cards = (await readdir('/sys/class/drm')).filter((d) => /^card\d+$/.test(d));
  } catch {
    return out;
  }
  for (const c of cards) {
    const dev = `/sys/class/drm/${c}/device`;
    const vendor = await readText(`${dev}/vendor`);
    if (vendor !== '0x1002' && vendor !== '0x8086') continue;
    const empty: Gpu = { name: vendor === '0x1002' ? 'AMD GPU' : 'Intel GPU', vendor: vendor === '0x1002' ? 'amd' : 'intel', utilPct: null, memUsedMB: null, memTotalMB: null, tempC: null, powerW: null, powerLimitW: null, fanPct: null, clockMHz: null };
    if (vendor === '0x8086') {
      out.push(empty);
      continue;
    }
    const g = { ...empty };
    g.utilPct = await readNum(`${dev}/gpu_busy_percent`);
    const used = await readNum(`${dev}/mem_info_vram_used`);
    const total = await readNum(`${dev}/mem_info_vram_total`);
    g.memUsedMB = used === null ? null : Math.round(used / 2 ** 20);
    g.memTotalMB = total === null ? null : Math.round(total / 2 ** 20);
    const sclk = await readText(`${dev}/pp_dpm_sclk`);
    const cur = sclk ? /(\d+)Mhz \*/i.exec(sclk) : null;
    g.clockMHz = cur ? Number(cur[1]) : null;
    try {
      const hw = (await readdir(`${dev}/hwmon`))[0];
      if (hw) {
        const h = `${dev}/hwmon/${hw}`;
        const t = await readNum(`${h}/temp1_input`);
        g.tempC = t === null ? null : t / 1000;
        const p = (await readNum(`${h}/power1_average`)) ?? (await readNum(`${h}/power1_input`));
        g.powerW = p === null ? null : Math.round(p / 1e5) / 10;
        const cap = await readNum(`${h}/power1_cap`);
        g.powerLimitW = cap === null ? null : Math.round(cap / 1e6);
        const pwm = await readNum(`${h}/pwm1`);
        g.fanPct = pwm === null ? null : Math.round((pwm / 255) * 100);
      }
    } catch {
      /* no hwmon for this card */
    }
    out.push(g);
  }
  return out;
}

// ------------------------------------------------------------------ monitor

interface CpuSample {
  at: number;
  perThread: Array<{ busy: number; total: number }>;
}

function cpuSample(): CpuSample {
  return {
    at: Date.now(),
    perThread: os.cpus().map((c) => {
      const t = c.times;
      const total = t.user + t.nice + t.sys + t.idle + t.irq;
      return { busy: total - t.idle, total };
    }),
  };
}

const pct = (busy: number, total: number) => (total > 0 ? Math.max(0, Math.min(100, (busy / total) * 100)) : 0);
const round1 = (n: number) => Math.round(n * 10) / 10;

export class ResourceMonitor {
  private prevCpu: CpuSample | undefined;
  private prevProc = new Map<number, { ticks: number; at: number }>();
  private prevSelf: { usage: NodeJS.CpuUsage; at: number } | undefined;
  private cached: { at: number; pending: boolean; view: Promise<SystemView> } | undefined;

  constructor(
    private readonly opts: {
      /** Directory whose disk is reported (the node's data dir). */
      diskPath: string;
      /** The runtimes this node runs now (hosted models + scorer). */
      runtimes: () => RuntimeProcess[];
    },
  ) {}

  /** One reading. Readings less than a second apart share one result, so several open pages cost one scan. */
  snapshot(): Promise<SystemView> {
    const now = Date.now();
    if (this.cached && (this.cached.pending || now - this.cached.at < 900)) return this.cached.view;
    const view = this.read();
    this.cached = { at: now, pending: true, view };
    void view.then(() => {
      if (this.cached?.view === view) { this.cached.pending = false; this.cached.at = Date.now(); }
    }, () => {
      if (this.cached?.view === view) this.cached = undefined;
    });
    return view;
  }

  private async read(): Promise<SystemView> {
    // CPU use needs two samples; the first reading waits briefly for a second one.
    if (!this.prevCpu || Date.now() - this.prevCpu.at > 30_000) {
      this.prevCpu = cpuSample();
      this.prevSelf = { usage: process.cpuUsage(), at: Date.now() };
      await new Promise((r) => setTimeout(r, 250));
    }
    const cur = cpuSample();
    const prev = this.prevCpu;
    this.prevCpu = cur;
    const perThreadPct = cur.perThread.map((c, i) => {
      const p = prev.perThread[i];
      return p ? round1(pct(c.busy - p.busy, c.total - p.total)) : 0;
    });
    const busy = cur.perThread.reduce((s, c, i) => s + c.busy - (prev.perThread[i]?.busy ?? c.busy), 0);
    const total = cur.perThread.reduce((s, c, i) => s + c.total - (prev.perThread[i]?.total ?? c.total), 0);

    const linux = process.platform === 'linux';
    const [meminfo, hw, nvidia, drm, disk] = await Promise.all([
      linux ? readText('/proc/meminfo').then((t) => (t ? parseMeminfo(t) : null)) : Promise.resolve(null),
      linux ? readHwmon() : Promise.resolve({ temps: [] as Temp[], fans: [] as Fan[] }),
      readNvidia(),
      linux ? readDrmGpus() : Promise.resolve([] as Gpu[]),
      statfs(this.opts.diskPath).then(
        (s) => ({ path: this.opts.diskPath, totalMB: Math.round((s.blocks * s.bsize) / 2 ** 20), freeMB: Math.round((s.bavail * s.bsize) / 2 ** 20) }),
        () => null,
      ),
    ]);

    const totalMB = Math.round(os.totalmem() / 2 ** 20);
    const availableMB = meminfo?.MemAvailable !== undefined ? Math.round(meminfo.MemAvailable / 1024) : Math.round(os.freemem() / 2 ** 20);
    const swapTotalMB = meminfo?.SwapTotal !== undefined ? Math.round(meminfo.SwapTotal / 1024) : 0;
    const swapUsedMB = meminfo?.SwapTotal !== undefined ? Math.round((meminfo.SwapTotal - (meminfo.SwapFree ?? meminfo.SwapTotal)) / 1024) : 0;

    const cpuTemp = pickCpuTemp(hw.temps);
    const cpus = os.cpus();
    const speeds = cpus.map((c) => c.speed).filter((s) => s > 0);

    // Werewolf's own processes.
    const now = Date.now();
    const selfUsage = process.cpuUsage();
    const selfCpu = this.prevSelf ? round1(((selfUsage.user + selfUsage.system - this.prevSelf.usage.user - this.prevSelf.usage.system) / 1000 / Math.max(1, now - this.prevSelf.at)) * 100) : null;
    this.prevSelf = { usage: selfUsage, at: now };
    const seen = new Set<number>();
    const runtimes = await Promise.all(
      this.opts.runtimes().map(async (r) => {
        if (!r.pid || !linux) return { name: r.name, pid: r.pid ?? null, rssMB: null, cpuPct: null, gpuMemMB: null, accel: r.accel };
        seen.add(r.pid);
        const st = await readText(`/proc/${r.pid}/stat`).then((t) => (t ? parsePidStat(t) : null));
        const rssKB = await readText(`/proc/${r.pid}/status`).then((t) => (t ? parseMeminfo(t).VmRSS : undefined));
        let cpuPct: number | null = null;
        if (st) {
          const p = this.prevProc.get(r.pid);
          if (p && now > p.at) cpuPct = round1(((st.ticks - p.ticks) / CLK_TCK / ((now - p.at) / 1000)) * 100);
          this.prevProc.set(r.pid, { ticks: st.ticks, at: now });
        }
        return {
          name: r.name,
          pid: r.pid,
          rssMB: rssKB === undefined ? null : Math.round(rssKB / 1024),
          cpuPct,
          gpuMemMB: nvidia?.apps.get(r.pid) ?? null,
          accel: r.accel,
        };
      }),
    );
    for (const pid of this.prevProc.keys()) if (!seen.has(pid)) this.prevProc.delete(pid);

    return {
      at: now,
      platform: `${os.type()} ${os.release()} ${os.arch()}`,
      uptimeS: Math.round(os.uptime()),
      cpu: {
        model: cpus[0]?.model.trim() ?? 'unknown CPU',
        threads: cpus.length,
        usagePct: total > 0 ? round1(pct(busy, total)) : null,
        perThreadPct,
        load: os.loadavg().map(round1) as [number, number, number],
        freqMHz: speeds.length ? Math.round(speeds.reduce((a, b) => a + b, 0) / speeds.length) : null,
        tempC: cpuTemp?.c ?? null,
        tempSource: cpuTemp ? `${cpuTemp.source} ${cpuTemp.label}` : null,
      },
      memory: { totalMB, usedMB: totalMB - availableMB, availableMB, swapTotalMB, swapUsedMB },
      gpus: [...(nvidia?.gpus ?? []), ...drm],
      disk,
      sensors: hw,
      mesh: {
        node: { pid: process.pid, rssMB: Math.round(process.memoryUsage.rss() / 2 ** 20), cpuPct: selfCpu },
        runtimes,
      },
    };
  }
}
