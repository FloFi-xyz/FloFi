// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { bridgeRpcUrls, failoverReadRpc } from './bridge-read-rpc';

it('uses an independent configured path when A is unavailable and B succeeds; every path is chain bound', async () => {
  const a = vi.fn(async () => { throw Error('PUBLIC_RPC_UNAVAILABLE'); });
  const b = vi.fn(async (method: string) => method === 'eth_chainId' ? '0x2105' : '0x61');
  const rpc = failoverReadRpc([a, b], 8453);
  expect(await rpc('eth_getTransactionCount', ['owner', 'latest'])).toBe('0x61');
  expect(b.mock.calls.map(c => c[0])).toEqual(['eth_chainId', 'eth_getTransactionCount']);
  expect([...a.mock.calls, ...b.mock.calls].every(c => !/send|sign/i.test(String(c[0])))).toBe(true);
});
it('bounds total failure and can recover on a later observation without a permanent circuit lock', async () => {
  let down = true;
  const provider = vi.fn(async () => { if (down) throw Error('PUBLIC_RPC_UNAVAILABLE'); return '0x2105'; });
  const rpc = failoverReadRpc([provider, provider], 8453);
  for (let i = 0; i < 3; i++) await expect(rpc('eth_chainId', [])).rejects.toThrow('PUBLIC_RPC_UNAVAILABLE');
  expect(provider).toHaveBeenCalledTimes(6);
  down = false;
  expect(await rpc('eth_chainId', [])).toBe('0x2105');
});
it('uses an archive-capable path for pruned state, preserving the exact historical block and call', async () => {
  const call = [{ to: '0x' + '1'.repeat(40), data: '0x70a08231' }, '0x32bd7fd'];
  const unavailable = vi.fn(async (method: string) => { if (method === 'eth_chainId') return '0x2105'; throw Error('PUBLIC_RPC_HISTORY_UNAVAILABLE'); });
  const archive = vi.fn(async (method: string) => method === 'eth_chainId' ? '0x2105' : '0x0f1726');
  expect(await failoverReadRpc([unavailable, archive], 8453)('eth_call', call)).toBe('0x0f1726');
  expect(archive.mock.calls).toContainEqual(['eth_call', call]);
});
it.each(['PUBLIC_RPC_RESPONSE_INVALID', 'WRONG_PROVIDER_CHAIN'])('never masks a definitive provider/chain failure: %s', async error => {
  const fallback = vi.fn(async () => '0x2105');
  const rpc = failoverReadRpc([async () => { throw Error(error); }, fallback], 8453);
  await expect(rpc('eth_chainId', [])).rejects.toThrow(error);
  expect(fallback).not.toHaveBeenCalled();
});
it('rejects a wrong-chain fallback before any balance or receipt read', async () => {
  const wrong = vi.fn(async () => '0x1');
  const rpc = failoverReadRpc([async () => { throw Error('PUBLIC_RPC_UNAVAILABLE'); }, wrong], 8453);
  await expect(rpc('eth_getTransactionReceipt', ['hash'])).rejects.toThrow('WRONG_PROVIDER_CHAIN');
  expect(wrong.mock.calls).toEqual([['eth_chainId', []]]);
});
it('uses existing server-side provider credentials and validates bounded HTTPS fallbacks without exposing them', () => {
  const urls = bridgeRpcUrls(8453, 'https://mainnet.base.org', { GRYLOO_ALCHEMY_API_KEY: 'fixture', GRYLOO_BASE_FALLBACK_RPC_URLS: 'https://base-rpc.publicnode.com' });
  expect(urls).toHaveLength(3);
  expect(urls[2]).toBe('https://base-mainnet.g.alchemy.com/v2/fixture');
  for (const invalid of ['http://unsafe', 'https://user:pass@example.com', 'https://example.com/#key', 'invalid'])
    expect(() => bridgeRpcUrls(8453, invalid, {})).toThrow('ROUTER_RPC_CONFIGURATION_INVALID');
});
