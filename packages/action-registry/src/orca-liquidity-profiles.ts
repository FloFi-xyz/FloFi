// SPDX-License-Identifier: Apache-2.0
import { ORCA_WHIRLPOOLS_DEVNET_LIQUIDITY } from './orca-liquidity-devnet.js';
import { ORCA_WHIRLPOOLS_MAINNET_LIQUIDITY } from './orca-liquidity-mainnet.js';

/**
 * BUILD-SOLANA-MAINNET-001: the Orca Whirlpools liquidity runtimes of the canonical `asset.liquidity.concentrated` action, keyed by
 * cluster. The action and the engine are shared; the cluster selects the pool, mints, evidence class and wallet chain. A workflow
 * on any other chain has no profile, and every engine entry point fails closed on it.
 */
export type OrcaLiquidityToken = { readonly symbol: string; readonly label?: string; readonly mint: string; readonly decimals: number;
  readonly native: boolean; readonly maximumAmount: string };
export type OrcaLiquidityProfile = {
  readonly chain: string; readonly network: 'Solana' | 'Solana Devnet'; readonly cluster: 'mainnet-beta' | 'devnet'; readonly walletChain: 'solana:mainnet' | 'solana:devnet';
  readonly genesisHash: string; readonly protocol: 'orca-whirlpools'; readonly adapterId: string; readonly providerLabel: string; readonly rpc: string;
  readonly explorer: string; readonly officialSource: string; readonly docsSource: string;
  readonly programs: typeof ORCA_WHIRLPOOLS_DEVNET_LIQUIDITY.programs; readonly whirlpoolsConfig: string;
  readonly pool: { readonly address: string; readonly tokenMintA: string; readonly tokenMintB: string; readonly tokenVaultA: string; readonly tokenVaultB: string;
    readonly tickSpacing: number };
  readonly token0: OrcaLiquidityToken; readonly token1: OrcaLiquidityToken; readonly feeTier: number; readonly metadataUpdateAuth: string;
  readonly instructions: typeof ORCA_WHIRLPOOLS_DEVNET_LIQUIDITY.instructions; readonly events: typeof ORCA_WHIRLPOOLS_DEVNET_LIQUIDITY.events;
  readonly positionDiscriminator: string; readonly tickArrayDiscriminator: string; readonly tickArraySize: number; readonly minTick: number; readonly maxTick: number;
  readonly maximumSlippageBps: number; readonly reviewTtlSeconds: number; readonly baseFeeLamports: string; readonly maximumComputeUnits: number;
  /** Reviewed compute-unit price (micro-lamports per CU) set in the transaction; '0' sets none. */ readonly computeUnitPriceMicroLamports: string;
  readonly environment: 'MAINNET' | 'PUBLIC_TESTNET'; readonly provenance: 'PUBLIC_MAINNET' | 'PUBLIC_DEVNET';
  readonly executedEvidence: 'PUBLIC_EXECUTED' | 'DEVNET_EXECUTED'; readonly bundleEnvironment: 'MAINNET_EXECUTED' | 'TESTNET_EXECUTED';
  readonly realFunds: boolean; readonly contractVersion: string; explorerTx(signature: string): string };
export const ORCA_LIQUIDITY_PROFILES: readonly OrcaLiquidityProfile[] = Object.freeze([ORCA_WHIRLPOOLS_DEVNET_LIQUIDITY, ORCA_WHIRLPOOLS_MAINNET_LIQUIDITY]);
/** The Orca liquidity runtime of a CAIP-2 Solana chain, or null. */
export function orcaLiquidityProfile(chain: string | null | undefined): OrcaLiquidityProfile | null {
  return ORCA_LIQUIDITY_PROFILES.find(profile => profile.chain === chain) ?? null;
}
