// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001: every eligible single-action card, reviewed as the Editor's one-step run on deterministic MOCKED
 * chain doubles (no database, no network, nothing signed). For a MetaMask that reports EIP-5792 atomic batching, each card is ONE wallet
 * confirmation and ONE transaction, with an EXACT approval folded into the batch only where the owner's current allowance does not cover the
 * spend (never unlimited), and an on-chain expiry (the swap's own deadline, else a deadline guard). Cards FloFi cannot batch are never presented
 * as one confirmation (the Review plans them step by step and the Editor keeps the card's own flow).
 */
import { describe, expect, it } from 'vitest';
import { CROSSCHAIN_ROUTER_ARBITRUM_BASE as P } from '@defi-workflow-engine/action-registry';
import type { Command } from '../domain/commands';
import { editorReducer, initialEditor } from '../domain/editor';
import type { Workflow } from '../domain/initial-workflow';
import { ARBITRUM_MAINNET_SWAP, BASE_MAINNET_SWAP, ETHEREUM_MAINNET_SWAP } from '../domain/public-testnet-swap.ts';
import { guarded } from '../delegation/chains.ts';
import { createEvmDouble } from '../delegation/harness/evm-double.ts';
import { ACROSS_DOUBLE_SPOKE_CODE, acrossDouble } from '../delegation/harness/across-double.ts';
import { delegationAavePool, delegationAaveReserve } from '../delegation/profiles.ts';
import { requirementOf } from '../delegation/steps.ts';
import { composeWorkflow, dappReviewContext } from '../engine/strategy-engine';
import { buildEvmGroupCalls, evmCallsOf } from '../user-funded/evm-calls.ts';
import type { UserFundedDeps } from '../user-funded/groups.ts';
import type { UserFundedFacts, WalletProfile } from '../workflow-runs/execution-groups.ts';
import { reviewEditorExecution } from './workflow-execution.ts';

const NOW_S = 1_800_000_000, NOW = new Date(NOW_S * 1000);
const OWNER = '0x' + '1a'.repeat(20), FRIEND = '0x' + '2b'.repeat(20);
const ARB = 'eip155:42161', BASE = 'eip155:8453', ETH = 'eip155:1';
const A_USDC = ARBITRUM_MAINNET_SWAP.usdc.toLowerCase(), A_WETH = ARBITRUM_MAINNET_SWAP.weth.toLowerCase();
const POOL = delegationAavePool(ARB, [ARB])!;
const reserve = (asset: string) => delegationAaveReserve(ARB, POOL, asset)!;
const RESERVES = [{ ...reserve(A_WETH), price: 2_500n * 10n ** 8n, ltvBps: 8_000n, liquidationThresholdBps: 8_300n, decimals: 18 },
  { ...reserve(A_USDC), price: 10n ** 8n, ltvBps: 7_500n, liquidationThresholdBps: 7_800n, decimals: 6 }];
const metamask = (chain: string, atomic: 'supported' | 'ready' | 'unsupported' = 'supported'): WalletProfile =>
  ({ eip155: { wallet: 'INJECTED', atomic: { [chain]: atomic }, typedData: true } });

/** ONE card on the Canvas, authored by the same command FloFi's chat produces for it. */
function canvasOf(strategy: unknown): Workflow {
  const composed = composeWorkflow(strategy);
  if (!composed.ok) throw new Error(composed.code);
  const state = editorReducer(initialEditor(), { ...composed.steps[0]!.command, baseRevision: initialEditor().workflow.revision } as Command, dappReviewContext());
  if (state.error) throw new Error(state.error);
  return state.workflow;
}
/** One MOCKED chain (with Arbitrum One's modelled Aave V3 market and Across origin), funded for the owner. */
function chainOf(chainId: 1 | 8453 | 42161) {
  const profile = chainId === 42161 ? ARBITRUM_MAINNET_SWAP : chainId === 8453 ? BASE_MAINNET_SWAP : ETHEREUM_MAINNET_SWAP;
  const double = createEvmDouble(chainId, () => NOW_S, { profile, ...chainId === 42161 ? { aave: { pool: POOL, reserves: RESERVES },
    across: { spokePool: P.source.spokePool, token: P.source.token, code: ACROSS_DOUBLE_SPOKE_CODE, role: 'origin' as const } }
    : chainId === 8453 ? { across: { spokePool: P.destination.spokePool, token: P.destination.token, code: ACROSS_DOUBLE_SPOKE_CODE, role: 'destination' as const } } : {} });
  double.control.fundToken(OWNER, profile.weth, 10n ** 18n); double.control.fundToken(OWNER, profile.usdc, 1_000_000_000n); double.control.fundNative(OWNER, 10n ** 18n);
  return { double, profile, chain: `eip155:${chainId}` };
}
type Chain = ReturnType<typeof chainOf>;
function depsOf(c: Chain, base?: Chain): { readonly deps: UserFundedDeps; readonly facts: UserFundedFacts } {
  const chains = base ? [c.chain, base.chain] : [c.chain];
  const across = base ? acrossDouble(P, () => NOW_S) : null;
  const evm = (chain: string) => chain === c.chain ? guarded(chain, 'read', 'MOCKED', c.double.rpc) : base && chain === base.chain ? guarded(chain, 'read', 'MOCKED', base.double.rpc) : null;
  return { deps: { chains, evm, bundler: () => null, solana: null, jupiter: null, now: () => NOW, ...across ? { across: (s: string, d: string) => s === ARB && d === BASE ? across.route : null } : {} },
    facts: { enabled: true, code: null, chains, bundlerChains: [], solanaNonceAccounts: false, ...base ? { bridgeRoutes: [`${ARB}>${BASE}`] } : {} } };
}
async function review(c: Chain, strategy: unknown, profile: WalletProfile = metamask(c.chain), base?: Chain) {
  const { deps, facts } = depsOf(c, base);
  const r = await reviewEditorExecution({ workflow: canvasOf(strategy), owner: OWNER, profile, facts, deps, now: NOW, singleStep: true });
  if (!r.ok) throw new Error(r.code);
  return r.value;
}
/** The owner's wallet executes a batch of these steps (to set up a position for a later card: collateral, debt). */
async function execute(c: Chain, strategy: unknown) {
  const composed = composeWorkflow(strategy);
  if (!composed.ok) throw new Error(composed.code);
  const req = requirementOf(composed);
  if (!req.ok) throw new Error(req.code);
  const built = await buildEvmGroupCalls(req.value, 0, req.value.steps.length - 1, { chains: [c.chain], owner: OWNER, deadline: NOW_S + 600,
    transport: chain => chain === c.chain ? guarded(chain, 'read', 'MOCKED', c.double.rpc) : null });
  if (!built.ok) throw new Error(built.code);
  c.double.control.walletBatch(OWNER, evmCallsOf(built.value));
}
const ONE = { mode: 'ONE_WALLET_CONFIRMATION', stepCount: 1, refusal: null, counts: { walletPrompts: 1, atLeast: false, signatures: 1, transactions: 1, networkSwitches: 0 } };
const kinds = (r: Awaited<ReturnType<typeof review>>) => r.groups[0]!.calls!.map(call => call.kind);

describe('BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001: every eligible single card is ONE wallet confirmation (MOCKED chains, read-only Review)', () => {
  it.each([[42161, 'arbitrum-one'], [8453, 'base'], [1, 'ethereum']] as const)('Swap on %s (%s): insufficient allowance → [exact approval, swap]; sufficient → [swap]', async (id, network) => {
    const c = chainOf(id), swap = { version: 1, action: 'swap', network, inputAsset: 'WETH', outputAsset: 'USDC', amount: '0.0006', slippageBps: 50 };
    const short = await review(c, swap);
    expect(short).toMatchObject({ ...ONE, counts: { ...ONE.counts, batchedCalls: 2 } });
    expect(kinds(short)).toEqual(['ERC20_APPROVE', 'UNISWAP_V3_EXACT_INPUT_SINGLE']);
    expect(short.groups[0]).toMatchObject({ strategy: 'EVM_WALLET_BATCH', approvals: 1, fee: { payer: OWNER } });
    c.double.control.setAllowance(c.profile.weth, OWNER, c.profile.router, 600_000_000_000_000n);
    const covered = await review(c, swap);
    expect(covered).toMatchObject({ ...ONE, counts: { ...ONE.counts, batchedCalls: 1 } });
    expect(kinds(covered)).toEqual(['UNISWAP_V3_EXACT_INPUT_SINGLE']);
  });

  it('MetaMask reporting atomic "ready" (the EIP-7702 upgrade happens inside the same confirmation): still ONE confirmation, the setup named', async () => {
    const c = chainOf(42161);
    const r = await review(c, { version: 1, action: 'swap', network: 'arbitrum-one', inputAsset: 'WETH', outputAsset: 'USDC', amount: '0.0006', slippageBps: 50 }, metamask(ARB, 'ready'));
    expect(r).toMatchObject(ONE);
    expect(r.groups[0]!.setup).toEqual(['EVM_SMART_ACCOUNT_UPGRADE']);
  });

  it('Aave Supply → [deadline guard, exact approval, supply]; with an allowance → [deadline guard, supply]', async () => {
    const c = chainOf(42161), supply = { version: 1, action: 'supply', network: 'arbitrum-one', asset: 'WETH', amount: '0.01', beneficiary: OWNER };
    const r = await review(c, supply);
    expect(r).toMatchObject(ONE);
    expect(kinds(r)).toEqual(['DEADLINE_GUARD', 'ERC20_APPROVE', 'AAVE_V3_SUPPLY']);
    c.double.control.setAllowance(A_WETH, OWNER, POOL, 10n ** 16n);
    expect(kinds(await review(c, supply))).toEqual(['DEADLINE_GUARD', 'AAVE_V3_SUPPLY']);
  });

  it('Aave Borrow, Withdraw and Repay on the owner\'s own position: ONE confirmation each (health factor proven by the batch simulation)', async () => {
    const c = chainOf(42161);
    await execute(c, { version: 1, action: 'supply', network: 'arbitrum-one', asset: 'WETH', amount: '0.1', beneficiary: OWNER });
    const borrow = await review(c, { version: 1, action: 'borrow', network: 'arbitrum-one', asset: 'USDC', amount: '20', beneficiary: OWNER });
    expect(borrow).toMatchObject(ONE);
    expect(kinds(borrow)).toEqual(['DEADLINE_GUARD', 'AAVE_V3_BORROW']);
    expect(BigInt(borrow.groups[0]!.healthFactorAfter!)).toBeGreaterThanOrEqual(2n * 10n ** 18n);
    await execute(c, { version: 1, action: 'borrow', network: 'arbitrum-one', asset: 'USDC', amount: '20', beneficiary: OWNER });
    const repay = await review(c, { version: 1, action: 'repay', network: 'arbitrum-one', asset: 'USDC', amount: '5', beneficiary: OWNER });
    expect(repay).toMatchObject(ONE);
    expect(kinds(repay)).toEqual(['DEADLINE_GUARD', 'ERC20_APPROVE', 'AAVE_V3_REPAY']);
    const withdraw = await review(c, { version: 1, action: 'withdraw', network: 'arbitrum-one', asset: 'WETH', amount: '0.01' });
    expect(withdraw).toMatchObject(ONE);
    expect(kinds(withdraw)).toEqual(['DEADLINE_GUARD', 'AAVE_V3_WITHDRAW']);
  });

  it('Transfer of a catalog ERC-20 and of native ETH to an EOA: ONE confirmation each (no approval)', async () => {
    const c = chainOf(42161);
    const usdc = await review(c, { version: 1, action: 'transfer', network: 'arbitrum-one', asset: 'USDC', amount: '3', recipient: FRIEND });
    expect(usdc).toMatchObject(ONE);
    expect(kinds(usdc)).toEqual(['DEADLINE_GUARD', 'ERC20_TRANSFER']);
    expect(usdc.steps[0]!.recipient).toBe(FRIEND);
    // A native transfer to an EOA is built the same way: ONE batch of [deadline guard, value transfer]. (The MOCKED double models no value-carrying
    // call, so its whole-batch simulation is not run here; `groups.test.ts` covers native transfers end to end on its own loopback transport.)
    const composed = composeWorkflow({ version: 1, action: 'transfer', network: 'arbitrum-one', asset: 'ETH', amount: '0.001', recipient: FRIEND });
    if (!composed.ok) throw new Error(composed.code);
    const req = requirementOf(composed);
    if (!req.ok) throw new Error(req.code);
    const built = await buildEvmGroupCalls(req.value, 0, 0, { chains: [ARB], owner: OWNER, deadline: NOW_S + 600,
      transport: chain => chain === ARB ? guarded(chain, 'read', 'MOCKED', c.double.rpc) : null });
    if (!built.ok) throw new Error(built.code);
    expect(built.value.calls).toEqual([{ kind: 'DEADLINE_GUARD', router: ARBITRUM_MAINNET_SWAP.router.toLowerCase(), deadline: String(NOW_S + 600) },
      { kind: 'NATIVE_TRANSFER', to: FRIEND, amount: '1000000000000000' }]);
  });

  it('Certified Router bridge Arbitrum One → Base (Across, to the owner): ONE confirmation [exact approval to the SpokePool, deposit]', async () => {
    const c = chainOf(42161), base = chainOf(8453);
    const r = await review(c, { version: 1, action: 'bridge', sourceNetwork: 'arbitrum-one', destinationNetwork: 'base', asset: 'USDC', amount: '5' }, metamask(ARB), base);
    expect(r).toMatchObject(ONE);
    expect(kinds(r).filter(k => k !== 'DEADLINE_GUARD')).toEqual(['ERC20_APPROVE', 'ACROSS_DEPOSIT']);
    expect(r.steps[0]!.destination).toBe('Base');
  });

  it('never presented as one confirmation: a wallet without atomic batching, an unknown capability, FloFi Wallet, and a native-ETH swap', async () => {
    const c = chainOf(42161), swap = { version: 1, action: 'swap', network: 'arbitrum-one', inputAsset: 'WETH', outputAsset: 'USDC', amount: '0.0006', slippageBps: 50 };
    expect(await review(c, swap, metamask(ARB, 'unsupported'))).toMatchObject({ mode: 'STEP_BY_STEP', reasons: ['WALLET_ATOMIC_BATCH_UNSUPPORTED'] });
    expect(await review(c, swap, { eip155: { wallet: 'INJECTED', atomic: {}, typedData: true } })).toMatchObject({ mode: 'STEP_BY_STEP',
      reasons: ['WALLET_ATOMIC_BATCH_UNKNOWN'] });
    expect((await review(c, swap, { eip155: { wallet: 'FLOFI_WALLET', atomic: {}, typedData: true } })).mode).toBe('STEP_BY_STEP');
    const native = await review(c, { ...swap, inputAsset: 'ETH' });
    expect(native.mode).toBe('STEP_BY_STEP');
    expect(native.reasons.join()).toMatch(/NATIVE|NOT_BUILDABLE/);
    // Counts are never rounded down: a step through its own flow is "at least" one confirmation.
    expect(native.counts.atLeast).toBe(true);
  });

  it('a card on another chain than the one the wallet reports batching for is not one confirmation there', async () => {
    const c = chainOf(8453);
    const r = await review(c, { version: 1, action: 'swap', network: 'base', inputAsset: 'WETH', outputAsset: 'USDC', amount: '0.0006', slippageBps: 50 }, metamask(ETH));
    expect(r.mode).toBe('STEP_BY_STEP');
  });
});
