// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-FLOFI-LIVE-CANVAS-WALLET-ACTIVITY-001: the wallet activity reader is read-only, bounded, verified-assets-only and honest about coverage. */
import { describe, expect, it, vi } from 'vitest';
import { JUPITER_SOLANA_MAINNET, type AssetCatalog } from '@defi-workflow-engine/action-registry';
import type { SolanaRpc } from '@defi-workflow-engine/reference-compiler';
import { ACTIVITY_READS_PER_MINUTE, activityAccount, activityGate, decodeCursor, encodeCursor, readWalletActivity, type AlchemyCall, type WalletActivityCache, type WalletActivitySeams } from './wallet-activity';
import type { cloudFlow } from './flow-runtime';
import { activityRows, mergeCoverage, signedAmount, type ActivityCoverage } from '../domain/wallet-activity';
import type { SolanaAssetCatalog } from '../domain/solana-asset-catalog';

const owner = '0x' + '1'.repeat(40), peer = '0x' + '2'.repeat(40), pool = '0x' + '3'.repeat(40);
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', WETH = '0x4200000000000000000000000000000000000006', SPAM = '0x' + '9'.repeat(40);
const h = (n: number) => '0x' + n.toString(16).padStart(64, '0');
const catalog = (): AssetCatalog => ({ assets: [
  { kind: 'NATIVE', assetClass: 'NATIVE', symbol: 'ETH', name: 'Ether', decimals: 18, address: null, logoUrl: null },
  { kind: 'ERC20', assetClass: 'STABLECOIN', symbol: 'USDC', name: 'USD Coin', decimals: 6, address: USDC, logoUrl: null },
  { kind: 'ERC20', assetClass: 'WRAPPED_NATIVE', symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, address: WETH, logoUrl: null },
], featured: [] } as unknown as AssetCatalog);
const transfer = (n: number, from: string, to: string, category: string, value: bigint, address: string | null = null, decimal = 6, at = '2026-11-17T10:00:00Z') => ({
  blockNum: '0x' + (1000 + n).toString(16), uniqueId: `${h(n)}:log:${n}`, hash: h(n), from, to, category, value: 1, asset: 'FAKE',
  rawContract: { value: '0x' + value.toString(16), address, decimal: '0x' + decimal.toString(16) }, metadata: { blockTimestamp: at } });
/** An Alchemy stand-in: incoming / outgoing lists per network, with an optional next page key. */
function alchemyOf(lists: Record<string, { IN?: unknown[]; OUT?: unknown[]; pageKey?: string }>, calls: unknown[] = []): AlchemyCall {
  return async (network, params) => {
    calls.push({ network, ...params });
    const direction = 'toAddress' in params ? 'IN' : 'OUT', list = lists[network] ?? {};
    return { transfers: list[direction] ?? [], ...list.pageKey && !params.pageKey ? { pageKey: list.pageKey } : {} };
  };
}
const cursorKey = Buffer.alloc(32, 7);
const seams = (alchemy: AlchemyCall | null, extra: Partial<WalletActivitySeams> = {}): WalletActivitySeams => ({ alchemy, cache: null, cursorKey,
  mode: async network => network === 'solana' ? 'off' : 'live', evmCatalog: async () => catalog(), now: () => new Date('2026-11-18T00:00:00Z'), ...extra });

describe('EVM wallet activity (Alchemy Transfers API on the existing key)', () => {
  it('lists incoming and outgoing ERC-20 and native movements with verified symbol, decimals, counterparty and explorer link', async () => {
    const calls: Record<string, unknown>[] = [];
    const page = await readWalletActivity({ account: owner }, {}, seams(alchemyOf({ base: {
      IN: [transfer(1, peer, owner, 'erc20', 1_000_000n, USDC)], OUT: [transfer(2, owner, peer, 'external', 10n ** 16n, null, 18, '2026-11-17T09:00:00Z')] } }, calls)));
    const base = page.transfers.filter(t => t.network === 'base');
    expect(base.map(t => [t.direction, t.kind, t.category, t.asset.symbol, t.amount, t.counterparty])).toEqual([
      ['IN', 'TRANSFER', 'TOKEN', 'USDC', '1000000', peer], ['OUT', 'TRANSFER', 'NATIVE', 'ETH', '10000000000000000', peer]]);
    expect(base[0]).toMatchObject({ transaction: h(1), explorerUrl: `https://basescan.org/tx/${h(1)}`, status: 'CONFIRMED', timestamp: '2026-11-17T10:00:00.000Z', chain: 'eip155:8453' });
    expect(signedAmount(base[0]!)).toBe('+1 USDC'); expect(signedAmount(base[1]!)).toBe('−0.01 ETH');
    // Bounded, read-only requests: one page per network and direction, newest first; "internal" only where the provider lists it (Ethereum).
    expect(calls.every(c => c.maxCount === '0x14' && c.order === 'desc' && c.excludeZeroValue === true)).toBe(true);
    expect(calls.find(c => c.network === 'ethereum')!.category).toEqual(['external', 'internal', 'erc20']);
    expect(calls.find(c => c.network === 'base')!.category).toEqual(['external', 'erc20']);
  });
  it('hides tokens outside the verified catalog or with mismatched decimals, never naming them (provider symbols are ignored)', async () => {
    const page = await readWalletActivity({ account: owner }, {}, seams(alchemyOf({ base: { IN: [transfer(1, peer, owner, 'erc20', 5n, SPAM), transfer(2, peer, owner, 'erc20', 7n, USDC, 18)] } })));
    expect(page.transfers).toEqual([]); expect(page.hidden).toBe(2);
  });
  it('a transaction that moves the wallet’s assets both ways is one interaction (a swap), a mint says so, a self-transfer is not received', async () => {
    const page = await readWalletActivity({ account: owner }, {}, seams(alchemyOf({ base: {
      IN: [transfer(5, pool, owner, 'erc20', 4n * 10n ** 15n, WETH, 18), transfer(6, '0x' + '0'.repeat(40), owner, 'erc20', 3n, USDC), transfer(7, owner, owner, 'external', 1n, null, 18)],
      OUT: [{ ...transfer(5, owner, pool, 'erc20', 10_000_000n, USDC), uniqueId: `${h(5)}:log:99` }, transfer(7, owner, owner, 'external', 1n, null, 18)] } })));
    const kinds = Object.fromEntries(page.transfers.map(t => [`${t.transaction.slice(-1)}:${t.direction}:${t.asset.symbol}`, t.kind]));
    expect(kinds).toEqual({ '5:IN:WETH': 'INTERACTION', '5:OUT:USDC': 'INTERACTION', '6:IN:USDC': 'MINT', '7:SELF:ETH': 'TRANSFER' });
    // The self-transfer is listed once.
    expect(activityRows(page.transfers, 'ALL').filter(r => r.transfer.direction === 'SELF')).toHaveLength(1);
  });
  it('states each network’s coverage: Ethereum covered, Base/Arbitrum without internal transfers, Robinhood Chain unsupported, disabled networks off', async () => {
    const page = await readWalletActivity({ account: owner }, {}, seams(alchemyOf({}), { mode: async n => n === 'arbitrum-one' ? 'off' : 'live' }));
    expect(page.coverage.map(c => [c.network, c.status, c.code])).toEqual([['ethereum', 'COVERED', null], ['base', 'PARTIAL', 'ACTIVITY_INTERNAL_TRANSFERS_NOT_LISTED'],
      ['arbitrum-one', 'OFF', null], ['robinhood', 'UNSUPPORTED', 'ACTIVITY_SOURCE_NOT_CONFIGURED']]);
  });
  it('without a configured provider key, EVM networks are unsupported — never an empty history', async () => {
    const page = await readWalletActivity({ account: owner }, {}, seams(null));
    expect(page.coverage.filter(c => c.network !== 'robinhood').every(c => c.status === 'UNSUPPORTED' && c.code === 'ACTIVITY_PROVIDER_NOT_CONFIGURED')).toBe(true);
    expect(page.transfers).toEqual([]);
  });
  it('a failing or slow network is UNAVAILABLE on its own; the others are still listed and nothing throws', async () => {
    const alchemy: AlchemyCall = async (network, params) => {
      if (network === 'ethereum') throw new Error('ACTIVITY_PROVIDER_RATE_LIMITED');
      if (network === 'arbitrum-one') return new Promise(() => undefined);
      return alchemyOf({ base: { IN: [transfer(1, peer, owner, 'erc20', 1n, USDC)] } })(network, params);
    };
    const page = await readWalletActivity({ account: owner }, {}, seams(alchemy, { budgetMs: 50 }));
    expect(page.coverage.map(c => [c.network, c.status, c.code])).toEqual([['ethereum', 'UNAVAILABLE', 'ACTIVITY_PROVIDER_RATE_LIMITED'], ['base', 'PARTIAL', 'ACTIVITY_INTERNAL_TRANSFERS_NOT_LISTED'],
      ['arbitrum-one', 'UNAVAILABLE', 'ACTIVITY_TIME_BUDGET_EXCEEDED'], ['robinhood', 'UNSUPPORTED', 'ACTIVITY_SOURCE_NOT_CONFIGURED']]);
    expect(page.transfers).toHaveLength(1);
  });
  it('paginates per network and direction with a continuation bound to the wallet; exhausted streams are not read again', async () => {
    const calls: Record<string, unknown>[] = [];
    const first = await readWalletActivity({ account: owner }, {}, seams(alchemyOf({ base: { IN: [transfer(1, peer, owner, 'erc20', 1n, USDC)], pageKey: 'page-2' } }, calls)));
    expect(first.cursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{24}$/);
    // The continuation names no wallet in clear (it travels in a header, never in a URL).
    expect(Buffer.from(first.cursor!.split('.')[0]!, 'base64url').toString()).not.toContain(owner.slice(2));
    expect(decodeCursor(first.cursor, owner, cursorKey)).toEqual({ 'ethereum:IN': null, 'ethereum:OUT': null, 'base:IN': 'page-2', 'base:OUT': 'page-2', 'arbitrum-one:IN': null, 'arbitrum-one:OUT': null });
    calls.length = 0;
    const second = await readWalletActivity({ account: owner, cursor: first.cursor }, {}, seams(alchemyOf({}, calls)));
    expect(calls.map(c => [c.network, c.pageKey])).toEqual([['base', 'page-2'], ['base', 'page-2']]);
    expect(second.cursor).toBeNull();
    // A continuation of another wallet, under another key, edited, forged or malformed, is refused before any provider read.
    expect(() => decodeCursor(first.cursor, peer, cursorKey)).toThrow('ACTIVITY_CURSOR_INVALID');
    expect(() => decodeCursor(first.cursor, owner, Buffer.alloc(32, 8))).toThrow('ACTIVITY_CURSOR_INVALID');
    const [body, mac] = first.cursor!.split('.');
    const edited = Buffer.from(JSON.stringify({ v: 2, s: { 'base:IN': 'page-99' } })).toString('base64url');
    expect(() => decodeCursor(`${edited}.${mac}`, owner, cursorKey)).toThrow('ACTIVITY_CURSOR_INVALID');
    expect(() => decodeCursor(`${body}`, owner, cursorKey)).toThrow('ACTIVITY_CURSOR_INVALID');
    expect(() => decodeCursor('not base64!', owner, cursorKey)).toThrow('ACTIVITY_CURSOR_INVALID');
    expect(() => decodeCursor(encodeCursor(owner, { 'evil:IN': 'x' }, cursorKey), owner, cursorKey)).toThrow('ACTIVITY_CURSOR_INVALID');
    await expect(readWalletActivity({ account: owner, cursor: `${edited}.${mac}` }, {}, seams(alchemyOf({}, calls)))).rejects.toThrow('ACTIVITY_CURSOR_INVALID');
  });
  it('accepts only a wallet address (no zero address, no program id); joins concurrent reads and caches briefly', async () => {
    expect(() => activityAccount('0x' + '0'.repeat(40))).toThrow(); expect(() => activityAccount('hello')).toThrow();
    expect(activityAccount(owner.toUpperCase().replace('0X', '0x'))).toEqual({ ecosystem: 'evm', address: owner });
    const alchemy = vi.fn(alchemyOf({}));
    const cache = new Map();
    const [a, b] = await Promise.all([readWalletActivity({ account: owner }, {}, seams(alchemy, { cache })), readWalletActivity({ account: owner }, {}, seams(alchemy, { cache }))]);
    expect(a).toBe(b); expect(alchemy).toHaveBeenCalledTimes(6);
  });
  it('bounds uncached reads per wallet (cached pages do not count) and stops reading a network once its time budget is spent', async () => {
    const limiter = new Map<string, number[]>(), cache = new Map();
    const alchemy = vi.fn(alchemyOf({}));
    await readWalletActivity({ account: owner }, {}, seams(alchemy, { limiter, cache }));
    for (let i = 1; i < ACTIVITY_READS_PER_MINUTE; i++) await readWalletActivity({ account: owner }, {}, seams(alchemy, { limiter }));
    // A cached page is still served; a new uncached read is refused with a closed code.
    await expect(readWalletActivity({ account: owner }, {}, seams(alchemy, { limiter, cache }))).resolves.toBeTruthy();
    await expect(readWalletActivity({ account: owner }, {}, seams(alchemy, { limiter }))).rejects.toThrow('ACTIVITY_RATE_LIMITED');
    await expect(readWalletActivity({ account: peer }, {}, seams(alchemy, { limiter }))).resolves.toBeTruthy();
    // A slow first request: once the budget ends, the network's second request is never sent.
    const slow: AlchemyCall = vi.fn(async (_network, _params, signal) => { await new Promise(r => setTimeout(r, 60)); expect(signal).toBeDefined(); return { transfers: [] }; });
    const page = await readWalletActivity({ account: owner }, {}, seams(slow, { budgetMs: 20, mode: async n => n === 'base' ? 'live' : 'off' }));
    expect(page.coverage.find(c => c.network === 'base')).toMatchObject({ status: 'UNAVAILABLE', code: 'ACTIVITY_TIME_BUDGET_EXCEEDED' });
    await new Promise(r => setTimeout(r, 100));
    expect(slow).toHaveBeenCalledTimes(1);
  });
  it('the MOCKED harness is served only outside hosted deployments and says it is test data', async () => {
    const page = await readWalletActivity({ account: owner }, { GRYLOO_WALLET_ACTIVITY_HARNESS: 'MOCKED_LOOPBACK_ONLY' }, { cache: null });
    expect(page.provenance).toBe('MOCKED');
    expect(page.transfers.map(t => t.direction)).toEqual(['IN', 'OUT', 'OUT']);
    const hosted = await readWalletActivity({ account: owner }, { GRYLOO_WALLET_ACTIVITY_HARNESS: 'MOCKED_LOOPBACK_ONLY', VERCEL: '1', VERCEL_ENV: 'production' }, seams(alchemyOf({})));
    expect(hosted.provenance).toBe('PUBLIC_MAINNET');
  });
});

describe('Solana wallet activity (the deployment’s Solana RPC)', () => {
  const wallet = 'Fq9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr', sender = 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr', usdcMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const ata = 'Hz9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr', senderAta = 'Jk9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr', spamMint = 'Spam1111111111111111111111111111111111111111';
  const sig = (c: string) => c.repeat(88);
  const solCatalog: SolanaAssetCatalog = { assets: [{ symbol: 'USDC', name: 'USD Coin', mint: usdcMint, decimals: 6, native: false, logoUrl: null }], fetchedAt: '', source: 'test', contentSha256: '', excludedRecords: 0 };
  const txs: Record<string, unknown> = {
    [sig('A')]: { slot: 30, blockTime: 1_763_000_000, meta: { err: null, fee: 5000, preBalances: [10_000_000, 0], postBalances: [5_000_000 - 5000, 5_000_000], preTokenBalances: [], postTokenBalances: [] },
      transaction: { message: { accountKeys: [{ pubkey: wallet }, { pubkey: sender }], instructions: [{ program: 'system', parsed: { type: 'transfer', info: { source: wallet, destination: sender, lamports: 5_000_000 } } }] } } },
    [sig('B')]: { slot: 40, blockTime: 1_763_000_100, meta: { err: null, fee: 5000, preBalances: [1, 1, 1, 1], postBalances: [1, 1, 1, 1],
      preTokenBalances: [{ accountIndex: 2, mint: usdcMint, owner: wallet, uiTokenAmount: { amount: '0', decimals: 6 } }, { accountIndex: 3, mint: usdcMint, owner: sender, uiTokenAmount: { amount: '9000000', decimals: 6 } }],
      postTokenBalances: [{ accountIndex: 2, mint: usdcMint, owner: wallet, uiTokenAmount: { amount: '2000000', decimals: 6 } }, { accountIndex: 3, mint: usdcMint, owner: sender, uiTokenAmount: { amount: '7000000', decimals: 6 } }] },
      transaction: { message: { accountKeys: [{ pubkey: sender }, { pubkey: 'Kk9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr' }, { pubkey: ata }, { pubkey: senderAta }],
        instructions: [{ program: 'spl-token', parsed: { type: 'transferChecked', info: { source: senderAta, destination: ata, authority: sender } } }] } } },
    [sig('C')]: { slot: 50, blockTime: 1_763_000_200, meta: { err: null, fee: 5000, preBalances: [1], postBalances: [1],
      preTokenBalances: [], postTokenBalances: [{ accountIndex: 0, mint: spamMint, owner: wallet, uiTokenAmount: { amount: '100', decimals: 0 } }] },
      transaction: { message: { accountKeys: [{ pubkey: ata }], instructions: [] } } },
    [sig('D')]: { slot: 60, blockTime: 1_763_000_300, meta: { err: { InstructionError: [0, 'Custom'] }, fee: 5000, preBalances: [5], postBalances: [0] }, transaction: { message: { accountKeys: [{ pubkey: wallet }], instructions: [] } } },
  };
  const rpc: SolanaRpc = async (method: string, params: readonly unknown[]) => {
    if (method === 'getTokenAccountsByOwner') return { value: (params[1] as { programId: string }).programId.startsWith('Tokenkeg')
      ? [{ pubkey: ata, account: { data: { parsed: { info: { mint: usdcMint, owner: wallet } } } } }, { pubkey: senderAta, account: { data: { parsed: { info: { mint: usdcMint, owner: sender } } } } }] : [] };
    if (method === 'getSignaturesForAddress') return params[0] === wallet ? [{ signature: sig('A'), slot: 30, err: null, confirmationStatus: 'finalized' }, { signature: sig('D'), slot: 60, err: {}, confirmationStatus: 'finalized' }]
      : [{ signature: sig('B'), slot: 40, err: null, confirmationStatus: 'confirmed' }, { signature: sig('C'), slot: 50, err: null, confirmationStatus: 'confirmed' }];
    if (method === 'getTransaction') return txs[params[0] as string] ?? null;
    throw new Error('UNEXPECTED_' + method);
  };
  it('reads native SOL (without the fee it paid) and SPL received into its token account, hides unverified mints, skips failed transactions', async () => {
    const page = await readWalletActivity({ account: wallet }, {}, { cache: null, mode: async () => 'live', solanaRpc: () => rpc, solanaCatalog: async () => solCatalog });
    expect(page.coverage).toEqual([{ network: 'solana', name: 'Solana', status: 'COVERED', code: null, covers: ['NATIVE', 'TOKEN'], missing: [] }]);
    expect(page.transfers.map(t => [t.transaction.slice(0, 1), t.direction, t.asset.symbol, t.amount, t.counterparty, t.status])).toEqual([
      ['B', 'IN', 'USDC', '2000000', sender, 'CONFIRMED'], ['A', 'OUT', 'SOL', '5000000', sender, 'FINALIZED']]);
    expect(page.hidden).toBe(1);
    expect(page.transfers[0]!.explorerUrl).toBe(`https://solscan.io/tx/${sig('B')}`);
  });
});

describe('History rows', () => {
  it('in All, a movement a FloFi record already shows is left to that record; Received and Sent mark it FloFi', async () => {
    const page = await readWalletActivity({ account: owner }, {}, seams(alchemyOf({ base: { IN: [transfer(1, peer, owner, 'erc20', 1n, USDC)], OUT: [transfer(2, owner, peer, 'erc20', 2n, USDC)] } })));
    const recorded = new Set([h(2).toUpperCase().replace('0X', '0x')].map(x => x.toLowerCase()));
    expect(activityRows(page.transfers, 'ALL', recorded).map(r => r.transfer.direction)).toEqual(['IN']);
    expect(activityRows(page.transfers, 'OUT', recorded)).toEqual([expect.objectContaining({ flofi: true })]);
    expect(activityRows(page.transfers, 'IN', recorded)).toEqual([expect.objectContaining({ flofi: false })]);
  });
});

describe('review hardening (flofi-protocol-integrations)', () => {
  it('a page is complete only down to the newest oldest-read time of streams with more history; older rows wait for the next page', async () => {
    const page = await readWalletActivity({ account: owner }, {}, seams(alchemyOf({ base: {
      IN: [transfer(1, peer, owner, 'erc20', 1n, USDC, 6, '2026-11-17T10:00:00Z'), transfer(2, peer, owner, 'erc20', 2n, USDC, 6, '2026-11-17T09:00:00Z')],
      OUT: [transfer(3, owner, peer, 'erc20', 3n, USDC, 6, '2026-11-10T09:00:00Z')], pageKey: 'more' } }), { mode: async n => n === 'base' ? 'live' : 'off' }));
    expect(page.completeAfter).toBe('2026-11-17T09:00:00.000Z');
    // The OUT row of a week earlier is held back: rows newer than it on the busier stream may not have been read yet. So is the row AT the
    // frontier: another movement of the same block may sit on the next page of its stream.
    expect(activityRows(page.transfers, 'ALL', new Set(), page.completeAfter).map(r => r.transfer.transaction)).toEqual([h(1)]);
    expect(activityRows(page.transfers, 'ALL').length).toBe(3);
  });
  it('legs of one swap that arrive on different pages are one interaction across everything loaded', () => {
    const base = { network: 'base' as const, networkName: 'Base', chain: 'eip155:8453', category: 'TOKEN' as const, counterparty: pool, transaction: h(9), explorerUrl: null,
      timestamp: '2026-11-17T10:00:00.000Z', block: '1', status: 'CONFIRMED' as const, kind: 'TRANSFER' as const };
    const legs = [{ ...base, id: 'a', direction: 'OUT' as const, asset: { symbol: 'USDC', decimals: 6, address: USDC, logo: null }, amount: '1' },
      { ...base, id: 'b', direction: 'IN' as const, asset: { symbol: 'WETH', decimals: 18, address: WETH, logo: null }, amount: '2' }];
    expect(activityRows(legs, 'ALL').map(r => r.transfer.kind)).toEqual(['INTERACTION', 'INTERACTION']);
  });
  it('the Alchemy transport: fixed host per network, key only in a Bearer header, read method only, closed codes, bounded call budget', async () => {
    const calls: [string, RequestInit][] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { calls.push([url, init]);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { transfers: [] } }), { status: 200, headers: { 'content-type': 'application/json' } }); }));
    const { alchemyTransport, ACTIVITY_ALCHEMY_CALLS_PER_MINUTE } = await import('./wallet-activity');
    const call = alchemyTransport({ GRYLOO_ALCHEMY_API_KEY: 'k'.repeat(32) })!;
    await call('arbitrum-one', { toAddress: owner });
    expect(calls[0]![0]).toBe('https://arb-mainnet.g.alchemy.com/v2'); expect(calls[0]![0]).not.toContain('kkkk');
    expect((calls[0]![1].headers as Record<string, string>).authorization).toBe(`Bearer ${'k'.repeat(32)}`);
    expect(JSON.parse(String(calls[0]![1].body))).toEqual({ jsonrpc: '2.0', id: 1, method: 'alchemy_getAssetTransfers', params: [{ toAddress: owner }] });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: 429, message: 'limit' } }), { status: 200, headers: { 'content-type': 'application/json' } })));
    await expect(call('base', {})).rejects.toThrow('ACTIVITY_PROVIDER_RATE_LIMITED');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })));
    await expect(call('base', {})).rejects.toThrow('ACTIVITY_PROVIDER_INVALID');
    for (let i = 0; i < ACTIVITY_ALCHEMY_CALLS_PER_MINUTE; i++) await call('base', {}).catch(() => undefined);
    await expect(call('base', {})).rejects.toThrow('ACTIVITY_PROVIDER_BUDGET_EXCEEDED');
    expect(alchemyTransport({})).toBeNull();
    vi.unstubAllGlobals();
  });
  it('a malformed continuation from the provider is an invalid answer, never "no more history"', async () => {
    const page = await readWalletActivity({ account: owner }, {}, seams(alchemyOf({ base: { IN: [], pageKey: 'bad key with spaces' } }), { mode: async n => n === 'base' ? 'live' : 'off' }));
    expect(page.coverage.find(c => c.network === 'base')).toMatchObject({ status: 'UNAVAILABLE', code: 'ACTIVITY_PROVIDER_INVALID' });
  });
  it('Solana: failed transactions are never fetched, an unreadable one marks the network partial, a scaled Token-2022 amount is hidden', async () => {
    const wallet = 'Fq9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr', mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const sig = (c: string) => c.repeat(88), fetched: string[] = [];
    const rpc: SolanaRpc = async (method: string, params: readonly unknown[]) => {
      if (method === 'getTokenAccountsByOwner') return { value: [] };
      if (method === 'getSignaturesForAddress') return [{ signature: sig('A'), slot: 3, err: { fail: 1 } }, { signature: sig('B'), slot: 2, err: null }, { signature: sig('C'), slot: 1, err: null }];
      if (method === 'getTransaction') { fetched.push(String(params[0]).slice(0, 1));
        return params[0] === sig('B') ? null : { slot: 1, blockTime: 1, meta: { err: null, fee: 0, preBalances: [1], postBalances: [1],
          preTokenBalances: [{ accountIndex: 0, mint, owner: wallet, uiTokenAmount: { amount: '1000000', decimals: 6, uiAmountString: '2' } }],
          postTokenBalances: [{ accountIndex: 0, mint, owner: wallet, uiTokenAmount: { amount: '3000000', decimals: 6, uiAmountString: '6' } }] },
          transaction: { message: { accountKeys: [{ pubkey: wallet }], instructions: [] } } }; }
      throw new Error('UNEXPECTED_' + method);
    };
    const catalog: SolanaAssetCatalog = { assets: [{ symbol: 'USDC', name: 'USD Coin', mint, decimals: 6, native: false, logoUrl: null }], fetchedAt: '', source: 'test', contentSha256: '', excludedRecords: 0 };
    const page = await readWalletActivity({ account: wallet }, {}, { cache: null, cursorKey, mode: async () => 'live', solanaRpc: () => rpc, solanaCatalog: async () => catalog });
    expect(fetched).toEqual(['B', 'C']);
    expect(page.coverage[0]).toMatchObject({ status: 'PARTIAL', code: 'SOLANA_TRANSACTION_UNREADABLE' });
    expect(page.transfers).toEqual([]); expect(page.hidden).toBe(1);
  });
});

describe('review hardening (multi-lens)', () => {
  it('a transaction that also moved an unverified token the other way is a contract interaction, never a plain receipt (the token stays unnamed)', async () => {
    const page = await readWalletActivity({ account: owner }, {}, seams(alchemyOf({ base: {
      IN: [transfer(5, pool, owner, 'erc20', 500_000_000n, USDC)], OUT: [{ ...transfer(5, owner, pool, 'erc20', 10n ** 21n, SPAM, 18), uniqueId: `${h(5)}:log:77` }] } })));
    expect(page.transfers.map(t => [t.direction, t.asset.symbol, t.kind])).toEqual([['IN', 'USDC', 'INTERACTION']]);
    expect(page.hidden).toBe(1); expect(page.hiddenMoves).toEqual([`eip155:8453:${h(5)}:OUT:log.77`]);
    expect(JSON.stringify(page)).not.toContain(SPAM.slice(2));
    // Its hidden leg read on another page still makes the visible one an interaction across everything loaded.
    const single = await readWalletActivity({ account: owner }, {}, seams(alchemyOf({ base: { IN: [transfer(5, pool, owner, 'erc20', 500_000_000n, USDC)] } })));
    expect(single.transfers[0]!.kind).toBe('TRANSFER');
    expect(activityRows(single.transfers, 'IN', new Set(), null, page.hiddenMoves!).map(r => r.transfer.kind)).toEqual(['INTERACTION']);
  });
  it('a network gate the runtime cannot answer is unavailable (never silently off) and shares the network’s time budget', async () => {
    const hanging = await readWalletActivity({ account: owner }, {}, seams(alchemyOf({}), { budgetMs: 30, mode: async n => n === 'base' ? new Promise<never>(() => undefined) : 'off' }));
    expect(hanging.coverage.find(c => c.network === 'base')).toMatchObject({ status: 'UNAVAILABLE', code: 'ACTIVITY_TIME_BUDGET_EXCEEDED' });
    const failing = await readWalletActivity({ account: owner }, {}, seams(alchemyOf({}), { mode: async n => { if (n === 'base') throw new Error('x'); return 'off'; } }));
    expect(failing.coverage.find(c => c.network === 'base')).toMatchObject({ status: 'UNAVAILABLE', code: 'ACTIVITY_NETWORK_GATE_UNAVAILABLE' });
    const call = (result: unknown) => vi.fn(async () => result) as unknown as typeof cloudFlow;
    const signal = new AbortController().signal;
    await expect(activityGate('base', {}, signal, call({ ok: false, code: 'CLOUD_RUNTIME_UNAVAILABLE' }))).rejects.toThrow('ACTIVITY_NETWORK_GATE_UNAVAILABLE');
    await expect(activityGate('base', {}, signal, call({ ok: false, code: 'TEST_NETWORK_NOT_AVAILABLE' }))).resolves.toBe('off');
    await expect(activityGate('base', {}, signal, call({ ok: true, value: 'live' }))).resolves.toBe('live');
    await expect(activityGate('base', {}, signal, call({ ok: true, value: 'off' }))).resolves.toBe('off');
    const asked = call({ ok: true, value: 'live' });
    await activityGate('solana', {}, signal, asked);
    // One attempt per flow, abandoned with the network's budget.
    expect(asked).toHaveBeenCalledWith('jupiter-swap', 'mode', [], expect.objectContaining({ signal, maxAttempts: 1 }));
  });
  it('a read in flight is joined however long it takes; a settled one is fresh for its own lifetime', async () => {
    const cache: WalletActivityCache = new Map();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const mode = vi.fn(async () => { await gate; return 'off' as const; });
    const now = vi.spyOn(Date, 'now');
    try {
      const t0 = 1_800_000_000_000;
      now.mockReturnValue(t0);
      const first = readWalletActivity({ account: owner }, {}, seams(alchemyOf({}), { cache, mode }));
      now.mockReturnValue(t0 + 9_000);
      const second = readWalletActivity({ account: owner }, {}, seams(alchemyOf({}), { cache, mode }));
      release();
      expect(await second).toEqual(await first);
      expect(mode).toHaveBeenCalledTimes(4);
    } finally { now.mockRestore(); }
  });
  it('Solana: a page cut through a same-slot pair never skips the signature before the gap', async () => {
    const wallet = 'Fq9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr', ata = 'Hz9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr', mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const sig = (c: string) => c.repeat(88);
    // The wallet: eight newer signatures, then X and Y in the same slot (X newer). Its token account lists Y too, earlier in its own list.
    const walletList = [...'abcdefgh'].map((c, i) => ({ signature: sig(c), slot: 100 - i, err: null })).concat([{ signature: sig('X'), slot: 50, err: null }, { signature: sig('Y'), slot: 50, err: null }]);
    const ataList = [...'pqr'].map((c, i) => ({ signature: sig(c), slot: 99 - i, err: null })).concat([{ signature: sig('Y'), slot: 50, err: null }]);
    const rpc: SolanaRpc = async (method: string, params: readonly unknown[]) => {
      if (method === 'getTokenAccountsByOwner') return { value: (params[1] as { programId: string }).programId.startsWith('Tokenkeg') ? [{ pubkey: ata, account: { data: { parsed: { info: { mint, owner: wallet } } } } }] : [] };
      if (method === 'getSignaturesForAddress') {
        const list = params[0] === wallet ? walletList : ataList, options = params[1] as { before?: string; limit: number };
        return list.slice(options.before ? list.findIndex(item => item.signature === options.before) + 1 : 0).slice(0, options.limit);
      }
      if (method === 'getTransaction') {
        const received = params[0] === sig('X') ? 7n : 0n;
        return { slot: 50, blockTime: 1, meta: { err: null, fee: 0, preBalances: [1, 0], postBalances: [1, Number(received)], preTokenBalances: [], postTokenBalances: [] },
          transaction: { message: { accountKeys: [{ pubkey: 'Kk9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr' }, { pubkey: wallet }], instructions: [] } } };
      }
      throw new Error('UNEXPECTED_' + method);
    };
    const catalog: SolanaAssetCatalog = { assets: [{ symbol: 'USDC', name: 'USD Coin', mint, decimals: 6, native: false, logoUrl: null }], fetchedAt: '', source: 'test', contentSha256: '', excludedRecords: 0 };
    const read = (cursor: string | null) => readWalletActivity({ account: wallet, cursor }, {}, { cache: null, cursorKey, mode: async () => 'live', solanaRpc: () => rpc, solanaCatalog: async () => catalog });
    const first = await read(null);
    expect(first.transfers.some(t => t.transaction === sig('X'))).toBe(false);
    // The wallet's stream continues after the last signature before the gap (h), so X is read again — never after Y.
    expect(decodeCursor(first.cursor, wallet, cursorKey)![`solana:${wallet}`]).toBe(sig('h'));
    const second = await read(first.cursor);
    expect(second.transfers.filter(t => t.transaction === sig('X')).map(t => [t.direction, t.amount])).toEqual([['IN', '7']]);
  });
});

describe('review hardening (fix verification)', () => {
  const wallet = 'Fq9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr', ata = 'Hz9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr', mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const spamMint = 'Spam1111111111111111111111111111111111111111';
  const sig = (c: string) => c.repeat(88);
  const catalog: SolanaAssetCatalog = { assets: [{ symbol: 'USDC', name: 'USD Coin', mint, decimals: 6, native: false, logoUrl: null }], fetchedAt: '', source: 'test', contentSha256: '', excludedRecords: 0 };
  type Item = { signature: string; slot: number; err: null; blockTime?: number | null };
  /** A paged Solana stand-in: per-address signature lists honouring `before`; `spam` signatures received one unverified token. */
  const solana = (walletList: Item[], ataList: Item[], spam: readonly string[] = []): SolanaRpc => async (method: string, params: readonly unknown[]) => {
    if (method === 'getTokenAccountsByOwner') return { value: (params[1] as { programId: string }).programId.startsWith('Tokenkeg') ? [{ pubkey: ata, account: { data: { parsed: { info: { mint, owner: wallet } } } } }] : [] };
    if (method === 'getSignaturesForAddress') {
      const list = params[0] === wallet ? walletList : ataList, options = params[1] as { before?: string; limit: number };
      return list.slice(options.before ? list.findIndex(item => item.signature === options.before) + 1 : 0).slice(0, options.limit);
    }
    if (method === 'getTransaction') return { slot: 1, blockTime: 1, meta: { err: null, fee: 0, preBalances: [1, 0], postBalances: [1, 0],
      preTokenBalances: [], postTokenBalances: spam.includes(params[0] as string) ? [{ accountIndex: 1, mint: spamMint, owner: wallet, uiTokenAmount: { amount: '5', decimals: 0 } }] : [] },
      transaction: { message: { accountKeys: [{ pubkey: 'Kk9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr' }, { pubkey: wallet }], instructions: [] } } };
    throw new Error('UNEXPECTED_' + method);
  };
  const read = (rpc: SolanaRpc, cursor: string | null = null) => readWalletActivity({ account: wallet, cursor }, {}, { cache: null, cursorKey, mode: async () => 'live', solanaRpc: () => rpc, solanaCatalog: async () => catalog });
  it('a hidden movement read again on a later page is one movement (its key repeats; the History counts unique keys)', async () => {
    const walletList = [...'abcdefgh'].map((c, i) => ({ signature: sig(c), slot: 100 - i, err: null })).concat([{ signature: sig('X'), slot: 50, err: null }, { signature: sig('Y'), slot: 50, err: null }]);
    const ataList = [...'pqr'].map((c, i) => ({ signature: sig(c), slot: 99 - i, err: null })).concat([{ signature: sig('Y'), slot: 50, err: null }]);
    const rpc = solana(walletList, ataList, [sig('Y')]);
    const first = await read(rpc), second = await read(rpc, first.cursor);
    // Y was on the first page and is read again after the gap: the same key, never a second movement.
    expect(first.hiddenMoves).toEqual([`${JUPITER_SOLANA_MAINNET.chain}:${sig('Y')}:IN:0`]);
    expect(second.hiddenMoves).toEqual(first.hiddenMoves);
    expect(new Set([...first.hiddenMoves, ...second.hiddenMoves]).size).toBe(1);
  });
  it('a signature without a block time never drops its address from the frontier; a row at the frontier waits', async () => {
    const t = (slot: number) => 1_763_000_000 + slot;
    // The wallet has more history; its oldest read signature has no block time: the nearest newer one bounds the page.
    const walletList: Item[] = Array.from({ length: 11 }, (_, i) => ({ signature: sig('abcdefghijk'[i]!), slot: 100 - i, err: null, blockTime: i === 9 ? null : t(100 - i) }));
    const ataList: Item[] = [{ signature: sig('p'), slot: 60, err: null, blockTime: t(60) }, { signature: sig('q'), slot: 59, err: null, blockTime: t(59) }];
    const page = await read(solana(walletList, ataList));
    expect(page.cursor).not.toBeNull();
    expect(page.completeAfter).toBe(new Date(t(92) * 1000).toISOString());
    // Without times at all, the address holds the whole page back rather than letting an older row through.
    const blind = await read(solana(walletList.map(item => ({ ...item, blockTime: null })), ataList));
    expect(Date.parse(blind.completeAfter!)).toBe(8.64e15);
  });
  it('Solana is enabled when either gate flow says so, even if the other cannot answer; unknown only when none says so', async () => {
    const signal = new AbortController().signal;
    const answers = (jupiter: unknown, transfer: unknown) => vi.fn(async (flow: string) => flow === 'jupiter-swap' ? jupiter : transfer) as unknown as typeof cloudFlow;
    await expect(activityGate('solana', {}, signal, answers({ ok: true, value: 'live' }, { ok: false, code: 'CLOUD_RUNTIME_UNAVAILABLE' }))).resolves.toBe('live');
    await expect(activityGate('solana', {}, signal, answers({ ok: true, value: 'off' }, { ok: false, code: 'CLOUD_RUNTIME_UNAVAILABLE' }))).rejects.toThrow('ACTIVITY_NETWORK_GATE_UNAVAILABLE');
    await expect(activityGate('solana', {}, signal, answers({ ok: true, value: 'off' }, { ok: true, value: 'off' }))).resolves.toBe('off');
  });
  it('coverage across pages: a later read clears "could not be loaded", but never erases an earlier page’s partial gap', () => {
    const c = (network: ActivityCoverage['network'], status: ActivityCoverage['status'], code: string | null = null): ActivityCoverage => ({ network, name: network, status, code, covers: [], missing: [] });
    let state = mergeCoverage(null, [c('solana', 'PARTIAL', 'SOLANA_TRANSACTION_UNREADABLE')]);
    state = mergeCoverage(state, [c('solana', 'UNAVAILABLE', 'ACTIVITY_TIME_BUDGET_EXCEEDED')]);
    state = mergeCoverage(state, [c('solana', 'COVERED')]);
    expect(state.current.map(x => x.status)).toEqual(['COVERED']);
    expect(state.gaps.map(x => x.code)).toEqual(['SOLANA_TRANSACTION_UNREADABLE']);
    const evm = mergeCoverage(mergeCoverage(null, [c('base', 'UNAVAILABLE'), c('robinhood', 'UNSUPPORTED')]), [c('base', 'PARTIAL', 'ACTIVITY_INTERNAL_TRANSFERS_NOT_LISTED'), c('robinhood', 'UNSUPPORTED')]);
    expect(evm.current.map(x => x.status)).toEqual(['PARTIAL', 'UNSUPPORTED']);
    expect(evm.gaps.map(x => x.code)).toEqual(['ACTIVITY_INTERNAL_TRANSFERS_NOT_LISTED']);
  });
});

