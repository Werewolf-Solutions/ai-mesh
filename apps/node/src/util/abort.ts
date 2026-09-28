import { MeshError } from '@werewolf-mesh/protocol';

/** An AbortController that also aborts when any parent signal aborts. */
export function linkedController(...parents: Array<AbortSignal | undefined>): AbortController {
  const ctl = new AbortController();
  for (const p of parents) {
    if (!p) continue;
    if (p.aborted) {
      ctl.abort(p.reason);
      break;
    }
    p.addEventListener('abort', () => ctl.abort(p.reason), { once: true, signal: ctl.signal });
  }
  return ctl;
}

/** Convert an abort reason into a MeshError (defaults to `cancelled`). */
export function abortReason(signal: AbortSignal): MeshError {
  const r = signal.reason;
  return r instanceof MeshError ? r : new MeshError('cancelled', 'cancelled');
}

/**
 * A resettable timer that aborts `ctl` with a MeshError when it fires.
 * Used for first-token, stream-idle and deadline enforcement.
 */
export class Watchdog {
  private timer: NodeJS.Timeout | undefined;
  constructor(private readonly ctl: AbortController) {}
  arm(ms: number, err: () => MeshError): void {
    this.clear();
    this.timer = setTimeout(() => this.ctl.abort(err()), Math.max(0, ms));
  }
  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

export function deadlineTimer(ctl: AbortController, ms: number): () => void {
  const t = setTimeout(() => ctl.abort(new MeshError('deadline_exceeded', `deadline of ${ms} ms exceeded`)), Math.max(0, ms));
  return () => clearTimeout(t);
}
