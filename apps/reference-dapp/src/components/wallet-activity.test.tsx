// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-LIVE-CANVAS-WALLET-ACTIVITY-001: the History's wallet activity panel never keeps a wallet's rows once FloFi refuses to read it for
 * this browser, retries exactly the request that failed, keeps every partial-coverage note of the pages it lists and counts each hidden movement
 * once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { HookHarness } from '../test-utils/hook-harness';
import type { ActivityCoverage, WalletActivityPage, WalletTransfer } from '../domain/wallet-activity';

const f = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), ...(await import('../test-utils/hook-harness')).hookMocks }));
vi.mock('../app/wallet-activity-reads', () => ({ walletActivity: (account: string, cursor: string | null) => f.read(account, cursor) }));
vi.mock('../i18n/locale', () => ({ useLocale: () => ({ language: 'EN', t: (value: string, ...args: unknown[]) => value.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)])) }) }));
vi.mock('./brand-icon', () => ({ NetworkBrandIcon: () => null, TokenBrandIcon: () => null }));
vi.mock('./dashboard/dashboard-view', () => ({ dateLabel: () => 'today' }));
vi.mock('./dashboard/dashboard-status', () => ({ StatusTag: ({ children }: { children?: ReactNode }) => children }));
const { WalletActivity } = await import('./wallet-activity');

type Props = Record<string, unknown> & { children?: ReactNode };
type Element = ReactElement<Props>;
function nodes(value: ReactNode): Element[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!isValidElement(value)) return [];
  return [value as Element, ...nodes((value as Element).props.children)];
}
const textOf = (value: ReactNode): string => Array.isArray(value) ? value.map(textOf).join('') : isValidElement(value) ? textOf((value as Element).props.children) : value == null || typeof value === 'boolean' ? '' : String(value);
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

const account = '0x' + '1'.repeat(40);
const transfer = (n: number): WalletTransfer => ({ id: `eip155:8453:${n}`, network: 'base', networkName: 'Base', chain: 'eip155:8453', direction: 'IN', kind: 'TRANSFER',
  category: 'TOKEN', asset: { symbol: 'USDC', decimals: 6, address: null, logo: null }, amount: '1000000', counterparty: null, transaction: `0x${n.toString(16).padStart(64, '0')}`,
  explorerUrl: null, timestamp: new Date(1_800_000_000_000 - n * 60_000).toISOString(), block: null, status: 'CONFIRMED' });
const coverage = (network: ActivityCoverage['network'], status: ActivityCoverage['status'], code: string | null = null): ActivityCoverage =>
  ({ network, name: network === 'solana' ? 'Solana' : 'Base', status, code, covers: [], missing: [] });
const page = (extra: Partial<WalletActivityPage> = {}): WalletActivityPage => ({ account, transfers: [transfer(1)], coverage: [coverage('base', 'PARTIAL', 'ACTIVITY_INTERNAL_TRANSFERS_NOT_LISTED')],
  cursor: null, completeAfter: null, hidden: 0, hiddenMoves: [], provenance: 'PUBLIC_MAINNET', observedAt: '', ...extra });

let host: HookHarness;
beforeEach(() => { host = new HookHarness(); f.read.mockReset(); });
afterEach(() => host.unmount());
const view = () => host.render(() => WalletActivity({ account, filter: 'ALL', recorded: new Set() }));
const rows = (tree: ReactNode) => nodes(tree).filter(e => 'transfer' in e.props).map(e => (e.props.transfer as WalletTransfer).id);
const click = async (tree: ReactNode, name: string) => {
  const button = nodes(tree).find(e => e.type === 'button' && (e.props['aria-label'] === name || textOf(e.props.children) === name));
  expect(button, name).toBeDefined();
  (button!.props.onClick as () => void)(); await flush();
};

describe('History wallet activity panel', () => {
  it('a FloFi session or access refusal clears the rows loaded earlier and says why; a temporary access check keeps them', async () => {
    f.read.mockResolvedValueOnce(page());
    view(); await flush();
    expect(rows(view())).toEqual(['eip155:8453:1']);
    f.read.mockRejectedValueOnce(new Error('BETA_UNAVAILABLE'));
    await click(view(), 'Refresh wallet activity');
    expect(rows(view())).toEqual(['eip155:8453:1']);
    f.read.mockRejectedValueOnce(new Error('BETA_SESSION_REQUIRED'));
    await click(view(), 'Refresh wallet activity');
    const tree = view();
    expect(rows(tree)).toEqual([]);
    // The gate's own reason and next step; never a claim that the wallet on screen lacks access.
    expect(textOf(tree)).toContain('Sign in again'); expect(textOf(tree)).toContain('FloFi stopped reading wallet activity for this browser.');
    expect(nodes(tree).find(e => e.type === 'a' && textOf(e.props.children) === 'Sign in')).toBeDefined();
    f.read.mockRejectedValueOnce(new Error('ACTIVITY_SIGN_IN_REQUIRED'));
    await click(tree, 'Retry');
    expect(f.read).toHaveBeenLastCalledWith(account, null);
    expect(textOf(view())).toContain('Verify this wallet above to see its activity.');
    // A wallet not linked: the Credentials step; access that ended: nothing to retry.
    f.read.mockRejectedValueOnce(new Error('BETA_WALLET_NOT_LINKED'));
    await click(view(), 'Retry');
    expect(nodes(view()).find(e => e.type === 'a' && textOf(e.props.children) === 'Open Credentials')).toBeDefined();
    f.read.mockRejectedValueOnce(new Error('BETA_ACCESS_REVOKED'));
    await click(view(), 'Retry');
    expect(textOf(view())).toContain('Flight access ended');
    expect(nodes(view()).some(e => e.type === 'button' && textOf(e.props.children) === 'Retry')).toBe(false);
  });
  it('Retry repeats exactly the request that failed: the next page after Load more, the newest after Refresh', async () => {
    f.read.mockResolvedValueOnce(page({ cursor: 'next-1' }));
    view(); await flush();
    f.read.mockRejectedValueOnce(new Error('ACTIVITY_READ_UNAVAILABLE'));
    await click(view(), 'Load more activity');
    f.read.mockResolvedValueOnce(page({ transfers: [transfer(2)], cursor: null }));
    await click(view(), 'Retry');
    expect(f.read).toHaveBeenLastCalledWith(account, 'next-1');
    expect(rows(view())).toEqual(['eip155:8453:1', 'eip155:8453:2']);
    f.read.mockRejectedValueOnce(new Error('ACTIVITY_READ_UNAVAILABLE'));
    await click(view(), 'Refresh wallet activity');
    f.read.mockResolvedValueOnce(page());
    await click(view(), 'Retry');
    expect(f.read).toHaveBeenLastCalledWith(account, null);
  });
  it('keeps every partial note of the pages listed (by its own words), clears a recovered network, and counts a hidden movement once', async () => {
    const move = 'solana:mainnet:SIG:IN:0';
    f.read.mockResolvedValueOnce(page({ coverage: [coverage('solana', 'PARTIAL', 'SOLANA_TRANSACTION_UNREADABLE'), coverage('base', 'UNAVAILABLE', 'ACTIVITY_TIME_BUDGET_EXCEEDED')],
      cursor: 'next-1', hidden: 1, hiddenMoves: [move] }));
    view(); await flush();
    let text = textOf(view());
    expect(text).toContain('Solana: some transactions could not be read right now, so their movements are not listed.');
    expect(text).toContain('Base: activity could not be loaded right now.');
    expect(text).not.toContain('Solana: ETH moved by contracts');
    f.read.mockResolvedValueOnce(page({ transfers: [transfer(3)], coverage: [coverage('solana', 'COVERED'), coverage('base', 'PARTIAL', 'ACTIVITY_INTERNAL_TRANSFERS_NOT_LISTED')],
      hidden: 1, hiddenMoves: [move] }));
    await click(view(), 'Load more activity');
    text = textOf(view());
    expect(text).toContain('Solana: some transactions could not be read right now');
    expect(text).toContain('Base: ETH moved by contracts (internal transfers) is not listed.');
    expect(text).not.toContain('Base: activity could not be loaded right now.');
    expect(text).toContain('1 movement of an unverified token is hidden.');
  });
});
