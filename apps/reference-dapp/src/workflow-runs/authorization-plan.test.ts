// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-E2E-001: before anything executes, how many authorizations a workflow needs in each mode, and exactly why delegation is or is not
 * available — never a claim of single-signature support for an incompatible path.
 */
import { describe, expect, it } from 'vitest';
import type { FlowName } from '../../backend/flows.ts';
import { composeWorkflow, type WorkflowComposition } from '../engine/strategy-engine';
import { evaluateWorkflowGates, readHandoffPolicy } from '../mcp/execution.ts';
import type { McpRuntime } from '../mcp/runtime.ts';
import { authorizationPlan, delegableByCode, type DelegationFacts } from './authorization-plan.ts';

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
async function planOf(input: unknown, sequences: boolean, delegation: DelegationFacts) {
  const w = ok(input);
  return authorizationPlan(w, await evaluateWorkflowGates(w, runtime(sequences, delegation), readHandoffPolicy({})), delegation);
}
const MOCKED: DelegationFacts = { mode: 'MOCKED_HARNESS', unavailable: null };

describe('BUILD-CHAT-E2E-001 authorization plan', () => {
  it('counts one wallet confirmation per step (at least) in confirm mode, and one passkey assertion for a delegable workflow', async () => {
    const plan = await planOf({ version: 2, steps: [BASE_SEPOLIA_SWAP, SOLANA_DEVNET_SWAP] }, true, MOCKED);
    expect(plan).toMatchObject({ stepCount: 2,
      confirmEachStep: { available: true, reason: null, walletConfirmationsAtLeast: 2, walletNamespaces: ['eip155', 'solana'] },
      delegatedSingleAuthorization: { available: true, reason: null, passkeyAssertions: 1, ownerKnown: false,
        enrollments: [{ chain: 'eip155:84532', mechanism: 'EVM_ERC7710_METAMASK_V1_3', active: null }, { mechanism: 'SOLANA_SPL_DELEGATE_V1', active: null }] },
      // Without the owner's grants FloFi cannot say one authorization suffices: the owner's own Credentials decide it in FloFi.
      recommended: 'CONFIRM_EACH_STEP' });
    expect(plan.notes[0]).toMatch(/not one transaction/);
    expect(plan.notes).toContain('This workflow uses an EVM wallet and a Solana wallet: both must be proven before it starts.');
  });

  it('reports the deployment, the signer and every step\'s own delegation refusal exactly', async () => {
    const both = { version: 2, steps: [BASE_SEPOLIA_SWAP, SOLANA_DEVNET_SWAP] };
    expect((await planOf(both, true, null)).delegatedSingleAuthorization).toMatchObject({ available: false, reason: 'DELEGATION_NOT_ENABLED' });
    // A hosted deployment can configure no signer provider: production delegated signing is blocked there.
    expect((await planOf(both, true, { mode: 'PRODUCTION', unavailable: 'DELEGATED_SIGNER_UNAVAILABLE' })).delegatedSingleAuthorization)
      .toMatchObject({ available: false, reason: 'DELEGATED_SIGNER_UNAVAILABLE' });
    // With a signer, production Solana swaps still have no delegated builder (the MOCKED harness fixture is never production support).
    const production = await planOf(both, true, { mode: 'PRODUCTION', unavailable: null });
    expect(production.delegatedSingleAuthorization).toMatchObject({ available: false, reason: 'SOLANA_DELEGATED_BUILDER_NOT_IMPLEMENTED' });
    expect(production.steps.map(s => [s.index, s.delegation.capable, s.delegation.code])).toEqual([[0, true, null], [1, false, 'SOLANA_DELEGATED_BUILDER_NOT_IMPLEMENTED']]);
    // Bridges are not target-scopable for a delegate: confirm each step remains the safe mode.
    const bridged = await planOf({ version: 2, steps: [BRIDGE, BASE_SEPOLIA_SWAP] }, true, MOCKED);
    expect(bridged).toMatchObject({ confirmEachStep: { available: true }, delegatedSingleAuthorization: { available: false, reason: 'DELEGATED_TARGET_SCOPE_UNAVAILABLE' },
      recommended: 'CONFIRM_EACH_STEP' });
    // Where the deployment runs no workflows, neither mode is offered.
    expect(await planOf(both, false, MOCKED)).toMatchObject({ confirmEachStep: { available: false, reason: 'WORKFLOW_RUNS_NOT_ENABLED' },
      delegatedSingleAuthorization: { available: false, reason: 'WORKFLOW_RUNS_NOT_ENABLED' }, recommended: null });
  });

  it('a step whose flow is not enabled here keeps confirm mode closed with that step\'s reason; mainnet delegation is refused', async () => {
    const supply = { action: 'supply', network: 'base-sepolia', asset: 'USDC', amount: '5', beneficiary: '0x' + '1'.repeat(40) };
    const plan = await planOf({ version: 2, steps: [BASE_SEPOLIA_SWAP, supply] }, true, MOCKED);
    expect(plan.confirmEachStep).toMatchObject({ available: false, reason: 'FLOW_NOT_ENABLED_IN_DEPLOYMENT' });
    expect(plan.steps[1]!.ownerExecution).toMatchObject({ supported: true, enabled: false, reason: 'FLOW_NOT_ENABLED_IN_DEPLOYMENT' });
    expect(delegableByCode(ok({ version: 2, steps: [BASE_SEPOLIA_SWAP, { ...BASE_SEPOLIA_SWAP, network: 'base' }] }), MOCKED))
      .toEqual({ ok: false, code: 'MAINNET_DELEGATION_DISABLED' });
  });

  it('a bound workflow resolves received amounts in confirm mode and in delegated mode', async () => {
    const bound = { version: 2, steps: [BASE_SEPOLIA_SWAP, { ...BASE_SEPOLIA_SWAP, inputAsset: 'WETH', outputAsset: 'USDC', amount: '1' }], bindings: [{ step: 1, amountFrom: 0 }] };
    expect(await planOf(bound, true, MOCKED)).toMatchObject({ confirmEachStep: { available: true, reason: null },
      delegatedSingleAuthorization: { available: true }, bindings: [{ step: 1, amountFrom: 0, confirmEachStep: 'RECONCILED_RECEIVED_AMOUNT',
        delegated: 'RECONCILED_RECEIVED_AMOUNT' }] });
    expect(await planOf(bound, true, null)).toMatchObject({ confirmEachStep: { available: true }, delegatedSingleAuthorization: { available: false },
      recommended: 'CONFIRM_EACH_STEP' });
  });
});
