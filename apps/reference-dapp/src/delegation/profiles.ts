// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-SINGLE-AUTH-WORKFLOW-UX-001: the deployments delegated execution may address, from the existing verified registries only.
 *
 *   swap   Uniswap v3 SwapRouter02 `exactInputSingle` for USDC⇄WETH: the public testnet pair profiles (unchanged) and, on a public mainnet the
 *          deployment opted into (FLOFI_DELEGATION_MAINNET_CHAINS), its catalog profile at the deepest USDC/WETH tier (0.05%)
 *   aave   the registered Aave V3 market of the chain (Pool, provider, oracle, reserves with their aToken and variable debt token)
 *
 * Mainnet delegated execution is closed by default: a chain is delegable on a mainnet only when it is in MAINNET_DELEGATION_CHAINS AND the
 * deployment lists it. No address is typed here; every identity comes from the registries the owner-signed flows already verify.
 */
import { AAVE_V3_LENDING_PROFILES } from '@defi-workflow-engine/action-registry';
import { ARBITRUM_MAINNET_SWAP, publicSwapProfile } from '../domain/public-testnet-swap.ts';

/** The only public mainnets whose delegated templates, drivers and evidence this build implements (Arbitrum One). */
export const MAINNET_DELEGATION_CHAINS: readonly string[] = Object.freeze(['eip155:42161']);
export type DelegationSwapProfile = { readonly chainId: number; readonly router: string; readonly quoter: string; readonly fee: number;
  readonly usdc: string; readonly weth: string; readonly environment: 'TESTNET' | 'MAINNET' };

/** The USDC⇄WETH swap profile a delegated swap on `chain` uses, or null. `mainnet` is the deployment's opted-in mainnet chains. */
export function delegationSwapProfile(chain: string, mainnet: readonly string[] = []): DelegationSwapProfile | null {
  const testnet = publicSwapProfile(chain);
  if (testnet) return { chainId: testnet.chainId, router: testnet.router, quoter: testnet.quoter, fee: testnet.fee, usdc: testnet.usdc, weth: testnet.weth, environment: 'TESTNET' };
  if (chain === ARBITRUM_MAINNET_SWAP.chainRef && MAINNET_DELEGATION_CHAINS.includes(chain) && mainnet.includes(chain))
    return { chainId: ARBITRUM_MAINNET_SWAP.chainId, router: ARBITRUM_MAINNET_SWAP.router, quoter: ARBITRUM_MAINNET_SWAP.quoter, fee: 500,
      usdc: ARBITRUM_MAINNET_SWAP.usdc, weth: ARBITRUM_MAINNET_SWAP.weth, environment: 'MAINNET' };
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
