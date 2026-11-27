// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Round 4 F5: a DUE group refused for an asset no batch may ever move (a Stock Token, a token outside the network's catalog, another scale of
 * decimals) is a PERMANENT refusal: the group is blocked and the run halted at once, and Resume runs its steps through their own owner-signed
 * flows — instead of the run staying RUNNING until its expiry while every preparation is refused again.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { composeWorkflow } from '../engine/strategy-engine';
import { PERMANENT_DUE_REFUSALS, resumeRefusal, resumeRun, runView, type WorkflowRunDeps } from './service.ts';
import type { GroupRecord, RunRecord, RunStepRecord } from './pg-store.ts';
import { GASLESS_STEP_MODE_CODE } from '../user-funded/gasless-groups.ts';
import { EXECUTION_REFUSAL, reviewOffersStepByStep } from '../components/editor-workflow-run.tsx';
import { translate } from '../i18n/translate';

describe('round 4 F5: an asset no batch may move is a permanent due-time refusal', () => {
  it('USER_FUNDED_TRANSFER_ASSET_UNSUPPORTED and USER_FUNDED_SWAP_ASSET_UNSUPPORTED halt and resume step by step', () => {
    for (const code of ['USER_FUNDED_TRANSFER_ASSET_UNSUPPORTED', 'USER_FUNDED_SWAP_ASSET_UNSUPPORTED']) {
      expect(PERMANENT_DUE_REFUSALS.has(code), code).toBe(true);
      // The batch builder still raises exactly this closed code (a renamed code would silently stop being permanent).
      expect(readFileSync(new URL('../user-funded/evm-calls.ts', import.meta.url), 'utf8')).toContain(`'${code}'`);
    }
    // A transient refusal is never permanent: it is retried while the run is open.
    for (const code of ['USER_FUNDED_RPC_UNAVAILABLE', 'USER_FUNDED_PREPARED_STILL_VALID', 'WORKFLOW_RUN_EXPIRED']) expect(PERMANENT_DUE_REFUSALS.has(code), code).toBe(false);
  });
});

describe('review Z1: a short-ETH Robinhood Chain batch of gasless-eligible swaps halts the run, and Resume runs each swap on its own', () => {
  const OWNER = '0x' + '1a'.repeat(20), NOW = new Date('2026-11-13T12:00:00Z'), RUN = 'wfr_' + 'z'.repeat(26);
  const SWAP = { action: 'swap', network: 'robinhood', inputAsset: 'WETH', outputAsset: 'USDG', amount: '0.001', slippageBps: 50 };
  it('USER_FUNDED_GASLESS_REQUIRES_STEP_MODE is permanent (the run halts instead of staying RUNNING until it expires)', () => {
    expect(GASLESS_STEP_MODE_CODE).toBe('USER_FUNDED_GASLESS_REQUIRES_STEP_MODE');
    expect(PERMANENT_DUE_REFUSALS.has(GASLESS_STEP_MODE_CODE)).toBe(true);
    expect(readFileSync(new URL('../user-funded/groups.ts', import.meta.url), 'utf8')).toContain('gaslessStepModeRefusal(requirement, g)');
  });
  it('Resume plans the blocked group as owner steps (each swap through its own flow, robinhood-swap), never the same batch again', async () => {
    const run = { runId: RUN, handoffId: 'apr_' + 'z'.repeat(26), mode: 'USER_FUNDED', state: 'HALTED', stepCount: 2, currentStep: 0, code: GASLESS_STEP_MODE_CODE,
      strategy: { version: 2, steps: [SWAP, { ...SWAP, inputAsset: 'USDG', outputAsset: 'WETH', amount: '1' }] }, workflowHash: '0x' + '1'.repeat(64), wallets: { eip155: OWNER },
      owner: { namespace: 'eip155', address: OWNER }, version: 4, completedAt: null, expiresAt: new Date(NOW.getTime() + 3_600_000), createdAt: NOW, updatedAt: NOW } as unknown as RunRecord;
    const step = (stepIndex: number) => ({ runId: RUN, stepIndex, state: 'BLOCKED', flow: null, strategy: null, workflowHash: null, bound: null, claimedAt: null, outcome: null,
      code: GASLESS_STEP_MODE_CODE, version: 1, updatedAt: NOW }) as unknown as RunStepRecord;
    // What blockDueGroup stored: the group refused at due time before any batch was handed out (prepared: null).
    const group = { runId: RUN, groupIndex: 0, namespace: 'eip155', chain: 'eip155:4663', feePayer: OWNER, stepFrom: 0, stepTo: 1, strategy: 'EVM_WALLET_BATCH', signing: 'WHEN_DUE',
      awaitsDelivery: null, state: 'BLOCKED', code: GASLESS_STEP_MODE_CODE, validUntil: null, version: 2, prepared: null, authorization: null, submission: null, outcome: null } as unknown as GroupRecord;
    const calls: unknown[][] = [];
    const store = { steps: async () => [step(0), step(1)], groups: async () => [group], byId: async () => null,
      transition: async (...args: unknown[]) => { calls.push(['run', ...args]); return run; },
      groupTransition: async (...args: unknown[]) => { calls.push(['group', ...args]); return group; },
      stepTransition: async (...args: unknown[]) => { calls.push(['step', ...args]); return true; } };
    await resumeRun({ store, now: () => NOW, log: () => undefined } as unknown as WorkflowRunDeps, run, [{ namespace: 'eip155', address: OWNER }]);
    expect(calls).toContainEqual(['group', RUN, 0, ['BLOCKED'], 'PLANNED', expect.objectContaining({ strategy: 'EVM_OWNER_STEP', signing: 'WHEN_DUE', prepared: null }), 'GROUP_RESUMED']);
    // Each step waits for its own owner-signed flow (PENDING), never DELEGATED to a batch.
    expect(calls.filter(call => call[0] === 'step')).toEqual([['step', RUN, 0, ['BLOCKED'], 'PENDING', { code: null }, 'STEP_RESUMED'],
      ['step', RUN, 1, ['BLOCKED'], 'PENDING', { code: null }, 'STEP_RESUMED']]);
  });
  it('the Editor\'s Review offers the step-by-step path for it, and the Editor and /approve word it the same, in EN and PT, without promising "free"', () => {
    expect(reviewOffersStepByStep({ mode: 'ONE_WALLET_CONFIRMATION', refusal: { code: GASLESS_STEP_MODE_CODE, step: 0 } } as never)).toBe(true);
    const text = EXECUTION_REFUSAL[GASLESS_STEP_MODE_CODE]!;
    expect(text).toMatch(/nothing was sent.*one step at a time/);
    const approve = /\n {2}USER_FUNDED_GASLESS_REQUIRES_STEP_MODE: '((?:[^'\\]|\\.)*)',/.exec(readFileSync(new URL('../components/approval-handoff.tsx', import.meta.url), 'utf8'))?.[1]?.replace(/\\(.)/g, '$1');
    expect(approve).toBe(text);
    expect(translate('PT', text)).toMatch(/^A sua carteira não tem ETH suficiente na Robinhood Chain/);
    expect(translate('PT', text)).not.toMatch(/grátis|sem taxas|patrocinad/i);
  });
});

describe('KAN-20: a Solana Batch Payment refused for good is never split, and an earlier request that landed is never prepared again', () => {
  const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', OWNER = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', NOW = new Date('2026-11-27T12:00:00Z');
  const RUN = 'wfr_' + 's'.repeat(26);
  const BATCH = { action: 'batch_payment', network: 'solana', asset: 'SOL', recipients: [{ recipient: '7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2', amount: '0.01' },
    { recipient: 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi', amount: '0.02' }] };
  const compiler = readFileSync(new URL('../../../../packages/reference-compiler/src/solana-batch-payment.ts', import.meta.url), 'utf8');
  const groups = readFileSync(new URL('../user-funded/groups.ts', import.meta.url), 'utf8');
  const DETERMINISTIC = ['TRANSACTION_TOO_LARGE', 'TOO_MANY_ACCOUNTS', 'INSTRUCTION_TRACE_TOO_LONG', 'COMPUTE_LIMIT_EXCEEDED', 'ASSET_UNSUPPORTED', 'RECIPIENT_RESERVED',
    'RECIPIENT_OFF_CURVE', 'RECIPIENT_IS_SENDER', 'RECIPIENT_INVALID', 'DUPLICATE_RECIPIENT', 'AMOUNT_OUT_OF_RANGE', 'TOTAL_OUT_OF_RANGE', 'ISOLATED_ONLY', 'DECLARATION_INVALID',
    'NETWORK_UNSUPPORTED'];
  const APP = ['LEG_MISMATCH', 'BINDING_NOT_EXACT', 'KORA_UNSUPPORTED', 'GROUP_INVALID'];

  it('the deterministic batch refusals are permanent (each still raised by its module); balance refusals and the C.4 outcomes are not', () => {
    for (const reason of DETERMINISTIC) {
      expect(PERMANENT_DUE_REFUSALS.has(`SOLANA_BATCH_PAYMENT_${reason}`), reason).toBe(true);
      expect(compiler, reason).toContain(`fail('${reason}'`);
    }
    // TOKEN_EXTENSION_UNSUPPORTED is the shared single-transfer check re-raised with the batch prefix.
    expect(PERMANENT_DUE_REFUSALS.has('SOLANA_BATCH_PAYMENT_TOKEN_EXTENSION_UNSUPPORTED')).toBe(true);
    expect(readFileSync(new URL('../../../../packages/reference-compiler/src/solana-transfer.ts', import.meta.url), 'utf8')).toContain('TOKEN_EXTENSION_UNSUPPORTED');
    for (const reason of APP) {
      expect(PERMANENT_DUE_REFUSALS.has(`SOLANA_BATCH_PAYMENT_${reason}`), reason).toBe(true);
      expect(groups, reason).toContain(`'SOLANA_BATCH_PAYMENT_${reason}'`);
    }
    for (const code of ['SOLANA_BATCH_PAYMENT_INSUFFICIENT_SOL', 'SOLANA_BATCH_PAYMENT_INSUFFICIENT_TOKEN_BALANCE', 'SOLANA_BATCH_PAYMENT_AMOUNT_BELOW_RENT_EXEMPT',
      'SOLANA_BATCH_PAYMENT_EARLIER_REQUEST_LIVE', 'BATCH_PAYMENT_EARLIER_REQUEST_UNPROVEN', 'BATCH_PAYMENT_EARLIER_REQUEST_LANDED', 'BATCH_PAYMENT_EARLIER_REQUEST_UNPROVABLE',
      'SOLANA_BATCH_PAYMENT_ANSWER_MISMATCH', 'SOLANA_BATCH_PAYMENT_TRANSACTION_CHANGED']) expect(PERMANENT_DUE_REFUSALS.has(code), code).toBe(false);
  });

  const records = (code: string) => {
    const composed = composeWorkflow(BATCH);
    if (!composed.ok) throw new Error(composed.code);
    const run = { runId: RUN, handoffId: 'apr_' + 's'.repeat(26), mode: 'USER_FUNDED', state: 'HALTED', stepCount: 2, currentStep: 0, code, strategy: composed.strategy,
      workflowHash: composed.workflowHash, wallets: { solana: OWNER }, owner: { namespace: 'solana', address: OWNER }, version: 4, completedAt: null,
      expiresAt: new Date(NOW.getTime() + 3_600_000), createdAt: NOW, updatedAt: NOW } as unknown as RunRecord;
    const step = (stepIndex: number) => ({ runId: RUN, stepIndex, state: 'BLOCKED', flow: null, strategy: null, workflowHash: null, bound: null, claimedAt: null, outcome: null,
      code, version: 1, updatedAt: NOW }) as unknown as RunStepRecord;
    const group = { runId: RUN, groupIndex: 0, namespace: 'solana', chain: SOLANA, feePayer: OWNER, stepFrom: 0, stepTo: 1, strategy: 'SOLANA_SIGN_ALL', signing: 'UPFRONT',
      awaitsDelivery: null, state: 'BLOCKED', code, validUntil: null, version: 2, prepared: code.startsWith('BATCH_PAYMENT_EARLIER') ? { kind: 'SOLANA_SIGN_ALL' } : null,
      authorization: null, submission: null, outcome: null } as unknown as GroupRecord;
    return { run, steps: [step(0), step(1)], groups: [group] };
  };

  it('Resume of a batch blocked for good answers BATCH_PAYMENT_REQUIRES_ATOMIC_EXECUTION; never its legs through their own flows', async () => {
    const { run, steps, groups } = records('SOLANA_BATCH_PAYMENT_TRANSACTION_TOO_LARGE');
    expect(resumeRefusal(run, steps, groups, NOW)).toBe('BATCH_PAYMENT_REQUIRES_ATOMIC_EXECUTION');
    const calls: unknown[] = [];
    const store = { steps: async () => steps, groups: async () => groups, byId: async () => run, transition: async (...a: unknown[]) => { calls.push(a); return run; },
      groupTransition: async (...a: unknown[]) => { calls.push(a); return groups[0]; }, stepTransition: async (...a: unknown[]) => { calls.push(a); return true; } };
    await expect(resumeRun({ store, now: () => NOW, log: () => undefined } as unknown as WorkflowRunDeps, run, [{ namespace: 'solana', address: OWNER }]))
      .rejects.toThrow('BATCH_PAYMENT_REQUIRES_ATOMIC_EXECUTION');
    expect(calls).toEqual([]);
  });

  it('an earlier request that landed (or can never be proven not to have): Resume answers that code, and the run is never "nothing sent"', async () => {
    for (const code of ['BATCH_PAYMENT_EARLIER_REQUEST_LANDED', 'BATCH_PAYMENT_EARLIER_REQUEST_UNPROVABLE']) {
      const { run, steps, groups } = records(code);
      expect(resumeRefusal(run, steps, groups, NOW), code).toBe(code);
      const view = await runView({ store: { steps: async () => steps, groups: async () => groups }, now: () => NOW }, run, { outcomes: true, owner: true });
      expect(view, code).toMatchObject({ state: 'HALTED', halted: 'STOPPED', resumable: false, nextAction: 'OWNER_DECIDES' });
    }
    // The same run stopped by a refusal before anything was handed out is "nothing sent" (unchanged).
    const { run, steps, groups } = records('SOLANA_BATCH_PAYMENT_TRANSACTION_TOO_LARGE');
    expect((await runView({ store: { steps: async () => steps, groups: async () => groups }, now: () => NOW }, run, { outcomes: true })).halted).toBe('NOTHING_SENT');
  });
});
