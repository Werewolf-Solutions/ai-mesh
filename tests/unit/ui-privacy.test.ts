import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrivacyContext, PrivateInput, PrivateTextarea, Sensitive } from '../../apps/web/src/privacy';
import { GatewaysView } from '../../apps/web/src/components/GatewaysView';
import { NetworkView } from '../../apps/web/src/components/NetworkView';
import { NodeBadge } from '../../apps/web/src/components/Moon';
import { App } from '../../apps/web/src/App';

const requireWeb = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { createElement: h } = requireWeb('react');
const { renderToStaticMarkup } = requireWeb('react-dom/server');
const render = (component: unknown, props: unknown, hidden = true) => renderToStaticMarkup(h(PrivacyContext.Provider, { value: hidden }, h(component, props)));
const gateway = { url: 'https://private-host.example:9876', label: 'Private home node', token: 'private-client-token', adminToken: 'private-admin-token' };

afterEach(() => vi.unstubAllGlobals());

describe('stream privacy rendering', () => {
  it('omits private text, links, tooltip text and accessibility labels rather than blurring them', () => {
    const content = h('a', { href: gateway.url, title: gateway.token, 'aria-label': gateway.label }, 'Private project');
    const html = render(Sensitive, { children: content });
    expect(html).toContain('***');
    for (const secret of [gateway.url, gateway.token, gateway.label, 'Private project']) expect(html).not.toContain(secret);
    expect(render(Sensitive, { children: content }, false)).toContain('Private project');
  });

  it('masks and disables editors while preserving their actual values when privacy is off', () => {
    for (const [component, type] of [[PrivateInput, 'password'], [PrivateTextarea, undefined]]) {
      const props = { value: gateway.token, type, title: gateway.adminToken, onChange: () => {} };
      const html = render(component, props);
      expect(html).toContain('***');
      expect(html).toContain('disabled');
      expect(html).not.toContain(gateway.token);
      expect(html).not.toContain(gateway.adminToken);
      const visible = render(component, props, false);
      expect(visible).toContain(gateway.token);
      expect(visible).not.toContain('disabled');
    }
  });

  it('masks gateway addresses, custom labels and peer badge tooltips', () => {
    vi.stubGlobal('window', { location: { origin: gateway.url } });
    const html = render(GatewaysView, { gateways: [gateway], setGateways: () => {} });
    for (const secret of Object.values(gateway)) expect(html).not.toContain(secret);
    expect(render(GatewaysView, { gateways: [gateway], setGateways: () => {} }, false)).toContain(gateway.url);
    const badge = render(NodeBadge, { peerId: 'private-peer-identity', label: gateway.label });
    expect(badge).not.toContain('private-peer-identity');
    expect(badge).not.toContain(gateway.label);
  });

  it('masks network identities and opaque errors while retaining model and connection status', () => {
    const peerId = 'private-peer-identity';
    const snap = {
      status: { peerId, runtime: { ready: true, detail: '/home/private-user/model.gguf' }, worker: { active: 0, queued: 0, maxConcurrency: 1, maxQueue: 8 }, gateway: { inFlight: 0, maxInFlight: 8 }, model: { verified: true, id: 'public-model' }, uptimeMs: 1000, state: 'accepting' },
      peers: [{ peerId: 'private-remote-identity', label: gateway.label, available: true, connected: true, models: ['public-model'], consecutiveFailures: 1, lastError: 'secret-path-in-error', rttMs: 10 }],
      metrics: { counters: {}, recent: { ttftMs: [], failoverMs: [] }, memory: { rssBytes: 100 } }, at: 0,
    };
    const html = render(NetworkView, { snap, error: 'private-address-in-error', gateway });
    for (const secret of [peerId, 'private-remote-identity', gateway.label, 'private-host.example', '/home/private-user', 'secret-path-in-error', 'private-address-in-error']) expect(html).not.toContain(secret);
    expect(html).toContain('public-model');
    expect(html).toContain('Unknown');
    expect(render(NetworkView, { snap, error: null, gateway })).toContain('Connected');
  });

  it('restores the saved privacy setting on the first render and masks chat history', () => {
    const values: Record<string, unknown> = {
      'wam.streamPrivacy': true, 'wam.gateways': [gateway],
      'wam.active': 'chat',
      'wam.chats': [{ id: 'chat', title: 'Secret customer project', updatedAt: 0, messages: [{ id: 'message', role: 'user', content: 'Secret prompt with credentials', at: 0 }, { id: 'reply', role: 'assistant', content: 'Secret response', reasoning: 'Private reasoning', error: 'Sensitive error', status: 'interrupted', at: 1 }] }],
    };
    vi.stubGlobal('localStorage', { getItem: (key: string) => key in values ? JSON.stringify(values[key]) : null });
    const html = renderToStaticMarkup(h(App));
    expect(html).toContain('Stream privacy on');
    expect(html).toContain('aria-pressed="true"');
    expect(html).not.toContain(gateway.url);
    for (const secret of ['Secret customer project', 'Secret prompt with credentials', 'Secret response', 'Private reasoning', 'Sensitive error']) expect(html).not.toContain(secret);
    values['wam.streamPrivacy'] = false;
    const visible = renderToStaticMarkup(h(App));
    expect(visible).toContain('Stream privacy off');
    expect(visible).toContain('Secret prompt with credentials');
    expect(visible).toContain('Secret response');
  });
});
