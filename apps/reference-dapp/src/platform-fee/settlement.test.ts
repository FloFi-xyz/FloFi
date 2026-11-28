// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (completion): the pure parts of fee collection and single-flow accounting.
 * Single-flow basis (§3.2), the settlement plan (authorized cap, final basis, already collected, treasury per namespace, supported networks), the
 * server-composed settlement transfer (recipient = treasury, exact amount) and how a transfer's durable record settles an attempt (§3.6).
 */
import { describe, expect, it } from 'vitest';
import { composeWorkflow, semanticWorkflowHash, type WorkflowComposition } from '../engine/strategy-engine';
import { collectionBlocker, platformFeeActivation } from './activation';
import { feeBasisDigest } from './authorization';
import { PLATFORM_FEE_BPS, PLATFORM_FEE_POLICY_ID } from './policy';
import { workflowFeeBasis } from './principal';
import { planSettlement, settlementAsset, settlementWorkflow, transferOutcome, SETTLEMENT_WORKFLOW_PREFIX, type Collection } from './settlement';
import { nodeFeeAction, singleFlowEnvironment, singleFlowFeeBasis, singleFlowOutcome } from './single-flow';

const compose = (input: unknown): WorkflowComposition => { const w = composeWorkflow(input); if (!w.ok) throw new Error(`${w.code} ${JSON.stringify(w.issues)}`); return w; };
const USDC_ETH = { chainId: 'eip155:1', address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6 };
const ETH_ETH = { chainId: 'eip155:1', address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', decimals: 18 };
const USDC_SOL = { chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 };
const TREASURY = { evm: '0x8ba1f109551bD432803012645Ac136ddd64DBA72', solana: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin' };
const SWAP_ETH = { action: 'swap', network: 'ethereum', inputAsset: 'USDC', outputAsset: 'ETH', amount: '100', slippageBps: 100 };
const recordOf = (input: unknown, extra: Record<string, unknown> = {}) => ({ review: { workflow: compose(input).steps[0]!.workflow }, ...extra });
const line = (asset: typeof USDC_ETH, principal: string, fee: string) => ({ ...asset, principal, fee });
const ENV = { FLOFI_PLATFORM_FEE_ACCOUNTING_FROM: '2026-11-28T00:00:00Z', FLOFI_PLATFORM_FEE_COLLECTION: 'on', FLOFI_PLATFORM_FEE_TREASURY_EVM: TREASURY.evm,
  FLOFI_PLATFORM_FEE_TREASURY_SOLANA: TREASURY.solana, FLOFI_PLATFORM_FEE_POLICY_APPROVAL: 'FIN-2026-11-28' };

describe('single-flow fee basis (§3.2)', () => {
  it('a direct single swap is charged exactly like a one-step workflow of the same swap', () => {
    const single = singleFlowFeeBasis(recordOf(SWAP_ETH), { final: false });
    const workflow = workflowFeeBasis(compose(SWAP_ETH));
    expect(single.status).toBe('FEEABLE');
    expect(single.lines).toEqual(workflow.lines);
    expect(single.lines).toEqual([line(USDC_ETH, '100000000', '800000')]);
  });
  it('a direct transfer and a direct bridge are feeable; supply too; the final basis never exceeds what was proven spent', () => {
    expect(singleFlowFeeBasis(recordOf({ action: 'transfer', network: 'ethereum', asset: 'USDC', amount: '50', recipient: '0x' + 'b2'.repeat(20) }), { final: false }).lines)
      .toEqual([line(USDC_ETH, '50000000', '400000')]);
    expect(singleFlowFeeBasis(recordOf({ action: 'bridge', sourceNetwork: 'ethereum', destinationNetwork: 'robinhood', asset: 'ETH', amount: '0.04' }), { final: false }).lines)
      .toEqual([line(ETH_ETH, '40000000000000000', '320000000000000')]);
    // The record proves only 60 USDC were spent: the final principal is capped there.
    const spent = recordOf(SWAP_ETH, { spentAmounts: [{ asset: 'eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', amount: '60000000' }] });
    expect(singleFlowFeeBasis(spent, { final: true }).lines).toEqual([line(USDC_ETH, '60000000', '480000')]);
    expect(singleFlowFeeBasis(spent, { final: false }).lines).toEqual([line(USDC_ETH, '100000000', '800000')]);
  });
  it('fails closed: no workflow, an unknown action or a fiat payment are UNSUPPORTED; borrow and liquidity are NOT_APPLICABLE', () => {
    expect(singleFlowFeeBasis({}, { final: true })).toMatchObject({ status: 'UNSUPPORTED', reason: 'PLATFORM_FEE_WORKFLOW_UNREADABLE' });
    expect(nodeFeeAction('payment.pix')).toBeNull();
    expect(nodeFeeAction('asset.liquidity.concentrated')).toBe('NOT_APPLICABLE');
    expect(nodeFeeAction('borrow')).toBe('borrow');
    const record = recordOf(SWAP_ETH);
    expect(singleFlowFeeBasis({ review: { workflow: { ...record.review.workflow, nodes: [{ ...record.review.workflow.nodes[0], actionType: 'payment.pix' }] } } },
      { final: true })).toMatchObject({ status: 'UNSUPPORTED', reason: 'PLATFORM_FEE_ACTION_UNKNOWN' });
    expect(singleFlowFeeBasis(record, { final: true, flow: 'lending-composition' }).status).toBe('NOT_APPLICABLE');
  });
  it('only a reconciled single flow with evidence completes; a revert or divergence is waived; anything else records nothing', () => {
    expect(singleFlowOutcome('RECONCILED', true)).toBe('COMPLETED');
    expect(singleFlowOutcome('RECONCILED', false)).toBeNull();
    for (const s of ['REVERTED', 'DIVERGENT', 'FAILED', 'REFUNDED']) expect(singleFlowOutcome(s, false)).toBe('WAIVED');
    for (const s of ['SIMULATED', 'AUTHORIZED', 'PREPARED', 'SUBMISSION_RESULT_UNKNOWN', 'REJECTED', 'CANCELLED', 'NOT_EXECUTED', 'DESTINATION_OBSERVED'])
      expect(singleFlowOutcome(s, false)).toBeNull();
    expect(singleFlowEnvironment('PUBLIC_MAINNET')).toBe('MAINNET');
    expect(singleFlowEnvironment('PUBLIC_DEVNET')).toBe('PUBLIC_TESTNET');
    expect(singleFlowEnvironment('SOMETHING')).toBeNull();
  });
});

describe('collection activation (§3.7)', () => {
  it('is active only with accounting, the switch, two valid treasuries and the approved policy reference', () => {
    expect(collectionBlocker(ENV)).toBeNull();
    expect(platformFeeActivation(ENV).collection).toEqual({ active: true, code: null });
    expect(collectionBlocker({ ...ENV, FLOFI_PLATFORM_FEE_ACCOUNTING_FROM: undefined })).toBe('PLATFORM_FEE_ACCOUNTING_NOT_ACTIVATED');
    expect(collectionBlocker({ ...ENV, FLOFI_PLATFORM_FEE_COLLECTION: 'off' })).toBe('PLATFORM_FEE_COLLECTION_DISABLED');
    expect(collectionBlocker({ ...ENV, FLOFI_PLATFORM_FEE_TREASURY_EVM: TREASURY.evm.toLowerCase() })).toBe('PLATFORM_FEE_TREASURY_INVALID');
    expect(collectionBlocker({ ...ENV, FLOFI_PLATFORM_FEE_TREASURY_SOLANA: '11111111111111111111111111111111' })).toBe('PLATFORM_FEE_TREASURY_INVALID');
    expect(collectionBlocker({ ...ENV, FLOFI_PLATFORM_FEE_POLICY_APPROVAL: '' })).toBe('PLATFORM_FEE_POLICY_NOT_APPROVED');
  });
  it('the disclosed basis digest is stable and changes with any line', () => {
    const basis = workflowFeeBasis(compose(SWAP_ETH));
    expect(feeBasisDigest(basis)).toMatch(/^[0-9a-f]{64}$/);
    expect(feeBasisDigest({ ...basis })).toBe(feeBasisDigest(basis));
    expect(feeBasisDigest({ ...basis, lines: [{ ...basis.lines[0]!, fee: '800001' }] })).not.toBe(feeBasisDigest(basis));
    expect(basis).toMatchObject({ policyId: PLATFORM_FEE_POLICY_ID, rateBps: PLATFORM_FEE_BPS });
  });
});

describe('settlement plan (§3.1/§3.6)', () => {
  const authorized = { status: 'FEEABLE', lines: [line(USDC_ETH, '100000000', '800000'), line(USDC_SOL, '50000000', '400000')] };
  it('charges per asset at most the authorized fee and at most the final basis, never an unauthorized asset', () => {
    const plan = planSettlement({ authorized, final: [line(USDC_ETH, '60000000', '480000'), line(USDC_SOL, '90000000', '720000'), line(ETH_ETH, '1', '1')],
      collection: null, treasury: TREASURY });
    expect(plan).toMatchObject({ ok: true });
    if (!plan.ok) return;
    expect(plan.transfers.map(t => [t.chainId, t.amount, t.decimal, t.flow, t.recipient, t.asset])).toEqual([
      ['eip155:1', '480000', '0.48', 'ethereum-mainnet-transfer', TREASURY.evm.toLowerCase(), 'USDC'],
      [USDC_SOL.chainId, '400000', '0.4', 'solana-transfer', TREASURY.solana, 'USDC']]);
  });
  it('collects only what remains after verified transactions; nothing remains → nothing planned', () => {
    const collection: Collection = { v: 1, attempt: 1, startedAt: '2026-11-28T00:00:00.000Z', transfers: [], code: 'PLATFORM_FEE_PARTIALLY_COLLECTED',
      transactions: [{ ...USDC_ETH, amount: '800000', hash: '0x' + 'a'.repeat(64), runId: 'ett-' + 'a'.repeat(32) }] };
    const plan = planSettlement({ authorized, final: authorized.lines, collection, treasury: TREASURY });
    expect(plan.ok && plan.transfers.map(t => t.chainId)).toEqual([USDC_SOL.chainId]);
    const none = planSettlement({ authorized: { status: 'FEEABLE', lines: [authorized.lines[0]!] }, final: authorized.lines, collection, treasury: TREASURY });
    expect(none).toEqual({ ok: true, transfers: [] });
  });
  it('refuses an execution whose authorization is not feeable, a test network or an asset it cannot transfer exactly', () => {
    expect(planSettlement({ authorized: { status: 'UNSUPPORTED', lines: [] }, final: authorized.lines, collection: null, treasury: TREASURY }))
      .toEqual({ ok: false, code: 'PLATFORM_FEE_NOT_AUTHORIZED' });
    const sepolia = { chainId: 'eip155:11155111', address: ETH_ETH.address, decimals: 18 };
    expect(planSettlement({ authorized: { status: 'FEEABLE', lines: [line(sepolia, '10', '1')] }, final: [line(sepolia, '10', '1')], collection: null, treasury: TREASURY }))
      .toEqual({ ok: false, code: 'PLATFORM_FEE_SETTLEMENT_NETWORK_UNSUPPORTED' });
    const unknown = { chainId: 'eip155:1', address: '0x' + '1'.repeat(40), decimals: 6 };
    expect(planSettlement({ authorized: { status: 'FEEABLE', lines: [line(unknown, '10', '1')] }, final: [line(unknown, '10', '1')], collection: null, treasury: TREASURY }))
      .toEqual({ ok: false, code: 'PLATFORM_FEE_SETTLEMENT_ASSET_UNSUPPORTED' });
    expect(settlementAsset(ETH_ETH)).toBe('ETH');
    expect(settlementAsset({ ...ETH_ETH, decimals: 6 })).toBeNull();
  });
  it('composes the transfer on the server: treasury recipient, exact amount, a settlement workflow id', () => {
    const plan = planSettlement({ authorized, final: authorized.lines, collection: null, treasury: TREASURY });
    if (!plan.ok) throw new Error(plan.code);
    const { workflow, workflowHash } = settlementWorkflow(plan.transfers[0]!, 'ett-' + 'b'.repeat(32), 1, 0);
    expect(workflow.workflowId).toBe(`${SETTLEMENT_WORKFLOW_PREFIX}ett-${'b'.repeat(32)}.1.0`);
    expect(workflowHash).toBe(semanticWorkflowHash(workflow));
    const node = workflow.nodes.find(n => n.actionType === 'asset.transfer')!;
    expect(JSON.stringify(node)).toContain(TREASURY.evm.toLowerCase());
    expect(JSON.stringify(node)).toContain('"800000"');
  });
});

describe('settlement transfer outcome (§3.6)', () => {
  const plan = planSettlement({ authorized: { status: 'FEEABLE', lines: [line(USDC_ETH, '100000000', '800000')] }, final: [line(USDC_ETH, '100000000', '800000')],
    collection: null, treasury: TREASURY });
  if (!plan.ok) throw new Error(plan.code);
  const { workflow, workflowHash } = settlementWorkflow(plan.transfers[0]!, 'ett-' + 'c'.repeat(32), 1, 0);
  const expected = { workflowHash, recipient: TREASURY.evm.toLowerCase() };
  const base = { review: { workflow, recipient: TREASURY.evm.toLowerCase() }, verdict: 'PENDING', attempt: null as unknown };
  const hash = '0x' + 'd'.repeat(64);
  it('collected only with the flow\'s own reconciled verdict for exactly the composed Review', () => {
    expect(transferOutcome({ ...base, verdict: 'RECONCILED', attempt: { state: 'CONFIRMED', transactionHash: hash, reconciled: true } }, expected))
      .toEqual({ kind: 'COLLECTED', hash });
    expect(transferOutcome({ ...base, verdict: 'RECONCILED', attempt: { state: 'CONFIRMED', transactionHash: hash, reconciled: false } }, expected)).toEqual({ kind: 'PENDING' });
    expect(transferOutcome({ ...base, review: { ...base.review, recipient: '0x' + 'e'.repeat(40) }, verdict: 'RECONCILED',
      attempt: { state: 'CONFIRMED', transactionHash: hash, reconciled: true } }, expected)).toMatchObject({ kind: 'FAILED', attention: true });
    expect(transferOutcome({ ...base, review: { ...base.review, workflow: { ...workflow, revision: 99 } }, verdict: 'RECONCILED',
      attempt: { state: 'CONFIRMED', transactionHash: hash, reconciled: true } }, expected)).toMatchObject({ kind: 'FAILED', code: 'PLATFORM_FEE_SETTLEMENT_REVIEW_MISMATCH' });
  });
  it('an outcome that may still reach the network stays pending; proven failures fail; divergence needs attention', () => {
    for (const state of ['SUBMITTING', 'SUBMISSION_RESULT_UNKNOWN', 'PENDING', 'CONFIRMED', 'NOT_FOUND', 'RECONCILIATION_REQUIRED'])
      expect(transferOutcome({ ...base, attempt: { state, transactionHash: hash, reconciled: false } }, expected)).toEqual({ kind: 'PENDING' });
    expect(transferOutcome(base, expected)).toEqual({ kind: 'UNSIGNED' });
    expect(transferOutcome({ ...base, attempt: { state: 'PREPARED', transactionHash: null, reconciled: false } }, expected)).toEqual({ kind: 'UNSIGNED' });
    expect(transferOutcome({ ...base, notSubmitted: true, attempt: { state: 'CANCELLED' } }, expected)).toMatchObject({ kind: 'FAILED', code: 'PLATFORM_FEE_SETTLEMENT_REJECTED' });
    expect(transferOutcome({ ...base, attempt: { state: 'REVERTED', transactionHash: hash } }, expected)).toMatchObject({ kind: 'FAILED', code: 'PLATFORM_FEE_SETTLEMENT_REVERTED' });
    expect(transferOutcome({ ...base, verdict: 'NOT_EXECUTED' }, expected)).toMatchObject({ kind: 'FAILED', code: 'PLATFORM_FEE_SETTLEMENT_NOT_EXECUTED' });
    expect(transferOutcome({ ...base, verdict: 'DIVERGENT' }, expected)).toEqual({ kind: 'FAILED', code: 'PLATFORM_FEE_SETTLEMENT_DIVERGENT', attention: true });
    expect(transferOutcome(null, expected)).toEqual({ kind: 'PENDING' });
  });
});
