// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-SINGLE-AUTH-WORKFLOW-UX-001: the deployments delegated execution may address, from the existing verified registries only.
 *
 *   swap   Uniswap v3 SwapRouter02 `exactInputSingle` for USDC⇄WETH: the public testnet pair profiles (unchanged) and, on a public mainnet the
 *          deployment opted into (FLOFI_DELEGATION_MAINNET_CHAINS: Ethereum, Base, Arbitrum One), its catalog profile at the 0.05% tier
 *   aave   the registered Aave V3 market of the chain (Pool, provider, oracle, reserves with their aToken and variable debt token)
 *
 * Mainnet delegated execution is closed by default: a chain is delegable on a mainnet only when it is in MAINNET_DELEGATION_CHAINS AND the
 * deployment lists it. No address is typed here; every identity comes from the registries the owner-signed flows already verify.
 */
import { AAVE_V3_LENDING_PROFILES } from '@defi-workflow-engine/action-registry';
import { ARBITRUM_MAINNET_SWAP, BASE_MAINNET_SWAP, ETHEREUM_MAINNET_SWAP, publicSwapProfile } from '../domain/public-testnet-swap.ts';

/**
 * The public mainnets whose delegated templates and drivers are implemented (BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001: Ethereum, Base and
 * Arbitrum One — the chains with a verified MetaMask Delegation Framework v1.3.0 deployment, Uniswap v3 SwapRouter02 and an Aave V3 market in
 * FloFi's registries). Robinhood Chain (eip155:4663) is absent: the framework is not deployed there and it has no Aave market. Solana uses a
 * different authority model (see capabilities.ts).
 */
export const MAINNET_DELEGATION_CHAINS: readonly string[] = Object.freeze(['eip155:1', 'eip155:8453', 'eip155:42161']);
/** The registered catalog swap profile of each delegable mainnet (router, quoter, USDC and WETH from the verified Uniswap v3 registries). */
const MAINNET_SWAP_PROFILES = Object.freeze([ETHEREUM_MAINNET_SWAP, BASE_MAINNET_SWAP, ARBITRUM_MAINNET_SWAP]);
export type DelegationSwapProfile = { readonly chainId: number; readonly router: string; readonly quoter: string; readonly fee: number;
  readonly usdc: string; readonly weth: string; readonly environment: 'TESTNET' | 'MAINNET'; readonly l1DataFee: boolean };

/** The USDC⇄WETH swap profile a delegated swap on `chain` uses, or null. `mainnet` is the deployment's opted-in mainnet chains. */
export function delegationSwapProfile(chain: string, mainnet: readonly string[] = []): DelegationSwapProfile | null {
  const testnet = publicSwapProfile(chain);
  if (testnet) return { chainId: testnet.chainId, router: testnet.router, quoter: testnet.quoter, fee: testnet.fee, usdc: testnet.usdc, weth: testnet.weth, environment: 'TESTNET',
    l1DataFee: false };
  const profile = MAINNET_SWAP_PROFILES.find(p => p.chainRef === chain);
  // The deepest USDC/WETH tier on each delegable mainnet is 0.05%.
  if (profile && MAINNET_DELEGATION_CHAINS.includes(chain) && mainnet.includes(chain))
    return { chainId: profile.chainId, router: profile.router, quoter: profile.quoter, fee: 500, usdc: profile.usdc, weth: profile.weth, environment: 'MAINNET',
      l1DataFee: profile.l1DataFee };
  return null;
}
/** The registered Aave V3 Pool of `chain` when delegated Supply/Borrow may address it (only opted-in mainnets in this build). */
export function delegationAavePool(chain: string, mainnet: readonly string[] = []): string | null {
  if (!MAINNET_DELEGATION_CHAINS.includes(chain) || !mainnet.includes(chain)) return null;
  const pools = [...new Set(AAVE_V3_LENDING_PROFILES.filter(p => p.chain === chain).map(p => p.pool))];
  return pools.length === 1 ? pools[0]! : null;
}
/** The registered Aave V3 reserve of `asset` in the market of `pool` on `chain`, or null (never resolved by symbol). */
export function delegationAaveReserve(chain: string, pool: string, asset: string) {
  return AAVE_V3_LENDING_PROFILES.find(p => p.chain === chain && p.pool === pool && p.asset === asset.toLowerCase()) ?? null;
}
