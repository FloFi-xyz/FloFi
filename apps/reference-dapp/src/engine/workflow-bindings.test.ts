// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-E2E-001: typed amount bindings between the steps of a v2 workflow — validated against each step's own canonical IR (exact token
 * identity, never a symbol), covered by the sequence hash only when present, and resolved only as min(cap, reconciled received).
 */
import { describe, expect, it } from 'vitest';
import { composeStrategy, composeWorkflow, workflowSequenceHash, type WorkflowComposition } from './strategy-engine';
import { strategyInputIssues } from './strategy-spec';
import { boundAmount, boundStrategy, decimalOf } from './workflow-bindings';

const OWNER = '0x' + '1'.repeat(40);
const ok = (input: unknown): WorkflowComposition => { const w = composeWorkflow(input); if (!w.ok) throw new Error(w.code + JSON.stringify(w.issues)); return w; };
const USDC_TO_WETH = { action: 'swap', network: 'base-sepolia', inputAsset: 'USDC', outputAsset: 'WETH', amount: '10' };
const WETH_TO_USDC = { action: 'swap', network: 'base-sepolia', inputAsset: 'WETH', outputAsset: 'USDC', amount: '0.01' };
const SUPPLY_AAVE_USDC = { action: 'supply', network: 'base-sepolia', asset: 'USDC', amount: '5', beneficiary: OWNER };
const BRIDGE = { action: 'bridge', sourceNetwork: 'base-sepolia', destinationNetwork: 'arbitrum-sepolia', asset: 'USDC', amount: '5' };

describe('BUILD-CHAT-E2E-001 workflow bindings', () => {
  it('binds a step to what an earlier step delivers, by exact token identity, and records the cap', () => {
    const w = ok({ version: 2, steps: [USDC_TO_WETH, WETH_TO_USDC], bindings: [{ step: 1, amountFrom: 0 }] });
    expect(w.bindings).toEqual([{ step: 1, amountFrom: 0, asset: { chainId: 'eip155:84532', address: '0x4200000000000000000000000000000000000006', decimals: 18 },
      cap: '10000000000000000' }]);
    expect(w.strategy).toMatchObject({ version: 2, bindings: [{ step: 1, amountFrom: 0 }] });
    // The canonical strategy round-trips to the same hash; the binding is part of it.
    expect(ok(w.strategy).workflowHash).toBe(w.workflowHash);
    expect(w.workflowHash).not.toBe(ok({ version: 2, steps: [USDC_TO_WETH, WETH_TO_USDC] }).workflowHash);
    expect(w.notes.at(-1)).toMatch(/Step 2 spends what step 1 actually delivers/);
  });

  it('keeps every unbound workflow hash byte for byte (BUILD-MCP-002 compatibility)', () => {
    const w = ok({ version: 2, steps: [BRIDGE, USDC_TO_WETH] });
    expect(w.bindings).toEqual([]);
    expect(w.strategy).toEqual({ version: 2, steps: w.steps.map(s => s.strategy) });
    expect(w.workflowHash).toBe(workflowSequenceHash(w.steps.map(s => s.workflowHash)));
    expect(w.workflowHash).toBe(workflowSequenceHash(w.steps.map(s => s.workflowHash), []));
  });

  it('refuses a binding between different tokens that share a symbol (Circle test USDC vs Aave test USDC on Base Sepolia)', () => {
    expect(composeWorkflow({ version: 2, steps: [WETH_TO_USDC, SUPPLY_AAVE_USDC], bindings: [{ step: 1, amountFrom: 0 }] }))
      .toMatchObject({ ok: false, code: 'WORKFLOW_BINDING_ASSET_MISMATCH', issues: [{ path: '/bindings/0' }] });
  });

  it('refuses consumers without one wallet input, producers delivering nothing to the owner, and malformed orders', () => {
    const liquidity = { action: 'add_liquidity', network: 'base-sepolia', maxAmounts: { USDC: '10', WETH: '0.01' }, range: { unit: 'price', lower: '1000', upper: '5000' } };
    expect(composeWorkflow({ version: 2, steps: [USDC_TO_WETH, liquidity], bindings: [{ step: 1, amountFrom: 0 }] }))
      .toMatchObject({ ok: false, code: 'WORKFLOW_BINDING_CONSUMER_UNSUPPORTED', issues: [{ path: '/bindings/0/step' }] });
    expect(composeWorkflow({ version: 2, steps: [SUPPLY_AAVE_USDC, USDC_TO_WETH], bindings: [{ step: 1, amountFrom: 0 }] }))
      .toMatchObject({ ok: false, code: 'WORKFLOW_BINDING_PRODUCER_UNSUPPORTED', issues: [{ path: '/bindings/0/amountFrom' }] });
    // A bridge to an explicit recipient delivers to someone else: never a producer for the owner's next step.
    const toOther = { ...BRIDGE, recipient: '0x' + '2'.repeat(40) };
    expect(composeWorkflow({ version: 2, steps: [toOther, { ...USDC_TO_WETH, network: 'base-sepolia' }], bindings: [{ step: 1, amountFrom: 0 }] }))
      .toMatchObject({ ok: false, code: 'WORKFLOW_BINDING_PRODUCER_UNSUPPORTED' });
    for (const bindings of [[{ step: 1, amountFrom: 1 }], [{ step: 2, amountFrom: 0 }], [{ step: 1, amountFrom: 0 }, { step: 1, amountFrom: 0 }]])
      expect(composeWorkflow({ version: 2, steps: [USDC_TO_WETH, WETH_TO_USDC], bindings })).toMatchObject({ ok: false, code: 'WORKFLOW_BINDING_INVALID' });
    // Schema: closed objects, integer indexes, never echoing values.
    expect(strategyInputIssues({ version: 2, steps: [USDC_TO_WETH, WETH_TO_USDC], bindings: [{ step: 1, amountFrom: 0, amount: '9' }] }))
      .toEqual([{ path: '/bindings/0/amount', rule: 'additionalProperties' }]);
    expect(strategyInputIssues({ version: 2, steps: [USDC_TO_WETH], bindings: [] })).toEqual([{ path: '/bindings', rule: 'minItems' }]);
  });

  it('never collapses a bound sequence into the lending composition (its indexes are what the bindings name)', () => {
    const steps = [{ action: 'supply', network: 'base-sepolia', asset: 'USDC', amount: '10', beneficiary: OWNER },
      { action: 'borrow', network: 'base-sepolia', asset: 'USDC', amount: '2', beneficiary: OWNER }, { ...USDC_TO_WETH, amount: '2' }];
    expect(ok({ version: 2, steps }).steps).toHaveLength(1);
    // Borrowed Aave USDC is not the swap's Circle USDC: the identity check refuses it rather than silently binding another token.
    expect(composeWorkflow({ version: 2, steps, bindings: [{ step: 2, amountFrom: 1 }] })).toMatchObject({ ok: false, code: 'WORKFLOW_BINDING_ASSET_MISMATCH' });
  });

  it('resolves min(cap, received) exactly in native units and renders it as the strategy decimal', () => {
    expect(boundAmount('1000', '400')).toBe(400n);
    expect(boundAmount('1000', '5000')).toBe(1000n);
    expect(boundAmount(1000n, 0n)).toBe(0n);
    expect(() => boundAmount('0', '1')).toThrow('WORKFLOW_BINDING_AMOUNT_INVALID');
    expect(() => boundAmount('1', '-1')).toThrow('WORKFLOW_BINDING_AMOUNT_INVALID');
    expect([decimalOf(1n, 18), decimalOf(10n ** 18n, 18), decimalOf(1_234_500n, 6), decimalOf(7n, 0)]).toEqual(['0.000000000000000001', '1', '1.2345', '7']);
    const spec = composeStrategy(WETH_TO_USDC);
    if (!spec.ok) throw new Error(spec.code);
    expect(boundStrategy(spec.strategy, 3_330_000_000_000_000n, 18)).toEqual({ ...spec.strategy, amount: '0.00333' });
    expect(() => boundStrategy(spec.strategy, 0n, 18)).toThrow('WORKFLOW_BINDING_AMOUNT_INVALID');
    // The resolved step is an ordinary strategy that composes on its own.
    expect(composeStrategy(boundStrategy(spec.strategy, 3_330_000_000_000_000n, 18))).toMatchObject({ ok: true });
  });
});
