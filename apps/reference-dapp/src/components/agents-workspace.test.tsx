// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Post-#254 hotfix (Agents page): "Connected" appears only for an assistant with a live connection of this browser's FloFi connection account, as
 * the existing Connections infrastructure reports it (`assistantConnections`); otherwise, or when it cannot answer, each assistant offers Connect.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HookHarness } from '../test-utils/hook-harness';

vi.mock('react', async original => ({ ...await original<typeof import('react')>(), ...(await import('../test-utils/hook-harness')).hookMocks }));
const f = vi.hoisted(() => ({ answer: null as unknown, calls: 0 }));
vi.mock('../app/connections-action', () => ({ assistantConnections: async () => { f.calls++; if (f.answer instanceof Error) throw f.answer; return f.answer; } }));
const { SecondaryProductWorkspace } = await import('./secondary-product-workspace');

let host: HookHarness;
const read = () => host.render(() => renderToStaticMarkup(createElement(SecondaryProductWorkspace, { workspace: 'agents' })));
async function settle() { let html = ''; for (let i = 0; i < 10; i++) { await new Promise(resolve => setTimeout(resolve, 0)); html = read(); } return html; }
beforeEach(() => { host = new HookHarness(); f.calls = 0; });
afterEach(() => host.unmount());

describe('post-#254 hotfix: Agents shows Connected only for a live connection', () => {
  it('marks the connected assistant Connected (with Manage, the existing Connections page) and keeps Connect for the other', async () => {
    f.answer = { ok: true, value: { endpoint: 'https://flofi.xyz/api/mcp', connected: ['Claude'] } };
    read(); const html = await settle();
    expect(f.calls).toBe(1);
    expect(html.match(/Connected to FloFi/g)).toHaveLength(1);
    expect(html).toContain('<a class="ux-button" href="/connections">Manage</a>');
    expect(html).not.toContain('aria-label="Connect Claude"');
    expect(html).toContain('aria-label="Connect ChatGPT"');
  });

  it.each([['no connection', { ok: true, value: { endpoint: 'https://flofi.xyz/api/mcp', connected: [] } }],
    ['a refusal (no FloFi connection account or MCP OAuth off)', { ok: false, code: 'MCP_OAUTH_NOT_ENABLED' }],
    ['a failed request', new Error('NETWORK')]])('assumes nothing after %s: both assistants offer Connect', async (_case, answer) => {
    f.answer = answer;
    read(); const html = await settle();
    expect(html).not.toContain('Connected to FloFi');
    for (const provider of ['Claude', 'ChatGPT']) expect(html).toContain(`aria-label="Connect ${provider}"`);
  });
});
