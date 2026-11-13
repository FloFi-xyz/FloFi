// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (ADR-0010 §3): the Editor's whole-workflow Review of a Base workflow whose owner holds USDC but no ETH
 * — the first group's fee is shown as paid from the owner's USDC through Circle (the permit's cap), the wallet is counted twice (permit, then
 * operation) and the plan the Authorize binding compares stays the run's own; an owner with ETH keeps the native fee and one confirmation; an
 * Ethereum MetaMask account gets the native shortfall with Circle's closed reason. Read-only; MOCKED loopback doubles only.
 */
import { describe, expect, it } from 'vitest';
import { BASE_MAINNET_SWAP, ETHEREUM_MAINNET_SWAP } from '../domain/public-testnet-swap.ts';
import { guarded } from '../delegation/chains.ts';
import { createEvmDouble } from '../delegation/harness/evm-double.ts';
import { createCircleDouble } from '../delegation/harness/circle-double.ts';
import type { UserFundedDeps } from '../user-funded/groups.ts';
import { reviewEditorExecution } from './workflow-execution.ts';
import { canvasWorkflowOfStrategy } from './workflow-strategy.ts';

const NOW = new Date('2026-11-13T12:00:00Z'), OWNER = '0x' + '1a'.repeat(20);
const transfers = (network: string) => ({ version: 2, steps: [
  { action: 'transfer', network, asset: 'USDC', amount: '1', recipient: '0x' + '2'.repeat(40) },
  { action: 'transfer', network, asset: 'USDC', amount: '2', recipient: '0x' + '3'.repeat(40) }] });

async function reviewOn(chainId: 1 | 8453, eth: bigint, options: { readonly tokenGasChains?: readonly string[]; readonly strategy?: unknown; readonly chains?: readonly string[] } = {}) {
  const chain = `eip155:${chainId}`, profile = chainId === 1 ? ETHEREUM_MAINNET_SWAP : BASE_MAINNET_SWAP;
  const evm = createEvmDouble(chainId, () => Math.floor(NOW.getTime() / 1000), { profile }), circle = createCircleDouble(evm, { chainId });
  evm.control.upgrade(OWNER); evm.control.fundToken(OWNER, profile.usdc, 50_000_000n); evm.control.fundNative(OWNER, eth);
  const transport = guarded(chain, 'read', 'MOCKED', circle.rpc);
  const deps: UserFundedDeps = { chains: [chain], evm: c => c === chain ? transport : null, bundler: c => c === chain ? circle.bundler : null, solana: null, jupiter: null,
    now: () => NOW, circle: { chains: [chain], price: async () => ({ ethUsd: 3_000n * 10n ** 8n, usdcUsd: null, observedAt: NOW.toISOString() }) } };
  const canvas = canvasWorkflowOfStrategy(options.strategy ?? transfers(chainId === 1 ? 'ethereum' : 'base'));
  if (!canvas.ok) throw new Error(canvas.code);
  const chains = options.chains ?? [chain];
  const r = await reviewEditorExecution({ workflow: canvas.workflow, owner: OWNER, profile: { eip155: { wallet: 'INJECTED', atomic: Object.fromEntries(chains.map(c => [c, 'supported'])),
    typedData: true } }, facts: { enabled: true, code: null, chains, bundlerChains: chains, solanaNonceAccounts: false,
    ...options.tokenGasChains ? { tokenGasChains: options.tokenGasChains } : {} }, deps, now: NOW });
  if (!r.ok) throw new Error(r.code);
  return { review: r.value, circle };
}

describe('ADR-0010: the Editor\'s Review with a Circle-paid first group', () => {
  it('no ETH on Base: the fee is the USDC cap paid through Circle, two wallet prompts, the run\'s own plan for the Authorize binding', async () => {
    const { review, circle } = await reviewOn(8453, 0n);
    expect(review.refusal).toBeNull();
    const g = review.groups[0]!;
    // The plan the Authorize binding compares with the started run is the run's own (a wallet batch group); the fee mechanism is the Review's.
    expect(g).toMatchObject({ strategy: 'EVM_WALLET_BATCH', interactions: 2, fee: null, gasPayment: { mechanism: 'CIRCLE_USDC_PAYMASTER', signatures: 2,
      maxFee: { symbol: 'USDC', decimals: 6 } } });
    expect(review.counts).toMatchObject({ walletPrompts: 2, signatures: 2, transactions: 1, atLeast: false });
    expect(review.mode).toBe('GROUPED');
    // Read-only: nothing was relayed (the bundler was never asked to send).
    expect(circle.control.sends()).toBe(0);
  });
  it('ETH on Base: the native fee and one wallet confirmation, exactly as before', async () => {
    const { review } = await reviewOn(8453, 10n ** 17n);
    expect(review.groups[0]).toMatchObject({ interactions: 1, fee: { payer: OWNER } });
    expect(review.groups[0]).not.toHaveProperty('gasPayment');
    expect(review).toMatchObject({ mode: 'ONE_WALLET_CONFIRMATION', counts: { walletPrompts: 1, signatures: 1 } });
  });
  it('review C5: on a deployment where Circle may pay the fee, the prepared first group is counted as it will be asked; a later group is "at least"', async () => {
    const base = ['eip155:8453'], both = ['eip155:8453', 'eip155:1'];
    // The first group is prepared by the Review: ETH pays (one confirmation, exactly as before) or Circle does (two signatures).
    expect((await reviewOn(8453, 10n ** 17n, { tokenGasChains: base })).review).toMatchObject({ mode: 'ONE_WALLET_CONFIRMATION',
      counts: { walletPrompts: 1, signatures: 1, atLeast: false } });
    expect((await reviewOn(8453, 0n, { tokenGasChains: base })).review).toMatchObject({ mode: 'GROUPED', counts: { walletPrompts: 2, signatures: 2, atLeast: false } });
    // A later group on another Circle chain is quoted only when due: whether ETH or USDC pays it is not known yet, so the count is a minimum.
    const later = await reviewOn(8453, 10n ** 17n, { tokenGasChains: both, chains: both, strategy: { version: 2, steps: [
      { action: 'transfer', network: 'base', asset: 'USDC', amount: '1', recipient: '0x' + '2'.repeat(40) },
      { action: 'transfer', network: 'ethereum', asset: 'USDC', amount: '2', recipient: '0x' + '3'.repeat(40) }] } });
    expect(later.review).toMatchObject({ mode: 'GROUPED', counts: { walletPrompts: 2, atLeast: true } });
    expect(later.review.groups.map(g => g.chain)).toEqual(['eip155:8453', 'eip155:1']);
  });
  it('Ethereum with MetaMask\'s DeleGator: the native shortfall, with Circle\'s closed reason', async () => {
    const { review } = await reviewOn(1, 0n);
    expect(review.refusal).toMatchObject({ code: 'USER_FUNDED_INSUFFICIENT_NATIVE_BALANCE', evidence: { chainId: 'eip155:1',
      unavailable: [{ mechanism: 'CIRCLE_USDC_PAYMASTER', code: 'CIRCLE_ACCOUNT_ENTRYPOINT_UNSUPPORTED' }] } });
  });
});
