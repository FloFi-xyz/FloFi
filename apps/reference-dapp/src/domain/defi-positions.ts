// SPDX-License-Identifier: AGPL-3.0-only
import type { LiquidityPositionView } from './liquidity-positions';

export type PositionWallet = { readonly namespace: 'eip155' | 'solana'; readonly address: string };
export type PositionProtocol = 'Aave V3' | 'Uniswap V3' | 'Orca Whirlpools';
export type PositionValuation = { readonly usd: string; readonly observedAt: string; readonly expiresAt: string };
export type PositionAsset = {
  readonly address: string;
  readonly symbol: string;
  readonly decimals: number;
  /** Null means the amount could not be read or derived for this position. */
  readonly units: string | null;
  /** Fees/owed tokens checkpointed on chain, distinct from principal and from newly accrued fees. */
  readonly recordedOwedUnits?: string;
  readonly valuation: PositionValuation | null;
};
export type DefiPosition = {
  readonly id: string;
  readonly type: 'SUPPLIED' | 'VARIABLE_DEBT' | 'LIQUIDITY';
  readonly assets: readonly PositionAsset[];
  readonly collateralEnabled?: boolean | null;
  /** BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: a concentrated-liquidity position's verified identity, range, owed and collectable amounts and the operations FloFi can prepare. */
  readonly liquidity?: LiquidityPositionView;
};

export type PositionScan = {
  readonly protocol: PositionProtocol;
  readonly network: string;
  readonly chain: string;
  readonly status: 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE' | 'UNSUPPORTED' | 'NETWORK_UNAVAILABLE';
  readonly observedAt: string | null;
  readonly provenance: 'PUBLIC_MAINNET' | 'MOCKED' | null;
  readonly positions: readonly DefiPosition[];
  readonly risk?: { readonly healthFactor: string; readonly liquidationThresholdBps: string };
};
export const positionsWalletKey = (wallet: PositionWallet) => `${wallet.namespace}:${wallet.address}`;
