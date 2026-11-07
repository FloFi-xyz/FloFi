// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-E2E-001: before anything executes, how many authorizations a workflow needs in each mode, and exactly why delegation is or is not
 * available — never a claim of single-signature support for an incompatible path.
 * BUILD-FLOFI-UNIVERSAL-WORKFLOW-002 (intentional, explained change): the delegated mode is retired on every deployment because its executor
 * paid the gas (EXPLICIT reason EXECUTOR_FUNDED_GAS_RETIRED); user-funded execution groups report their own honest counts.
 */
import { describe, expect, it } from 'vitest';
import type { FlowName } from '../../backend/flows.ts';
import { composeWorkflow, type WorkflowComposition } from '../engine/strategy-engine';
import { evaluateWorkflowGates, readHandoffPolicy } from '../mcp/execution.ts';
import type { McpRuntime } from '../mcp/runtime.ts';
import { authorizationPlan, delegableByCode, EXECUTOR_FUNDED_GAS_RETIRED, type DelegationFacts } from './authorization-plan.ts';
import type { UserFundedFacts } from './execution-groups.ts';

const ok = (input: unknown): WorkflowComposition => { const w = composeWorkflow(input); if (!w.ok) throw new Error(w.code); return w; };
const BASE_SEPOLIA_SWAP = { action: 'swap', network: 'base-sepolia', inputAsset: 'USDC', outputAsset: 'WETH', amount: '10' };
const SOLANA_DEVNET_SWAP = { action: 'swap', network: 'solana-devnet', inputAsset: 'devUSDC', outputAsset: 'SOL', amount: '5' };
const BRIDGE = { action: 'bridge', sourceNetwork: 'base-sepolia', destinationNetwork: 'arbitrum-sepolia', asset: 'USDC', amount: '5' };
const FLOWS: FlowName[] = ['base-sepolia-swap', 'solana-devnet-swap', 'crosschain-router-testnet'];
function runtime(sequences: boolean, delegation: DelegationFacts): McpRuntime {
  const never = async (): Promise<never> => { throw new Error('NEVER'); };
  return { kind: 'embedded', mode: async flow => FLOWS.includes(flow) ? 'harness' : 'off', info: async () => ({ executionEnabled: true }), preview: never, run: never,
    journal: never, evidence: never, sequences: async () => ({ enabled: sequences, delegation }) };
}
async function planOf(input: unknown, sequences: boolean, delegation: DelegationFacts, userFunded?: UserFundedFacts) {
  const w = ok(input);
  return authorizationPlan(w, await evaluateWorkflowGates(w, runtime(sequences, delegation), readHandoffPolicy({})), delegation, undefined,
    userFunded ? { facts: userFunded } : undefined);
}
const USER_FUNDED: UserFundedFacts = { enabled: true, code: null, chains: ['eip155:8453'], bundlerChains: [], solanaNonceAccounts: true };
const MOCKED: DelegationFacts = { mode: 'MOCKED_HARNESS', unavailable: null };

describe('BUILD-CHAT-E2E-001 authorization plan', () => {
  it('counts one wallet confirmation per step (at least) in confirm mode; the executor-funded delegated mode is never offered', async () => {
    const plan = await planOf({ version: 2, steps: [BASE_SEPOLIA_SWAP, SOLANA_DEVNET_SWAP] }, true, MOCKED);
    expect(plan).toMatchObject({ stepCount: 2,
      confirmEachStep: { available: true, reason: null, walletConfirmationsAtLeast: 2, walletNamespaces: ['eip155', 'solana'] },
      delegatedSingleAuthorization: { available: false, reason: EXECUTOR_FUNDED_GAS_RETIRED, passkeyAssertions: 0, ownerKnown: false },
      userFunded: { available: false, reason: 'USER_FUNDED_NOT_ENABLED', feePayer: 'OWNER_WALLET' }, recommended: 'CONFIRM_EACH_STEP' });
    // Even a workflow PR #166 could delegate (EVM only, same chain) is refused now: its executor would pay the gas.
    const evmOnly = await planOf({ version: 2, steps: [BASE_SEPOLIA_SWAP, { ...BASE_SEPOLIA_SWAP, inputAsset: 'WETH', outputAsset: 'USDC', amount: '0.001' }] }, true, MOCKED);
    expect(evmOnly.delegatedSingleAuthorization).toMatchObject({ available: false, reason: EXECUTOR_FUNDED_GAS_RETIRED });
    expect(plan.notes[0]).toMatch(/Your own wallet pays every network fee/);
    expect(plan.notes.join(' ')).toMatch(/not one transaction/);
    expect(plan.notes).toContain('This workflow uses an EVM wallet and a Solana wallet: both must be proven before it starts.');
  });

  it('reports why each mode is or is not available, exactly', async () => {
    const both = { version: 2, steps: [BASE_SEPOLIA_SWAP, SOLANA_DEVNET_SWAP] };
    for (const delegation of [null, MOCKED, { mode: 'PRODUCTION', unavailable: null } as const, { mode: 'PRODUCTION', unavailable: 'DELEGATED_SIGNER_UNAVAILABLE' } as const])
      expect((await planOf(both, true, delegation)).delegatedSingleAuthorization).toMatchObject({ available: false, reason: EXECUTOR_FUNDED_GAS_RETIRED });
    // Per-step delegation facts stay visible for the record (never an offer).
    const production = await planOf(both, true, { mode: 'PRODUCTION', unavailable: null });
    expect(production.steps.map(s => [s.index, s.delegation.capable, s.delegation.code])).toEqual([[0, true, null], [1, false, 'SOLANA_DELEGATED_BUILDER_NOT_IMPLEMENTED']]);
    const bridged = await planOf({ version: 2, steps: [BRIDGE, BASE_SEPOLIA_SWAP] }, true, MOCKED);
    expect(bridged).toMatchObject({ confirmEachStep: { available: true }, delegatedSingleAuthorization: { available: false, reason: EXECUTOR_FUNDED_GAS_RETIRED },
      recommended: 'CONFIRM_EACH_STEP' });
    // Where the deployment runs no workflows, no mode is offered.
    expect(await planOf(both, false, MOCKED, USER_FUNDED)).toMatchObject({ confirmEachStep: { available: false, reason: 'WORKFLOW_RUNS_NOT_ENABLED' },
      delegatedSingleAuthorization: { available: false, reason: 'WORKFLOW_RUNS_NOT_ENABLED' }, userFunded: { available: false, reason: 'WORKFLOW_RUNS_NOT_ENABLED' },
      recommended: null });
  });

  it('a step whose flow is not enabled here keeps confirm mode and user-funded groups closed with that step\'s reason', async () => {
    const supply = { action: 'supply', network: 'base-sepolia', asset: 'USDC', amount: '5', beneficiary: '0x' + '1'.repeat(40) };
    const plan = await planOf({ version: 2, steps: [BASE_SEPOLIA_SWAP, supply] }, true, MOCKED, USER_FUNDED);
    expect(plan.confirmEachStep).toMatchObject({ available: false, reason: 'FLOW_NOT_ENABLED_IN_DEPLOYMENT' });
    expect(plan.userFunded).toMatchObject({ available: false, reason: 'FLOW_NOT_ENABLED_IN_DEPLOYMENT' });
    expect(plan.steps[1]!.ownerExecution).toMatchObject({ supported: true, enabled: false, reason: 'FLOW_NOT_ENABLED_IN_DEPLOYMENT' });
    expect(delegableByCode(ok({ version: 2, steps: [BASE_SEPOLIA_SWAP, { ...BASE_SEPOLIA_SWAP, network: 'base' }] }), MOCKED))
      .toEqual({ ok: false, code: EXECUTOR_FUNDED_GAS_RETIRED });
  });

  it('user-funded groups are offered only when they need fewer wallet interactions than confirming each step, and never on a disabled chain', async () => {
    const bound = { version: 2, steps: [BASE_SEPOLIA_SWAP, { ...BASE_SEPOLIA_SWAP, inputAsset: 'WETH', outputAsset: 'USDC', amount: '1' }], bindings: [{ step: 1, amountFrom: 0 }] };
    const plan = await planOf(bound, true, MOCKED, USER_FUNDED);
    // Base Sepolia is not a user-funded chain: each step is its own owner-step group (2 interactions = confirm each step): never recommended.
    expect(plan).toMatchObject({ confirmEachStep: { available: true, reason: null }, userFunded: { available: true, wallets: 'ASSUMED',
      interactions: { upfront: 0, whenDue: 2, single: false } }, recommended: 'CONFIRM_EACH_STEP',
      bindings: [{ step: 1, amountFrom: 0, confirmEachStep: 'RECONCILED_RECEIVED_AMOUNT', delegated: 'SIGNED_GUARANTEED_MINIMUM' }] });
    expect(plan.userFunded.groups.map(g => [g.strategy, g.downgrades[0]])).toEqual([['EVM_OWNER_STEP', 'USER_FUNDED_CHAIN_DISABLED'], ['EVM_OWNER_STEP', 'USER_FUNDED_CHAIN_DISABLED']]);
  });
});
