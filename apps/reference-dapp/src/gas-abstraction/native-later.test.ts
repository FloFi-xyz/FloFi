// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 review B1 (bridge) / LQ1 (liquidity), ADR-0010 §2: token-paid fees are offered exactly when the owner's
 * ETH or SOL is short, so a run could execute a token-paid step and then stop at a later step on the same chain whose own flow needs the native
 * coin, leaving the funds midway. Before the first signature the Editor's Review and the /approve plan name those later steps and the coin they
 * need — on real mainnet compositions, for each mechanism — and never cancel or change the design.
 */
import { describe, expect, it } from 'vitest';
import { requirementOf, type WorkflowRequirement } from '../delegation/steps.ts';
import { composeWorkflow, type WorkflowComposition } from '../engine/strategy-engine';
import { evaluateWorkflowGates, readHandoffPolicy } from '../mcp/execution.ts';
import type { McpRuntime } from '../mcp/runtime.ts';
import { evmStepBuildable } from '../user-funded/evm-calls.ts';
import { authorizationPlan } from '../workflow-runs/authorization-plan.ts';
import { planExecutionGroups, type UserFundedFacts, type WalletProfile } from '../workflow-runs/execution-groups.ts';
import { nativeLaterMessage } from '../domain/token-fee';
import { translate } from '../i18n/translate';
import { nativeLaterWarnings } from './native-later.ts';

const OWNER = '0x' + '1'.repeat(40), SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', ROBINHOOD = 'eip155:4663', BASE = 'eip155:8453';
const ALL: UserFundedFacts = { enabled: true, code: null, chains: ['eip155:1', BASE, 'eip155:42161', ROBINHOOD, SOLANA], bundlerChains: [BASE], solanaNonceAccounts: true };
const METAMASK: WalletProfile = { eip155: { wallet: 'INJECTED', atomic: { [BASE]: 'supported', [ROBINHOOD]: 'supported' }, typedData: true },
  solana: { wallet: 'WALLET_STANDARD', signMultiple: true, nonceAccounts: 0 } };
const composed = (input: unknown): WorkflowComposition => { const w = composeWorkflow(input); if (!w.ok) throw new Error(w.code); return w; };
const req = (input: unknown): WorkflowRequirement => { const r = requirementOf(composed(input)); if (!r.ok) throw new Error(r.code); return r.value; };
const groupsOf = (r: WorkflowRequirement, facts: UserFundedFacts) => {
  const p = planExecutionGroups(r, facts, METAMASK, s => s.namespace === 'solana' || evmStepBuildable(s, facts.chains, OWNER, facts.bridgeRoutes) === null);
  if (!p.ok) throw new Error(p.code);
  return p.groups;
};

const JUPITER = { action: 'swap', network: 'solana', inputAsset: 'USDC', outputAsset: 'SOL', amount: '50' };
const ORCA = { action: 'add_liquidity', network: 'solana', maxAmounts: { SOL: '0.2', USDC: '20' }, range: { unit: 'tick', lower: '-64', upper: '64' } };
const RELAY_SOLANA_BASE = { action: 'bridge', sourceNetwork: 'solana', destinationNetwork: 'base', asset: 'USDC', amount: '5' };
const SWAP_BASE = { action: 'swap', network: 'base', inputAsset: 'USDC', outputAsset: 'WETH', amount: '10' };
const UNISWAP_BASE = { action: 'add_liquidity', network: 'base', maxAmounts: { USDC: '10', WETH: '0.004' }, range: { unit: 'full' } };
const GASLESS_SWAP = { action: 'swap', network: 'robinhood', inputAsset: 'WETH', outputAsset: 'USDG', amount: '0.01' };
const ROBINHOOD_BRIDGE = { action: 'bridge', sourceNetwork: 'robinhood', destinationNetwork: 'base', asset: 'USDG', amount: '5' };

describe('LQ1: a Kora-paid Jupiter swap, then Orca liquidity on Solana', () => {
  const r = req({ version: 2, steps: [JUPITER, ORCA] });
  it('names the liquidity step and SOL when Kora may pay the swap\'s fee (sign-all group or the swap\'s own flow)', () => {
    const expected = [{ chain: SOLANA, network: 'Solana', symbol: 'SOL', after: 0, steps: [{ index: 1, action: 'add_liquidity' }] }];
    expect(nativeLaterWarnings(r.steps, groupsOf(r, ALL), { koraTokenGas: true })).toEqual(expected);
    expect(nativeLaterWarnings(r.steps, null, { koraTokenGas: true })).toEqual(expected);
  });
  it('nothing without Kora on this deployment, and nothing when the liquidity step comes first (the run stops before anything ran)', () => {
    expect(nativeLaterWarnings(r.steps, groupsOf(r, ALL), {})).toEqual([]);
    const first = req({ version: 2, steps: [ORCA, JUPITER] });
    expect(nativeLaterWarnings(first.steps, null, { koraTokenGas: true })).toEqual([]);
  });
  it('B1: a Relay deposit from Solana after a Kora-paid swap needs SOL too', () => {
    const relay = req({ version: 2, steps: [JUPITER, RELAY_SOLANA_BASE] });
    expect(nativeLaterWarnings(relay.steps, null, { koraTokenGas: true })).toEqual([{ chain: SOLANA, network: 'Solana', symbol: 'SOL', after: 0,
      steps: [{ index: 1, action: 'bridge' }] }]);
  });
});

describe('LQ1: a Circle-paid swap, then Uniswap liquidity on Base', () => {
  const r = req({ version: 2, steps: [SWAP_BASE, UNISWAP_BASE] });
  const facts: UserFundedFacts = { ...ALL, tokenGasChains: [BASE] };
  it('names the liquidity step and ETH when Circle may pay the swap group\'s fee', () => {
    expect(nativeLaterWarnings(r.steps, groupsOf(r, facts), facts)).toEqual([{ chain: BASE, network: 'Base', symbol: 'ETH', after: 0,
      steps: [{ index: 1, action: 'add_liquidity' }] }]);
  });
  it('a Review that prepared the swap group knows its fee payer: Circle (certain), or the owner\'s ETH (no token-paid step: nothing)', () => {
    expect(nativeLaterWarnings(r.steps, groupsOf(r, facts), facts, new Map([[0, 'TOKEN' as const]]))).toHaveLength(1);
    expect(nativeLaterWarnings(r.steps, groupsOf(r, facts), facts, new Map([[0, 'NATIVE' as const]]))).toEqual([]);
  });
  it('nothing where Circle is not offered, and nothing when every step runs through its own flow (single-step pages keep native gas)', () => {
    expect(nativeLaterWarnings(r.steps, groupsOf(r, ALL), ALL)).toEqual([]);
    expect(nativeLaterWarnings(r.steps, null, facts)).toEqual([]);
  });
});

describe('B1: a 0x Gasless swap, then a bridge from Robinhood Chain', () => {
  const r = req({ version: 2, steps: [GASLESS_SWAP, ROBINHOOD_BRIDGE] });
  it('names the bridge and ETH when 0x Gasless may carry the swap (confirm each step), whatever the grouping', () => {
    const expected = [{ chain: ROBINHOOD, network: 'Robinhood Chain', symbol: 'ETH', after: 0, steps: [{ index: 1, action: 'bridge' }] }];
    expect(nativeLaterWarnings(r.steps, null, { gaslessSwapChains: [ROBINHOOD] })).toEqual(expected);
    expect(nativeLaterWarnings(r.steps, groupsOf(r, ALL), { gaslessSwapChains: [ROBINHOOD] })).toEqual(expected);
  });
  it('a swap that sells native ETH is never gasless: nothing to warn about; nor without 0x Gasless', () => {
    const native = req({ version: 2, steps: [{ ...GASLESS_SWAP, inputAsset: 'ETH' }, ROBINHOOD_BRIDGE] });
    expect(nativeLaterWarnings(native.steps, null, { gaslessSwapChains: [ROBINHOOD] })).toEqual([]);
    expect(nativeLaterWarnings(r.steps, null, {})).toEqual([]);
  });
});

describe('the warning in words (EN/PT): who needs which coin, never a cancelled design', () => {
  const tr = (language: 'EN' | 'PT') => (key: string, ...parameters: string[]) => translate(language, key, ...parameters);
  const action = (language: 'EN' | 'PT') => (a: string) => translate(language, a === 'add_liquidity' ? 'Add liquidity' : a === 'bridge' ? 'Bridge' : a);
  it('one later step, and several', () => {
    const one = { network: 'Solana', symbol: 'SOL', steps: [{ index: 1, action: 'add_liquidity' }] };
    expect(nativeLaterMessage(one, tr('EN'), action('EN'))).toBe('A later step on Solana needs SOL for its network fee: step 2 (Add liquidity). Add SOL before starting, or the run will stop there.');
    expect(nativeLaterMessage(one, tr('PT'), action('PT'))).toBe('Uma etapa posterior em Solana precisa de SOL para a taxa de rede: etapa 2 (Adicionar liquidez). Adicione SOL antes de começar, ou a execução vai parar ali.');
    const two = { network: 'Base', symbol: 'ETH', steps: [{ index: 1, action: 'add_liquidity' }, { index: 2, action: 'bridge' }] };
    expect(nativeLaterMessage(two, tr('EN'), action('EN'))).toBe('Later steps on Base need ETH for their network fee: step 2 (Add liquidity), step 3 (Bridge). Add ETH before starting, or the run will stop there.');
    expect(nativeLaterMessage(two, tr('PT'), action('PT'))).toMatch(/^Etapas posteriores em Base precisam de ETH para a taxa de rede: etapa 2 \(Adicionar liquidez\), etapa 3 \(/);
  });
});

describe('the /approve plan carries the warning (both modes), and the design stays as it is', () => {
  const never = async (): Promise<never> => { throw new Error('NEVER'); };
  const runtime: McpRuntime = { kind: 'embedded', mode: async () => 'live', info: async () => ({ executionEnabled: true }), preview: never, run: never, journal: never, evidence: never,
    sequences: async () => ({ enabled: true, delegation: null }) };
  const planOf = async (input: unknown, facts: UserFundedFacts) => {
    const w = composed(input);
    return authorizationPlan(w, await evaluateWorkflowGates(w, runtime, readHandoffPolicy({ FLOFI_MCP_HANDOFF_MAINNET_NETWORKS: 'base,solana' })), null, undefined,
      { facts, wallets: METAMASK, evmOwner: OWNER });
  };
  it('a Kora swap → Orca liquidity plan names the liquidity step and SOL', async () => {
    const plan = await planOf({ version: 2, steps: [JUPITER, ORCA] }, { ...ALL, koraTokenGas: true });
    expect(plan.nativeLater).toEqual([{ chain: SOLANA, network: 'Solana', symbol: 'SOL', after: 0, steps: [{ index: 1, action: 'add_liquidity' }] }]);
    expect(plan.stepCount).toBe(2);
    expect((await planOf({ version: 2, steps: [JUPITER, ORCA] }, ALL)).nativeLater).toEqual([]);
  });
  it('a Circle swap → Uniswap liquidity plan names the liquidity step and ETH (user-funded groups offered); its groups are unchanged', async () => {
    const facts: UserFundedFacts = { ...ALL, tokenGasChains: [BASE] };
    const plan = await planOf({ version: 2, steps: [SWAP_BASE, UNISWAP_BASE] }, facts);
    const without = await planOf({ version: 2, steps: [SWAP_BASE, UNISWAP_BASE] }, ALL);
    expect(plan.userFunded.groups.map(g => [g.strategy, g.stepFrom, g.stepTo])).toEqual(without.userFunded.groups.map(g => [g.strategy, g.stepFrom, g.stepTo]));
    expect(plan.userFunded).toMatchObject({ available: true, reason: null });
    expect(plan.nativeLater).toEqual([{ chain: BASE, network: 'Base', symbol: 'ETH', after: 0, steps: [{ index: 1, action: 'add_liquidity' }] }]);
    expect(without.nativeLater).toEqual([]);
  });
});
