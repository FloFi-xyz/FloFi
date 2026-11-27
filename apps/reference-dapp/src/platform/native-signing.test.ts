// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-ADMIN-ANALYTICS-AND-SOLANA-BATCH-001 (KAN-20, WS02 evaluation A.1 / T1): native channel signing (PR #259) drives exactly ONE SINGLE_FLOW
 * execution-run flow. A Solana Batch Payment always composes to 2..8 transfer legs, so it is planned SEQUENTIAL with no flow of its own and executes as one
 * workflow-run user-funded SOLANA_SIGN_ALL group: there is no flow for native signing to call, and the approval keeps FloFi's /approve page. A single
 * Solana transfer stays natively signable. Pure: composition and planning only, nothing signed or sent.
 */
import { describe, expect, it } from 'vitest';
import { composeWorkflow, type WorkflowComposition } from '../engine/strategy-engine';
import { workflowPlan } from '../mcp/execution';
import { NATIVE_SIGNING_FLOWS, nativeSigningEligible } from './native-signing';

// Seed-derived Ed25519 wallet keys (on the curve; never paid).
const A = '2CERLkG39Jq8zc8FaVkmHjkpsptwQVFMwzvWQgdtmCzb', B = 'C4o8DvwfiPWCQPPH4AfDLBtG7vbCixVKYdwj1S4pDrty';
const BATCH = { action: 'batch_payment', network: 'solana', asset: 'SOL', recipients: [{ recipient: A, amount: '0.01' }, { recipient: B, amount: '0.02' }] };
const TRANSFER = { action: 'transfer', network: 'solana', asset: 'SOL', amount: '0.01', recipient: A };
const compose = (input: unknown): WorkflowComposition => { const w = composeWorkflow(input); if (!w.ok) throw new Error(w.code); return w; };

describe('KAN-20 T1: a Solana Batch Payment is never natively signed', () => {
  it('a real 2-recipient Solana SOL batch is SEQUENTIAL with no flow (each leg a solana-transfer step), so it is not natively signable', () => {
    const batch = compose(BATCH);
    expect(batch.batches).toMatchObject([{ step: 0, from: 0, to: 1, network: 'solana', asset: 'SOL', recipients: 2 }]);
    const plan = workflowPlan(batch);
    expect(plan).toMatchObject({ kind: 'SEQUENTIAL', flow: null, reason: null });
    expect(plan.steps.map(step => step.flow)).toEqual(['solana-transfer', 'solana-transfer']);
    expect(nativeSigningEligible({ plan })).toBe(false);
    // Whatever the leg flows, a SEQUENTIAL plan is never eligible (eligibility is SINGLE_FLOW on a native signing flow only).
    for (const flow of NATIVE_SIGNING_FLOWS) expect(nativeSigningEligible({ plan: { ...plan, flow } as typeof plan }), flow).toBe(false);
  });

  it('a single Solana transfer stays SINGLE_FLOW solana-transfer and natively signable (unchanged)', () => {
    const plan = workflowPlan(compose(TRANSFER));
    expect(plan).toMatchObject({ kind: 'SINGLE_FLOW', flow: 'solana-transfer' });
    expect(nativeSigningEligible({ plan })).toBe(true);
  });
});
