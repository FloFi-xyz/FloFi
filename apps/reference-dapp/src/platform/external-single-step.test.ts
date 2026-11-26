// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-CHANNEL-EXECUTION-PARITY-001 (WS03): when a ONE-step proposal from MCP (ChatGPT, Claude) or a channel (Telegram) is
 * handed off as a workflow run of that step (one wallet batch with any exact approval folded in, where the owner's wallet supports it) instead
 * of its SINGLE_FLOW plan. Every condition is the server's; any failure keeps SINGLE_FLOW exactly as before. MOCKED runtime doubles only.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { composeWorkflow } from '../engine/strategy-engine';
import { readHandoffPolicy, workflowPlan } from '../mcp/execution.ts';
import type { McpRuntime } from '../mcp/runtime.ts';
import { approvalLinkScheme, prepareApprovalRequest, requestApproval, type ApprovalDeps, type ApprovalRequester, type HandoffStore } from './index.ts';
import { compositionChain, externalOneStepPlan, groupedSingleStepFlow, oneStepFactsAllow, ONE_STEP_RUN_REQUESTERS } from './external-single-step.ts';

const BASE = 'eip155:8453';
const V1_SWAP = { version: 1, action: 'swap', network: 'base', inputAsset: 'USDC', outputAsset: 'WETH', amount: '1', slippageBps: 100 };
const MCP: ApprovalRequester = { kind: 'MCP_ACCOUNT', ref: 'acct_' + 'b'.repeat(26), grantId: 'grt_' + 'c'.repeat(26), clientId: 'mcp-test-client', displayName: 'ChatGPT' };
const CHANNEL: ApprovalRequester = { kind: 'CHANNEL_CONVERSATION', ref: 'cnv_parity0000000000000001', clientId: 'telegram-test-bot', displayName: 'Telegram', context: {} };
const AUTOMATION: ApprovalRequester = { kind: 'AUTOMATION_RULE', ref: 'aut_' + 'd'.repeat(26), clientId: 'flofi-automations', displayName: 'Automation', context: {} };
type Facts = Awaited<ReturnType<NonNullable<McpRuntime['sequences']>>>;
const USER_FUNDED = (chains: string[], bridgeRoutes: string[] = []) => ({ enabled: true, code: null, chains, bundlerChains: [], solanaNonceAccounts: false, bridgeRoutes });
const runtime = (facts: Facts | null): McpRuntime => ({ kind: 'embedded', mode: async () => 'harness', info: async () => ({ executionEnabled: true }),
  preview: async () => ({ ok: false, code: 'PREVIEW_NOT_USED' }), ...facts ? { sequences: async () => facts } : {} }) as unknown as McpRuntime;
const policy = readHandoffPolicy({ FLOFI_MCP_HANDOFF_MAINNET_NETWORKS: 'base,arbitrum-one' });
// Nothing in `prepareApprovalRequest` may touch the store: the double throws if it does.
const untouched = new Proxy({}, { get: () => () => { throw new Error('STORE_TOUCHED'); } }) as unknown as HandoffStore;
const deps = (requester: ApprovalRequester, facts: Facts | null, singleStepRuns: (() => Promise<boolean>) | null = async () => true): ApprovalDeps => ({
  origin: 'http://localhost:3999', scheme: approvalLinkScheme('flofi_hs_', randomBytes(32), [requester.kind]), handoffs: untouched, allow: async () => true,
  runtime: runtime(facts), policy, rules: { handoffSeconds: 900, maxPending: 3, rate: [20, 3_600], supersedeSameWorkflow: true }, now: new Date(),
  ...singleStepRuns ? { singleStepRuns } : {} });
const ENABLED: Facts = { enabled: true, delegation: null, userFunded: USER_FUNDED([BASE]) } as Facts;

describe('BUILD-FLOFI-UNIVERSAL-CHANNEL-EXECUTION-PARITY-001: the external one-step rule (pure)', () => {
  it('covers exactly the flows the user-funded EVM groups build for one card', () => {
    for (const flow of ['base-swap', 'arbitrum-swap', 'ethereum-swap', 'robinhood-swap', 'crosschain-router-arbitrum-to-base', 'crosschain-router-testnet',
      'base-mainnet-transfer', 'arbitrum-aave', 'ethereum-aave', 'aave-supply', 'base-sepolia-swap']) expect(groupedSingleStepFlow(flow), flow).toBe(true);
    for (const flow of ['crosschain-universal', 'uniswap-liquidity', 'arbitrum-liquidity', 'orca-liquidity-mainnet', 'jupiter-swap', 'solana-transfer', 'pix-payment',
      'lending-composition', 'crosschain-router', 'base-swap ', '', null, 7]) expect(groupedSingleStepFlow(flow), String(flow)).toBe(false);
  });
  it('applies only to MCP accounts and channel conversations, and only to a stored run of exactly one grouped step', () => {
    expect([...ONE_STEP_RUN_REQUESTERS].sort()).toEqual(['CHANNEL_CONVERSATION', 'MCP_ACCOUNT']);
    const one = { kind: 'SEQUENTIAL', steps: [{ flow: 'arbitrum-swap' }] };
    expect(externalOneStepPlan('MCP_ACCOUNT', one)).toBe(true);
    expect(externalOneStepPlan('CHANNEL_CONVERSATION', one)).toBe(true);
    for (const kind of ['AUTOMATION_RULE', 'DEVELOPER_PROJECT', 'EDITOR_SESSION']) expect(externalOneStepPlan(kind, one), kind).toBe(false);
    expect(externalOneStepPlan('MCP_ACCOUNT', { kind: 'SINGLE_FLOW', steps: [{ flow: 'arbitrum-swap' }] })).toBe(false);
    expect(externalOneStepPlan('MCP_ACCOUNT', { kind: 'SEQUENTIAL', steps: [{ flow: 'arbitrum-swap' }, { flow: 'arbitrum-swap' }] })).toBe(false);
    expect(externalOneStepPlan('MCP_ACCOUNT', { kind: 'SEQUENTIAL', steps: [{ flow: 'uniswap-liquidity' }] })).toBe(false);
  });
  it('needs workflow runs and user-funded groups on the step\'s own EVM chain (a bridge also a certified batch route from it)', () => {
    expect(oneStepFactsAllow(ENABLED, 'base-swap', BASE)).toBe(true);
    expect(oneStepFactsAllow(null, 'base-swap', BASE)).toBe(false);
    expect(oneStepFactsAllow({ ...ENABLED!, enabled: false }, 'base-swap', BASE)).toBe(false);
    expect(oneStepFactsAllow({ enabled: true, userFunded: null }, 'base-swap', BASE)).toBe(false);
    expect(oneStepFactsAllow(ENABLED, 'arbitrum-swap', 'eip155:42161')).toBe(false);
    expect(oneStepFactsAllow(ENABLED, 'base-swap', null)).toBe(false);
    expect(oneStepFactsAllow({ enabled: true, userFunded: { enabled: true, chains: ['solana:mainnet'] } }, 'base-swap', 'solana:mainnet')).toBe(false);
    expect(oneStepFactsAllow(ENABLED, 'crosschain-router-base-to-arbitrum', BASE)).toBe(false);
    expect(oneStepFactsAllow({ enabled: true, userFunded: USER_FUNDED([BASE], [`${BASE}>eip155:42161`]) }, 'crosschain-router-base-to-arbitrum', BASE)).toBe(true);
  });
  it('reads the chain of the one financial node of a composition', () => {
    const composed = composeWorkflow(V1_SWAP);
    if (!composed.ok) throw new Error(composed.code);
    expect(compositionChain(composed.steps[0]!.workflow)).toBe(BASE);
    expect(compositionChain({ nodes: [] })).toBeNull();
    expect(compositionChain({})).toBeNull();
  });
});

describe('BUILD-FLOFI-UNIVERSAL-CHANNEL-EXECUTION-PARITY-001: the approval service decides, never the caller', () => {
  const composed = composeWorkflow(V1_SWAP);
  if (!composed.ok) throw new Error(composed.code);
  it('hands an eligible MCP or Telegram one-step swap off as a run of that step, with its authorization plan (the Arbitrum incident shape)', async () => {
    for (const requester of [MCP, CHANNEL]) {
      const prepared = await prepareApprovalRequest(deps(requester, ENABLED), requester, composed.strategy, composed.workflowHash, { externalOneStep: true });
      if (!prepared.ok) throw new Error(`${requester.kind}: ${prepared.code}`);
      expect(prepared.value.executionPlan, requester.kind).toBe('SEQUENTIAL');
      expect(prepared.draft.plan).toMatchObject({ kind: 'SEQUENTIAL', steps: [{ index: 0, flow: 'base-swap' }] });
      // The stored strategy and hash stay the step's own (a one-step workflow composes to its step's identity).
      expect(prepared.value.workflowHash).toBe(composed.workflowHash);
      expect(prepared.value).toHaveProperty('authorizationPlan');
      expect(externalOneStepPlan(requester.kind, prepared.draft.plan)).toBe(true);
    }
  });
  it('keeps SINGLE_FLOW, exactly as before, whenever any condition fails', async () => {
    const single = async (d: ApprovalDeps, requester: ApprovalRequester, options: Parameters<typeof prepareApprovalRequest>[4] = { externalOneStep: true }) => {
      const prepared = await prepareApprovalRequest(d, requester, composed.strategy, composed.workflowHash, options);
      if (!prepared.ok) throw new Error(prepared.code);
      return prepared.value.executionPlan;
    };
    expect(await single(deps(MCP, ENABLED), MCP, {})).toBe('SINGLE_FLOW');
    expect(await single(deps(MCP, ENABLED, null), MCP)).toBe('SINGLE_FLOW');
    expect(await single(deps(MCP, ENABLED, async () => false), MCP)).toBe('SINGLE_FLOW');
    expect(await single(deps(MCP, ENABLED, async () => { throw new Error('DB_DOWN'); }), MCP)).toBe('SINGLE_FLOW');
    expect(await single(deps(MCP, null), MCP)).toBe('SINGLE_FLOW');
    expect(await single(deps(MCP, { ...ENABLED!, enabled: false } as Facts), MCP)).toBe('SINGLE_FLOW');
    expect(await single(deps(MCP, { enabled: true, delegation: null, userFunded: USER_FUNDED(['eip155:42161']) } as Facts), MCP)).toBe('SINGLE_FLOW');
    expect(await single(deps(AUTOMATION, ENABLED), AUTOMATION)).toBe('SINGLE_FLOW');
    // A one-step plan is never forced: the Editor's explicit opt-in stays refused for external requesters.
    for (const requester of [MCP, CHANNEL]) expect(await requestApproval(deps(requester, ENABLED), requester, composed.strategy, composed.workflowHash, { singleStepRun: true }))
      .toEqual({ ok: false, code: 'APPROVAL_REQUESTER_INVALID' });
  });
  it('a flow the groups do not build keeps SINGLE_FLOW (here a Solana swap)', async () => {
    const solana = composeWorkflow({ version: 1, action: 'swap', network: 'solana-devnet', inputAsset: 'SOL', outputAsset: 'devUSDC', amount: '0.1' });
    if (!solana.ok) throw new Error(solana.code);
    expect(workflowPlan(solana, { run: true }).steps[0]!.flow).not.toBe('base-swap');
    const prepared = await prepareApprovalRequest(deps(MCP, { enabled: true, delegation: null, userFunded: USER_FUNDED([BASE, 'solana:devnet']) } as Facts), MCP,
      solana.strategy, solana.workflowHash, { externalOneStep: true });
    expect(prepared.ok && prepared.value.executionPlan).toBe('SINGLE_FLOW');
  });
});
