// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 review LQ1/B1 (ADR-0010 §2): the Editor's whole-workflow Review names, before anything is signed, a later
 * step that needs the native coin for its fee after an earlier step on the same chain whose fee may be paid in a token (Kora on Solana); a
 * workflow the Editor runs step by step on a Circle chain pays every EVM fee natively, so nothing is token-paid first and nothing is warned about.
 * The design and its groups are unchanged. Read-only; MOCKED loopback doubles only.
 */
import { describe, expect, it } from 'vitest';
import { BASE_MAINNET_SWAP } from '../domain/public-testnet-swap.ts';
import { guarded } from '../delegation/chains.ts';
import { createEvmDouble } from '../delegation/harness/evm-double.ts';
import { createCircleDouble } from '../delegation/harness/circle-double.ts';
import type { UserFundedDeps } from '../user-funded/groups.ts';
import { reviewEditorExecution } from './workflow-execution.ts';
import { canvasWorkflowOfStrategy } from './workflow-strategy.ts';

const NOW = new Date('2026-11-13T12:00:00Z'), OWNER = '0x' + '1a'.repeat(20), BASE = 'eip155:8453', SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const CIRCLE_THEN_LIQUIDITY = { version: 2, steps: [
  { action: 'transfer', network: 'base', asset: 'USDC', amount: '1', recipient: '0x' + '2'.repeat(40) },
  { action: 'add_liquidity', network: 'base', maxAmounts: { USDC: '10', WETH: '0.004' }, range: { unit: 'full' } }] };
// The Canvas holds a Solana transfer before an Orca position (a Solana swap → Orca pair is the Swap → liquidity composition, not a Canvas sequence).
const SOLANA_SEND = { action: 'transfer', network: 'solana', asset: 'USDC', amount: '1', recipient: '7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2' };
const KORA_THEN_ORCA = { version: 2, steps: [
  { action: 'transfer', network: 'base', asset: 'USDC', amount: '1', recipient: '0x' + '2'.repeat(40) }, SOLANA_SEND,
  { action: 'add_liquidity', network: 'solana', maxAmounts: { SOL: '0.01', USDC: '1' }, range: { unit: 'tick', lower: '-64', upper: '64' } }] };
const KORA_THEN_RELAY = { version: 2, steps: [
  { action: 'transfer', network: 'base', asset: 'USDC', amount: '1', recipient: '0x' + '2'.repeat(40) },
  { action: 'swap', network: 'solana', inputAsset: 'USDC', outputAsset: 'SOL', amount: '2' },
  { action: 'bridge', sourceNetwork: 'solana', destinationNetwork: 'base', asset: 'USDC', amount: '5' }] };

async function reviewWith(eth: bigint, tokenGasChains: readonly string[], strategy: unknown = CIRCLE_THEN_LIQUIDITY, koraTokenGas = false) {
  const evm = createEvmDouble(8453, () => Math.floor(NOW.getTime() / 1000), { profile: BASE_MAINNET_SWAP }), circle = createCircleDouble(evm, { chainId: 8453 });
  evm.control.upgrade(OWNER); evm.control.fundToken(OWNER, BASE_MAINNET_SWAP.usdc, 50_000_000n); evm.control.fundNative(OWNER, eth);
  const transport = guarded(BASE, 'read', 'MOCKED', circle.rpc);
  const deps: UserFundedDeps = { chains: [BASE], evm: c => c === BASE ? transport : null, bundler: c => c === BASE ? circle.bundler : null, solana: null, jupiter: null,
    now: () => NOW, circle: { chains: [BASE], price: async () => ({ ethUsd: 3_000n * 10n ** 8n, usdcUsd: null, observedAt: NOW.toISOString() }) } };
  const canvas = canvasWorkflowOfStrategy(strategy);
  if (!canvas.ok) throw new Error(canvas.code);
  const r = await reviewEditorExecution({ workflow: canvas.workflow, owner: OWNER, profile: { eip155: { wallet: 'INJECTED', atomic: { [BASE]: 'supported' }, typedData: true } },
    facts: { enabled: true, code: null, chains: [BASE], bundlerChains: [BASE], solanaNonceAccounts: false, tokenGasChains, ...koraTokenGas ? { koraTokenGas } : {} }, deps, now: NOW });
  if (!r.ok) throw new Error(r.code);
  return r.value;
}

describe('review LQ1/B1 in the Editor: only a step that can really pay in a token before a native-only one is warned about', () => {
  it('LQ1: a Kora-paid Solana transfer, then Orca liquidity: the Review names the liquidity step and SOL before anything is signed', async () => {
    const review = await reviewWith(10n ** 17n, [], KORA_THEN_ORCA, true);
    expect(review.mode).toBe('STEP_BY_STEP');
    expect(review.nativeLater).toEqual([{ chain: SOLANA, network: 'Solana', symbol: 'SOL', after: 1, steps: [{ index: 2, action: 'add_liquidity' }] }]);
    expect((await reviewWith(10n ** 17n, [], KORA_THEN_ORCA, false)).nativeLater).toEqual([]);
  });
  it('B1: a Kora-paid Jupiter swap, then a Relay deposit from Solana: the Review names the bridge and SOL', async () => {
    expect((await reviewWith(10n ** 17n, [], KORA_THEN_RELAY, true)).nativeLater).toEqual([{ chain: SOLANA, network: 'Solana', symbol: 'SOL', after: 1,
      steps: [{ index: 2, action: 'bridge' }] }]);
  });
  it('a Circle-chain transfer, then Uniswap liquidity: the Editor runs it step by step, where every EVM fee is native, so nothing is token-paid first', async () => {
    // The liquidity step runs through its own flow, so the Review is step by step; single-step pages keep native gas (ADR-0010 §3), so no step of
    // this run is paid through Circle — and the Review never shows the first group's fee in USDC (with no ETH it is the native shortfall): the
    // first step stops for lack of ETH, not midway.
    for (const eth of [0n, 10n ** 17n]) {
      const review = await reviewWith(eth, [BASE]);
      expect(review.mode, String(eth)).toBe('STEP_BY_STEP');
      expect(review.nativeLater, String(eth)).toEqual([]);
      expect(review.groups.some(g => g.gasPayment), String(eth)).toBe(false);
    }
  });
});
