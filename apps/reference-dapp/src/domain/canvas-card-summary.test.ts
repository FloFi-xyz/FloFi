// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { baseAssetRegistry, referenceRegistry } from '@defi-workflow-engine/action-registry';
import { createReviewContext } from '@defi-workflow-engine/reference-linter';
import { editorReducer, initialEditor, type EditorState } from './editor';
import type { Command } from './commands';
import { composerActions, composerConnections, composerSummary } from './composer-presentation';
import { canvasCardFlow, canvasCardParams, shortRecipient } from './canvas-card-summary';
import { translate } from '../i18n/locale';

const context = createReviewContext({ registryId: referenceRegistry.registryId, capabilityId: referenceRegistry.capabilities[0]!.id, actionId: referenceRegistry.actions[0]!.id, assets: baseAssetRegistry });
const apply = (state: EditorState, command: Record<string, unknown>) => {
  const next = editorReducer(state, { source: 'CANVAS', baseRevision: state.workflow.revision, ...command } as Command, context);
  expect(next.error).toBeNull();
  return next;
};
const swap = { type: 'ADD_SWAP', direction: 'USDC_TO_WETH', amount: '1', slippage: '50' };
const summary = (action: string, fields: Partial<{ provider: string; chain: string; amount: string; detail: string; bridgePair: string }> = {}) =>
  ({ action, provider: '', chain: 'Base (8453)', amount: '1 USDC', ...fields });

describe('BUILD-FLOFI-BUILDER-UX-002 Canvas card summary', () => {
  it('states each action as a one-line flow from the values the card shows, never an amount', () => {
    expect(canvasCardFlow(summary('Swap', { detail: 'USDC → WETH' }))).toBe('USDC → WETH');
    expect(canvasCardFlow(summary('Stocks', { detail: 'USDG → TSLA' }))).toBe('USDG → TSLA');
    expect(canvasCardFlow(summary('Bridge', { chain: 'Base (8453) → Arbitrum (42161)', bridgePair: 'USDC → USDC' }))).toBe('USDC · Base → Arbitrum');
    expect(canvasCardFlow(summary('Bridge', { chain: 'Base → Robinhood Chain', bridgePair: 'USDC → USDG' }))).toBe('USDC → USDG · Base → Robinhood Chain');
    expect(canvasCardFlow(summary('Supply', { provider: 'Aave V3' }))).toBe('USDC → Aave V3');
    expect(canvasCardFlow(summary('Repay', { provider: 'Aave V3' }))).toBe('USDC → Aave V3');
    expect(canvasCardFlow(summary('Borrow', { provider: 'Aave V3' }))).toBe('Aave V3 → USDC');
    expect(canvasCardFlow(summary('Withdraw', { provider: 'Aave V3' }))).toBe('Aave V3 → USDC');
    expect(canvasCardFlow(summary('Send', { amount: '5 USDC' }), shortRecipient('0x3333333333333333333333333333333333333333'))).toBe('USDC → 0x3333…3333');
    expect(canvasCardFlow(summary('Send', { amount: '5 USDC' }), null)).toBe('USDC');
    expect(canvasCardFlow(summary('Swap', { detail: 'USDC → WETH', amount: '12.5 USDC' }))).not.toContain('12.5');
    expect(canvasCardFlow(summary('Supply', { provider: 'Aave V3', amount: '7 USDC' }))).not.toContain('7 ');
  });

  it('leaves out what the step does not hold instead of inventing it', () => {
    expect(canvasCardFlow(summary('Swap'))).toBeNull();
    expect(canvasCardFlow(summary('Bridge', { chain: 'Base' }))).toBeNull();
    // A destination change can clear the output asset: the route alone, never "USDC" as if the asset were kept.
    expect(canvasCardFlow(summary('Bridge', { chain: 'Base → Solana', bridgePair: 'USDC → ' }))).toBe('Base → Solana');
    expect(canvasCardFlow(summary('Supply', { amount: 'Amount from linked step', provider: 'Aave V3' }))).toBeNull();
    expect(canvasCardFlow(summary('Pool / Liquidity', { detail: 'USDC / WETH' }))).toBeNull();
    expect(canvasCardFlow(summary('Prepare liquidity'))).toBeNull();
  });

  it('reads key parameters only from the canonical step', () => {
    let state = apply(initialEditor(), swap);
    const node = () => state.workflow.nodes.find(item => item.actionType === 'asset.swap.exact-input')!;
    expect(canvasCardParams(node())).toEqual([{ key: 'slippage', value: '0.5% (50 bps)' }]);
    state = apply(state, { type: 'LOCK', nodeId: node().nodeId, locked: true });
    expect(canvasCardParams(node())).toEqual([{ key: 'slippage', value: '0.5% (50 bps)' }]);
    const pool = apply(initialEditor(), { type: 'ADD_UNISWAP_LIQUIDITY', input: { network: 'Base Sepolia', maxUsdc: '10', maxWeth: '0.005', rangeUnit: 'PRICE', lower: '140', upper: '180', slippage: '100' } });
    expect(canvasCardParams(pool.workflow.nodes.find(item => item.actionType === 'asset.liquidity.concentrated')!)).toEqual([
      { key: 'slippage', value: '1% (100 bps)' }, { key: 'fee-tier', value: '0.05%' }]);
    const supply = apply(initialEditor(), { type: 'ADD_SUPPLY', input: { network: 'Base Sepolia', asset: 'USDC', amount: '1', beneficiary: '0x1111111111111111111111111111111111111111' } });
    expect(canvasCardParams(supply.workflow.nodes.find(item => item.actionType === 'supply')!)).toEqual([]);
  });

  it('keeps flow lines as data in Portuguese, translating only the one with words', () => {
    for (const flow of ['USDC → WETH', 'USDC · Base → Arbitrum', 'USDC → USDG · Base → Robinhood Chain', 'USDC → Aave V3', 'Aave V3 → USDC', 'USDC → 0x3333…3333', 'Base → Solana'])
      expect(translate('PT', flow)).toBe(flow);
    expect(translate('PT', 'Borrowed USDC → WETH')).toBe('USDC emprestado → WETH');
  });

  it('connects cards only through the workflow’s own dependencies, never by their visual order', () => {
    const two = apply(apply(initialEditor(), swap), swap);
    const [first, second] = composerActions(two.workflow);
    expect(composerConnections(two.workflow)).toEqual([]);
    const linked = apply(two, { type: 'CONNECT', from: first!.nodeId, to: second!.nodeId });
    expect(composerConnections(linked.workflow).map(edge => [edge.source, edge.target])).toEqual([[first!.nodeId, second!.nodeId]]);
    // A summary describes a card; it never changes the workflow it reads.
    const before = JSON.stringify(linked.workflow);
    for (const item of composerActions(linked.workflow)) { canvasCardFlow(composerSummary(linked.workflow, item, context)); canvasCardParams(item); }
    expect(JSON.stringify(linked.workflow)).toBe(before);
  });
});
