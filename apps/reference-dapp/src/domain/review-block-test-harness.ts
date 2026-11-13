// SPDX-License-Identifier: AGPL-3.0-only
/** Test fixture (not product code): the board 06 Review of Swap 2 USDC → WETH on Base, then Bridge to Arbitrum One. */
import type { EditorExecutionReview, ReviewAmount } from '../editor/workflow-execution';

export const BASE = 'eip155:8453', ARB = 'eip155:42161';
const weth = (chain: string, units: string): ReviewAmount => ({ asset: `${chain}/erc20:0x4200`, units, decimals: 18, symbol: 'WETH',
  text: `0.${units.padStart(18, '0').replace(/0+$/, '')} WETH` });
const usdc = (units: string, text: string): ReviewAmount => ({ asset: `${BASE}/erc20:0x8335`, units, decimals: 6, symbol: 'USDC', text });
/** The board 06 scenario: swap 2 USDC → WETH on Base, then bridge the swap's minimum to Arbitrum One, in ONE prepared batch on Base. */
export const swapBridgeReview = (patch: Partial<EditorExecutionReview> = {}): EditorExecutionReview => ({ workflowHash: '0x' + '1'.repeat(64), stepCount: 2,
  owner: '0x' + 'ab'.repeat(20), reviewedAt: '2020-01-01T00:00:00.000Z', validUntil: '2999-01-01T00:00:00.000Z', mode: 'ONE_WALLET_CONFIRMATION', reasons: [], refusal: null,
  groups: [{ index: 0, chain: BASE, network: 'Base', strategy: 'EVM_WALLET_BATCH', steps: [0, 1], signing: 'UPFRONT', interactions: 1, setup: [], downgrades: [],
    calls: [{ kind: 'ERC20_APPROVE', step: 0 }, { kind: 'UNISWAP_V3_EXACT_INPUT_SINGLE', step: 0 }, { kind: 'ERC20_APPROVE', step: 1 }, { kind: 'ACROSS_DEPOSIT', step: 1 }],
    approvals: 2, fee: { estimatedWei: '227000000000000', maxWei: '454000000000000', payer: '0x' + 'ab'.repeat(20) }, healthFactorAfter: null }],
  steps: [{ index: 0, action: 'swap', network: 'Base', chain: BASE, provider: 'Uniswap V3', spend: usdc('2000000', '2 USDC'), basis: 'EXACT', boundTo: null,
    expected: weth(BASE, '800123456789000'), minimum: weth(BASE, '796123456789123'), recipient: null },
  { index: 1, action: 'bridge', network: 'Base', chain: BASE, provider: null, spend: weth(BASE, '796123456789123'), basis: 'GUARANTEED_MINIMUM', boundTo: 0,
    expected: weth(ARB, '790555555555555'), minimum: weth(ARB, '790555555555555'), recipient: null, destination: 'Arbitrum One' }],
  counts: { walletPrompts: 1, atLeast: false, signatures: 1, transactions: 1, batchedCalls: 4, networkSwitches: 0, oneTimeSetup: [] }, ...patch });
