// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-IDENTITY-RECOVERY-UX-001 (UX-02): 25% · 50% · 75% · Max — exact base-unit math rounded down, a native fee reserve, raw balances of
 * the exact asset only, no shortcut for a future output, and the structured "awaiting an amount" state of FloFi's own question.
 * Scripted model answers and fixture catalogs only: no network, no wallet, no quote, no execution.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { amountBalance, amountShortcuts, amountSource, shortcutAnswer, shortcutFigure, workflowTouches, type AmountSource } from './amount-shortcuts';
import { awaitingAmount } from './copilot-conversation';
import { CopilotSession, act, intent } from './copilot-session.test-harness';
import { registerFixtureCatalogs, resetNetworkCatalogs } from './intelligence/intelligence.test-harness';
import { setActiveNetworkScope } from './network-scope';
import type { PortfolioHolding, PortfolioNetwork, WalletPortfolio } from './wallet-portfolio';
import type { Workflow } from './initial-workflow';

beforeAll(() => registerFixtureCatalogs());
afterAll(() => resetNetworkCatalogs());
beforeEach(() => setActiveNetworkScope('PUBLIC_MAINNET'));
afterEach(() => setActiveNetworkScope(null));

const keys = (shortcuts: ReturnType<typeof amountShortcuts>) => Object.fromEntries(shortcuts.map(item => [item.key, item.amount]));
const USDC_BASE: AmountSource = { networkId: 'base', ecosystem: 'evm', chain: 'eip155:8453', symbol: 'USDC', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  decimals: 6, native: false, listed: true };
const ETH_BASE: AmountSource = { networkId: 'base', ecosystem: 'evm', chain: 'eip155:8453', symbol: 'ETH', address: null, decimals: 18, native: true, listed: true };

describe('amount shortcuts: exact integer math, rounded down', () => {
  it('writes canonical decimals the engine reads one way only', () => {
    expect(shortcutAnswer(0n, 6)).toBeNull();
    expect(shortcutAnswer(500_000n, 6)).toBe('0.5');
    expect(shortcutAnswer(10n ** 18n, 18)).toBe('1');
    expect(shortcutAnswer(1n, 18)).toBe('0.000000000000000001');
    // "1.234" could be read as 1234: the same number is written "1.2340"; with three decimals it cannot be written safely.
    expect(shortcutAnswer(1_234_000n, 6)).toBe('1.2340');
    expect(shortcutAnswer(1_234n, 3)).toBeNull();
    expect(shortcutAnswer(1_234_500n, 6)).toBe('1.2345');
    expect(shortcutAnswer(1000_234_000n, 6)).toBe('1000.234');
  });
  it('takes 25/50/75 % rounded down and Max of a token exactly', () => {
    expect(keys(amountShortcuts(100_000_001n, USDC_BASE))).toEqual({ 25: '25', 50: '50', 75: '75', MAX: '100.000001' });
    expect(keys(amountShortcuts(3n, USDC_BASE))).toEqual({ 25: null, 50: '0.000001', 75: '0.000002', MAX: '0.000003' });
    expect(keys(amountShortcuts(0n, USDC_BASE))).toEqual({ 25: null, 50: null, 75: null, MAX: null });
  });
  it('keeps at most six decimals in a percentage of an 18-decimal asset', () => {
    const weth = { ...ETH_BASE, native: false, symbol: 'WETH', address: '0x4200000000000000000000000000000000000006' };
    const shortcuts = amountShortcuts(1_123_456_789_000_000_000n, weth);
    expect(keys(shortcuts)).toEqual({ 25: '0.280864', 50: '0.561728', 75: '0.842592', MAX: '1.123456789' });
    for (const item of shortcuts) expect(item.units <= 1_123_456_789_000_000_000n).toBe(true);
  });
  it('keeps the network fee reserve out of a native Max, and offers nothing below it', () => {
    expect(keys(amountShortcuts(10n ** 18n, ETH_BASE))).toEqual({ 25: '0.25', 50: '0.5', 75: '0.75', MAX: '0.9995' });
    // 0.0004 ETH on Base is below the 0.0005 ETH reserve: no shortcut could leave enough for fees.
    expect(keys(amountShortcuts(400_000_000_000_000n, ETH_BASE))).toEqual({ 25: null, 50: null, 75: null, MAX: null });
    // 0.001 ETH: 75% would eat into the reserve, so it is capped at the spendable 0.0005.
    expect(keys(amountShortcuts(1_000_000_000_000_000n, ETH_BASE))).toEqual({ 25: '0.00025', 50: '0.0005', 75: '0.0005', MAX: '0.0005' });
    // A native coin without a known reserve has no Max.
    expect(keys(amountShortcuts(10n ** 18n, { ...ETH_BASE, chain: 'eip155:999999' })).MAX).toBeNull();
    expect(shortcutFigure(999_500_000_000_000_000n, 18, 'ETH')).toBe('0.9995 ETH');
  });
  it('shows people a figure in their language and marks a cut, never a "0" for a balance', () => {
    expect(shortcutFigure(1_234_500_000n, 6, 'USDC')).toBe('1,234.5 USDC');
    expect(shortcutFigure(1_234_500_000n, 6, 'USDC', 'PT')).toBe('1.234,5 USDC');
    expect(shortcutFigure(1_234_000n, 6, 'USDC', 'PT')).toBe('1,234 USDC');
    // An exact Max of an 18-decimal token: six decimals on the button, marked as cut; the exact figure for the accessible name.
    expect(shortcutFigure(1_123_456_789_000_000_000n, 18, 'WETH')).toBe('1.123456… WETH');
    expect(shortcutFigure(1_123_456_789_000_000_000n, 18, 'WETH', 'EN', false)).toBe('1.123456789 WETH');
    expect(shortcutFigure(1_234n, 3, 'X')).toBe('1.234 X');
    expect(shortcutFigure(0n, 6, 'USDC')).toBe('0 USDC');
  });
});

const network = (patch: Partial<PortfolioNetwork> = {}): PortfolioNetwork => ({ id: 'base', name: 'Base', chain: 'eip155:8453', chainId: 8453, ecosystem: 'evm', status: 'READ',
  provenance: 'PUBLIC_MAINNET', observedAt: '2026-11-17T12:00:00.000Z', block: '1', slot: null, tokens: 'ALL', uncheckedTokens: 0, code: null, ...patch });
const holding = (patch: Partial<PortfolioHolding> = {}): PortfolioHolding => ({ networkId: 'base', network: 'Base', chain: 'eip155:8453', symbol: 'USDC', name: 'USD Coin',
  address: USDC_BASE.address, decimals: 6, units: '2500000', displayUnits: '2500000', displayBasis: 'RAW', unavailableCode: null, native: false, provenance: 'PUBLIC_MAINNET',
  price: null, valueUsd: null, logo: null, ...patch });
const portfolio = (networks: PortfolioNetwork[], holdings: PortfolioHolding[]): WalletPortfolio => ({ format: 'flofi.wallet-portfolio.v2', observedAt: '2026-11-17T12:00:00.000Z',
  accounts: [], networks, holdings, pricedTotalUsd: null, unpricedCount: 0, unlisted: 0, priceSource: null, mocked: false });

describe('amount shortcuts: only an authoritative raw balance of the exact asset', () => {
  it('reads the raw units of the same token on the same network', () => {
    expect(amountBalance(portfolio([network()], [holding({ address: USDC_BASE.address!.toUpperCase().replace('0X', '0x') })]), USDC_BASE))
      .toEqual({ kind: 'READY', units: 2_500_000n, observedAt: '2026-11-17T12:00:00.000Z' });
  });
  it('treats a missing token as zero only when every listed token was checked', () => {
    expect(amountBalance(portfolio([network()], []), USDC_BASE)).toMatchObject({ kind: 'READY', units: 0n });
    expect(amountBalance(portfolio([network({ tokens: 'PARTIAL' })], []), USDC_BASE)).toEqual({ kind: 'UNAVAILABLE', code: 'AMOUNT_SHORTCUT_TOKEN_UNCHECKED' });
    expect(amountBalance(portfolio([network({ tokens: 'NATIVE_ONLY' })], []), ETH_BASE)).toMatchObject({ kind: 'READY', units: 0n });
  });
  it('never uses an unread network, another asset, a scaled balance or mismatched decimals', () => {
    expect(amountBalance(portfolio([network({ status: 'UNAVAILABLE', code: 'PORTFOLIO_RPC_FAILED', observedAt: null })], [holding()]), USDC_BASE))
      .toEqual({ kind: 'UNAVAILABLE', code: 'PORTFOLIO_RPC_FAILED' });
    expect(amountBalance(portfolio([], []), USDC_BASE)).toEqual({ kind: 'UNAVAILABLE', code: 'AMOUNT_SHORTCUT_NETWORK_UNREAD' });
    // Native ETH is never WETH (or any token), and the other way round.
    expect(amountBalance(portfolio([network()], [holding({ native: true, address: null, symbol: 'ETH', decimals: 18, units: '7' })]), USDC_BASE)).toMatchObject({ units: 0n });
    expect(amountBalance(portfolio([network()], [holding({ displayBasis: 'SCALED_UI_AMOUNT' })]), USDC_BASE)).toEqual({ kind: 'UNAVAILABLE', code: 'AMOUNT_SHORTCUT_BALANCE_NOT_RAW' });
    expect(amountBalance(portfolio([network()], [holding({ decimals: 18 })]), USDC_BASE)).toEqual({ kind: 'UNAVAILABLE', code: 'AMOUNT_SHORTCUT_DECIMALS_MISMATCH' });
    // Token-2022 balances the portfolio could not read (confidential, rule read failed, decimals mismatch) are never a number.
    expect(amountBalance(portfolio([network()], [holding({ displayBasis: 'RAW', displayUnits: null, unavailableCode: 'SOLANA_TOKEN_MINT_UNAVAILABLE' })]), USDC_BASE))
      .toEqual({ kind: 'UNAVAILABLE', code: 'AMOUNT_SHORTCUT_BALANCE_NOT_RAW' });
    // A token named by its contract (not one the read lists) is never shown as a zero balance.
    expect(amountBalance(portfolio([network()], []), { ...USDC_BASE, listed: false })).toEqual({ kind: 'UNAVAILABLE', code: 'AMOUNT_SHORTCUT_TOKEN_UNCHECKED' });
  });
  it('resolves one exact public-mainnet asset, never a test network, a currency or an unknown token', () => {
    expect(amountSource({ asset: 'USDC', network: 'BASE' })).toMatchObject({ networkId: 'base', chain: 'eip155:8453', decimals: 6, native: false });
    expect(amountSource({ asset: 'ETH', network: 'BASE' })).toMatchObject({ native: true, address: null, decimals: 18 });
    expect(amountSource({ asset: 'WETH', network: 'BASE' })).toMatchObject({ native: false, decimals: 18 });
    expect(amountSource({ asset: 'SOL', network: 'SOLANA' })).toMatchObject({ networkId: 'solana', ecosystem: 'solana', native: true, decimals: 9 });
    expect(amountSource({ asset: 'USDC', network: 'BASE_SEPOLIA' })).toBeNull();
    expect(amountSource({ asset: 'USD', network: 'BASE' })).toBeNull();
    expect(amountSource({ asset: 'NOTATOKEN', network: 'BASE' })).toBeNull();
  });
  it('offers nothing when a step already in the workflow spends or delivers the asset there', () => {
    const node = (asset: Record<string, unknown>) => ({ nodeId: 'n1', actionType: 'asset.swap.exact-input', inputs: [{ name: 'asset-out', kind: 'ASSET', value: asset }],
      userConstraints: [] });
    const workflow = (nodes: unknown[]) => ({ nodes }) as unknown as Workflow;
    expect(workflowTouches(workflow([]), USDC_BASE)).toBe(false);
    expect(workflowTouches(workflow([node({ chainId: 'eip155:8453', address: USDC_BASE.address, decimals: 6 })]), USDC_BASE)).toBe(true);
    expect(workflowTouches(workflow([node({ chainId: 'eip155:42161', address: USDC_BASE.address, decimals: 6 })]), USDC_BASE)).toBe(false);
    expect(workflowTouches(workflow([node({ chainId: 'eip155:8453', address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', decimals: 18 })]), ETH_BASE)).toBe(true);
  });
});

describe('the structured question a shortcut answers', () => {
  it('is FloFi\'s own amount question for one single action, with its asset and network', () => {
    const s = new CopilotSession();
    s.say('bridge eth from base to 1 usdc on arbitrum', intent.action(act.bridge({ sourceNetwork: 'BASE', destinationNetwork: 'ARBITRUM', asset: 'ETH', outputAsset: 'USDC', amount: '1' })));
    expect(awaitingAmount(s.state)).toMatchObject({ field: 'amount', action: 'BRIDGE', asset: 'ETH', network: 'BASE' });
    // A shortcut writes exactly what a typed answer writes: the same proposal (authoring only; nothing is signed or run).
    expect(s.say('0.25')).toMatchObject({ kind: 'PROPOSAL', command: { type: 'ADD_UNIVERSAL_BRIDGE', input: { amount: '0.25' } } });
    expect(awaitingAmount(s.state)).toBeNull();
  });
  it('is not open while FloFi still needs the network, or after the request ended', () => {
    const s = new CopilotSession();
    s.say('swap usdc to eth', intent.action(act.swap({ network: null, inputAsset: 'USDC', outputAsset: 'ETH', amount: null })));
    expect(awaitingAmount(s.state)).toBeNull();
  });
  it('never trusts a network or an asset only the model wrote (the planners ask for the amount before checking them)', () => {
    const s = new CopilotSession();
    s.say('swap usdc to eth', intent.action(act.swap({ network: 'BASE', inputAsset: 'USDC', outputAsset: 'ETH', amount: null })));
    expect(s.state.draft?.expected).toEqual(['amount']);
    expect(awaitingAmount(s.state)).toBeNull();
    const stated = new CopilotSession();
    stated.say('swap usdc to eth on base', intent.action(act.swap({ network: 'BASE', inputAsset: 'USDC', outputAsset: 'ETH', amount: null })));
    expect(awaitingAmount(stated.state)).toMatchObject({ action: 'SWAP', asset: 'USDC', network: 'BASE' });
  });
  it('offers no balance beside FloFi\'s "which reading?" buttons, and no Aave supply of an asset the market does not list', () => {
    const s = new CopilotSession();
    s.say('swap 1,000 usdc to eth on base', intent.action(act.swap({ network: 'BASE', inputAsset: 'USDC', outputAsset: 'ETH', amount: '1000' })));
    expect(s.state.draft?.expected).toEqual(['amount']);
    expect(s.state.draft?.shown?.length).toBeGreaterThan(0);
    expect(awaitingAmount(s.state)).toBeNull();
    const aave = new CopilotSession();
    aave.say('supply eth on aave on base', intent.action(act.lending('SUPPLY', { network: 'BASE', asset: 'ETH', amount: null })));
    expect(awaitingAmount(aave.state)).toBeNull();
  });
});
