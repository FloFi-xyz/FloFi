// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-FLOFI-LIVE-CANVAS-WALLET-ACTIVITY-001: the wallet activity reader is read-only, bounded, verified-assets-only and honest about coverage. */
import { describe, expect, it, vi } from 'vitest';
import type { AssetCatalog } from '@defi-workflow-engine/action-registry';
import type { SolanaRpc } from '@defi-workflow-engine/reference-compiler';
import { activityAccount, decodeCursor, readWalletActivity, type AlchemyCall, type WalletActivitySeams } from './wallet-activity';
import { activityRows, signedAmount } from '../domain/wallet-activity';
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
const seams = (alchemy: AlchemyCall | null, extra: Partial<WalletActivitySeams> = {}): WalletActivitySeams => ({ alchemy, cache: null,
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
    expect(first.cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(first.cursor, owner)).toEqual({ 'ethereum:IN': null, 'ethereum:OUT': null, 'base:IN': 'page-2', 'base:OUT': 'page-2', 'arbitrum-one:IN': null, 'arbitrum-one:OUT': null });
    calls.length = 0;
    const second = await readWalletActivity({ account: owner, cursor: first.cursor }, {}, seams(alchemyOf({}, calls)));
    expect(calls.map(c => [c.network, c.pageKey])).toEqual([['base', 'page-2'], ['base', 'page-2']]);
    expect(second.cursor).toBeNull();
    // A continuation of another wallet, or a forged one, is refused.
    expect(() => decodeCursor(first.cursor, peer)).toThrow('ACTIVITY_CURSOR_INVALID');
    expect(() => decodeCursor('not base64!', owner)).toThrow('ACTIVITY_CURSOR_INVALID');
    expect(() => decodeCursor(Buffer.from(JSON.stringify({ v: 1, a: owner, s: { 'evil:IN': 'x' } })).toString('base64url'), owner)).toThrow('ACTIVITY_CURSOR_INVALID');
  });
  it('accepts only a wallet address (no zero address, no program id); joins concurrent reads and caches briefly', async () => {
    expect(() => activityAccount('0x' + '0'.repeat(40))).toThrow(); expect(() => activityAccount('hello')).toThrow();
    expect(activityAccount(owner.toUpperCase().replace('0X', '0x'))).toEqual({ ecosystem: 'evm', address: owner });
    const alchemy = vi.fn(alchemyOf({}));
    const cache = new Map();
    const [a, b] = await Promise.all([readWalletActivity({ account: owner }, {}, seams(alchemy, { cache })), readWalletActivity({ account: owner }, {}, seams(alchemy, { cache }))]);
    expect(a).toBe(b); expect(alchemy).toHaveBeenCalledTimes(6);
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
