// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Round 4 F5: a DUE group refused for an asset no batch may ever move (a Stock Token, a token outside the network's catalog, another scale of
 * decimals) is a PERMANENT refusal: the group is blocked and the run halted at once, and Resume runs its steps through their own owner-signed
 * flows — instead of the run staying RUNNING until its expiry while every preparation is refused again.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PERMANENT_DUE_REFUSALS, resumeRun, type WorkflowRunDeps } from './service.ts';
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
