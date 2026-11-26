// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001: the pure gates of the Editor's single-card run — the Canvas conversion of ONE card (only on the
 * Editor's explicit opt-in), the run-of-one plan and gates (only on request; MCP / Developer API / channels keep their one-step SINGLE_FLOW
 * contract), the approval service's Editor-only opt-in, and the delivered amount a completed run proves for the card's output asset.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { baseAssetRegistry, referenceRegistry } from '@defi-workflow-engine/action-registry';
import { createReviewContext } from '@defi-workflow-engine/reference-linter';
import { parseLocalCommand } from '../domain/commands';
import { editorReducer, initialEditor, type EditorState } from '../domain/editor';
import type { Workflow } from '../domain/initial-workflow';
import { deliveredByRun, SEQUENCE_RUNTIMES, SINGLE_CARD_RUNTIMES, singleCardFallsBack, localExecutionHolds } from '../domain/workflow-sequence';
import { composeWorkflow } from '../engine/strategy-engine';
import { evaluateWorkflowGates, readHandoffPolicy, workflowPlan } from '../mcp/execution.ts';
import type { McpRuntime } from '../mcp/runtime.ts';
import { approvalLinkScheme, requestApproval, type ApprovalDeps, type HandoffRecord, type HandoffStore } from '../platform/index.ts';
import { ensureForClaim } from '../workflow-runs/service.ts';
import { withdrawUnstartedHandoff } from './approval';
import { editorWorkflowStrategy } from './workflow-strategy';

const context = createReviewContext({ registryId: referenceRegistry.registryId, capabilityId: referenceRegistry.capabilities[0]!.id, actionId: referenceRegistry.actions[0]!.id,
  assets: baseAssetRegistry });
const OWNER = '0x1111111111111111111111111111111111111111';
function author(...sentences: string[]): Workflow {
  let state: EditorState = initialEditor();
  for (const sentence of sentences) {
    state = editorReducer(state, parseLocalCommand(sentence, state.workflow, context, OWNER), context);
    expect(state.error, sentence).toBeNull();
  }
  return state.workflow;
}
const SWAP = 'swap 10 USDC to WETH on Base slippage 100 bps';
const V1_SWAP = { version: 1, action: 'swap', network: 'base', inputAsset: 'USDC', outputAsset: 'WETH', amount: '10', slippageBps: 100 };

describe('BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001: Canvas conversion of ONE card', () => {
  it('is refused by default and accepted on the Editor\'s opt-in as the step\'s own strategy and hash (the MCP / Developer identity)', () => {
    const card = author(SWAP);
    expect(editorWorkflowStrategy(card)).toEqual({ ok: false, code: 'EDITOR_WORKFLOW_SINGLE_STEP' });
    const single = editorWorkflowStrategy(card, { singleStep: true });
    if (!single.ok) throw new Error(single.code);
    expect(single.stepCount).toBe(1);
    expect(single.strategy).toEqual(V1_SWAP);
    const composed = composeWorkflow(V1_SWAP);
    expect(composed.ok && composed.workflowHash).toBe(single.workflowHash);
  });

  it('covers every single card the user-funded groups build: swap, bridge, Aave supply / borrow / repay / withdraw, transfer', () => {
    const cases: [string, string][] = [[SWAP, 'swap'], ['bridge 5 USDC from Base to Arbitrum', 'bridge'],
      [`supply 5 USDC to Aave on Arbitrum One beneficiary ${OWNER}`, 'supply'], [`borrow 1 USDC from Aave on Arbitrum One beneficiary ${OWNER}`, 'borrow'],
      [`repay 1 USDC to Aave on Arbitrum One beneficiary ${OWNER}`, 'repay'], ['withdraw 2 USDC from Aave on Arbitrum One', 'withdraw'],
      ['send 1 USDC on Base to 0x2222222222222222222222222222222222222222', 'transfer']];
    for (const [sentence, action] of cases) {
      const result = editorWorkflowStrategy(author(sentence), { singleStep: true });
      if (!result.ok) throw new Error(`${sentence}: ${result.code}`);
      expect((result.strategy as { action: string }).action, sentence).toBe(action);
    }
  });

  it('the opt-in changes nothing for a sequence, and an empty or composition workflow is still refused', () => {
    const two = author(SWAP, 'swap 0.004 WETH to USDC on Base slippage 100 bps');
    const plain = editorWorkflowStrategy(two), opted = editorWorkflowStrategy(two, { singleStep: true });
    expect(opted).toEqual(plain);
    expect(editorWorkflowStrategy(initialEditor().workflow, { singleStep: true })).toMatchObject({ ok: false });
  });
});

describe('BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001: the run-of-one plan and gates are only ever asked for', () => {
  const composed = composeWorkflow(V1_SWAP);
  if (!composed.ok) throw new Error(composed.code);
  const runtime = (sequences: boolean): McpRuntime => ({ kind: 'embedded', mode: async () => 'harness', info: async () => ({ executionEnabled: true }),
    preview: async () => ({ ok: false, code: 'PREVIEW_NOT_USED' }), sequences: async () => ({ enabled: sequences, delegation: null }) }) as unknown as McpRuntime;
  const policy = readHandoffPolicy({ FLOFI_MCP_HANDOFF_MAINNET_NETWORKS: 'base' });

  it('one step stays SINGLE_FLOW by default (the public contract) and is a SEQUENTIAL run of that one step only on request', () => {
    expect(workflowPlan(composed)).toMatchObject({ kind: 'SINGLE_FLOW', flow: 'base-swap' });
    const run = workflowPlan(composed, { run: true });
    expect(run).toMatchObject({ kind: 'SEQUENTIAL', flow: null, reason: null, fundsClass: 'REAL_FUNDS' });
    expect(run.steps).toHaveLength(1);
    expect(run.steps[0]).toMatchObject({ index: 0, action: 'swap', flow: 'base-swap', network: 'base' });
  });

  it('the run gates add the workflow-run gate a one-step handoff never consults (WORKFLOW_RUNS_NOT_ENABLED)', async () => {
    expect((await evaluateWorkflowGates(composed, runtime(false), policy)).handoff).toEqual({ allowed: true, reason: null });
    expect((await evaluateWorkflowGates(composed, runtime(false), policy, { run: true })).handoff).toEqual({ allowed: false, reason: 'WORKFLOW_RUNS_NOT_ENABLED' });
    const open = await evaluateWorkflowGates(composed, runtime(true), policy, { run: true });
    expect(open).toMatchObject({ plan: { kind: 'SEQUENTIAL' }, handoff: { allowed: true, reason: null }, supportedByCode: { plan: 'SEQUENTIAL', steps: [{ index: 0, flow: 'base-swap' }] } });
  });

  it('only the Editor\'s requester may ask the approval service for a one-step run, and only for exactly one step', async () => {
    const untouched = new Proxy({}, { get: () => () => { throw new Error('STORE_TOUCHED'); } }) as unknown as HandoffStore;
    const deps = (kinds: Parameters<typeof approvalLinkScheme>[2]): ApprovalDeps => ({ origin: 'http://localhost:3999', scheme: approvalLinkScheme('flofi_edhs_', randomBytes(32), kinds),
      handoffs: untouched, allow: async () => true, runtime: runtime(true), policy, rules: { handoffSeconds: 900, maxPending: 3, rate: [20, 3_600], supersedeSameWorkflow: true },
      now: new Date() });
    // Every external requester kind is refused before anything is composed, rate-limited or stored (the store double throws if touched).
    const external = [
      { kind: 'CHANNEL_CONVERSATION' as const, ref: 'cnv_singlecardrun000000001', clientId: 'telegram-test-bot', displayName: 'Telegram', context: {} },
      { kind: 'MCP_ACCOUNT' as const, ref: 'acct_' + 'b'.repeat(26), grantId: 'grt_' + 'c'.repeat(26), clientId: 'mcp-test-client', displayName: 'Claude' },
      { kind: 'AUTOMATION_RULE' as const, ref: 'aut_' + 'd'.repeat(26), clientId: 'flofi-automations', displayName: 'Automation', context: {} },
      { kind: 'DEVELOPER_PROJECT' as const, ref: 'prj_' + 'e'.repeat(26), clientId: 'developer-test-client', displayName: 'Developer', context: {} }];
    let allowed = 0;
    for (const requester of external) {
      const d = { ...deps([requester.kind]), allow: async () => { allowed++; return true; } };
      expect(await requestApproval(d, requester, composed.strategy, composed.workflowHash, { singleStepRun: true }), requester.kind)
        .toEqual({ ok: false, code: 'APPROVAL_REQUESTER_INVALID' });
    }
    expect(allowed).toBe(0);
    const two = composeWorkflow({ version: 2, steps: [V1_SWAP, { ...V1_SWAP, inputAsset: 'WETH', outputAsset: 'USDC', amount: '0.004' }] });
    if (!two.ok) throw new Error(two.code);
    const editor = { kind: 'EDITOR_SESSION' as const, ref: 'acct_' + 'a'.repeat(26), clientId: 'flofi-editor', displayName: 'FloFi Editor', context: {} };
    expect(await requestApproval(deps(['EDITOR_SESSION']), editor, two.strategy, two.workflowHash, { singleStepRun: true }))
      .toEqual({ ok: false, code: 'EDITOR_WORKFLOW_NOT_SEQUENCE' });
  });
});

describe('BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001: what a completed one-step run proves it delivered', () => {
  const ARB = 'eip155:42161', USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
  it('reads exactly the card\'s output asset from the run\'s reconciled step outcome, never another asset or an ambiguous answer', () => {
    const output = { chainId: ARB, address: USDC, decimals: 6 };
    expect(deliveredByRun([{ asset: `${ARB}/erc20:${USDC.toUpperCase().replace('0X', '0x')}`, amount: '1599000' }], output)).toBe('1599000');
    expect(deliveredByRun([{ asset: `${ARB}/erc20:0x${'1'.repeat(40)}`, amount: '5' }], output)).toBeNull();
    expect(deliveredByRun([{ asset: `${ARB}/erc20:${USDC}`, amount: '1' }, { asset: `${ARB}/erc20:${USDC}`, amount: '2' }], output)).toBeNull();
    expect(deliveredByRun([{ asset: `${ARB}/erc20:${USDC}`, amount: '-1' }], output)).toBeNull();
    expect(deliveredByRun([{ asset: `${ARB}/native:ETH`, amount: '42' }], { chainId: ARB, address: null, decimals: 18 })).toBe('42');
    expect(deliveredByRun([], output)).toBeNull();
    expect(deliveredByRun([{ asset: `${ARB}/erc20:${USDC}`, amount: '1' }], null)).toBeNull();
  });
  it('offers the one-confirmation run only to runtimes the user-funded EVM groups build (each one is also a sequence runtime)', () => {
    expect([...SINGLE_CARD_RUNTIMES].sort()).toEqual(['public', 'router', 'supply', 'transfer']);
    for (const kind of SINGLE_CARD_RUNTIMES) expect(SEQUENCE_RUNTIMES).toContain(kind);
    for (const kept of ['universal', 'uniswap-pool', 'solana-swap', 'solana-transfer', 'solana-pool']) expect(SINGLE_CARD_RUNTIMES).not.toContain(kept);
  });
});

describe('BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001: a run of ONE step exists only for the Editor\'s own handoff', () => {
  it('ensureForClaim refuses a one-step SEQUENTIAL handoff of any other requester before anything is created', async () => {
    const composed = composeWorkflow(V1_SWAP);
    if (!composed.ok) throw new Error(composed.code);
    const plan = workflowPlan(composed, { run: true });
    const untouched = new Proxy({}, { get: () => () => { throw new Error('STORE_TOUCHED'); } });
    const deps = { store: untouched, now: () => new Date(), newId: () => 'wfr_' + 'a'.repeat(26) } as unknown as Parameters<typeof ensureForClaim>[0];
    const wallets = [{ namespace: 'eip155' as const, address: OWNER }];
    for (const requesterKind of ['MCP_ACCOUNT', 'CHANNEL_CONVERSATION', 'DEVELOPER_PROJECT', 'AUTOMATION_RULE'] as const) {
      const handoff = { handoffId: 'apr_' + 'a'.repeat(26), requesterKind, requesterRef: 'ref', plan, workflowHash: composed.workflowHash, claimed: null } as unknown as HandoffRecord;
      await expect(ensureForClaim(deps, handoff, composed, wallets), requesterKind).rejects.toThrow('WORKFLOW_RUN_NOT_SEQUENTIAL');
    }
    // A one-step plan stored as SINGLE_FLOW never becomes a run, whoever asked.
    const single = { handoffId: 'apr_' + 'a'.repeat(26), requesterKind: 'EDITOR_SESSION', requesterRef: 'ref', plan: workflowPlan(composed), workflowHash: composed.workflowHash,
      claimed: null } as unknown as HandoffRecord;
    await expect(ensureForClaim(deps, single, composed, wallets)).rejects.toThrow('WORKFLOW_RUN_NOT_SEQUENTIAL');
  });

  it('a failed Authorize withdraws only its own handoff, only while no run exists for it; an unreadable run store withdraws nothing (final security review)', async () => {
    const ACCOUNT = 'acct_' + 'a'.repeat(32), APPROVAL = 'apr_' + 'b'.repeat(26), now = new Date();
    const revoked: unknown[][] = [];
    const handoffs = { revokeForRequester: async (...args: unknown[]) => { revoked.push(args); return { status: 'REVOKED' } as unknown as HandoffRecord; } };
    expect(await withdrawUnstartedHandoff({ handoffs, runFor: async () => ({ runId: 'wfr_1' }) }, ACCOUNT, APPROVAL, now)).toBe(false);
    expect(revoked).toEqual([]);
    await expect(withdrawUnstartedHandoff({ handoffs, runFor: async () => { throw new Error('ECONNRESET'); } }, ACCOUNT, APPROVAL, now)).rejects.toThrow('ECONNRESET');
    expect(revoked).toEqual([]);
    expect(await withdrawUnstartedHandoff({ handoffs, runFor: async () => null }, 'not-an-account', APPROVAL, now)).toBe(false);
    expect(revoked).toEqual([]);
    expect(await withdrawUnstartedHandoff({ handoffs, runFor: async () => null }, ACCOUNT, APPROVAL, now)).toBe(true);
    expect(revoked).toEqual([[APPROVAL, { kind: 'EDITOR_SESSION', ref: ACCOUNT }, now]]);
  });

  it('a single card goes back to its own flow when its Review is step by step, refuses, or could not answer at all; never once its run started', () => {
    const base = { started: false, review: null, stepByStep: false, error: null };
    expect(singleCardFallsBack(base)).toBe(false); // not reviewed yet: the whole-workflow path stays primary
    expect(singleCardFallsBack({ ...base, review: { mode: 'ONE_WALLET_CONFIRMATION', refusal: null } })).toBe(false);
    expect(singleCardFallsBack({ ...base, review: { mode: 'STEP_BY_STEP', refusal: null } })).toBe(true);
    expect(singleCardFallsBack({ ...base, review: { mode: 'ONE_WALLET_CONFIRMATION', refusal: { code: 'SIMULATION_REVERTED' } } })).toBe(true);
    // Final workflow review: a Review that could not answer (rate limited, RPC or server failure) never hides the card's own flow.
    for (const error of ['EDITOR_REVIEW_RATE_LIMITED', 'USER_FUNDED_RPC_UNAVAILABLE', 'EDITOR_EXECUTION_FAILED']) expect(singleCardFallsBack({ ...base, error })).toBe(true);
    // No connected wallet keeps the whole-workflow path and its connect reason (final frontend-ux review: no silent flip).
    expect(singleCardFallsBack({ ...base, error: 'EVM_WALLET_REQUIRED' })).toBe(false);
    // A started run always stays on its path, whatever its Review or errors say.
    expect(singleCardFallsBack({ ...base, started: true, review: { mode: 'STEP_BY_STEP', refusal: null }, error: 'EDITOR_EXECUTION_FAILED', stepByStep: true })).toBe(false);
  });
});

describe('execution UX regression fixes: one wallet confirmation for a simple card after an earlier execution in the tab', () => {
  const none = { current: false, started: false, unfinished: false, recorded: false, sequence: null };
  it('a FINISHED run of another workflow that the runtime still holds never sends a single card to its own multi-prompt flow', () => {
    expect(localExecutionHolds({ ...none, started: true })).toBe(false);
    expect(localExecutionHolds(none)).toBe(false);
  });
  it('anything that may still execute keeps holding the whole-workflow path (never executed twice)', () => {
    expect(localExecutionHolds({ ...none, current: true, started: true, unfinished: true })).toBe(true); // a run of this workflow, or any run in flight
    // A detached run (the owner chose "Create new workflow" while it was submitted) that is not final: its flow's own guard stays in force.
    expect(localExecutionHolds({ ...none, started: true, unfinished: true })).toBe(true);
    expect(localExecutionHolds({ ...none, recorded: true })).toBe(true);                 // a start recorded for this workflow
  });
  it('a step-by-step sequence keeps its former rule', () => {
    expect(localExecutionHolds({ ...none, started: true, sequence: { cursor: 0, completed: [] } })).toBe(true);
    expect(localExecutionHolds({ ...none, sequence: { cursor: 1, completed: [] } })).toBe(true);
    expect(localExecutionHolds({ ...none, sequence: { cursor: 0, completed: [{}] } })).toBe(true);
    expect(localExecutionHolds({ ...none, sequence: { cursor: 0, completed: [] } })).toBe(false);
  });
});
