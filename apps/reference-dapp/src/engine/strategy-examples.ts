// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-MCP-001: one canonical, composable example strategy per supported action and network. They document the contract
 * and are what `capability-catalog.ts` composes to derive each row's capabilities from the real IR and registry. The
 * placeholder account is a valid non-zero address used only to compose; it is never simulated or shown as a recipient.
 */
import type { StrategySpec } from './strategy-spec';

const EXAMPLE_ACCOUNT = '0x0000000000000000000000000000000000000001';
/** BUILD-SOLANA-TRANSFER-UX-001: a valid Ed25519 wallet key (sha256("flofi-example-recipient") seed) used only to compose; never simulated. */
const EXAMPLE_SOLANA_RECIPIENT = 'CtV2foUoy5uJaK5Wybz8Nf1xmC6TgDv93itdja7n9yvH';
export const STRATEGY_EXAMPLES: readonly { readonly id: string; readonly strategy: StrategySpec }[] = Object.freeze([
  { id: 'bridge-base-sepolia-arbitrum-sepolia', strategy: { action: 'bridge', sourceNetwork: 'base-sepolia', destinationNetwork: 'arbitrum-sepolia', asset: 'USDC', amount: '5', routing: 'auto' } },
  { id: 'bridge-base-arbitrum-one', strategy: { action: 'bridge', sourceNetwork: 'base', destinationNetwork: 'arbitrum-one', asset: 'USDC', amount: '5', routing: 'auto' } },
  { id: 'swap-base', strategy: { action: 'swap', network: 'base', inputAsset: 'USDC', outputAsset: 'WETH', amount: '2', slippageBps: 50 } },
  { id: 'swap-base-sepolia', strategy: { action: 'swap', network: 'base-sepolia', inputAsset: 'USDC', outputAsset: 'WETH', amount: '1', slippageBps: 50 } },
  { id: 'swap-ethereum-sepolia', strategy: { action: 'swap', network: 'ethereum-sepolia', inputAsset: 'USDC', outputAsset: 'WETH', amount: '1', slippageBps: 50 } },
  { id: 'swap-solana', strategy: { action: 'swap', network: 'solana', inputAsset: 'USDC', outputAsset: 'SOL', amount: '1', slippageBps: 50 } },
  { id: 'swap-solana-devnet', strategy: { action: 'swap', network: 'solana-devnet', inputAsset: 'devUSDC', outputAsset: 'SOL', amount: '1', slippageBps: 50 } },
  { id: 'transfer-solana', strategy: { action: 'transfer', network: 'solana', asset: 'USDC', amount: '1', recipient: EXAMPLE_SOLANA_RECIPIENT } },
  { id: 'transfer-solana-devnet', strategy: { action: 'transfer', network: 'solana-devnet', asset: 'SOL', amount: '0.01', recipient: EXAMPLE_SOLANA_RECIPIENT } },
  { id: 'transfer-ethereum-sepolia', strategy: { action: 'transfer', network: 'ethereum-sepolia', asset: 'ETH', amount: '0.000001' } },
  { id: 'transfer-robinhood-testnet', strategy: { action: 'transfer', network: 'robinhood-testnet', asset: 'ETH', amount: '0.000001' } },
  ...(['supply', 'borrow', 'repay'] as const).flatMap(action => [
    { id: `${action}-base-sepolia`, strategy: { action, network: 'base-sepolia', asset: 'USDC', amount: '1', beneficiary: EXAMPLE_ACCOUNT } as StrategySpec },
    { id: `${action}-ethereum-sepolia`, strategy: { action, network: 'ethereum-sepolia', asset: 'WBTC', amount: '0.001', beneficiary: EXAMPLE_ACCOUNT } as StrategySpec }]),
  { id: 'withdraw-base-sepolia', strategy: { action: 'withdraw', network: 'base-sepolia', asset: 'USDC', amount: '1' } },
  { id: 'withdraw-ethereum-sepolia', strategy: { action: 'withdraw', network: 'ethereum-sepolia', asset: 'WBTC', amount: '0.001' } },
  { id: 'add-liquidity-base-sepolia', strategy: { action: 'add_liquidity', network: 'base-sepolia', maxAmounts: { USDC: '10', WETH: '0.005' },
    range: { unit: 'tick', lower: '189960', upper: '200040' } } },
  { id: 'add-liquidity-ethereum-sepolia', strategy: { action: 'add_liquidity', network: 'ethereum-sepolia', maxAmounts: { USDC: '10', WETH: '0.005' },
    range: { unit: 'tick', lower: '189960', upper: '200040' } } },
  { id: 'add-liquidity-solana-devnet', strategy: { action: 'add_liquidity', network: 'solana-devnet', maxAmounts: { SOL: '0.01', devUSDC: '0.3' },
    range: { unit: 'tick', lower: '-29952', upper: '-25600' } } },
  { id: 'add-liquidity-solana', strategy: { action: 'add_liquidity', network: 'solana', maxAmounts: { SOL: '0.01', USDC: '0.3' },
    range: { unit: 'tick', lower: '-29952', upper: '-25600' } } },
  { id: 'lending-composition-base-sepolia', strategy: { action: 'lending_composition', network: 'base-sepolia', asset: 'USDC', supplyAmount: '10', borrowAmount: '2',
    outputAsset: 'WETH', owner: EXAMPLE_ACCOUNT } },
  // BUILD-RH-002: Robinhood Chain (real funds). Examples use the code-pinned USDG and WETH so they compose without the registry; a Stock Token
  // (e.g. `outputAsset: 'TSLA'`) is named the same way once the official registry is loaded.
  { id: 'bridge-base-robinhood', strategy: { action: 'bridge', sourceNetwork: 'base', destinationNetwork: 'robinhood', asset: 'USDC', amount: '5', routing: 'auto' } },
  { id: 'bridge-robinhood-base', strategy: { action: 'bridge', sourceNetwork: 'robinhood', destinationNetwork: 'base', asset: 'USDG', amount: '5', routing: 'auto' } },
  { id: 'bridge-arbitrum-robinhood', strategy: { action: 'bridge', sourceNetwork: 'arbitrum-one', destinationNetwork: 'robinhood', asset: 'USDC', amount: '5', routing: 'auto' } },
  { id: 'bridge-robinhood-arbitrum', strategy: { action: 'bridge', sourceNetwork: 'robinhood', destinationNetwork: 'arbitrum-one', asset: 'USDG', amount: '5', routing: 'auto' } },
  { id: 'swap-robinhood', strategy: { action: 'swap', network: 'robinhood', inputAsset: 'USDG', outputAsset: 'WETH', amount: '10', slippageBps: 50 } },
  { id: 'add-liquidity-robinhood', strategy: { action: 'add_liquidity', network: 'robinhood', maxAmounts: { USDG: '10', WETH: '0.003' }, range: { unit: 'full' }, feeTier: 100 } },
  { id: 'transfer-robinhood', strategy: { action: 'transfer', network: 'robinhood', asset: 'USDG', amount: '1' } },
  // BUILD-BASE-001: Base mainnet (real funds) as a catalog network. Examples use the code-pinned ETH/USDC/WETH so they compose without the token
  // list; any token-list symbol (e.g. `outputAsset: 'cbBTC'`) is named the same way once the validated list is loaded. `swap-base` above is
  // the USDC ⇄ WETH reference swap (BUILD-002 declaration).
  { id: 'bridge-arbitrum-base', strategy: { action: 'bridge', sourceNetwork: 'arbitrum-one', destinationNetwork: 'base', asset: 'USDC', amount: '5', routing: 'auto' } },
  { id: 'add-liquidity-base', strategy: { action: 'add_liquidity', network: 'base', maxAmounts: { USDC: '10', WETH: '0.003' }, range: { unit: 'full' }, feeTier: 500 } },
  { id: 'transfer-base', strategy: { action: 'transfer', network: 'base', asset: 'USDC', amount: '1' } },
  ...(['supply', 'borrow', 'repay'] as const).map(action =>
    ({ id: `${action}-base`, strategy: { action, network: 'base', asset: 'USDC', amount: '1', beneficiary: EXAMPLE_ACCOUNT } as StrategySpec })),
  { id: 'withdraw-base', strategy: { action: 'withdraw', network: 'base', asset: 'USDC', amount: '1' } },
  ...(['supply', 'borrow', 'repay'] as const).map(action =>
    ({ id: `${action}-arbitrum`, strategy: { action, network: 'arbitrum-one', asset: 'USDC', amount: '1', beneficiary: EXAMPLE_ACCOUNT } as StrategySpec })),
  { id: 'withdraw-arbitrum', strategy: { action: 'withdraw', network: 'arbitrum-one', asset: 'USDC', amount: '1' } },
  { id: 'swap-arbitrum', strategy: { action: 'swap', network: 'arbitrum-one', inputAsset: 'USDC', outputAsset: 'WETH', amount: '10', slippageBps: 50 } },
  { id: 'transfer-arbitrum', strategy: { action: 'transfer', network: 'arbitrum-one', asset: 'USDC', amount: '5' } },
  { id: 'add-liquidity-arbitrum', strategy: { action: 'add_liquidity', network: 'arbitrum-one', maxAmounts: { USDC: '10', WETH: '0.003' }, range: { unit: 'full' }, feeTier: 500 } },
  ...(['supply', 'borrow', 'repay'] as const).map(action =>
    ({ id: `${action}-ethereum`, strategy: { action, network: 'ethereum', asset: 'USDC', amount: '1', beneficiary: EXAMPLE_ACCOUNT } as StrategySpec })),
  { id: 'withdraw-ethereum', strategy: { action: 'withdraw', network: 'ethereum', asset: 'USDC', amount: '1' } },
  { id: 'swap-ethereum', strategy: { action: 'swap', network: 'ethereum', inputAsset: 'USDC', outputAsset: 'WETH', amount: '10', slippageBps: 50 } },
  { id: 'transfer-ethereum', strategy: { action: 'transfer', network: 'ethereum', asset: 'USDC', amount: '5' } },
  { id: 'add-liquidity-ethereum', strategy: { action: 'add_liquidity', network: 'ethereum', maxAmounts: { USDC: '10', WETH: '0.003' }, range: { unit: 'full' }, feeTier: 500 } },
  { id: 'bridge-ethereum-base', strategy: { action: 'bridge', sourceNetwork: 'ethereum', destinationNetwork: 'base', asset: 'USDC', amount: '5', routing: 'auto' } },
  { id: 'bridge-base-ethereum', strategy: { action: 'bridge', sourceNetwork: 'base', destinationNetwork: 'ethereum', asset: 'USDC', amount: '5', routing: 'auto' } },
  { id: 'bridge-ethereum-arbitrum', strategy: { action: 'bridge', sourceNetwork: 'ethereum', destinationNetwork: 'arbitrum-one', asset: 'USDC', amount: '5', routing: 'auto' } },
  { id: 'bridge-arbitrum-ethereum', strategy: { action: 'bridge', sourceNetwork: 'arbitrum-one', destinationNetwork: 'ethereum', asset: 'USDC', amount: '5', routing: 'auto' } },
  { id: 'bridge-ethereum-robinhood', strategy: { action: 'bridge', sourceNetwork: 'ethereum', destinationNetwork: 'robinhood', asset: 'USDC', amount: '5', routing: 'auto' } },
  { id: 'bridge-robinhood-ethereum', strategy: { action: 'bridge', sourceNetwork: 'robinhood', destinationNetwork: 'ethereum', asset: 'USDG', amount: '5', routing: 'auto' } },
]);
