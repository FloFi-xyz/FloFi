// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { certifiedRouterExecution, resetCertifiedRouterExecution, routerFlowName } from './router-capability';
import type { cloudFlow } from './flow-runtime';

/** P0 Track A: the certified Router capability read that labels a Router Bridge card executable (never an authority; fail closed). */
const REMOTE = { API_BASE_URL: 'https://api.example.test' };
type Read = typeof cloudFlow;
const answer = (value: unknown): Read => vi.fn(async () => value) as unknown as Read;

describe('certifiedRouterExecution', () => {
  beforeEach(() => resetCertifiedRouterExecution());
  it('reads the pair\'s own Router flow info and caches only a successful answer for 60 s', async () => {
    let t = 1_000;
    const read = answer({ ok: true, value: { executionEnabled: true } });
    expect(await certifiedRouterExecution('arbitrum-to-base', REMOTE, { read, now: () => t })).toBe(true);
    expect(read).toHaveBeenCalledWith('crosschain-router-arbitrum-to-base', 'info', [], expect.objectContaining({ principal: null, maxAttempts: 1 }));
    t += 59_000; expect(await certifiedRouterExecution('arbitrum-to-base', REMOTE, { read, now: () => t })).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    t += 2_000; await certifiedRouterExecution('arbitrum-to-base', REMOTE, { read, now: () => t });
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('fails closed: a disabled flow, a refused read or a thrown error is "not executable"; refusals and errors are never cached', async () => {
    expect(await certifiedRouterExecution('arbitrum-to-base', REMOTE, { read: answer({ ok: true, value: { executionEnabled: false } }) })).toBe(false);
    resetCertifiedRouterExecution();
    const refused = answer({ ok: false, code: 'BETA_SESSION_REQUIRED' });
    expect(await certifiedRouterExecution('arbitrum-to-base', REMOTE, { read: refused })).toBe(false);
    expect(await certifiedRouterExecution('arbitrum-to-base', REMOTE, { read: refused })).toBe(false);
    expect(refused).toHaveBeenCalledTimes(2);
    const thrown = vi.fn(async () => { throw new Error('NETWORK'); }) as unknown as Read;
    expect(await certifiedRouterExecution('arbitrum-to-base', REMOTE, { read: thrown })).toBe(false);
    expect(await certifiedRouterExecution('arbitrum-to-base', REMOTE, { read: thrown })).toBe(false);
    expect(thrown).toHaveBeenCalledTimes(2);
  });
  it('without a remote runtime, the in-process deployment gates decide (Router off: not executable)', async () => {
    expect(await certifiedRouterExecution('arbitrum-to-base', {}, { read: answer(null) })).toBe(false);
  });
  it('never reuses another deployment configuration\'s answer, and passes the estimate\'s cancellation through', async () => {
    const yes = answer({ ok: true, value: { executionEnabled: true } }), no = answer({ ok: true, value: { executionEnabled: false } });
    expect(await certifiedRouterExecution('arbitrum-to-base', REMOTE, { read: yes })).toBe(true);
    expect(await certifiedRouterExecution('arbitrum-to-base', { API_BASE_URL: 'https://other.example.test' }, { read: no })).toBe(false);
    const signal = new AbortController().signal, read = answer({ ok: true, value: { executionEnabled: true } });
    await certifiedRouterExecution('base-to-robinhood', REMOTE, { read, signal });
    expect(read).toHaveBeenCalledWith(routerFlowName('base-to-robinhood'), 'info', [], expect.objectContaining({ signal }));
  });
});
