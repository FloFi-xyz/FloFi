// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 (WS02): Batch Payment through the engine, the workflow-run planner and the authorization plan — no network,
 * no wallet, no database.
 *   composition  one strategy step, its own semantic IR (the batch node), executed as one transfer leg per recipient; the workflow hash binds the
 *                ordered manifest; each recipient counts toward the 8-step run budget; duplicates, Solana and Stock Tokens are refused
 *   bindings     a Batch Payment funded by an earlier step pays each recipient EXACTLY (never min(cap, received)); a batch is never a producer
 *   execution    only one atomic group (EIP-5792 wallet batch or the owner's smart-account operation); never confirm-each-step, never split
 */
import { describe, expect, it } from 'vitest';
import { requirementOf, type WorkflowRequirement } from '../delegation/steps.ts';
import { evmStepBuildable } from '../user-funded/evm-calls.ts';
import { authorizationPlan } from '../workflow-runs/authorization-plan.ts';
import { planExecutionGroups, type UserFundedFacts, type WalletProfile } from '../workflow-runs/execution-groups.ts';
import { exactBoundAmount } from './workflow-bindings';
import { composeWorkflow, workflowSequenceHash, type WorkflowComposition } from './strategy-engine';
import { isStrategyInput } from './strategy-spec';
import { toChecksumAddress } from '@defi-workflow-engine/action-registry';
import { checkBatchPaymentDraft } from '../domain/batch-payment-authoring';

const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20), C = '0x' + 'c3'.repeat(20);
// EIP-55: a mixed-case recipient must be its exact checksum encoding (the Send card's rule); a mistyped letter is refused.
const MIXED = toChecksumAddress('0xabcdef0123456789abcdef0123456789abcdef01');
const letter = MIXED.slice(2).search(/[a-fA-F]/) + 2, flipped = MIXED[letter]!;
const MISTYPED = MIXED.slice(0, letter) + (flipped === flipped.toUpperCase() ? flipped.toLowerCase() : flipped.toUpperCase()) + MIXED.slice(letter + 1);
const BATCH = { action: 'batch_payment', network: 'base', asset: 'USDC', recipients: [{ recipient: A, amount: '25' }, { recipient: B, amount: '50' }, { recipient: C, amount: '75' }] };
const SWAP = { action: 'swap', network: 'base', inputAsset: 'WETH', outputAsset: 'USDC', amount: '0.1', slippageBps: 100 };
const compose = (input: unknown): WorkflowComposition => { const w = composeWorkflow(input); if (!w.ok) throw new Error(`${w.code} ${JSON.stringify(w.issues)}`); return w; };
const ALL: UserFundedFacts = { enabled: true, code: null, chains: ['eip155:1', 'eip155:8453', 'eip155:42161', 'eip155:4663'], bundlerChains: ['eip155:8453'], solanaNonceAccounts: true };
const ATOMIC: WalletProfile = { eip155: { wallet: 'INJECTED', atomic: { 'eip155:8453': 'supported', 'eip155:42161': 'ready', 'eip155:1': 'unsupported' }, typedData: true } };
const req = (w: WorkflowComposition): WorkflowRequirement => { const r = requirementOf(w); if (!r.ok) throw new Error(r.code); return r.value; };
const buildable = (facts: UserFundedFacts) => (s: WorkflowRequirement['steps'][number]) => evmStepBuildable(s, facts.chains) === null;
const GATES = { supportedByCode: { execute: true, plan: 'SEQUENTIAL' as const, flow: null, reason: null, modes: { confirmEachStep: null, delegated: 'EXECUTOR_FUNDED_GAS_RETIRED' } },
  enabledByDeployment: { enabled: true, flow: null, mode: 'PER_STEP', executionSwitch: null, mockedHarness: false, reason: null },
  enabledByPolicy: { enabled: true, fundsClass: 'REAL_FUNDS' as const, networks: [], reason: null }, handoff: { allowed: true, reason: null } };
const gatesFor = (w: WorkflowComposition) => ({ ...GATES, plan: { steps: w.steps.map(c => ({ flow: 'base-mainnet-transfer', network: 'base', action: c.strategy.action })) } });

describe('BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 Batch Payment composition', () => {
  it('"Send 25 USDC to A, 50 USDC to B and 75 USDC to C on Base" is ONE operation: three exact legs in order, one semantic node, a hash of the manifest', () => {
    const w = compose(BATCH);
    expect(w.strategy).toEqual({ version: 2, steps: [{ version: 1, action: 'batch_payment', network: 'base', asset: 'USDC', recipients: BATCH.recipients }] });
    expect(w.steps.map(c => [c.strategy.action, 'amount' in c.strategy ? c.strategy.amount : null, 'recipient' in c.strategy ? c.strategy.recipient : null]))
      .toEqual([['transfer', '25', A], ['transfer', '50', B], ['transfer', '75', C]]);
    expect(w.batches).toHaveLength(1);
    const [batch] = w.batches!;
    expect(batch).toMatchObject({ step: 0, from: 0, to: 2, network: 'base', asset: 'USDC', recipients: 3 });
    expect(batch!.composition.workflow.nodes.filter(n => n.actionType === 'asset.transfer.batch')).toHaveLength(1);
    expect(w.workflowHash).toBe(workflowSequenceHash(w.steps.map(c => c.workflowHash), [], [{ step: 0, from: 0, to: 2, workflowHash: batch!.composition.workflowHash }]));
    // The same three payments as separate transfers are a different workflow (not a Batch Payment).
    const separate = compose({ version: 2, steps: BATCH.recipients.map(r => ({ action: 'transfer', network: 'base', asset: 'USDC', amount: r.amount, recipient: r.recipient })) });
    expect(separate.workflowHash).not.toBe(w.workflowHash);
    expect(separate.batches ?? []).toEqual([]);
    // v1 and its one-step v2 form are the same workflow; the canonical strategy recomposes to the same hash.
    expect(compose({ version: 2, steps: [BATCH] }).workflowHash).toBe(w.workflowHash);
    expect(compose(w.strategy).workflowHash).toBe(w.workflowHash);
  });

  it('every recipient, amount, order, asset and network change is a new workflow hash (a fresh Review)', () => {
    const base = compose(BATCH).workflowHash;
    const r = BATCH.recipients;
    for (const changed of [{ ...BATCH, recipients: [r[1], r[0], r[2]] }, { ...BATCH, recipients: [r[0], r[1], { ...r[2]!, amount: '75.000001' }] },
      { ...BATCH, recipients: [r[0], r[1], { ...r[2]!, recipient: '0x' + 'd4'.repeat(20) }] }, { ...BATCH, recipients: [r[0], r[1]] },
      { ...BATCH, asset: 'ETH', recipients: r.map(x => ({ ...x, amount: '0.001' })) }, { ...BATCH, network: 'arbitrum-one' }])
      expect(compose(changed).workflowHash).not.toBe(base);
  });

  it('normalizes recipients to lower case, keeps exact decimal amounts and supports equal amounts when asked', () => {
    const w = compose({ ...BATCH, recipients: [{ recipient: MIXED, amount: '10' }, { recipient: A, amount: '10' }] });
    expect((w.strategy as { steps: { recipients: unknown }[] }).steps[0]!.recipients).toEqual([{ recipient: MIXED.toLowerCase(), amount: '10' }, { recipient: A, amount: '10' }]);
    // Exact integer base units, no float rounding (6 decimals for USDC).
    const fine = compose({ ...BATCH, recipients: [{ recipient: A, amount: '0.000001' }, { recipient: B, amount: '123456789.123456' }] });
    const units = fine.steps.map(c => c.workflow.nodes.find(n => n.actionType === 'asset.transfer')!.userConstraints[0]!);
    expect(units.map(u => (u as { quantity: { amount: string } }).quantity.amount)).toEqual(['1', '123456789123456']);
    expect(fine.batches![0]!.composition.workflow.nodes.find(n => n.actionType === 'asset.transfer.batch')!.userConstraints[0]).toMatchObject({ quantity: { amount: '123456789123457' } });
  });

  it('refuses a duplicate recipient (never merged or dropped), a reserved recipient, one recipient, nine recipients, a zero amount, Solana and a Stock Token', () => {
    const refusal = (input: unknown) => { const w = composeWorkflow(input); return w.ok ? 'OK' : w.code; };
    expect(refusal({ ...BATCH, recipients: [{ recipient: A, amount: '1' }, { recipient: A.toUpperCase().replace('0X', '0x'), amount: '2' }] })).toBe('BATCH_PAYMENT_DUPLICATE_RECIPIENT');
    expect(refusal({ ...BATCH, recipients: [{ recipient: A, amount: '1' }] })).toBe('STRATEGY_SCHEMA_INVALID');
    const nine = Array.from({ length: 9 }, (_, i) => ({ recipient: '0x' + String(i + 1).repeat(40).slice(0, 40), amount: '1' }));
    expect(isStrategyInput({ ...BATCH, recipients: nine })).toBe(false);
    expect(refusal({ ...BATCH, recipients: [{ recipient: A, amount: '0' }, { recipient: B, amount: '1' }] })).toBe('BATCH_PAYMENT_AMOUNT_INVALID');
    // A checksummed address with a mistyped letter is refused, never lower-cased into another wallet.
    expect(refusal({ ...BATCH, recipients: [{ recipient: MISTYPED, amount: '1' }, { recipient: B, amount: '1' }] })).toBe('BATCH_PAYMENT_RECIPIENT_INVALID');
    // A reserved payee (the zero address or a precompile 0x…01..0x…ff: nobody holds its key) is refused, never paid.
    for (const reserved of ['0x' + '0'.repeat(38) + '02', '0x' + '0'.repeat(40), '0x' + '0'.repeat(38) + 'ff'])
      expect(refusal({ ...BATCH, recipients: [{ recipient: reserved, amount: '1' }, { recipient: B, amount: '1' }] }), reserved).toBe('BATCH_PAYMENT_RECIPIENT_INVALID');
    // The first address past the precompile range is an ordinary payee.
    expect(refusal({ ...BATCH, recipients: [{ recipient: '0x' + '0'.repeat(37) + '100', amount: '1' }, { recipient: B, amount: '1' }] })).toBe('OK');
    // An ETH payment above the network's per-payment maximum (uint256 on mainnets: no USD cap) is named as such (never "enter a positive amount").
    expect(refusal({ ...BATCH, asset: 'ETH', recipients: [{ recipient: A, amount: '1' + '0'.repeat(60) }, { recipient: B, amount: '0.001' }] })).toBe('STRATEGY_SCHEMA_INVALID');
    expect(checkBatchPaymentDraft({ network: 'Base', asset: 'ETH', payments: [{ recipient: A, amount: '1' + '0'.repeat(60) }, { recipient: B, amount: '0.001' }] }).code)
      .toBe('BATCH_PAYMENT_AMOUNT_ABOVE_MAXIMUM');
    expect(refusal({ ...BATCH, recipients: [{ recipient: A, amount: '1.0000001' }, { recipient: B, amount: '1' }] })).toBe('BATCH_PAYMENT_AMOUNT_TOO_PRECISE');
    // A Stock Token (Robinhood Chain) never rides in a Batch Payment.
    expect(refusal({ ...BATCH, network: 'robinhood', asset: 'TSLA' })).not.toBe('OK');
    expect(refusal({ ...BATCH, network: 'solana' })).toBe('STRATEGY_SCHEMA_INVALID');
    expect(refusal({ ...BATCH, network: 'base-sepolia' })).toBe('STRATEGY_SCHEMA_INVALID');
  });

  it('counts every recipient toward the 8-step budget: 8 alone is allowed, a swap plus 8 is refused, a swap plus 7 is allowed', () => {
    // Ordinary payees 0x0101…01..0x0808…08: the former 0x…01..0x…08 are precompile addresses a Batch Payment refuses as payees.
    const eight = Array.from({ length: 8 }, (_, i) => ({ recipient: '0x' + (i + 1).toString(16).padStart(2, '0').repeat(20), amount: '1' }));
    expect(compose({ ...BATCH, recipients: eight }).steps).toHaveLength(8);
    const over = composeWorkflow({ version: 2, steps: [SWAP, { ...BATCH, recipients: eight }] });
    expect(over.ok ? 'OK' : over.code).toBe('BATCH_PAYMENT_EXCEEDS_WORKFLOW_STEP_BUDGET');
    expect(compose({ version: 2, steps: [SWAP, { ...BATCH, recipients: eight.slice(0, 7) }] }).steps).toHaveLength(8);
  });
});

describe('BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 Swap → Batch Payment funding', () => {
  it('binds every leg EXACTLY to the swap delivery; a batch is never a producer', () => {
    const w = compose({ version: 2, steps: [SWAP, BATCH], bindings: [{ step: 1, amountFrom: 0 }] });
    expect(w.steps.map(c => c.strategy.action)).toEqual(['swap', 'transfer', 'transfer', 'transfer']);
    expect(w.bindings.map(b => [b.step, b.amountFrom, b.cap, b.exact ?? false])).toEqual([[1, 0, '25000000', true], [2, 0, '50000000', true], [3, 0, '75000000', true]]);
    expect(w.strategy).toMatchObject({ bindings: [{ step: 1, amountFrom: 0 }] });
    expect(w.batches![0]).toMatchObject({ step: 1, from: 1, to: 3 });
    // Without the binding: another workflow.
    expect(compose({ version: 2, steps: [SWAP, BATCH] }).workflowHash).not.toBe(w.workflowHash);
    const producer = composeWorkflow({ version: 2, steps: [BATCH, { action: 'transfer', network: 'base', asset: 'USDC', amount: '1', recipient: A }], bindings: [{ step: 1, amountFrom: 0 }] });
    expect(producer.ok ? 'OK' : producer.code).toBe('WORKFLOW_BINDING_PRODUCER_UNSUPPORTED');
  });
  it('Bridge → Batch, Swap → Bridge → Batch and Aave Withdraw → Batch bind every leg exactly to the reconciled delivery', () => {
    const BRIDGE = { action: 'bridge', sourceNetwork: 'base', destinationNetwork: 'arbitrum-one', asset: 'USDC', amount: '200', routing: 'auto' };
    const ARB_BATCH = { ...BATCH, network: 'arbitrum-one' };
    const bridged = compose({ version: 2, steps: [BRIDGE, ARB_BATCH], bindings: [{ step: 1, amountFrom: 0 }] });
    expect(bridged.steps.map(c => c.strategy.action)).toEqual(['bridge', 'transfer', 'transfer', 'transfer']);
    expect(bridged.bindings.map(b => [b.step, b.amountFrom, b.cap, b.exact ?? false])).toEqual([[1, 0, '25000000', true], [2, 0, '50000000', true], [3, 0, '75000000', true]]);
    const swapBridge = compose({ version: 2, steps: [SWAP, { ...BRIDGE, amount: '150' }, ARB_BATCH], bindings: [{ step: 1, amountFrom: 0 }, { step: 2, amountFrom: 1 }] });
    expect(swapBridge.steps.map(c => c.strategy.action)).toEqual(['swap', 'bridge', 'transfer', 'transfer', 'transfer']);
    expect(swapBridge.bindings.map(b => [b.step, b.amountFrom, b.exact ?? false])).toEqual([[1, 0, false], [2, 1, true], [3, 1, true], [4, 1, true]]);
    const withdrawn = compose({ version: 2, steps: [{ action: 'withdraw', network: 'base', asset: 'USDC', amount: '150' }, BATCH], bindings: [{ step: 1, amountFrom: 0 }] });
    expect(withdrawn.steps.map(c => c.strategy.action)).toEqual(['withdraw', 'transfer', 'transfer', 'transfer']);
    expect(withdrawn.bindings.every(b => b.amountFrom === 0 && b.exact === true)).toBe(true);
    expect(withdrawn.strategy).toMatchObject({ steps: [{ action: 'withdraw' }, { action: 'batch_payment' }], bindings: [{ step: 1, amountFrom: 0 }] });
  });

  it('an exact leg spends its whole amount or nothing: never a reduced payment', () => {
    expect(exactBoundAmount('75000000', '75000000')).toBe(75000000n);
    expect(exactBoundAmount('75000000', '90000000')).toBe(75000000n);
    expect(() => exactBoundAmount('75000000', '74999999')).toThrow('WORKFLOW_BINDING_INSUFFICIENT_FOR_EXACT_PAYMENT');
  });
});

describe('BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 atomic-only execution', () => {
  it('plans the legs as ONE atomic wallet batch for a wallet that reports atomic batches', () => {
    const p = planExecutionGroups(req(compose(BATCH)), ALL, ATOMIC, buildable(ALL));
    expect(p.ok && p.groups.map(g => [g.strategy, g.stepFrom, g.stepTo])).toEqual([['EVM_WALLET_BATCH', 0, 2]]);
    expect(p.ok && p.interactions).toMatchObject({ upfront: 1, single: true });
    // A swap and its funded batch on one chain are one atomic group too.
    const swapThenPay = planExecutionGroups(req(compose({ version: 2, steps: [SWAP, BATCH], bindings: [{ step: 1, amountFrom: 0 }] })), ALL, ATOMIC, buildable(ALL));
    expect(swapThenPay.ok && swapThenPay.groups.map(g => [g.strategy, g.stepFrom, g.stepTo])).toEqual([['EVM_WALLET_BATCH', 0, 3]]);
  });
  it('refuses instead of splitting: a wallet without atomic batches, a chain without user-funded groups, user-funded execution off', () => {
    const ethereum = compose({ ...BATCH, network: 'ethereum' });
    expect(planExecutionGroups(req(ethereum), ALL, ATOMIC, buildable(ALL))).toMatchObject({ ok: false, code: 'BATCH_PAYMENT_ATOMIC_EXECUTION_UNAVAILABLE',
      because: ['WALLET_ATOMIC_BATCH_UNSUPPORTED'] });
    const noBase: UserFundedFacts = { ...ALL, chains: ALL.chains.filter(c => c !== 'eip155:8453') };
    expect(planExecutionGroups(req(compose(BATCH)), noBase, ATOMIC, buildable(noBase))).toMatchObject({ ok: false, code: 'BATCH_PAYMENT_ATOMIC_EXECUTION_UNAVAILABLE' });
    expect(planExecutionGroups(req(compose(BATCH)), { ...ALL, enabled: false, code: 'USER_FUNDED_NOT_ENABLED' }, ATOMIC)).toMatchObject({ ok: false, code: 'USER_FUNDED_NOT_ENABLED' });
  });
  it('never offers confirm-each-step for a Batch Payment; offers the atomic group only where it exists', () => {
    const w = compose(BATCH);
    const plan = authorizationPlan(w, gatesFor(w), null, undefined, { facts: ALL, wallets: ATOMIC });
    expect(plan.confirmEachStep).toMatchObject({ available: false, reason: 'BATCH_PAYMENT_REQUIRES_ATOMIC_EXECUTION' });
    expect(plan.userFunded).toMatchObject({ available: true, reason: null, groups: [{ strategy: 'EVM_WALLET_BATCH', stepFrom: 0, stepTo: 2 }] });
    expect(plan.recommended).toBe('USER_FUNDED');
    const ethereum = compose({ ...BATCH, network: 'ethereum' });
    const refused = authorizationPlan(ethereum, gatesFor(ethereum), null, undefined, { facts: ALL, wallets: ATOMIC });
    expect(refused.userFunded).toMatchObject({ available: false, reason: 'BATCH_PAYMENT_ATOMIC_EXECUTION_UNAVAILABLE' });
    expect(refused.confirmEachStep.available).toBe(false);
    expect(refused.recommended).toBeNull();
    // A workflow without a batch keeps confirm-each-step exactly as before.
    const separate = compose({ version: 2, steps: BATCH.recipients.map(r => ({ action: 'transfer', network: 'base', asset: 'USDC', amount: r.amount, recipient: r.recipient })) });
    expect(authorizationPlan(separate, gatesFor(separate), null, undefined, { facts: ALL, wallets: ATOMIC }).confirmEachStep.available).toBe(true);
  });
});
