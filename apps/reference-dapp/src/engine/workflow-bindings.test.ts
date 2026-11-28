// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-E2E-001: typed amount bindings between the steps of a v2 workflow — validated against each step's own canonical IR (exact token
 * identity, never a symbol), covered by the sequence hash only when present, and resolved only as min(cap, reconciled received).
 */
import { describe, expect, it } from 'vitest';
import { composeStrategy, composeWorkflow, workflowSequenceHash, type WorkflowComposition } from './strategy-engine';
import { strategyInputIssues } from './strategy-spec';
import { boundAmount, boundStrategy, canonicalBindings, consumption, decimalOf } from './workflow-bindings';

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

  it('binds only the matching liquidity deposit, leaving its other limit and immutable range unchanged', () => {
    const liquidity = { action: 'add_liquidity', network: 'base-sepolia', maxAmounts: { USDC: '10', WETH: '0.01' }, range: { unit: 'price', lower: '1000', upper: '5000' } };
    const w = ok({ version: 2, steps: [USDC_TO_WETH, liquidity], bindings: [{ step: 1, amountFrom: 0 }] });
    expect(w.bindings).toEqual([{ step: 1, amountFrom: 0, inputAsset: 'WETH', asset: { chainId: 'eip155:84532', address: '0x4200000000000000000000000000000000000006', decimals: 18 }, cap: '10000000000000000' }]);
    const resolved = boundStrategy(w.steps[1]!.strategy, 4_000_000_000_000_000n, 18, w.bindings[0]!.inputAsset);
    expect(resolved).toEqual({ ...w.steps[1]!.strategy, maxAmounts: { USDC: '10', WETH: '0.004' } });
    expect(composeStrategy(resolved)).toMatchObject({ ok: true });
    expect(ok(w.strategy).workflowHash).toBe(w.workflowHash);
    expect(() => boundStrategy(w.steps[1]!.strategy, 1n, 18, 'ETH')).toThrow('WORKFLOW_BINDING_ASSET_MISMATCH');
  });

  it('can fund both liquidity deposits with different prior outputs and canonicalizes their order', () => {
    const steps = [{ ...USDC_TO_WETH, network: 'base' }, { ...WETH_TO_USDC, network: 'base' },
      { action: 'add_liquidity', network: 'base', maxAmounts: { USDC: '10', WETH: '0.01' }, range: { unit: 'full' } }];
    const a = ok({ version: 2, steps, bindings: [{ step: 2, amountFrom: 1 }, { step: 2, amountFrom: 0 }] });
    const b = ok({ version: 2, steps, bindings: [{ step: 2, amountFrom: 0 }, { step: 2, amountFrom: 1 }] });
    expect(a.bindings.map(x => x.inputAsset)).toEqual(['WETH', 'USDC']);
    expect(a.workflowHash).toBe(b.workflowHash);
    expect(composeWorkflow({ version: 2, steps: [steps[0], steps[0], steps[2]], bindings: [{ step: 2, amountFrom: 0 }, { step: 2, amountFrom: 1 }] }))
      .toMatchObject({ ok: false, code: 'WORKFLOW_BINDING_INVALID' });
  });

  it('binds native ETH and SOL deliveries to native transfers without substituting WETH', () => {
    const eth = { action: 'swap', network: 'base', inputAsset: 'USDC', outputAsset: 'ETH', amount: '10' };
    const transfer = { action: 'transfer', network: 'base', asset: 'ETH', amount: '0.01', recipient: OWNER };
    const native = ok({ version: 2, steps: [eth, transfer], bindings: [{ step: 1, amountFrom: 0 }] });
    expect(native.bindings[0]).toMatchObject({ asset: { chainId: 'eip155:8453', address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', decimals: 18 } });
    expect(JSON.stringify(native.steps[1]!.workflow)).not.toContain('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
    expect(composeWorkflow({ version: 2, steps: [{ ...eth, outputAsset: 'WETH' }, transfer], bindings: [{ step: 1, amountFrom: 0 }] }))
      .toMatchObject({ ok: false, code: 'WORKFLOW_BINDING_ASSET_MISMATCH' });
    const sol = ok({ version: 2, steps: [{ action: 'swap', network: 'solana', inputAsset: 'USDC', outputAsset: 'SOL', amount: '10' },
      { action: 'transfer', network: 'solana', asset: 'SOL', amount: '0.1', recipient: '11111111111111111111111111111111' }], bindings: [{ step: 1, amountFrom: 0 }] });
    expect(sol.bindings[0]).toMatchObject({ asset: { chainId: expect.stringMatching(/^solana:/), address: 'So11111111111111111111111111111111111111112', decimals: 9 } });
  });

  it('uses protocol integer limits instead of arbitrary mainnet amount caps', () => {
    for (const strategy of [
      { action: 'swap', network: 'base', inputAsset: 'USDC', outputAsset: 'WETH', amount: '1000001' },
      { action: 'swap', network: 'solana', inputAsset: 'SOL', outputAsset: 'USDC', amount: '1001' },
      { action: 'add_liquidity', network: 'base', maxAmounts: { USDC: '1000000001', WETH: '1' }, range: { unit: 'full' } },
      { action: 'add_liquidity', network: 'solana', maxAmounts: { SOL: '1001', USDC: '1000001' }, range: { unit: 'tick', lower: '-64', upper: '64' } },
      { action: 'transfer', network: 'base', asset: 'ETH', amount: '1000001', recipient: OWNER },
    ]) expect(composeStrategy(strategy), JSON.stringify(strategy)).toMatchObject({ ok: true });
    expect(composeStrategy({ action: 'swap', network: 'solana', inputAsset: 'USDC', outputAsset: 'SOL', amount: '18446744073709.551616' })).toMatchObject({ ok: false });
  });

  it('refuses producers delivering nothing to the owner, mismatched identities, and malformed orders', () => {
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

describe('BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 consumption modes (E02/E05)', () => {
  const steps = [USDC_TO_WETH, WETH_TO_USDC];
  it('is canonical and hashed only when present: every binding written before it keeps its exact form and hash', () => {
    const plain = ok({ version: 2, steps, bindings: [{ step: 1, amountFrom: 0 }] });
    expect(plain.strategy).toMatchObject({ bindings: [{ step: 1, amountFrom: 0 }] });
    expect(Object.keys((plain.strategy as { bindings: object[] }).bindings[0]!)).toEqual(['step', 'amountFrom']);
    expect(plain.workflowHash).toBe(workflowSequenceHash(plain.steps.map(c => c.workflowHash), [{ step: 1, amountFrom: 0 }]));
    const hashes = new Set([plain.workflowHash]);
    for (const extra of [{ consume: 'ALL' }, { consume: 'PERCENT', bps: 5000 }, { consume: 'PERCENT', bps: 2500 }, { consume: 'FIXED' }] as const) {
      const w = ok({ version: 2, steps, bindings: [{ step: 1, amountFrom: 0, ...extra }] });
      expect(w.bindings[0]).toMatchObject({ step: 1, amountFrom: 0, ...extra, cap: '10000000000000000' });
      expect((w.strategy as { bindings: object[] }).bindings).toEqual([{ step: 1, amountFrom: 0, ...extra }]);
      // Round trip: the canonical strategy composes to the same hash; each mode (and each share) is a different workflow.
      expect(ok(w.strategy).workflowHash).toBe(w.workflowHash);
      hashes.add(w.workflowHash);
    }
    expect(hashes.size).toBe(5);
    expect(canonicalBindings([{ step: 1, amountFrom: 0, bps: 5000, consume: 'PERCENT' }])).toEqual([{ step: 1, amountFrom: 0, consume: 'PERCENT', bps: 5000 }]);
  });

  it('describes each mode in the engine notes', () => {
    expect(ok({ version: 2, steps, bindings: [{ step: 1, amountFrom: 0, consume: 'ALL' }] }).notes.at(-1)).toMatch(/spends all of what step 1 actually delivers/);
    expect(ok({ version: 2, steps, bindings: [{ step: 1, amountFrom: 0, consume: 'PERCENT', bps: 5000 }] }).notes.at(-1)).toMatch(/spends 50% of what step 1/);
    expect(ok({ version: 2, steps, bindings: [{ step: 1, amountFrom: 0, consume: 'FIXED' }] }).notes.at(-1)).toMatch(/exactly its own amount.*stops before anything is signed/);
  });

  it('refuses malformed modes: a share without bps, bps without a share, out-of-range shares, unknown modes, a mode on a Batch Payment', () => {
    for (const binding of [{ consume: 'PERCENT' }, { consume: 'ALL', bps: 5000 }, { bps: 5000 }, { consume: 'FIXED', bps: 1 }])
      expect(composeWorkflow({ version: 2, steps, bindings: [{ step: 1, amountFrom: 0, ...binding }] }), JSON.stringify(binding))
        .toMatchObject({ ok: false, code: 'WORKFLOW_BINDING_CONSUMPTION_INVALID' });
    for (const bps of [0, 10_001, 50.5]) expect(strategyInputIssues({ version: 2, steps, bindings: [{ step: 1, amountFrom: 0, consume: 'PERCENT', bps }] }))
      .toEqual([expect.objectContaining({ path: '/bindings/0/bps' })]);
    expect(strategyInputIssues({ version: 2, steps, bindings: [{ step: 1, amountFrom: 0, consume: 'HALF' }] })).not.toEqual([]);
    const batch = { action: 'batch_payment', network: 'base', asset: 'WETH', recipients: [{ recipient: '0x' + '2'.repeat(40), amount: '0.001' },
      { recipient: '0x' + '3'.repeat(40), amount: '0.001' }] };
    const swap = { action: 'swap', network: 'base', inputAsset: 'USDC', outputAsset: 'WETH', amount: '10' };
    expect(ok({ version: 2, steps: [swap, batch], bindings: [{ step: 1, amountFrom: 0 }] }).bindings.every(b => b.exact)).toBe(true);
    expect(composeWorkflow({ version: 2, steps: [swap, batch], bindings: [{ step: 1, amountFrom: 0, consume: 'FIXED' }] }))
      .toMatchObject({ ok: false, code: 'WORKFLOW_BINDING_CONSUMPTION_INVALID', issues: [{ path: '/bindings/0/consume' }] });
  });

  it('resolves each mode from the producer\'s own delivery only, never above the cap or what is left', () => {
    const cap = '1000';
    // No mode and ALL: min(cap, what is left of the delivery).
    for (const rule of [{ cap }, { cap, consume: 'ALL' as const }]) {
      expect(consumption(rule, 400n)).toEqual({ ok: true, amount: 400n });
      expect(consumption(rule, 5000n)).toEqual({ ok: true, amount: 1000n });
      expect(consumption(rule, 5000n, 300n)).toEqual({ ok: true, amount: 300n });
      expect(consumption(rule, 0n)).toEqual({ ok: false, code: 'WORKFLOW_BINDING_NOTHING_RECEIVED' });
    }
    // PERCENT: floor(delivered × bps / 10 000), capped; a share of the delivery, not of what an earlier consumer left.
    const half = { cap, consume: 'PERCENT' as const, bps: 5000 };
    expect(consumption(half, 801n)).toEqual({ ok: true, amount: 400n });
    expect(consumption(half, 5000n)).toEqual({ ok: true, amount: 1000n });
    expect(consumption(half, 800n, 500n)).toEqual({ ok: true, amount: 400n });
    expect(consumption(half, 800n, 100n)).toEqual({ ok: true, amount: 100n });
    expect(consumption({ cap, consume: 'PERCENT', bps: 1 }, 9_999n)).toEqual({ ok: false, code: 'WORKFLOW_BINDING_NOTHING_RECEIVED' });
    expect(consumption({ cap: '10', consume: 'PERCENT', bps: 10_000 }, 7n)).toEqual({ ok: true, amount: 7n });
    // FIXED: exactly the cap or a refusal before signing (never topped up from anything else); a Batch Payment leg keeps its own code.
    const fixed = { cap, consume: 'FIXED' as const };
    expect(consumption(fixed, 1000n)).toEqual({ ok: true, amount: 1000n });
    expect(consumption(fixed, 5000n)).toEqual({ ok: true, amount: 1000n });
    expect(consumption(fixed, 999n)).toEqual({ ok: false, code: 'WORKFLOW_BINDING_INSUFFICIENT_FOR_FIXED_AMOUNT' });
    expect(consumption(fixed, 5000n, 999n)).toEqual({ ok: false, code: 'WORKFLOW_BINDING_INSUFFICIENT_FOR_FIXED_AMOUNT' });
    expect(consumption({ cap, exact: true }, 999n)).toEqual({ ok: false, code: 'WORKFLOW_BINDING_INSUFFICIENT_FOR_EXACT_PAYMENT' });
    expect(() => consumption({ cap: '0' }, 1n)).toThrow('WORKFLOW_BINDING_AMOUNT_INVALID');
    expect(() => consumption({ cap, consume: 'PERCENT' }, 1n)).toThrow('WORKFLOW_BINDING_AMOUNT_INVALID');
  });
});
