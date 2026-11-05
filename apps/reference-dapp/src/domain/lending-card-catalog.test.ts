// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD AAVE-V3-CARD-CATALOG-FIX-001: the lending card's own token picker. A Supply / Borrow / Repay / Withdraw card selects any registered
 * reserve of its market (by chain + address, never by symbol alone), its per-action catalog is ordered and explained by the live market read
 * without ever dropping a supported reserve, and a changed reserve is authored only through the card's reviewed proposal — carrying the exact
 * address and decimals through the workflow IR and a save/reload. MOCKED market reads only: nothing here reaches a network or a wallet.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AAVE_V3_LENDING_PROFILES } from '@defi-workflow-engine/action-registry';
import type { AaveMarketCatalog, AaveReserveStatus } from '@defi-workflow-engine/reference-compiler';
import { lintWorkflow } from '@defi-workflow-engine/reference-linter';
import { cryptoInputOf, cryptoNetworks, cryptoReviewContext, cryptoSelectionOf, createCryptoActionNode, selectCryptoNetwork, selectCryptoToken, canSelectCryptoAssets, type CryptoAction } from './crypto-action-picker';
import { hiddenCardReserves, lendingCardCatalog, lendingCardFunding, visibleCardReserves, type LendingKind } from './lending-card-catalog';
import { editorHistoryReducer, initialEditorHistory } from './editor-history';
import { editorReducer } from './editor';
import { canvasAmountCommand, actionReviewValue } from './canvas-action-setup';
import { lendingNodeAsset, lendingReservesFor } from './supply-authoring';
import { validateSavedWorkflow } from './saved-workflow';
import { stepAssets, workflowSequence } from './workflow-sequence';
import { setActiveNetworkScope } from './network-scope';
import { registerFixtureCatalogs, resetNetworkCatalogs } from './intelligence/intelligence.test-harness';
import { CopilotSession, act, intent } from './copilot-session.test-harness';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';

beforeAll(registerFixtureCatalogs);
afterAll(() => { resetNetworkCatalogs(); setActiveNetworkScope(null); });
beforeEach(() => setActiveNetworkScope('PUBLIC_MAINNET'));

const owner = '0x1111111111111111111111111111111111111111';
const LENDING: readonly LendingKind[] = ['supply', 'borrow', 'repay', 'withdraw'];
const reserve = (network: string, symbol: string) => lendingReservesFor(network).find(item => item.symbol === symbol)!;
const node = (action: CryptoAction, network: string, symbol: string, amount = '1') =>
  createCryptoActionNode('node-002', { selection: selectCryptoToken(selectCryptoNetwork(action, network), 'source', symbol), amount, slippage: '50', beneficiary: owner });

/** A MOCKED read of one market: every registry reserve listed and usable, with per-symbol overrides. */
function market(network: string, overrides: Record<string, Partial<AaveReserveStatus>> = {}, account: Partial<NonNullable<AaveMarketCatalog['account']>> | null = {}, withWallet = true): AaveMarketCatalog {
  const reserves = lendingReservesFor(network);
  return { chain: reserves[0]!.chain, network, pool: '0x0000000000000000000000000000000000000001', block: 100, blockHash: `0x${'1'.repeat(64)}`, observedAt: '2026-11-05T00:00:00.000Z',
    unlisted: [], provenance: 'MOCKED',
    ...account ? { account: { collateralBase: '10000000000', debtBase: '0', availableBorrowBase: '7000000000', healthFactor: (2n ** 256n - 1n).toString(),
      ltvBps: '7000', liquidationThresholdBps: '7500', eMode: '0', ...account } } : {},
    reserves: reserves.map(profile => ({ reserveId: profile.reserveId, asset: profile.asset, symbol: profile.symbol, decimals: profile.decimals,
      aToken: '0x0000000000000000000000000000000000000002', variableDebtToken: '0x0000000000000000000000000000000000000003', listed: true, verified: true,
      active: true, frozen: false, paused: false, borrowingEnabled: true, ltvBps: 7000, liquidationThresholdBps: 7500, collateralEligible: true, isolated: false, siloed: false,
      supplyCap: '0', borrowCap: '0', supplied: '0', borrowed: '0', availableLiquidity: (10n ** BigInt(profile.decimals + 6)).toString(), price: '100000000', priceSourceMatches: true,
      supplyApyPercent: 2.5, borrowApyPercent: 4.25, supply: { available: true, reason: null }, borrow: { available: true, reason: null }, complete: true,
      ...withWallet ? { wallet: { balance: '0', supplied: '0', debt: '0', collateralEnabled: false } } : {},
      ...overrides[profile.symbol] })) };
}
const live = (catalog: AaveMarketCatalog | null, failed = false) => ({ catalog, failed, loading: false });
const units = (network: string, symbol: string, amount: bigint) => (amount * 10n ** BigInt(reserve(network, symbol).decimals)).toString();
const wallet = (balance = '0', supplied = '0', debt = '0', collateralEnabled = false) => ({ wallet: { balance, supplied, debt, collateralEnabled } });

describe('the lending card selects any registered reserve of its market', () => {
  it.each(LENDING)('%s: every mainnet reserve round-trips chain + address + decimals through the card selection and the authored node', kind => {
    for (const network of ['Ethereum', 'Base', 'Arbitrum One']) for (const profile of lendingReservesFor(network)) {
      const selection = selectCryptoToken(selectCryptoNetwork(kind, network), 'source', profile.symbol);
      expect(selection).toEqual({ action: kind, network, from: profile.symbol });
      const authored = createCryptoActionNode('node-002', { selection, amount: '1', slippage: '50', beneficiary: owner });
      expect(authored.chainId).toBe(profile.chain);
      expect(lendingNodeAsset(authored)).toBe(profile.asset);
      const amount = authored.inputs.find(input => input.name === 'amount')!.value as { asset: { address: string; decimals: number }; amount: string };
      expect(amount.asset).toEqual({ chainId: profile.chain, address: profile.asset, decimals: profile.decimals });
      expect(amount.amount).toBe((10n ** BigInt(profile.decimals)).toString());
      expect(cryptoSelectionOf(authored)).toEqual(selection);
    }
  });
  it('a Base Supply card changes from USDC → Aave V3 to WETH → Aave V3 (WETH 0x4200…0006, 18 decimals)', () => {
    const usdc = node('supply', 'Base', 'USDC');
    expect(cryptoSelectionOf(usdc)?.from).toBe('USDC');
    const weth = node('supply', 'Base', 'WETH', '0.25');
    expect(lendingNodeAsset(weth)).toBe('0x4200000000000000000000000000000000000006');
    expect(cryptoInputOf(weth)).toMatchObject({ selection: { action: 'supply', network: 'Base', from: 'WETH' }, amount: '0.25' });
  });
  it('refuses a symbol the market does not list, the destination side, and a reserve of another network that merely shares a symbol', () => {
    const base = selectCryptoNetwork('supply', 'Base');
    expect(() => selectCryptoToken(base, 'source', 'ARB')).toThrow('ACTION_TOKEN_UNSUPPORTED');
    expect(() => selectCryptoToken(base, 'destination', 'WETH')).toThrow('ACTION_TOKEN_UNSUPPORTED');
    // USDC.e is an Arbitrum reserve only; on Arbitrum it is its own reserve, never Arbitrum's native USDC.
    expect(() => selectCryptoToken(base, 'source', 'USDC.e')).toThrow('ACTION_TOKEN_UNSUPPORTED');
    const arbitrum = selectCryptoNetwork('supply', 'Arbitrum One');
    expect(lendingNodeAsset(createCryptoActionNode('n', { selection: selectCryptoToken(arbitrum, 'source', 'USDC.e'), amount: '1', slippage: '50', beneficiary: owner })))
      .not.toBe(lendingNodeAsset(createCryptoActionNode('n', { selection: selectCryptoToken(arbitrum, 'source', 'USDC'), amount: '1', slippage: '50', beneficiary: owner })));
  });
  it('a node whose reserve is not registered on its market is never shown as the market\'s first token', () => {
    const usdc = node('supply', 'Base', 'USDC');
    const forged = JSON.parse(JSON.stringify(usdc).replaceAll('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', '0x9999999999999999999999999999999999999999')) as typeof usdc;
    expect(cryptoSelectionOf(forged)).toBeNull();
  });
  it('the three mainnet markets list different reserve sets, each identified by its own chain and address', () => {
    const markets = cryptoNetworks('supply', 'mainnet').map(profile => profile.network);
    expect(markets).toEqual(['Base', 'Arbitrum One', 'Ethereum']);
    const wethAddresses = markets.map(network => reserve(network, 'WETH').asset);
    expect(new Set(wethAddresses).size).toBe(3);
    for (const network of markets) {
      const catalog = lendingCardCatalog('supply', network, live(market(network)));
      expect(catalog.entries.map(entry => entry.address).sort()).toEqual(lendingReservesFor(network).map(item => item.asset).sort());
      expect(catalog.entries.every(entry => entry.chain === reserve(network, 'USDC').chain)).toBe(true);
    }
    // A read of another market (same symbols, other chain) never lends its state.
    const crossed = lendingCardCatalog('supply', 'Base', live({ ...market('Arbitrum One'), network: 'Base' }));
    expect(crossed.state).toBe('UNAVAILABLE');
    expect(crossed.entries.every(entry => !entry.live && entry.selectable)).toBe(true);
  });
});

describe('per-action card catalogs (MOCKED market read)', () => {
  const held = () => market('Base', {
    USDC: { ...wallet(units('Base', 'USDC', 250n), units('Base', 'USDC', 100n), '0', true) },
    WETH: { ...wallet((4n * 10n ** 17n).toString(), '0', (10n ** 16n).toString()), price: '300000000000' },
    cbBTC: { borrowingEnabled: false, borrow: { available: false, reason: 'BORROWING_DISABLED' } },
    EURC: { frozen: true, supply: { available: false, reason: 'RESERVE_FROZEN' }, borrow: { available: false, reason: 'RESERVE_FROZEN' } },
  }, { debtBase: '3000000000' });
  it('Supply prioritizes held assets by value, keeps zero balances discoverable behind the toggle and the search', () => {
    const catalog = lendingCardCatalog('supply', 'Base', live(held()));
    expect(catalog).toMatchObject({ state: 'LIVE', provenance: 'MOCKED', walletKnown: true });
    expect(catalog.entries.slice(0, 2).map(entry => [entry.symbol, entry.primary])).toEqual([['WETH', true], ['USDC', true]]);
    expect(catalog.entries).toHaveLength(lendingReservesFor('Base').length);
    const shown = visibleCardReserves(catalog, { showAll: false, query: '', selected: 'USDC' });
    expect(shown.map(entry => entry.symbol)).toEqual(['WETH', 'USDC']);
    expect(hiddenCardReserves(catalog)).toBe(lendingReservesFor('Base').length - 2);
    // Zero balance is never "unsupported": the toggle and the search reach every reserve, and a zero-balance reserve stays selectable.
    const all = visibleCardReserves(catalog, { showAll: true, query: '', selected: 'USDC' });
    expect(all).toHaveLength(lendingReservesFor('Base').length);
    const ghO = all.find(entry => entry.symbol === 'GHO')!;
    expect(ghO).toMatchObject({ selectable: true, reason: null, notes: ['NO_WALLET_BALANCE'], walletBalance: '0' });
    expect(visibleCardReserves(catalog, { showAll: false, query: 'gho', selected: 'USDC' }).map(entry => entry.symbol)).toEqual(['GHO']);
    expect(visibleCardReserves(catalog, { showAll: false, query: reserve('Base', 'cbBTC').asset.slice(0, 10), selected: 'USDC' }).map(entry => entry.symbol)).toEqual(['cbBTC']);
    // The current selection always stays visible; a frozen reserve is listed with its reason, never as usable.
    expect(visibleCardReserves(catalog, { showAll: false, query: '', selected: 'EURC' }).map(entry => entry.symbol)).toContain('EURC');
    expect(all.find(entry => entry.symbol === 'EURC')).toMatchObject({ selectable: false, reason: 'RESERVE_FROZEN' });
  });
  it('Borrow is built from borrow configuration, not supply: borrowing disabled closes an option that Supply keeps open', () => {
    const borrow = lendingCardCatalog('borrow', 'Base', live(held())), supply = lendingCardCatalog('supply', 'Base', live(held()));
    expect(borrow.entries.find(entry => entry.symbol === 'cbBTC')).toMatchObject({ selectable: false, reason: 'BORROWING_DISABLED', primary: false });
    expect(supply.entries.find(entry => entry.symbol === 'cbBTC')).toMatchObject({ selectable: true, reason: null });
    expect(borrow.entries.find(entry => entry.symbol === 'WETH')).toMatchObject({ selectable: true, primary: true, apyPercent: 4.25, debt: (10n ** 16n).toString() });
    expect(borrow.entries.map(entry => entry.symbol)).not.toEqual(supply.entries.map(entry => entry.symbol));
    // The disabled reserve stays discoverable behind the toggle.
    expect(visibleCardReserves(borrow, { showAll: false, query: '', selected: 'USDC' }).map(entry => entry.symbol)).not.toContain('cbBTC');
    expect(visibleCardReserves(borrow, { showAll: true, query: '', selected: 'USDC' }).map(entry => entry.symbol)).toContain('cbBTC');
  });
  it('Borrow explains account limits as notes (a Supply earlier in the workflow may add collateral), never as an unsupported asset', () => {
    const empty = lendingCardCatalog('borrow', 'Base', live(market('Base', {}, { collateralBase: '0', availableBorrowBase: '0' })));
    const weth = empty.entries.find(entry => entry.symbol === 'WETH')!;
    expect(weth).toMatchObject({ selectable: true, reason: null, notes: ['NO_COLLATERAL'] });
    const capped = lendingCardCatalog('borrow', 'Base', live(market('Base', {}, { availableBorrowBase: '0' })));
    expect(capped.entries.find(entry => entry.symbol === 'WETH')!.notes).toEqual(['NO_BORROW_CAPACITY']);
    const risky = lendingCardCatalog('borrow', 'Base', live(market('Base', {}, { debtBase: '1', healthFactor: (15n * 10n ** 17n).toString() })));
    expect(risky.entries.find(entry => entry.symbol === 'WETH')!.notes).toContain('HEALTH_FACTOR_BELOW_MINIMUM');
  });
  it('Repay offers only real debts; Withdraw only real supplied positions (others stay listed, closed, with their reason)', () => {
    const repay = lendingCardCatalog('repay', 'Base', live(held()));
    expect(repay.entries[0]).toMatchObject({ symbol: 'WETH', primary: true, selectable: true, debt: (10n ** 16n).toString() });
    expect(repay.entries.find(entry => entry.symbol === 'USDC')).toMatchObject({ selectable: false, reason: 'NO_DEBT' });
    expect(visibleCardReserves(repay, { showAll: false, query: '', selected: 'WETH' }).map(entry => entry.symbol)).toEqual(['WETH']);
    const withdraw = lendingCardCatalog('withdraw', 'Base', live(held()));
    expect(withdraw.entries[0]).toMatchObject({ symbol: 'USDC', primary: true, selectable: true, supplied: units('Base', 'USDC', 100n) });
    expect(withdraw.entries.find(entry => entry.symbol === 'WETH')).toMatchObject({ selectable: false, reason: 'NO_SUPPLY' });
    // A frozen reserve stays open to Repay and Withdraw (Aave semantics).
    const frozenDebt = lendingCardCatalog('repay', 'Base', live(market('Base', { EURC: { frozen: true, ...wallet('5', '0', '7') } })));
    expect(frozenDebt.entries.find(entry => entry.symbol === 'EURC')).toMatchObject({ selectable: true, reason: null });
  });
  it('an E-Mode account closes what Simulate refuses (every Borrow/Repay/Withdraw, an owner-beneficiary Supply); an unreadable state is only a note', () => {
    const eMode = market('Base', { USDC: wallet('1', '1', '1'), WETH: wallet('1', '1', '1') }, { eMode: '1' });
    for (const kind of ['borrow', 'repay', 'withdraw'] as const)
      expect(lendingCardCatalog(kind, 'Base', live(eMode)).entries.find(entry => entry.symbol === 'USDC'), kind).toMatchObject({ selectable: false, reason: 'ACCOUNT_EMODE_UNSUPPORTED' });
    // Base USDC Supply may name another beneficiary and reads only the reserve (readSupplyState): E-Mode does not close it. WETH (owner-only) is closed.
    const supply = lendingCardCatalog('supply', 'Base', live(eMode));
    expect(supply.entries.find(entry => entry.symbol === 'USDC')).toMatchObject({ selectable: true, reason: null });
    expect(supply.entries.find(entry => entry.symbol === 'WETH')).toMatchObject({ selectable: false, reason: 'ACCOUNT_EMODE_UNSUPPORTED' });
    const unknown = lendingCardCatalog('borrow', 'Base', live(market('Base', { WETH: { borrow: { available: false, reason: 'ACCOUNT_STATE_UNKNOWN' } } })));
    expect(unknown.entries.find(entry => entry.symbol === 'WETH')).toMatchObject({ selectable: true, reason: null, notes: expect.arrayContaining(['ACCOUNT_STATE_UNKNOWN']) });
  });
  it('without a wallet, a failed read or an incomplete reserve nothing is filtered or claimed', () => {
    const anonymous = lendingCardCatalog('supply', 'Base', live(market('Base', {}, null, false)));
    expect(anonymous.walletKnown).toBe(false);
    expect(hiddenCardReserves(anonymous)).toBe(0);
    expect(visibleCardReserves(anonymous, { showAll: false, query: '', selected: 'USDC' })).toHaveLength(lendingReservesFor('Base').length);
    expect(anonymous.entries.every(entry => entry.walletBalance === undefined)).toBe(true);
    const failed = lendingCardCatalog('repay', 'Base', live(null, true));
    expect(failed.state).toBe('UNAVAILABLE');
    expect(failed.entries.every(entry => entry.selectable && !entry.live && entry.reason === null)).toBe(true);
    expect(visibleCardReserves(failed, { showAll: false, query: '', selected: 'USDC' })).toHaveLength(lendingReservesFor('Base').length);
    const partial = lendingCardCatalog('supply', 'Base', live(market('Base', { WETH: { complete: false, ...wallet('999') } })));
    expect(partial.entries.find(entry => entry.symbol === 'WETH')).toMatchObject({ live: false, selectable: true, notes: ['STATUS_UNKNOWN'] });
    expect(partial.entries.find(entry => entry.symbol === 'WETH')!.walletBalance).toBeUndefined();
    // A status whose address does not match the registry (a different token labelled WETH) is never matched by its symbol.
    const spoofed = lendingCardCatalog('supply', 'Base', live(market('Base', { WETH: { asset: '0x9999999999999999999999999999999999999999', ...wallet('5') } })));
    expect(spoofed.entries.find(entry => entry.symbol === 'WETH')).toMatchObject({ live: false });
    // A test network has no live market: its registry reserves are listed as they are.
    expect(lendingCardCatalog('supply', 'Base Sepolia', null)).toMatchObject({ state: 'NONE', entries: [{ symbol: 'USDC', selectable: true }] });
  });
});

describe('a changed reserve is authored only through the card\'s reviewed proposal', () => {
  const context = cryptoReviewContext('Base');
  function authored(symbol = 'USDC', amount = '10') {
    const history = editorHistoryReducer(initialEditorHistory(), { type: 'START_ACTION_SETUP', action: 'supply', position: { x: 0, y: 0 }, beneficiary: owner });
    const id = history.actionSetup!.id;
    let state = editorHistoryReducer(history, { type: 'EDIT_CRYPTO_SELECTION', id, selection: selectCryptoToken(selectCryptoNetwork('supply', 'Base'), 'source', symbol), context, beneficiary: owner });
    state = editorHistoryReducer(state, { type: 'EDIT_CANVAS_AMOUNT', id, amount, context });
    const command = canvasAmountCommand(state.editor, state.actionSetup, state.amountInputs, id, context);
    return editorHistoryReducer(state, { type: 'COMMAND', command, context, authoringId: id, authoringAmount: actionReviewValue(state.actionSetup, id, undefined)! });
  }
  it('a new Supply card authors the chosen WETH reserve; changing the asset clears the amount for the new denomination', () => {
    let history = editorHistoryReducer(initialEditorHistory(), { type: 'START_ACTION_SETUP', action: 'supply', position: { x: 0, y: 0 }, beneficiary: owner });
    const id = history.actionSetup!.id;
    history = editorHistoryReducer(history, { type: 'EDIT_CRYPTO_SELECTION', id, selection: selectCryptoNetwork('supply', 'Base'), context, beneficiary: owner });
    history = editorHistoryReducer(history, { type: 'EDIT_CANVAS_AMOUNT', id, amount: '1000', context });
    history = editorHistoryReducer(history, { type: 'EDIT_CRYPTO_SELECTION', id, selection: selectCryptoToken(history.actionSetup!.cryptoSelection!, 'source', 'WETH'), context });
    // 1000 USDC is never re-read as 1000 WETH.
    expect(history.actionSetup).toMatchObject({ amount: '0', cryptoSelection: { from: 'WETH' } });
    history = editorHistoryReducer(history, { type: 'EDIT_CANVAS_AMOUNT', id, amount: '0.5', context });
    const command = canvasAmountCommand(history.editor, history.actionSetup, history.amountInputs, id, context);
    const next = editorReducer(history.editor, command, context);
    expect(next.error).toBeNull();
    expect(lendingNodeAsset(next.workflow.nodes.at(-1)! as SemanticWorkflow['nodes'][number])).toBe(reserve('Base', 'WETH').asset);
  });
  it('an authored USDC Supply changes to WETH through SET_CRYPTO_ACTION, a new revision, and survives a save/reload with its address and decimals', () => {
    let history = authored();
    const supply = history.editor.workflow.nodes.at(-1)!;
    expect(canSelectCryptoAssets(supply, history.editor.workflow)).toBe(true);
    const before = history.editor.workflow.revision;
    history = editorHistoryReducer(history, { type: 'EDIT_CRYPTO_SELECTION', id: supply.nodeId, selection: selectCryptoToken(cryptoSelectionOf(supply)!, 'source', 'WETH'), context });
    expect(history.cryptoSelections[supply.nodeId]).toMatchObject({ from: 'WETH' });
    expect(history.amountInputs[supply.nodeId]).toBe('');
    // The empty amount cannot be reviewed; the amount typed for WETH can.
    expect(() => canvasAmountCommand(history.editor, null, history.amountInputs, supply.nodeId, context, {}, history.cryptoSelections)).toThrow(/AMOUNT/);
    history = editorHistoryReducer(history, { type: 'EDIT_CANVAS_AMOUNT', id: supply.nodeId, amount: '0.25', context });
    const command = canvasAmountCommand(history.editor, null, history.amountInputs, supply.nodeId, context, {}, history.cryptoSelections);
    expect(command).toMatchObject({ type: 'SET_CRYPTO_ACTION', nodeId: supply.nodeId, input: { selection: { action: 'supply', network: 'Base', from: 'WETH' }, amount: '0.25' } });
    const amount = actionReviewValue(null, supply.nodeId, history.amountInputs[supply.nodeId], undefined, history.cryptoSelections[supply.nodeId])!;
    history = editorHistoryReducer(history, { type: 'COMMAND', command, context, authoringId: supply.nodeId, authoringAmount: amount });
    expect(history.editor.workflow.revision).toBe(before + 1);
    const changed = history.editor.workflow.nodes.find(item => item.nodeId === supply.nodeId)!;
    expect(cryptoSelectionOf(changed)).toEqual({ action: 'supply', network: 'Base', from: 'WETH' });
    expect(history.cryptoSelections[supply.nodeId]).toBeUndefined();
    // Save → reload: the saved IR is validated again and keeps the exact reserve identity.
    const reloaded = editorHistoryReducer(initialEditorHistory(), { type: 'RESTORE_WORKFLOW', workflow: validateSavedWorkflow(JSON.parse(JSON.stringify(history.editor.workflow))) });
    const restored = reloaded.editor.workflow.nodes.find(item => item.nodeId === supply.nodeId)!;
    const quantity = restored.inputs.find(input => input.name === 'amount')!.value as { asset: unknown; amount: string };
    expect(quantity).toEqual({ asset: { chainId: 'eip155:8453', address: '0x4200000000000000000000000000000000000006', decimals: 18 }, amount: '250000000000000000' });
    expect(cryptoSelectionOf(restored)?.from).toBe('WETH');
  });
  it('a proposal built from the stale settings form (the old reserve) is never applied over a card draft', () => {
    let history = authored();
    const supply = history.editor.workflow.nodes.at(-1)!;
    history = editorHistoryReducer(history, { type: 'EDIT_CRYPTO_SELECTION', id: supply.nodeId, selection: selectCryptoToken(cryptoSelectionOf(supply)!, 'source', 'WETH'), context });
    history = editorHistoryReducer(history, { type: 'EDIT_CANVAS_AMOUNT', id: supply.nodeId, amount: '10', context });
    const stale = { type: 'SET_SUPPLY' as const, nodeId: supply.nodeId, input: { network: 'Base' as const, asset: 'USDC', amount: '10', beneficiary: owner }, source: 'CANVAS' as const, baseRevision: history.editor.workflow.revision };
    expect(editorHistoryReducer(history, { type: 'COMMAND', command: stale, context, authoringId: supply.nodeId, authoringAmount: '10' })).toBe(history);
  });
});

describe('Swap USDC → WETH (Base) → Supply WETH keeps its order and funding through a card edit', () => {
  const composition = () => intent.composition([
    act.swap({ network: 'BASE', inputAsset: 'USDC', outputAsset: 'WETH', amount: '100' }),
    act.lending('SUPPLY', { network: 'BASE', asset: 'WETH', amount: '0.05' }),
  ]);
  it('the auto-connected Supply shows WETH, is funded by the swap, and an asset change keeps the dependency but ends the funding only once applied', () => {
    const s = new CopilotSession(); s.walletChainId = 'eip155:8453';
    s.say('Swap 100 USDC to WETH on Base and supply up to 0.05 of the resulting WETH on Aave', composition());
    s.apply();
    const [swap, supply] = workflowSequence(s.workflow, candidate => lintWorkflow(candidate, s.context))!.steps.map(step => s.workflow.nodes.find(item => item.nodeId === step.nodeId)!);
    expect(supply!.dependencies).toEqual([swap!.nodeId]);
    expect(cryptoSelectionOf(supply!)).toEqual({ action: 'supply', network: 'Base', from: 'WETH' });
    expect(canSelectCryptoAssets(supply!, s.workflow)).toBe(true);
    const context = s.context;
    let history = editorHistoryReducer(initialEditorHistory(), { type: 'RESTORE_WORKFLOW', workflow: validateSavedWorkflow(JSON.parse(JSON.stringify(s.workflow))) });
    const revision = history.editor.workflow.revision;
    // A draft alone changes nothing that runs: the saved sequence still funds the Supply from the swap.
    history = editorHistoryReducer(history, { type: 'EDIT_CRYPTO_SELECTION', id: supply!.nodeId, selection: selectCryptoToken(cryptoSelectionOf(supply!)!, 'source', 'USDC'), context });
    expect(history.editor.workflow.revision).toBe(revision);
    expect(workflowSequence(history.editor.workflow, candidate => lintWorkflow(candidate, s.context))!.steps[1]!.fundedBy).toBe(0);
    history = editorHistoryReducer(history, { type: 'EDIT_CANVAS_AMOUNT', id: supply!.nodeId, amount: '25', context });
    const command = canvasAmountCommand(history.editor, null, history.amountInputs, supply!.nodeId, context, {}, history.cryptoSelections);
    history = editorHistoryReducer(history, { type: 'COMMAND', command, context, authoringId: supply!.nodeId,
      authoringAmount: actionReviewValue(null, supply!.nodeId, history.amountInputs[supply!.nodeId], undefined, history.cryptoSelections[supply!.nodeId])! });
    // Applied as a new revision (every earlier simulation, review and approval belongs to the old one): the order link stays, the funding ends.
    expect(history.editor.workflow.revision).toBe(revision + 1);
    const edited = history.editor.workflow.nodes.find(item => item.nodeId === supply!.nodeId)!;
    expect(edited.dependencies).toEqual([swap!.nodeId]);
    expect(cryptoSelectionOf(edited)?.from).toBe('USDC');
    expect(workflowSequence(history.editor.workflow, candidate => lintWorkflow(candidate, s.context))!.steps[1]!.fundedBy).toBeNull();
  });
});

describe('review findings: account-level Borrow refusals, positions opened earlier in the workflow, funding by network', () => {
  it('Borrow mirrors Simulate\'s isolation-mode and siloed-borrowing refusals; Repay/Withdraw close without an oracle price', () => {
    const isolated = lendingCardCatalog('borrow', 'Base', live(market('Base', { USDC: { isolated: true, ...wallet('0', '100000000', '0', true) } })));
    expect(isolated.entries.find(entry => entry.symbol === 'WETH')).toMatchObject({ selectable: false, reason: 'ACCOUNT_ISOLATION_MODE' });
    // A second enabled collateral leaves isolation mode.
    const twoCollaterals = lendingCardCatalog('borrow', 'Base', live(market('Base', { USDC: { isolated: true, ...wallet('0', '1', '0', true) }, WETH: wallet('0', '1', '0', true) })));
    expect(twoCollaterals.entries.find(entry => entry.symbol === 'GHO')).toMatchObject({ selectable: true });
    const siloedTarget = lendingCardCatalog('borrow', 'Base', live(market('Base', { GHO: { siloed: true }, WETH: wallet('0', '0', '5') })));
    expect(siloedTarget.entries.find(entry => entry.symbol === 'GHO')).toMatchObject({ selectable: false, reason: 'SILOED_BORROWING_CONFLICT' });
    expect(siloedTarget.entries.find(entry => entry.symbol === 'WETH')).toMatchObject({ selectable: true });
    const siloedDebt = lendingCardCatalog('borrow', 'Base', live(market('Base', { GHO: { siloed: true, ...wallet('0', '0', '5') } })));
    expect(siloedDebt.entries.find(entry => entry.symbol === 'USDC')).toMatchObject({ selectable: false, reason: 'SILOED_BORROWING_CONFLICT' });
    for (const kind of ['repay', 'withdraw'] as const)
      expect(lendingCardCatalog(kind, 'Base', live(market('Base', { WETH: { price: '0', ...wallet('5', '5', '5') } }))).entries.find(entry => entry.symbol === 'WETH'), kind)
        .toMatchObject({ selectable: false, reason: 'ORACLE_UNAVAILABLE' });
  });
  it('Withdraw after a Supply (and Repay after a Borrow) of the same reserve in this workflow keeps that reserve selectable', () => {
    const weth = reserve('Base', 'WETH').asset;
    const withdraw = lendingCardCatalog('withdraw', 'Base', live(market('Base')), { opened: new Set([weth]) });
    expect(withdraw.entries[0]).toMatchObject({ symbol: 'WETH', selectable: true, primary: true, notes: ['OPENED_BY_EARLIER_STEP'] });
    expect(withdraw.entries.find(entry => entry.symbol === 'USDC')).toMatchObject({ selectable: false, reason: 'NO_SUPPLY' });
    const repay = lendingCardCatalog('repay', 'Base', live(market('Base')), { opened: new Set([weth]) });
    expect(repay.entries.find(entry => entry.symbol === 'WETH')).toMatchObject({ selectable: true, notes: ['OPENED_BY_EARLIER_STEP'] });
  });
  it('a funded step\'s draft is flagged when it changes network under the same label, not only when the label changes', () => {
    const sequence = { steps: [{ nodeId: 'swap', fundedBy: null }, { nodeId: 'supply', fundedBy: 0 }] };
    const saved = { action: 'supply' as const, network: 'Base', from: 'WETH' };
    expect(lendingCardFunding(sequence, 'supply', ['swap', 'supply'], saved)).toEqual({ step: 1, symbol: 'WETH', network: 'Base', changed: false });
    expect(lendingCardFunding(sequence, 'supply', ['swap', 'supply'], saved, saved)?.changed).toBe(false);
    expect(lendingCardFunding(sequence, 'supply', ['swap', 'supply'], saved, { ...saved, network: 'Arbitrum One' })?.changed).toBe(true);
    expect(lendingCardFunding(sequence, 'supply', ['swap', 'supply'], saved, { ...saved, from: 'USDC' })?.changed).toBe(true);
    expect(lendingCardFunding(sequence, 'swap', ['swap', 'supply'], saved)).toBeNull();
    expect(lendingCardFunding(null, 'supply', ['swap', 'supply'], saved)).toBeNull();
  });
  it('Borrow and Withdraw draw from Aave and spend nothing from the wallet: never funded by, nor capped at, an earlier delivery', () => {
    for (const action of ['borrow', 'withdraw'] as const) {
      const assets = stepAssets(node(action, 'Base', 'USDC', '1000'));
      expect(assets.inputs, action).toEqual([]);
      expect(assets.input, action).toBeNull();
      expect(assets.output, action).toEqual({ chainId: 'eip155:8453', address: reserve('Base', 'USDC').asset, decimals: 6 });
    }
    expect(stepAssets(node('repay', 'Base', 'USDC', '5')).inputs).toEqual([{ chainId: 'eip155:8453', address: reserve('Base', 'USDC').asset, decimals: 6, amount: '5000000' }]);
  });
});

it('every registry reserve has a unique label within its market (the card selects by label within one market only)', () => {
  for (const network of new Set(AAVE_V3_LENDING_PROFILES.map(profile => profile.network))) {
    const labels = lendingReservesFor(network).map(profile => profile.symbol.toLowerCase());
    expect(new Set(labels).size, network).toBe(labels.length);
  }
});
