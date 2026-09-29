/** Parsing of the kernel and nvidia-smi readings behind GET /admin/system. */
import { describe, expect, it } from 'vitest';
import { parseMeminfo, parseNvidiaApps, parseNvidiaGpus, parsePidStat, pickCpuTemp, ResourceMonitor } from '../../apps/node/src/system/resources.js';

describe('resource readings', () => {
  it('parses nvidia-smi GPU rows, including unsupported fields', () => {
    const g = parseNvidiaGpus('NVIDIA GeForce RTX 3060, 28, 407, 12288, 40, 22.40, 170.00, 0, 442\nTesla T4, 0, 1, 15360, 35, [N/A], 70.00, [Not Supported], 300\n');
    expect(g).toHaveLength(2);
    expect(g[0]).toMatchObject({ name: 'NVIDIA GeForce RTX 3060', utilPct: 28, memUsedMB: 407, memTotalMB: 12288, tempC: 40, powerW: 22.4, powerLimitW: 170, fanPct: 0, clockMHz: 442 });
    expect(g[1]).toMatchObject({ name: 'Tesla T4', powerW: null, fanPct: null, clockMHz: 300 });
  });

  it('sums GPU memory per process', () => {
    const m = parseNvidiaApps('30829, 5840\n31065, 100\n30829, 60\n');
    expect(m.get(30829)).toBe(5900);
    expect(m.get(31065)).toBe(100);
    expect(parseNvidiaApps('').size).toBe(0);
  });

  it('parses /proc/meminfo and /proc/<pid>/status', () => {
    const m = parseMeminfo('MemTotal:       16292148 kB\nMemAvailable:   10812776 kB\nSwapTotal: 4194300 kB\nSwapFree: 4194300 kB\nHugePages_Total:       0\nVmRSS:\t  896260 kB\n');
    expect(m).toMatchObject({ MemTotal: 16292148, MemAvailable: 10812776, SwapFree: 4194300, VmRSS: 896260 });
  });

  it('reads CPU ticks even when the command name has spaces and parentheses', () => {
    const fields = Array.from({ length: 50 }, (_, i) => String(i + 3)); // field 3 onwards
    fields[11] = '1200'; // utime (field 14)
    fields[12] = '34'; // stime (field 15)
    expect(parsePidStat(`4242 (llama (server) x) ${fields.join(' ')}`)).toEqual({ ticks: 1234 });
    expect(parsePidStat('garbage')).toBeNull();
  });

  it('picks the sensor that represents the CPU', () => {
    const t = (source: string, label: string, c = 50) => ({ source, label, c });
    expect(pickCpuTemp([t('nvme', 'Composite'), t('asus_wmi_sensors', 'CPU Temperature'), t('k10temp', 'Tccd1'), t('k10temp', 'Tctl')])).toMatchObject({ source: 'k10temp', label: 'Tctl' });
    expect(pickCpuTemp([t('coretemp', 'Core 0'), t('coretemp', 'Package id 0')])).toMatchObject({ label: 'Package id 0' });
    expect(pickCpuTemp([t('acpitz', 'Temperature 1'), t('asus_wmi_sensors', 'CPU Temperature')])).toMatchObject({ label: 'CPU Temperature' });
    expect(pickCpuTemp([t('nvme', 'Composite')])).toBeNull();
  });

  it('reads this machine: CPU use, memory and its own process', async () => {
    const m = new ResourceMonitor({ diskPath: '.', runtimes: () => [{ name: 'self', pid: process.pid, accel: 'cpu' }] });
    const v = await m.snapshot();
    expect(v.cpu.threads).toBeGreaterThan(0);
    expect(v.cpu.usagePct).toBeGreaterThanOrEqual(0);
    expect(v.cpu.perThreadPct).toHaveLength(v.cpu.threads);
    expect(v.memory.totalMB).toBeGreaterThan(v.memory.availableMB);
    expect(v.disk?.totalMB).toBeGreaterThan(0);
    expect(await m.snapshot()).toBe(v); // readings < 1 s apart are shared
    if (process.platform === 'linux') expect(v.mesh.runtimes[0]!.rssMB).toBeGreaterThan(10);
  });
});
