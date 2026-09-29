/**
 * Splitting one model across machines (docs/split.md).
 *
 * llama.cpp can spread a model's layers over several "devices", where a device
 * may be another machine running `ggml-rpc-server`. The mesh adds what that
 * RPC protocol lacks:
 *
 * - LENDER: runs ggml-rpc-server bound to 127.0.0.1 only, and accepts tunnels
 *   (/werewolf-mesh/rpc/1.0.0) only from approved peers its operator listed
 *   for lending, and only over direct (not relayed) connections.
 * - BORROWER: for a model split across lenders, opens a local TCP port per
 *   lender and forwards each connection llama-server makes to it through a
 *   tunnel. llama-server is started with `--rpc 127.0.0.1:<port>,…`.
 *
 * TRUST: the RPC protocol lets the borrower allocate memory and run tensor
 * operations on the lender, with no authentication of its own. A lender must
 * trust every peer it lends to as it would trust someone with a login on
 * that machine. Lending is off by default and granted per peer.
 */
import { peerIdFromString } from '@libp2p/peer-id';
import type { Connection, Libp2p, Stream } from '@libp2p/interface';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { connect, createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { z } from 'zod';
import { freePort } from '../runtime/llamacpp.js';
import { atomicWriteJson, readJsonIfExists } from '../util/fs.js';
import type { Logger } from '../util/log.js';
import { pipeSocketStream, probeTunnel } from './tunnel.js';

export const RPC_PROTOCOL = '/werewolf-mesh/rpc/1.0.0';

const LendState = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  peers: z.array(z.string().max(128)).max(64),
  device: z.enum(['cpu', 'gpu']),
});
export type LendSettings = z.infer<typeof LendState>;

export interface LendView extends LendSettings {
  running: boolean;
  pid: number | null;
  detail: string;
  tunnels: { active: number; total: number; bytesIn: number; bytesOut: number; refused: number };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SplitLender {
  private settings: LendSettings = { version: 1, enabled: false, peers: [], device: 'cpu' };
  private child: ChildProcess | undefined;
  private port = 0;
  private detail = 'not lending';
  private stopping = false;
  private handling = false;
  private readonly stats = { active: 0, total: 0, bytesIn: 0, bytesOut: 0, refused: 0 };
  private readonly file: string;

  constructor(
    private readonly deps: {
      dataDir: string;
      libp2p: Libp2p;
      isAuthorized: (peerId: string) => boolean;
      /** ggml-rpc-server for the chosen device ('gpu' uses the node's GPU build). Null if not available. */
      binaryFor: (device: 'cpu' | 'gpu') => string | null;
      threads: number;
      log: Logger;
    },
  ) {
    this.file = join(deps.dataDir, 'split-lend.json');
  }

  async start(): Promise<void> {
    const saved = await readJsonIfExists(this.file).then((r) => (r ? LendState.parse(r) : null)).catch(() => null);
    if (saved) this.settings = saved;
    if (this.settings.enabled) await this.enable();
  }

  view(): LendView {
    return { ...this.settings, running: !!this.child, pid: this.child?.pid ?? null, detail: this.detail, tunnels: { ...this.stats } };
  }

  /** Operator changes lending (admin API / CLI). */
  async configure(next: Partial<Pick<LendSettings, 'enabled' | 'peers' | 'device'>>): Promise<LendView> {
    const peers = next.peers ? [...new Set(next.peers)] : this.settings.peers;
    for (const p of peers) {
      try {
        peerIdFromString(p);
      } catch {
        throw new Error(`not a peer ID: ${p}`);
      }
    }
    const deviceChanged = next.device !== undefined && next.device !== this.settings.device;
    this.settings = { version: 1, enabled: next.enabled ?? this.settings.enabled, peers, device: next.device ?? this.settings.device };
    await atomicWriteJson(this.file, this.settings);
    if (!this.settings.enabled) await this.disable();
    else {
      if (deviceChanged) await this.stopServer();
      await this.enable();
    }
    return this.view();
  }

  private async enable(): Promise<void> {
    if (!this.child) await this.spawnServer();
    if (!this.handling) {
      // Registered only while lending: peers learn through identify that this node lends.
      await this.deps.libp2p.handle(RPC_PROTOCOL, (s, c) => this.onTunnel(s, c), { maxInboundStreams: 32, runOnLimitedConnection: false });
      this.handling = true;
    }
  }

  private async disable(): Promise<void> {
    if (this.handling) {
      await this.deps.libp2p.unhandle(RPC_PROTOCOL);
      this.handling = false;
    }
    await this.stopServer();
    this.detail = 'not lending';
  }

  async stop(): Promise<void> {
    await this.disable();
  }

  private async spawnServer(): Promise<void> {
    const bin = this.deps.binaryFor(this.settings.device);
    if (!bin || !existsSync(bin)) {
      this.detail = this.settings.device === 'gpu' ? 'no GPU build of llama.cpp installed (./mesh gpu on)' : 'ggml-rpc-server not found in the pinned llama.cpp build';
      throw new Error(this.detail);
    }
    this.port = await freePort();
    const cache = join(this.deps.dataDir, 'rpc-cache');
    await mkdir(cache, { recursive: true, mode: 0o700 });
    const args = ['-H', '127.0.0.1', '-p', String(this.port), '-t', String(this.deps.threads), '-c'];
    const usePdeath = process.platform === 'linux' && existsSync('/usr/bin/setpriv');
    const [cmd, cmdArgs] = usePdeath ? ['/usr/bin/setpriv', ['--pdeathsig', 'KILL', '--', bin, ...args]] : [bin, args];
    this.stopping = false;
    const child = spawn(cmd, cmdArgs, {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        LD_LIBRARY_PATH: join(bin, '..'),
        // The tensor cache (-c) lives in the node's data directory.
        LLAMA_CACHE: cache,
        HOME: cache,
        ...Object.fromEntries(['XDG_RUNTIME_DIR', 'VK_ICD_FILENAMES', 'VK_DRIVER_FILES', 'CUDA_VISIBLE_DEVICES', 'GGML_VK_VISIBLE_DEVICES'].flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : []))),
      },
    });
    this.child = child;
    child.stderr!.resume();
    child.on('exit', (code, sig) => {
      if (this.child !== child) return;
      this.child = undefined;
      if (this.stopping) return;
      this.detail = `ggml-rpc-server exited (code ${code}, signal ${sig}); restarting`;
      this.deps.log.warn({ code, sig }, 'rpc server exited; restarting');
      void sleep(2000).then(() => (this.settings.enabled && !this.child ? this.spawnServer().catch(() => undefined) : undefined));
    });
    // Wait until it accepts connections.
    for (let i = 0; i < 50; i++) {
      if (await canConnect(this.port)) break;
      await sleep(100);
    }
    this.detail = `lending ${this.settings.device === 'gpu' ? 'GPU' : 'CPU'} memory to ${this.settings.peers.length} peer${this.settings.peers.length === 1 ? '' : 's'}`;
    this.deps.log.info({ port: this.port, device: this.settings.device, peers: this.settings.peers.length }, 'lending: ggml-rpc-server on loopback');
  }

  private async stopServer(): Promise<void> {
    const c = this.child;
    if (!c) return;
    this.stopping = true;
    this.child = undefined;
    c.kill('SIGTERM');
    await Promise.race([new Promise((r) => c.once('exit', r)), sleep(3000)]);
    if (c.exitCode === null) c.kill('SIGKILL');
  }

  private onTunnel(stream: Stream, conn: Connection): void {
    const peer = conn.remotePeer.toString();
    // Relayed (limited) connections are refused by the handler option; check again, and the peer rules.
    if (!this.settings.enabled || !this.deps.isAuthorized(peer) || !this.settings.peers.includes(peer) || conn.limits || !this.child) {
      this.stats.refused++;
      this.deps.log.warn({ peer, relayed: !!conn.limits }, 'refused a split tunnel');
      stream.abort(new Error('not allowed to use this node for splitting'));
      return;
    }
    const sock = connect(this.port, '127.0.0.1');
    this.stats.active++;
    this.stats.total++;
    sock.once('connect', () => this.deps.log.debug({ peer }, 'split tunnel open'));
    void pipeSocketStream(sock, stream, { preamble: 'send' }).then(({ toStream, toSocket }) => {
      this.stats.active--;
      this.stats.bytesIn += toSocket;
      this.stats.bytesOut += toStream;
    });
  }
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(port, '127.0.0.1');
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
  });
}

/** Borrower side: a loopback TCP port per lender, forwarding into tunnels. */
export class SplitTunnels {
  private readonly servers = new Map<string, { server: Server; port: number }>();
  readonly stats = { active: 0, total: 0, failed: 0 };

  constructor(private readonly deps: { libp2p: Libp2p; log: Logger }) {}

  /** Is this peer connected directly, and does it lend (announces the RPC protocol)? */
  async lends(peer: string): Promise<{ ok: boolean; reason?: string }> {
    let id;
    try {
      id = peerIdFromString(peer);
    } catch {
      return { ok: false, reason: 'not a peer ID' };
    }
    const conns = this.deps.libp2p.getConnections(id);
    if (!conns.length) return { ok: false, reason: 'not connected' };
    if (!conns.some((c) => !c.limits)) return { ok: false, reason: 'only reachable through a relay (splitting needs a direct connection)' };
    const protocols = await this.deps.libp2p.peerStore.get(id).then((p) => p.protocols, () => [] as string[]);
    if (!protocols.includes(RPC_PROTOCOL)) return { ok: false, reason: 'is not lending memory' };
    return { ok: true };
  }

  /** Loopback endpoints (host:port) for the lenders that can be used now, and why the others cannot. */
  async endpoints(peers: string[]): Promise<{ endpoints: string[]; used: string[]; missing: Array<{ peer: string; reason: string }> }> {
    const endpoints: string[] = [];
    const used: string[] = [];
    const missing: Array<{ peer: string; reason: string }> = [];
    for (const p of peers) {
      const l = await this.lends(p);
      if (!l.ok) {
        missing.push({ peer: p, reason: l.reason! });
        continue;
      }
      const allowed = await probeTunnel(() => this.deps.libp2p.dialProtocol(peerIdFromString(p), RPC_PROTOCOL, { runOnLimitedConnection: false, signal: AbortSignal.timeout(10_000) }));
      if (!allowed) {
        missing.push({ peer: p, reason: 'does not lend to this node' });
        continue;
      }
      endpoints.push(`127.0.0.1:${await this.portFor(p)}`);
      used.push(p);
    }
    return { endpoints, used, missing };
  }

  private async portFor(peer: string): Promise<number> {
    const have = this.servers.get(peer);
    if (have) return have.port;
    const server = createServer((sock) => void this.forward(peer, sock));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (server.address() as { port: number }).port;
    this.servers.set(peer, { server, port });
    return port;
  }

  private async forward(peer: string, sock: import('node:net').Socket): Promise<void> {
    sock.pause();
    let stream: Stream;
    try {
      stream = await this.deps.libp2p.dialProtocol(peerIdFromString(peer), RPC_PROTOCOL, { runOnLimitedConnection: false, signal: AbortSignal.timeout(10_000) });
    } catch (err) {
      this.stats.failed++;
      this.deps.log.warn({ peer, err: (err as Error).message }, 'could not open a split tunnel');
      sock.destroy();
      return;
    }
    this.stats.active++;
    this.stats.total++;
    // Attach the pipe's listeners first, then let the paused socket flow.
    const piped = pipeSocketStream(sock, stream, { preamble: 'expect' });
    sock.resume();
    await piped;
    this.stats.active--;
  }

  async close(): Promise<void> {
    for (const { server } of this.servers.values()) server.close();
    this.servers.clear();
  }
}
