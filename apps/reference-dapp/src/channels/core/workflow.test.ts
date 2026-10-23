// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-E2E-001: multi-step workflows in a channel conversation — authored step by step (ADD STEP keeps a step; the next message authors the
 * next one; REMOVE / MOVE edit the list), composed as ONE canonical workflow with the same parity guard as a single command, and reported back
 * from the run's durable state (outcomes only while the owner shares status). No model is needed for any of it.
 */
import { describe, expect, it } from 'vitest';
import { composeWorkflow } from '../../engine/strategy-engine';
import type { HandoffRecord } from '../../platform/index.ts';
import { decideTurn, freshState, parseState, type ChannelState, type TurnDecision } from './conversation.ts';
import { plannedNotifications, statusReplies } from './status.ts';
import { canonicalWorkflow } from './strategy.ts';

const SWAP = 'swap 1 USDC to WETH on Base Sepolia slippage 50 bps', BRIDGE = 'bridge 5 USDC from Base Sepolia to Arbitrum Sepolia via auto slippage 50 bps';
function chat(language: 'EN' | 'PT' = 'EN') {
  let state: ChannelState = freshState(language);
  const say = async (text: string): Promise<TurnDecision> => {
    const decided = await decideTurn({ content: { kind: 'TEXT', text }, state, optedOut: false, interpret: null, support: 's@flofi.test', privacy: 'https://flofi.test/p' });
    state = parseState(JSON.stringify(decided.state), language);
    return decided;
  };
  return { say, get state() { return state; } };
}

describe('BUILD-CHAT-E2E-001 channel workflows', () => {
  it('ADD STEP keeps the pending proposal; the next message authors a new step; the list is proposed as one workflow', async () => {
    const c = chat();
    const first = await c.say(SWAP);
    expect(first).toMatchObject({ action: 'PROPOSE', command: { type: 'ADD_TESTNET_SWAP' } });
    expect(await c.say('add step')).toMatchObject({ action: 'ADD_STEP', outcome: 'STEP_ADDED' });
    expect(c.state).toMatchObject({ pending: null, steps: [first.command], copilot: null });
    const second = await c.say(BRIDGE);
    expect(second).toMatchObject({ action: 'PROPOSE', command: { type: 'ADD_ROUTER_BRIDGE' } });
    expect(c.state.steps).toEqual([first.command]);
    // The service proposes [...steps, pending] as ONE canonical workflow, bound to the same hash every surface computes.
    const workflow = canonicalWorkflow([...c.state.steps!, c.state.pending!]);
    if (!workflow.ok) throw new Error(workflow.code);
    const direct = composeWorkflow(workflow.spec);
    expect(direct.ok && direct.workflowHash).toBe(workflow.workflowHash);
    expect(workflow).toMatchObject({ stepCount: 2, commands: [first.command, second.command], spec: { version: 2, steps: [{ action: 'swap' }, { action: 'bridge' }] } });
    expect(await c.say('steps')).toMatchObject({ action: 'STEPS' });
  });

  it('REMOVE and MOVE edit the list and re-propose it; unknown steps and an empty ADD are refused locally (EN/PT)', async () => {
    const c = chat();
    const swap = (await c.say(SWAP)).command;
    await c.say('add step');
    const bridge = (await c.say(BRIDGE)).command;
    const moved = await c.say('move step 2 to 1');
    expect(moved).toMatchObject({ action: 'WORKFLOW', outcome: 'STEP_MOVED', command: swap });
    expect(c.state).toMatchObject({ steps: [bridge], pending: swap });
    const removed = await c.say('remove step 1');
    expect(removed).toMatchObject({ action: 'WORKFLOW', outcome: 'STEP_REMOVED', command: swap });
    expect(c.state).toMatchObject({ steps: [], pending: swap });
    expect(await c.say('remove step 5')).toMatchObject({ action: 'REPLY', outcome: 'STEP_UNKNOWN' });
    expect(await c.say('new')).toMatchObject({ action: 'CANCEL' });
    expect(c.state).toMatchObject({ steps: [], pending: null });
    expect(await c.say('add step')).toMatchObject({ action: 'REPLY', outcome: 'STEP_NOTHING_PENDING' });
    const pt = chat('PT');
    await pt.say(SWAP);
    expect(await pt.say('adicionar etapa')).toMatchObject({ action: 'ADD_STEP' });
    expect(pt.state.language).toBe('PT');
    expect(await pt.say('remover etapa 1')).toMatchObject({ action: 'WORKFLOW', command: null });
    expect(pt.state).toMatchObject({ steps: [], pending: null });
  });

  it('refuses a list FloFi would collapse into another shape, and steps naming different wallets', async () => {
    const owner = '0x' + '1'.repeat(40), other = '0x' + '2'.repeat(40);
    const supply = (who: string) => ({ type: 'ADD_SUPPLY', input: { network: 'Base Sepolia', asset: 'USDC', amount: '10', beneficiary: who } });
    const c = chat();
    const decided = await c.say(`supply 10 USDC to Aave on Base Sepolia beneficiary ${owner}`);
    const again = await chat().say(`supply 5 USDC to Aave on Base Sepolia beneficiary ${other}`);
    expect(canonicalWorkflow([decided.command!, again.command!])).toEqual({ ok: false, code: 'CHANNEL_INTENDED_WALLETS_DIFFER' });
    expect(canonicalWorkflow([supply(owner) as never, decided.command!])).toMatchObject({ ok: false });
  });

  it('reports the run from durable state: step states always, transactions only when shared; notifications once each, with the continuation link', () => {
    const handoff = { handoffId: 'apr_' + 'a'.repeat(26), shareStatus: true } as HandoffRecord;
    const tx = '0x' + 'ab'.repeat(32);
    const run = { workflowRunId: 'wfr_' + 'a'.repeat(26), approvalId: handoff.handoffId, state: 'RUNNING', mode: 'CONFIRM_EACH_STEP', stepCount: 2, currentStep: 1, code: null,
      workflowHash: '0x' + '1'.repeat(64), expiresAt: '', completedAt: null, createdAt: '', updatedAt: '', stepsVisible: true, nextAction: 'OWNER_SIGNS_STEP', authority: 'NONE', note: null,
      steps: [{ index: 0, action: 'swap', state: 'RECONCILED', flow: null, stepWorkflowHash: null, code: null, bound: null,
        outcome: { executionId: 'r', kind: 'OWNER_RUN', status: 'RECONCILED', evidence: null, submissions: [{ chain: 'eip155:84532', hash: tx, explorerUrl: null }], spent: [], received: [],
          receiptUrl: null } },
        { index: 1, action: 'bridge', state: 'PENDING', flow: null, stepWorkflowHash: null, code: null, bound: null, outcome: null }] } as const;
    const progress = { status: 'APPLIED', expiresAt: '2026-10-22T10:00:00.000Z', runs: [], runsVisible: true, workflowRun: run, note: null } as never;
    const status = statusReplies('EN', { handoff, progress })[0]!.text;
    expect(status).toContain('Workflow: running');
    expect(status).toContain('1. Swap — reconciled ✅ · tx 0xabab…abab');
    expect(status).toContain('2. Bridge — waiting');
    const hidden = statusReplies('PT', { handoff, progress: { ...progress as object, workflowRun: { ...run, stepsVisible: false } } as never })[0]!.text;
    expect(hidden).not.toContain('0xabab');
    expect(hidden).toContain('Fluxo: em execução');
    const { due, done } = plannedNotifications('EN', handoff, progress, 'https://flofi.test');
    expect(done).toBe(false);
    expect(due.map(n => n.key)).toEqual([`notify:${handoff.handoffId}:wfr:step:0:reconciled`, `notify:${handoff.handoffId}:wfr:ready:1`]);
    expect(due[1]!.text).toContain(`https://flofi.test/approve#${handoff.handoffId}`);
    // Without the owner's consent nothing about the run reaches the conversation; a finished run is followed no more.
    expect(plannedNotifications('EN', { ...handoff, shareStatus: false }, progress, 'https://flofi.test').due).toEqual([]);
    const completed = { ...progress as object, workflowRun: { ...run, state: 'COMPLETED', nextAction: 'NONE' } } as never;
    expect(plannedNotifications('PT', handoff, completed, 'https://flofi.test')).toMatchObject({ done: true, due: [{ text: expect.stringContaining('1. Troca') },
      { text: 'Fluxo concluído: todas as etapas reconciliadas ✅' }] });
  });
});
