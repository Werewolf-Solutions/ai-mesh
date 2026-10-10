import { FarmCapabilities, FarmRef, FarmSubmit, type FarmCapabilities as Capabilities, type FarmRef as Ref, type FarmSubmit as Submit, type FarmResult, type FarmStatus } from '@werewolf-mesh/protocol';

export interface FarmJob {
  ref: Ref; targetPeerId: string; state: string; status?: FarmStatus; error?: string; result?: FarmResult;
}
const reference = (ref: Ref) => FarmRef.parse({ jobId: ref.jobId, attemptId: ref.attemptId, fence: ref.fence });
/** Explicit admin-only execution client; never fails over or replays a job. */
export class FarmClient {
  constructor(private readonly gateway: { url: string; token?: string }, private readonly fetchImpl: typeof fetch = fetch) {}
  private async call(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const response = await this.fetchImpl(`${this.gateway.url.replace(/\/$/, '')}/admin/farm${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(this.gateway.token ? { authorization: `Bearer ${this.gateway.token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: signal ?? AbortSignal.timeout(20000),
    });
    const value = await response.json() as { error?: { message?: string } };
    if (!response.ok) throw new Error(value.error?.message ?? `farm HTTP ${response.status}`);
    return value;
  }
  async discover(peerId: string, signal?: AbortSignal): Promise<Capabilities> { return FarmCapabilities.parse(await this.call(`/peers/${encodeURIComponent(peerId)}`, undefined, signal)); }
  async submit(input: Submit, signal?: AbortSignal): Promise<FarmJob> { return await this.call('/jobs', FarmSubmit.parse(input), signal) as FarmJob; }
  async status(ref: Ref, signal?: AbortSignal): Promise<FarmJob> { return await this.call('/jobs/status', reference(ref), signal) as FarmJob; }
  async cancel(ref: Ref, signal?: AbortSignal): Promise<FarmJob> { return await this.call('/jobs/cancel', reference(ref), signal) as FarmJob; }
  async acknowledge(ref: Ref, signal?: AbortSignal): Promise<FarmJob> { return await this.call('/jobs/ack', reference(ref), signal) as FarmJob; }
}
