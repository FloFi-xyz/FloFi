// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-WORKFLOW-002 (channels review): the "Strategy ready" reply states the authorizations the owner will actually be offered
 * in FloFi, from the approval's own plan — confirm each step (one wallet confirmation per step, at least) and, where FloFi offers user-funded
 * groups, their wallet-interaction count as a lower bound ("at least": the owner's wallet was not read yet), paid by the owner's own wallet.
 * The retired executor-funded single authorization is never offered.
 */
import { describe, expect, it } from 'vitest';
import type { FlowName } from '../../../backend/flows.ts';
import { composeWorkflow } from '../../engine/strategy-engine';
import { evaluateWorkflowGates, readHandoffPolicy } from '../../mcp/execution.ts';
import type { McpRuntime } from '../../mcp/runtime.ts';
import { authorizationPlan } from '../../workflow-runs/authorization-plan.ts';
import type { UserFundedFacts } from '../../workflow-runs/execution-groups.ts';
import { channelCopy, readyText } from './copy.ts';
import { authorizationFacts } from './service.ts';

const SWAP = { action: 'swap', network: 'base-sepolia', inputAsset: 'USDC', outputAsset: 'WETH', amount: '10', slippageBps: 50 };
/** Swap, then swap back what the first swap is guaranteed to deliver: two steps on one chain (one wallet batch where the chain is user-funded). */
const SAME_CHAIN = { version: 2, steps: [SWAP, { ...SWAP, inputAsset: 'WETH', outputAsset: 'USDC', amount: '1' }], bindings: [{ step: 1, amountFrom: 0 }] };
const FLOWS: FlowName[] = ['base-sepolia-swap'];
const runtime: McpRuntime = { kind: 'embedded', mode: async flow => FLOWS.includes(flow) ? 'harness' : 'off', info: async () => ({ executionEnabled: true }),
  preview: async () => { throw new Error('NEVER'); }, run: async () => { throw new Error('NEVER'); }, journal: async () => { throw new Error('NEVER'); },
  evidence: async () => { throw new Error('NEVER'); }, sequences: async () => ({ enabled: true, delegation: null }) };
const userFunded = (chains: readonly string[]): UserFundedFacts => ({ enabled: true, code: null, chains, bundlerChains: [], solanaNonceAccounts: true });
/** The plan exactly as the shared approval service computes it for a channel (no wallet reported: capabilities assumed). */
async function planOf(facts: UserFundedFacts | null) {
  const w = composeWorkflow(SAME_CHAIN);
  if (!w.ok) throw new Error(w.code);
  return authorizationPlan(w, await evaluateWorkflowGates(w, runtime, readHandoffPolicy({})), null, undefined, facts ? { facts } : undefined);
}

describe('channel authorization count (user-funded groups)', () => {
  it('a plan whose user-funded groups are offered states their wallet interactions as a lower bound, paid by the owner\'s wallet (EN/PT)', async () => {
    const plan = await planOf(userFunded(['eip155:84532']));
    expect(plan).toMatchObject({ recommended: 'USER_FUNDED', confirmEachStep: { available: true, walletConfirmationsAtLeast: 2 },
      userFunded: { available: true, wallets: 'ASSUMED', interactions: { upfront: 1, whenDue: 0, atLeast: true, single: false } },
      delegatedSingleAuthorization: { available: false } });
    const facts = authorizationFacts(plan);
    expect(facts).toEqual({ confirm: 2, groups: { interactions: 1, atLeast: true } });
    expect(channelCopy('EN').authorizations(facts)).toEqual([
      'Authorizations: at least 2 wallet confirmations in FloFi — one per step, each after a fresh simulation.',
      'Or, in groups of same-network steps: at least 1 wallet interaction in FloFi. Either way your own wallet pays every network fee; FloFi never pays gas.']);
    expect(channelCopy('PT').authorizations(facts)).toEqual([
      'Autorizações: pelo menos 2 confirmações na carteira no FloFi — uma por etapa, cada uma depois de uma nova simulação.',
      'Ou, em grupos de etapas na mesma rede: pelo menos 1 interação na carteira no FloFi. Em qualquer caso, a sua própria carteira paga todas as taxas de rede; o FloFi nunca paga gas.']);
    // Never a single-signature promise, never the retired executor-funded mode.
    for (const language of ['EN', 'PT'] as const) expect(channelCopy(language).authorizations(facts).join('\n')).not.toMatch(/ONCE|UMA vez|single|única assinatura/);
    // The whole count reaches the reply even when a previous link was withdrawn (the reply keeps at most three notes).
    const text = readyText('EN', { lines: ['Swap', 'Swap'], networks: ['base-sepolia'], fundsClass: 'TEST_FUNDS', notes: [channelCopy('EN').replaced,
      ...channelCopy('EN').authorizations(facts)], preview: { kind: 'DISABLED' }, intendedWallet: null, aiInterpreted: false, expiresMinutes: 15 });
    expect(text).toContain('at least 2 wallet confirmations');
    expect(text).toContain('at least 1 wallet interaction in FloFi. Either way your own wallet pays every network fee');
  });

  it('only user-funded groups: the count stands alone; groups FloFi would not offer are never described', async () => {
    const onlyGroups = channelCopy('EN').authorizations({ confirm: null, groups: { interactions: 3, atLeast: true } });
    expect(onlyGroups).toEqual(['Authorizations, in groups of same-network steps: at least 3 wallet interactions in FloFi. Your own wallet pays every network fee; FloFi never pays gas.']);
    // A chain that is not user-funded: each step is its own group (as many interactions as steps), so the claim starts confirm-each-step at once.
    const notOffered = await planOf(userFunded([]));
    expect(notOffered).toMatchObject({ recommended: 'CONFIRM_EACH_STEP', userFunded: { available: true } });
    expect(authorizationFacts(notOffered)).toEqual({ confirm: 2, groups: null });
    expect(channelCopy('EN').authorizations(authorizationFacts(notOffered))).toEqual([
      'Authorizations: at least 2 wallet confirmations in FloFi — one per step, each after a fresh simulation.',
      'One authorization is not one transaction: each step pays its own network fees.']);
    // User-funded execution not enabled on this deployment: confirm each step only.
    expect(authorizationFacts(await planOf(null))).toEqual({ confirm: 2, groups: null });
  });
});
