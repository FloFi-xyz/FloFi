// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: execution groups of real mainnet compositions — which steps one wallet interaction authorizes, which
 * strategy each group uses for the owner's actual wallets, what waits for a cross-chain delivery, and the honest interaction count.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createMockedSolanaWallet } from '@defi-workflow-engine/reference-compiler';
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

describe('ADR-0010 review C5: a group whose network fee Circle may pay is never counted as one sure wallet interaction', () => {
  it('on a chain where the fee may be paid in USDC: flagged, "at least", never "single"; native-only deployments, other chains and FloFi Wallet unchanged', () => {
    const facts: UserFundedFacts = { ...ALL, tokenGasChains: ['eip155:8453'] };
    const p = plan({ version: 2, steps: [SWAP_BASE, SEND_BASE] }, METAMASK, facts);
    // The plan cannot know the owner's ETH when the group becomes due: one confirmation if ETH pays, two signatures (permit, operation) if Circle does.
    expect(p.groups[0]).toMatchObject({ strategy: 'EVM_WALLET_BATCH', interactions: 1, tokenGas: 'CIRCLE_USDC_PAYMASTER' });
    expect(p.interactions).toMatchObject({ upfront: 1, whenDue: 0, single: false, atLeast: true });
    expect(describeGroup(p.groups[0]!)).toMatch(/one wallet confirmation \(atomic batch\).*two signatures \(a USDC permit, then the operation\)/);
    // Before /approve (assumed wallet capabilities) too.
    expect(plan({ version: 2, steps: [SWAP_BASE, SEND_BASE] }, undefined, facts).interactions).toMatchObject({ single: false, atLeast: true });
    // A native-only deployment: exactly as before.
    const native = plan({ version: 2, steps: [SWAP_BASE, SEND_BASE] }, METAMASK);
    expect(native.groups[0]).not.toHaveProperty('tokenGas');
    expect(native.interactions).toMatchObject({ single: true, atLeast: false });
    // A chain where Circle is not offered, and FloFi Wallet (never handed a Circle permit): unchanged.
    const arbitrum = plan({ version: 2, steps: [{ ...SWAP_BASE, network: 'arbitrum-one' }, { ...SEND_BASE, network: 'arbitrum-one' }] }, METAMASK, facts);
    expect(arbitrum.groups[0]).not.toHaveProperty('tokenGas');
    expect(arbitrum.interactions).toMatchObject({ single: true });
    const flofi = plan({ version: 2, steps: [SWAP_BASE, SEND_BASE] }, { eip155: { wallet: 'FLOFI_WALLET', atomic: { 'eip155:8453': 'supported' }, typedData: true } }, facts);
    expect(flofi.groups[0]).toMatchObject({ strategy: 'EVM_WALLET_BATCH' });
    expect(flofi.groups[0]).not.toHaveProperty('tokenGas');
  });
  it('owner requirement (FloFi Wallet + Circle): a FloFi Wallet group stays owner steps; on a Circle chain it is flagged as possibly Circle-paid when due', () => {
    const facts: UserFundedFacts = { ...ALL, tokenGasChains: ['eip155:8453'] };
    const p = plan({ version: 2, steps: [SWAP_BASE, SEND_BASE] }, FLOFI, facts);
    expect(p.groups[0]).toMatchObject({ strategy: 'EVM_OWNER_STEP', interactions: 2, signing: 'WHEN_DUE', tokenGas: 'CIRCLE_USDC_PAYMASTER' });
    expect(p.interactions).toMatchObject({ single: false, atLeast: true });
    expect(describeGroup(p.groups[0]!)).toMatch(/one wallet confirmation per step.*three signatures the first time \(a smart-account upgrade you agree to first, a USDC permit, then the operation\), two afterwards/);
    // Without the operator's Circle switch, or on a chain without it: exactly as before.
    expect(plan({ version: 2, steps: [SWAP_BASE, SEND_BASE] }, FLOFI).groups[0]).not.toHaveProperty('tokenGas');
    expect(plan({ version: 2, steps: [{ ...SWAP_BASE, network: 'arbitrum-one' }, { ...SEND_BASE, network: 'arbitrum-one' }] }, FLOFI, facts).groups[0]).not.toHaveProperty('tokenGas');
  });
});

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
    // P0: a group that touches Aave after a bridge is never a user operation signed upfront (relayed later without the health-factor and
    // supply-cap simulation): it is a wallet batch simulated and signed when due, and says why.
    const toBase = { action: 'bridge', sourceNetwork: 'arbitrum-one', destinationNetwork: 'base', asset: 'USDC', amount: '5' };
    expect(plan({ version: 2, steps: [toBase, SEND_BASE] }, METAMASK).groups[1]).toMatchObject({ strategy: 'EVM_USER_OPERATION', signing: 'UPFRONT' });
    const borrow = { action: 'borrow', network: 'base', asset: 'USDC', amount: '1', beneficiary: OWNER };
    for (const aave of [{ ...SUPPLY_BASE, asset: 'USDC', amount: '1' }, borrow]) {
      const g = plan({ version: 2, steps: [toBase, aave] }, METAMASK).groups[1]!;
      expect(g).toMatchObject({ strategy: 'EVM_WALLET_BATCH', signing: 'WHEN_DUE' });
      expect(g.downgrades).toContain('USER_OPERATION_AAVE_SIGNED_WHEN_DUE');
    }
  });

  it('a swap whose output a later step of its delayed group spends is never a user operation: a wallet batch simulated and signed when due', () => {
    const toBase = { action: 'bridge', sourceNetwork: 'arbitrum-one', destinationNetwork: 'base', asset: 'USDC', amount: '5' };
    const sendWeth = { ...SEND_BASE, asset: 'WETH', amount: '0.001' };
    // Only the whole-batch simulation proves the owner received the swap's full output (a fee-on-transfer token delivers less, and the bound
    // transfer would spend the owner's other WETH); a user operation signed upfront only ever gets bundler estimates.
    const bound = plan({ version: 2, steps: [toBase, SWAP_BASE, sendWeth], bindings: [{ step: 2, amountFrom: 1 }] }, METAMASK).groups[1]!;
    expect(bound).toMatchObject({ strategy: 'EVM_WALLET_BATCH', signing: 'WHEN_DUE', awaitsDelivery: 0, stepFrom: 1, stepTo: 2 });
    expect(bound.steps[1]).toMatchObject({ amount: 'GUARANTEED_MINIMUM', boundTo: 1 });
    expect(bound.downgrades).toEqual(['USER_OPERATION_SWAP_OUTPUT_SIGNED_WHEN_DUE']);
    // The same swap and transfer, unbound (the swap's output stays with the owner): still one typed-data signature upfront.
    const free = plan({ version: 2, steps: [toBase, SWAP_BASE, sendWeth] }, METAMASK).groups[1]!;
    expect(free).toMatchObject({ strategy: 'EVM_USER_OPERATION', signing: 'UPFRONT', downgrades: [] });
    // Without a bundler the group is a wallet batch when due anyway, for that reason alone.
    const noBundler = plan({ version: 2, steps: [toBase, SWAP_BASE, sendWeth], bindings: [{ step: 2, amountFrom: 1 }] }, METAMASK, { ...ALL, bundlerChains: [] }).groups[1]!;
    expect(noBundler).toMatchObject({ strategy: 'EVM_WALLET_BATCH', signing: 'WHEN_DUE', downgrades: ['USER_OPERATION_BUNDLER_UNAVAILABLE'] });
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

  it('a Solana step spending an output of an earlier step of its group starts a new sign-all group with a closed reason: SOLANA_GROUP_STEP_DEPENDENT', () => {
    // The universal proof's reproduction: swap SOL → USDC, then swap that USDC back to SOL (bound to the first swap's output).
    const roundTrip = { version: 2, steps: [{ action: 'swap', network: 'solana', inputAsset: 'SOL', outputAsset: 'USDC', amount: '0.05' }, SOL_SWAP],
      bindings: [{ step: 1, amountFrom: 0 }] };
    const p = plan(roundTrip, METAMASK);
    // One more wallet prompt, signed when the first swap's output landed (it could not be simulated before): never an unexplained split.
    expect(p.groups.map(g => [g.strategy, g.signing, g.stepFrom, g.stepTo, g.interactions, g.downgrades])).toEqual([
      ['SOLANA_SIGN_ALL', 'UPFRONT', 0, 0, 1, []], ['SOLANA_SIGN_ALL', 'WHEN_DUE', 1, 1, 1, ['SOLANA_GROUP_STEP_DEPENDENT']]]);
    expect(p.groups[1]!.steps[0]).toMatchObject({ amount: 'RECONCILED_ACTUAL', boundTo: 0 });
    expect(p.interactions).toMatchObject({ upfront: 1, whenDue: 1, single: false });
    // The same two swaps unbound share one sign-all prompt (nothing to explain); an owner-step wallet prompts per step anyway (nothing added).
    expect(plan({ version: 2, steps: roundTrip.steps }, METAMASK).groups.map(g => [g.strategy, g.stepFrom, g.stepTo, g.downgrades])).toEqual([['SOLANA_SIGN_ALL', 0, 1, []]]);
    expect(plan(roundTrip, FLOFI).groups.flatMap(g => g.downgrades)).not.toContain('SOLANA_GROUP_STEP_DEPENDENT');
    // An EVM batch keeps a bound step in its producer's group (the batch enforces the signed minimum): no such cut, no such code.
    const evm = plan({ version: 2, steps: [SWAP_BASE, SUPPLY_BASE], bindings: [{ step: 1, amountFrom: 0 }] }, METAMASK);
    expect(evm.groups.map(g => [g.strategy, g.stepFrom, g.stepTo, g.downgrades])).toEqual([['EVM_WALLET_BATCH', 0, 1, []]]);
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

describe('KAN-20: a Solana Batch Payment is ONE sign-all group of exactly its legs (one atomic transaction), never split', () => {
  const PAYEES = ['7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2', '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi'];
  const SOL_BATCH = { action: 'batch_payment', network: 'solana', asset: 'SOL', recipients: PAYEES.map((recipient, i) => ({ recipient, amount: `0.0${i + 1}` })) };
  const USDC_BATCH = { ...SOL_BATCH, asset: 'USDC', recipients: PAYEES.map((recipient, i) => ({ recipient, amount: String(i + 1) })) };
  const OTHER = { ...SOL_SEND, recipient: 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr' };
  const refused = (input: unknown, wallets?: WalletProfile, facts = ALL) => planExecutionGroups(req(input), facts, wallets, buildable(facts));

  it('alone: one SOLANA_SIGN_ALL group of exactly the legs, signed upfront in one prompt (single)', () => {
    for (const batch of [SOL_BATCH, USDC_BATCH]) {
      const p = plan(batch, METAMASK);
      expect(p.groups.map(g => [g.strategy, g.stepFrom, g.stepTo, g.signing, g.interactions, g.downgrades])).toEqual([['SOLANA_SIGN_ALL', 0, 2, 'UPFRONT', 1, []]]);
      expect(p.groups[0]!.steps.map(s => [s.index, s.action, s.amount])).toEqual([[0, 'transfer', 'EXACT'], [1, 'transfer', 'EXACT'], [2, 'transfer', 'EXACT']]);
      expect(p.interactions).toEqual({ upfront: 1, whenDue: 0, perNamespace: { solana: 1 }, networkSwitches: 0, oneTimeSetup: [], single: true, atLeast: false });
    }
  });

  it('an unbound Solana step before or after it is a group of its own (one more prompt): the batch group is always exactly the batch', () => {
    const before = plan({ version: 2, steps: [OTHER, SOL_BATCH] }, METAMASK);
    expect(before.groups.map(g => [g.strategy, g.stepFrom, g.stepTo, g.signing])).toEqual([['SOLANA_SIGN_ALL', 0, 0, 'UPFRONT'], ['SOLANA_SIGN_ALL', 1, 3, 'WHEN_DUE']]);
    const after = plan({ version: 2, steps: [SOL_BATCH, OTHER] }, METAMASK);
    expect(after.groups.map(g => [g.strategy, g.stepFrom, g.stepTo, g.signing])).toEqual([['SOLANA_SIGN_ALL', 0, 2, 'UPFRONT'], ['SOLANA_SIGN_ALL', 3, 3, 'WHEN_DUE']]);
    // Without a batch, two Solana transfers still share one sign-all prompt (unchanged).
    expect(plan({ version: 2, steps: [OTHER, SOL_SEND] }, METAMASK).groups.map(g => [g.strategy, g.stepFrom, g.stepTo])).toEqual([['SOLANA_SIGN_ALL', 0, 1]]);
  });

  it('Jupiter swap -> batch, bound: two groups; the batch spends the reconciled swap output, signed when due', () => {
    const p = plan({ version: 2, steps: [SOL_SWAP, SOL_BATCH], bindings: [{ step: 1, amountFrom: 0 }] }, METAMASK);
    expect(p.groups.map(g => [g.strategy, g.stepFrom, g.stepTo, g.signing, g.downgrades])).toEqual([['SOLANA_SIGN_ALL', 0, 0, 'UPFRONT', []],
      ['SOLANA_SIGN_ALL', 1, 3, 'WHEN_DUE', ['SOLANA_GROUP_STEP_DEPENDENT']]]);
    expect(p.groups[1]!.steps.map(s => [s.amount, s.boundTo])).toEqual([['RECONCILED_ACTUAL', 0], ['RECONCILED_ACTUAL', 0], ['RECONCILED_ACTUAL', 0]]);
  });

  it('Universal bridge -> batch: the batch group waits for the delivery and is signed when due, with the delivered amount', () => {
    const bridge = { action: 'bridge', sourceNetwork: 'base', destinationNetwork: 'solana', asset: 'USDC', amount: '10' };
    const p = plan({ version: 2, steps: [bridge, USDC_BATCH], bindings: [{ step: 1, amountFrom: 0 }] }, METAMASK);
    expect(p.groups.map(g => [g.chain, g.strategy, g.stepFrom, g.stepTo, g.signing, g.awaitsDelivery])).toEqual([['eip155:8453', 'EVM_OWNER_STEP', 0, 0, 'WHEN_DUE', null],
      ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'SOLANA_SIGN_ALL', 1, 3, 'WHEN_DUE', 0]]);
    expect(p.groups[1]!.steps.every(s => s.amount === 'RECONCILED_ACTUAL' && s.boundTo === 0)).toBe(true);
  });

  it('FloFi Wallet, a disabled chain, or no Solana wallet that signs: BATCH_PAYMENT_ATOMIC_EXECUTION_UNAVAILABLE with the reason, never owner steps', () => {
    const flofi = { ...METAMASK, solana: { wallet: 'FLOFI_WALLET' as const, signMultiple: false, nonceAccounts: 0 } };
    expect(refused(SOL_BATCH, flofi)).toEqual({ ok: false, code: 'BATCH_PAYMENT_ATOMIC_EXECUTION_UNAVAILABLE', because: ['FLOFI_WALLET_SOLANA_BATCH_PAYMENT_UNSUPPORTED'] });
    // Even a FloFi Wallet profile that claims to sign several transactions: it has no signing binding for a workflow run's Solana group.
    expect(refused(SOL_BATCH, { ...flofi, solana: { ...flofi.solana, signMultiple: true } }))
      .toEqual({ ok: false, code: 'BATCH_PAYMENT_ATOMIC_EXECUTION_UNAVAILABLE', because: ['FLOFI_WALLET_SOLANA_BATCH_PAYMENT_UNSUPPORTED'] });
    expect(refused(SOL_BATCH, METAMASK, { ...ALL, chains: ALL.chains.filter(c => !c.startsWith('solana:')) }))
      .toEqual({ ok: false, code: 'BATCH_PAYMENT_ATOMIC_EXECUTION_UNAVAILABLE', because: ['USER_FUNDED_CHAIN_DISABLED'] });
    for (const solana of [undefined, { wallet: 'WALLET_STANDARD' as const, signMultiple: false, nonceAccounts: 0 }])
      expect(refused(USDC_BATCH, { eip155: METAMASK.eip155!, ...solana ? { solana } : {} }))
        .toEqual({ ok: false, code: 'BATCH_PAYMENT_ATOMIC_EXECUTION_UNAVAILABLE', because: ['SOLANA_MULTI_SIGN_UNSUPPORTED'] });
    // A non-batch Solana group of FloFi Wallet keeps its owner steps and code (unchanged).
    expect(plan({ version: 2, steps: [SOL_SWAP, SOL_SEND] }, flofi).groups.map(g => [g.strategy, g.downgrades])).toEqual([['SOLANA_OWNER_STEP', ['SOLANA_MULTI_SIGN_UNSUPPORTED']]]);
  });

  it('compositions (design 5): Swap/Withdraw -> Bridge -> Batch, Bridge -> Batch, Jupiter -> Batch, Batch alone at 8: the batch is always ONE group of its legs', () => {
    const payees = Array.from({ length: 8 }, () => createMockedSolanaWallet().owner);
    const usdc = (n: number) => ({ action: 'batch_payment', network: 'solana', asset: 'USDC', recipients: payees.slice(0, n).map((recipient, i) => ({ recipient, amount: String(i + 1) })) });
    const swap = { action: 'swap', network: 'base', inputAsset: 'WETH', outputAsset: 'USDC', amount: '0.01' };
    const withdraw = { action: 'withdraw', network: 'base', asset: 'USDC', amount: '10' };
    const bridge = { action: 'bridge', sourceNetwork: 'base', destinationNetwork: 'solana', asset: 'USDC', amount: '10' };
    const shape = (input: unknown) => plan(input, METAMASK).groups.map(g => [g.chain, g.strategy, g.stepFrom, g.stepTo, g.signing, g.awaitsDelivery]);
    const SOL = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
    // An EVM producer, the bridge (an owner step), then the batch: signed when the delivery reconciled, at most 6 recipients (the 8-step budget).
    for (const producer of [swap, withdraw])
      expect(shape({ version: 2, steps: [producer, bridge, usdc(6)], bindings: [{ step: 1, amountFrom: 0 }, { step: 2, amountFrom: 1 }] })).toEqual([
        ['eip155:8453', 'EVM_WALLET_BATCH', 0, 0, 'UPFRONT', null], ['eip155:8453', 'EVM_OWNER_STEP', 1, 1, 'WHEN_DUE', null], [SOL, 'SOLANA_SIGN_ALL', 2, 7, 'WHEN_DUE', 1]]);
    expect(shape({ version: 2, steps: [bridge, usdc(7)], bindings: [{ step: 1, amountFrom: 0 }] })).toEqual([['eip155:8453', 'EVM_OWNER_STEP', 0, 0, 'WHEN_DUE', null],
      [SOL, 'SOLANA_SIGN_ALL', 1, 7, 'WHEN_DUE', 0]]);
    expect(shape({ version: 2, steps: [{ ...SOL_SWAP, inputAsset: 'SOL', outputAsset: 'USDC', amount: '1' }, usdc(7)], bindings: [{ step: 1, amountFrom: 0 }] })).toEqual([
      [SOL, 'SOLANA_SIGN_ALL', 0, 0, 'UPFRONT', null],
      [SOL, 'SOLANA_SIGN_ALL', 1, 7, 'WHEN_DUE', null]]);
    expect(shape(usdc(8))).toEqual([[SOL, 'SOLANA_SIGN_ALL', 0, 7, 'UPFRONT', null]]);
    // Beyond the step budget, or a batch as a producer: refused when composed, never split or trimmed.
    const composed = (input: unknown) => { const c = composeWorkflow(input); return c.ok ? 'OK' : c.code; };
    expect(composed({ version: 2, steps: [swap, bridge, usdc(7)], bindings: [{ step: 1, amountFrom: 0 }, { step: 2, amountFrom: 1 }] })).toBe('BATCH_PAYMENT_EXCEEDS_WORKFLOW_STEP_BUDGET');
    expect(composed({ version: 2, steps: [bridge, usdc(8)], bindings: [{ step: 1, amountFrom: 0 }] })).toBe('BATCH_PAYMENT_EXCEEDS_WORKFLOW_STEP_BUDGET');
    expect(composed({ version: 2, steps: [usdc(2), { ...SOL_SEND, asset: 'USDC', amount: '1' }], bindings: [{ step: 1, amountFrom: 0 }] })).toBe('WORKFLOW_BINDING_PRODUCER_UNSUPPORTED');
  });

  it('every EVM Batch Payment plan deep-equals the fed320e planner (Robinhood, Base, Arbitrum, Ethereum; supported / ready / unsupported / unknown / FloFi / assumed)', () => {
    // Produced by the planner at fed320e (before KAN-20) for exactly these inputs, and compared with this planner when it was recorded.
    const baseline = JSON.parse(readFileSync(new URL('./testdata/evm-batch-plans.fed320e.json', import.meta.url), 'utf8')) as Record<string, unknown>;
    const payees = ['0x' + 'a1'.repeat(20), '0x' + 'b2'.repeat(20), '0x' + 'c3'.repeat(20)];
    const nets = [['robinhood', 'eip155:4663', 'USDG'], ['base', 'eip155:8453', 'USDC'], ['arbitrum-one', 'eip155:42161', 'USDC'], ['ethereum', 'eip155:1', 'USDC']] as const;
    const plans: Record<string, unknown> = {};
    for (const [net, chain, asset] of nets) {
      const batch = { action: 'batch_payment', network: net, asset, recipients: payees.map((recipient, i) => ({ recipient, amount: String(i + 1) })) };
      const inputs: Record<string, unknown> = { batch, ...net === 'base' ? { swapThenBatch: { version: 2, steps: [{ action: 'swap', network: 'base', inputAsset: 'WETH',
        outputAsset: 'USDC', amount: '0.01' }, batch], bindings: [{ step: 1, amountFrom: 0 }] } } : {} };
      for (const [label, input] of Object.entries(inputs))
        for (const atomic of ['supported', 'ready', 'unsupported', 'unknown', 'flofi', 'assumed'] as const) for (const tokenGas of [false, true]) {
          const facts: UserFundedFacts = tokenGas ? { ...ALL, tokenGasChains: [chain] } : ALL;
          const wallets: WalletProfile | undefined = atomic === 'assumed' ? undefined : atomic === 'flofi' ? { eip155: { wallet: 'FLOFI_WALLET', atomic: {}, typedData: true } }
            : { eip155: { wallet: 'INJECTED', atomic: atomic === 'unknown' ? {} : { [chain]: atomic }, typedData: true } };
          plans[`${net}|${label}|${atomic}|${tokenGas ? 'tokenGas' : 'native'}`] = JSON.parse(JSON.stringify(planExecutionGroups(req(input), facts, wallets, buildable(facts))));
        }
    }
    expect(Object.keys(plans)).toHaveLength(60);
    expect(plans).toEqual(baseline);
  });
});
