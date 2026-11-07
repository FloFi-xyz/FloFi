// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: execution groups of real mainnet compositions — which steps one wallet interaction authorizes, which
 * strategy each group uses for the owner's actual wallets, what waits for a cross-chain delivery, and the honest interaction count.
 */
import { describe, expect, it } from 'vitest';
import { requirementOf, type WorkflowRequirement } from '../delegation/steps.ts';
import { composeWorkflow } from '../engine/strategy-engine';
import { evmStepBuildable } from '../user-funded/evm-calls.ts';
import { describeGroup, planExecutionGroups, summarize, type UserFundedFacts, type WalletProfile } from './execution-groups.ts';

const OWNER = '0x' + '1'.repeat(40);
const ALL: UserFundedFacts = { enabled: true, code: null, chains: ['eip155:1', 'eip155:8453', 'eip155:42161', 'eip155:4663', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'],
  bundlerChains: ['eip155:8453'], solanaNonceAccounts: true };
const METAMASK: WalletProfile = { eip155: { wallet: 'INJECTED', atomic: { 'eip155:8453': 'supported', 'eip155:42161': 'ready', 'eip155:1': 'unsupported' }, typedData: true },
  solana: { wallet: 'WALLET_STANDARD', signMultiple: true, nonceAccounts: 0 } };
const FLOFI: WalletProfile = { eip155: { wallet: 'FLOFI_WALLET', atomic: {}, typedData: true }, solana: { wallet: 'FLOFI_WALLET', signMultiple: false, nonceAccounts: 0 } };
function req(input: unknown): WorkflowRequirement {
  const w = composeWorkflow(input);
  if (!w.ok) throw new Error(w.code);
  const r = requirementOf(w);
  if (!r.ok) throw new Error(r.code);
  return r.value;
}
const buildable = (facts: UserFundedFacts) => (s: WorkflowRequirement['steps'][number]) => s.namespace === 'solana' || evmStepBuildable(s, facts.chains) === null;
const plan = (input: unknown, wallets?: WalletProfile, facts = ALL) => {
  const p = planExecutionGroups(req(input), facts, wallets, buildable(facts));
  if (!p.ok) throw new Error(p.code);
  return p;
};
const SWAP_BASE = { action: 'swap', network: 'base', inputAsset: 'USDC', outputAsset: 'WETH', amount: '10' };
const SUPPLY_BASE = { action: 'supply', network: 'base', asset: 'WETH', amount: '0.002', beneficiary: OWNER };
const SEND_BASE = { action: 'transfer', network: 'base', asset: 'USDC', amount: '1', recipient: '0x' + '2'.repeat(40) };
const SOL_SWAP = { action: 'swap', network: 'solana', inputAsset: 'USDC', outputAsset: 'SOL', amount: '5' };
const SOL_SEND = { action: 'transfer', network: 'solana', asset: 'SOL', amount: '0.01', recipient: '7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2' };

describe('BUILD-FLOFI-UNIVERSAL-WORKFLOW-002 execution groups', () => {
  it('batches consecutive buildable same-chain steps into ONE owner-paid wallet interaction, with in-group bindings fixed to the signed minimum', () => {
    const p = plan({ version: 2, steps: [SWAP_BASE, SUPPLY_BASE, SEND_BASE], bindings: [{ step: 1, amountFrom: 0 }] }, METAMASK);
    expect(p.groups).toHaveLength(1);
    expect(p.groups[0]).toMatchObject({ chain: 'eip155:8453', strategy: 'EVM_WALLET_BATCH', signing: 'UPFRONT', interactions: 1, feePayer: 'OWNER_WALLET', setup: [],
      steps: [{ index: 0, amount: 'EXACT' }, { index: 1, amount: 'GUARANTEED_MINIMUM', boundTo: 0 }, { index: 2, amount: 'EXACT' }], downgrades: [] });
    expect(p.interactions).toEqual({ upfront: 1, whenDue: 0, perNamespace: { eip155: 1 }, networkSwitches: 0, oneTimeSetup: [], single: true, atLeast: false });
    expect(describeGroup(p.groups[0]!)).toMatch(/one wallet confirmation \(atomic batch\).*fees paid by your own wallet/);
  });

  it('a wallet without atomic batching confirms each step through its flow (FloFi Wallet: one Privy confirmation per step), counted per step', () => {
    const p = plan({ version: 2, steps: [SWAP_BASE, SEND_BASE] }, FLOFI);
    expect(p.groups.map(g => [g.strategy, g.stepFrom, g.stepTo, g.interactions])).toEqual([['EVM_OWNER_STEP', 0, 1, 2]]);
    expect(p.groups[0]!.downgrades).toEqual(['WALLET_ATOMIC_BATCH_UNKNOWN']);
    expect(p.interactions.single).toBe(false);
    // An explicit `unsupported` answer is reported as such; `ready` means the wallet upgrades the account inside the same confirmation.
    expect(plan({ version: 2, steps: [{ ...SWAP_BASE, network: 'ethereum' }, { ...SEND_BASE, network: 'ethereum' }] }, METAMASK).groups[0]!.downgrades).toEqual(['WALLET_ATOMIC_BATCH_UNSUPPORTED']);
    const arbitrum = plan({ version: 2, steps: [{ ...SWAP_BASE, network: 'arbitrum-one' }, { ...SEND_BASE, network: 'arbitrum-one' }] }, METAMASK);
    expect(arbitrum.groups[0]).toMatchObject({ strategy: 'EVM_WALLET_BATCH', setup: ['EVM_SMART_ACCOUNT_UPGRADE'], interactions: 1 });
    expect(arbitrum.interactions).toMatchObject({ single: true, oneTimeSetup: ['EVM_SMART_ACCOUNT_UPGRADE'] });
  });

  it('a step FloFi cannot build exactly stands alone through its own flow; a disabled chain is never batched', () => {
    const liquidity = { action: 'add_liquidity', network: 'base', maxAmounts: { USDC: '2', WETH: '0.001' }, range: { unit: 'full' } };
    const p = plan({ version: 2, steps: [SWAP_BASE, SEND_BASE, liquidity] }, METAMASK);
    expect(p.groups.map(g => [g.strategy, g.stepFrom, g.stepTo])).toEqual([['EVM_WALLET_BATCH', 0, 1], ['EVM_OWNER_STEP', 2, 2]]);
    expect(p.groups[1]!.downgrades[0]).toMatch(/^USER_FUNDED_ACTION_NOT_BUILDABLE/);
    const disabled = plan({ version: 2, steps: [SWAP_BASE, SEND_BASE] }, METAMASK, { ...ALL, chains: ['eip155:1'] });
    expect(disabled.groups.map(g => [g.strategy, g.downgrades[0]])).toEqual([['EVM_OWNER_STEP', 'USER_FUNDED_CHAIN_DISABLED'], ['EVM_OWNER_STEP', 'USER_FUNDED_CHAIN_DISABLED']]);
  });

  it('cuts at every chain change and at a bridge; the destination group waits for the reconciled delivery and is signed when due', () => {
    const bridge = { action: 'bridge', sourceNetwork: 'base', destinationNetwork: 'solana', asset: 'USDC', amount: '5' };
    expect(composeWorkflow({ version: 2, steps: [SWAP_BASE, bridge, SOL_SWAP, SOL_SEND], bindings: [{ step: 2, amountFrom: 1 }] }).ok).toBe(true);
    const p = plan({ version: 2, steps: [SWAP_BASE, bridge, SOL_SWAP, SOL_SEND], bindings: [{ step: 2, amountFrom: 1 }] }, METAMASK);
    expect(p.groups.map(g => [g.chain, g.strategy, g.signing, g.awaitsDelivery, g.stepFrom, g.stepTo])).toEqual([
      ['eip155:8453', 'EVM_WALLET_BATCH', 'UPFRONT', null, 0, 0],
      ['eip155:8453', 'EVM_OWNER_STEP', 'WHEN_DUE', null, 1, 1],
      ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'SOLANA_SIGN_ALL', 'WHEN_DUE', 1, 2, 3]]);
    // The Solana swap spends what the bridge actually delivered (reconciled), never an estimate; it is signed when the delivery landed.
    expect(p.groups[2]!.steps[0]).toMatchObject({ amount: 'RECONCILED_ACTUAL', boundTo: 1 });
    // Durable nonces are not offered in this build (ADR-0008): a post-delivery Solana group is signed when due, and says why.
    expect(p.groups[2]!.downgrades).toContain('SOLANA_DURABLE_NONCE_NOT_OFFERED');
    expect(p.interactions).toMatchObject({ upfront: 1, whenDue: 2, perNamespace: { eip155: 2, solana: 1 }, single: false });
    // The bridge runs through its own flow (an approval may add a confirmation): every count is a minimum, never rounded down.
    expect(p.interactions.atLeast).toBe(true);
    expect(plan({ version: 2, steps: [SWAP_BASE, SEND_BASE] }, METAMASK).interactions).toMatchObject({ upfront: 1, whenDue: 0, single: true, atLeast: false });
    // Even a delayed Solana group with no dependency on the delivery, on a deployment that would allow nonce accounts, is signed when due.
    const free = plan({ version: 2, steps: [bridge, SOL_SEND] }, METAMASK, { ...ALL, solanaNonceAccounts: true });
    expect(free.groups.map(g => [g.strategy, g.signing])).toEqual([['EVM_OWNER_STEP', 'WHEN_DUE'], ['SOLANA_SIGN_ALL', 'WHEN_DUE']]);
  });

  it('only the first group or a user operation is signed upfront: a later wallet batch would be SENT at once, out of order', () => {
    const p = plan({ version: 2, steps: [SWAP_BASE, { ...SWAP_BASE, network: 'arbitrum-one' }] }, METAMASK);
    expect(p.groups.map(g => [g.chain, g.strategy, g.signing])).toEqual([['eip155:8453', 'EVM_WALLET_BATCH', 'UPFRONT'], ['eip155:42161', 'EVM_WALLET_BATCH', 'WHEN_DUE']]);
    // A user operation needs an account that is ALREADY a smart account: `ready` (upgrade on first batch) cannot sign one.
    const bridge = { action: 'bridge', sourceNetwork: 'arbitrum-one', destinationNetwork: 'base', asset: 'USDC', amount: '5' };
    const ready = { ...METAMASK, eip155: { ...METAMASK.eip155!, atomic: { 'eip155:8453': 'ready' as const, 'eip155:42161': 'ready' as const } } };
    const delayed = plan({ version: 2, steps: [bridge, SEND_BASE] }, ready);
    expect(delayed.groups[1]).toMatchObject({ strategy: 'EVM_WALLET_BATCH', signing: 'WHEN_DUE' });
    expect(delayed.groups[1]!.downgrades).toContain('EVM_SMART_ACCOUNT_REQUIRED');
  });

  it('Solana: independent steps share one sign-all prompt; a step spending an earlier step\'s output starts its own group, signed when due', () => {
    const independent = plan({ version: 2, steps: [SOL_SWAP, SOL_SEND] }, METAMASK);
    expect(independent.groups.map(g => [g.strategy, g.stepFrom, g.stepTo, g.interactions])).toEqual([['SOLANA_SIGN_ALL', 0, 1, 1]]);
    const bound = plan({ version: 2, steps: [SOL_SWAP, { ...SOL_SEND, amount: '0.02' }], bindings: [{ step: 1, amountFrom: 0 }] }, METAMASK);
    expect(bound.groups.map(g => [g.strategy, g.signing, g.stepFrom])).toEqual([['SOLANA_SIGN_ALL', 'UPFRONT', 0], ['SOLANA_SIGN_ALL', 'WHEN_DUE', 1]]);
    // FloFi Wallet (Privy) shows one confirmation per Solana transaction: one interaction per step, never claimed as one.
    const flofi = plan({ version: 2, steps: [SOL_SWAP, SOL_SEND] }, FLOFI);
    expect(flofi.groups.map(g => [g.strategy, g.interactions])).toEqual([['SOLANA_OWNER_STEP', 2]]);
    expect(flofi.groups[0]!.downgrades).toContain('SOLANA_MULTI_SIGN_UNSUPPORTED');
  });

  it('summarizes honestly: network switches, setup prompts and the meaning of "single"', () => {
    const p = plan({ version: 2, steps: [SWAP_BASE, { ...SWAP_BASE, network: 'arbitrum-one' }] }, METAMASK);
    expect(p.groups.map(g => g.chain)).toEqual(['eip155:8453', 'eip155:42161']);
    expect(p.interactions).toMatchObject({ upfront: 1, whenDue: 1, networkSwitches: 1, single: false });
    expect(summarize([{ ...p.groups[0]!, setup: ['SOLANA_NONCE_ACCOUNTS'] }]).single).toBe(false);
    // Without a wallet profile the plan says it assumed the supported wallet families' documented capabilities.
    expect(plan({ version: 2, steps: [SWAP_BASE, SEND_BASE] }).groups[0]!.downgrades).toContain('WALLET_CAPABILITIES_ASSUMED');
    expect(planExecutionGroups(req({ version: 2, steps: [SWAP_BASE, SEND_BASE] }), { ...ALL, enabled: false, code: 'USER_FUNDED_NOT_ENABLED' })).toEqual({ ok: false,
      code: 'USER_FUNDED_NOT_ENABLED' });
  });
});
