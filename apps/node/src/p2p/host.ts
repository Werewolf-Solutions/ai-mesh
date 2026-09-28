/**
 * libp2p host: TCP transport, Noise encryption (authenticates the remote
 * peer's Ed25519 key), Yamux multiplexing, identify, ping, and circuit relay
 * v2 (client transport always; server only on nodes configured as relays).
 *
 * The connection gater enforces admission for every connection, relay
 * reservation and relayed circuit. Peers that are not in
 * authorized-peers.json cannot complete a connection at all.
 */
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { circuitRelayServer, circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { identify, identifyPush } from '@libp2p/identify';
import { FaultTolerance, type ConnectionGater, type Libp2p, type PrivateKey } from '@libp2p/interface';
import { ping } from '@libp2p/ping';
import { tcp } from '@libp2p/tcp';
import { isLinkLocal, isLoopback, isPrivate } from '@libp2p/utils';
import type { Multiaddr } from '@multiformats/multiaddr';
import { createLibp2p } from 'libp2p';
import type { NodeConfig } from '../config.js';
import { SOFTWARE_VERSION } from '../version.js';

export function buildGater(isAuthorized: (peerId: string) => boolean, onDeny: (peerId: string, where: string) => void): ConnectionGater {
  const deny = (peerId: { toString(): string }, where: string): boolean => {
    const id = peerId.toString();
    if (isAuthorized(id)) return false;
    onDeny(id, where);
    return true;
  };
  return {
    denyDialPeer: (p) => deny(p, 'dial'),
    denyInboundEncryptedConnection: (p) => deny(p, 'inbound'),
    denyOutboundEncryptedConnection: (p) => deny(p, 'outbound'),
    denyInboundRelayReservation: (p) => deny(p, 'relay-reservation'),
    denyOutboundRelayedConnection: (src, dst) => deny(src, 'relay-src') || deny(dst, 'relay-dst'),
    denyInboundRelayedConnection: (relay, remote) => deny(relay, 'via-relay') || deny(remote, 'relayed-remote'),
  };
}

export function isPublicAddr(ma: Multiaddr): boolean {
  try {
    if (ma.toString().includes('/p2p-circuit')) return true;
    return !(isPrivate(ma) || isLoopback(ma) || isLinkLocal(ma));
  } catch {
    return false;
  }
}

export async function createHost(opts: {
  cfg: NodeConfig;
  privateKey: PrivateKey;
  gater: ConnectionGater;
}): Promise<Libp2p> {
  const { cfg } = opts;
  const p2p = cfg.p2p;
  const listen = [...p2p.listen];
  // One '/p2p-circuit' listen entry == one relay reservation, filled from connected authorised relays.
  if (p2p.useRelays) for (let i = 0; i < p2p.relayReservations; i++) listen.push('/p2p-circuit');

  const services: Record<string, any> = {
    identify: identify({ runOnLimitedConnection: true }),
    // Push address changes (e.g. new relay reservations) to connected peers.
    identifyPush: identifyPush({ runOnLimitedConnection: true }),
    ping: ping({ runOnLimitedConnection: true }),
  };
  if (p2p.relayServer) {
    services.relay = circuitRelayServer({
      reservations: {
        maxReservations: 128,
        // Relayed mesh traffic is small (JSON frames) but long-lived; the default
        // 2 min / 128 KiB limit would cut off inference streams. Only authorised
        // peers can reserve (see gater).
        applyDefaultLimit: false,
      },
    });
  }

  return createLibp2p({
    privateKey: opts.privateKey,
    nodeInfo: { name: 'werewolf-mesh', version: SOFTWARE_VERSION, userAgent: `werewolf-mesh/${SOFTWARE_VERSION}` },
    addresses: {
      listen,
      announce: p2p.announce,
      announceFilter: p2p.advertisePrivateAddrs ? (addrs) => addrs : (addrs) => addrs.filter(isPublicAddr),
    },
    transports: [tcp(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    connectionGater: opts.gater,
    connectionManager: {
      maxConnections: p2p.maxConnections,
      maxIncomingPendingConnections: 16,
      dialTimeout: cfg.timeouts.connectMs,
      reconnectRetries: 0, // reconnection is handled by PeerManager with backoff + jitter
    },
    transportManager: { faultTolerance: FaultTolerance.NO_FATAL },
    services,
    start: false,
  });
}

const HOP_PROTOCOL = '/libp2p/circuit/relay/0.2.0/hop';

/**
 * Re-reserve on an authorised relay after it comes back.
 *
 * WORKAROUND for @libp2p/circuit-relay-v2 4.2.13: when a relay goes down, the
 * transport's relay search tries it while it is unreachable, gets a DialError
 * and adds it to an internal "invalid relay" filter that is not cleared when
 * the relay reconnects, so the lost reservation is never restored. When an
 * authorised peer that speaks the HOP protocol (re)connects and we hold fewer
 * reservations than configured, we remove it from that filter and request a
 * reservation. Feature-detected: if internals change, this is a logged no-op.
 * Guarded by tests/integration/relay.test.ts ("survives loss of relay ...").
 */
export function installRelayRecovery(libp2p: Libp2p, opts: { wanted: number; isAuthorized: (id: string) => boolean; log: { warn: (o: object, m: string) => void; info: (o: object, m: string) => void } }): void {
  if (opts.wanted <= 0) return;
  const store = (libp2p as any).components?.transportManager
    ?.getTransports?.()
    ?.find((t: any) => t?.reservationStore)?.reservationStore;
  if (!store || typeof store.addRelay !== 'function' || typeof store.relayFilter?.remove !== 'function') {
    opts.log.warn({}, 'relay recovery workaround unavailable (libp2p internals changed); lost relay reservations may not be restored until restart');
    return;
  }
  libp2p.addEventListener('peer:identify', (ev) => {
    const { peerId, protocols } = ev.detail;
    const id = peerId.toString();
    if (!protocols.includes(HOP_PROTOCOL) || !opts.isAuthorized(id)) return;
    if (store.hasReservation?.(peerId)) return;
    const have = typeof store.reservationCount === 'function' ? store.reservationCount() : 0;
    if (have >= opts.wanted) return;
    store.relayFilter.remove(peerId.toMultihash().bytes);
    store.addRelay(peerId, 'discovered').then(
      () => opts.log.info({ relay: id }, 'relay reservation (re)established'),
      () => undefined, // e.g. HadEnoughRelaysError or relay unreachable; retried on next identify
    );
  });
}
