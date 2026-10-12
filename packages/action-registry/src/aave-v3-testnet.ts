// SPDX-License-Identifier: Apache-2.0
/** Existing engine scope, shared by capability wording and deterministic authoring. Amounts still require live debt/balance preflight. */
export const AAVE_V3_AMOUNT_POLICY = Object.freeze({ repay: 'PARTIAL_ONLY', withdraw: 'PARTIAL_ONLY' } as const);
/** Verified from Aave's current DAO address book and interface; only this runtime profile. */
export const AAVE_V3_BASE_SEPOLIA = Object.freeze({
  network: 'Base Sepolia', chainId: 84532, chain: 'eip155:84532', chainHex: '0x14a34', protocol: 'aave-v3',
  pool: '0x8bab6d1b75f19e9ed9fce8b9bd338844ff79ae27',
  provider: '0xe4c23309117aa30342bfaae6c95c6478e0a4ad00',
  asset: '0xba50cd2a20f6da35d788639e581bca8d0b5d4d5f', decimals: 6, symbol: 'USDC',
  /** Pool reserve id: user-configuration bits 2·id (borrowing) and 2·id+1 (collateral). Read on chain 2026-10-05. */
  reserveId: 0,
  aToken: '0x10f1a9d11cdf50041f3f8cb7191cbe2f31750acc',
  variableDebtToken: '0xfb3e85601b7feb3691bbb8779ef0e1069e347204',
  oracle: '0x943b0de18d4abf4ef02a85912f8fc07684c141df',
  faucet: '0xd9145b5f45ad4519c7accd6e0a4a82e83bb8a6dc',
  explorer: 'https://sepolia.basescan.org', rpc: 'https://base-sepolia.gateway.tenderly.co',
  officialSource: 'https://github.com/aave-dao/aave-address-book/blob/main/src/AaveV3BaseSepolia.sol',
  /** OP Stack: receipts carry a separate L1 data fee (`l1Fee`) that is part of the owner's network cost. */
  l1DataFee: true,
});
/**
 * BUILD-ETHEREUM-001: Aave V3 on Ethereum Sepolia, WBTC reserve only. From the Aave DAO address book (`AaveV3Sepolia`,
 * `AaveV3SepoliaAssets`) and verified read-only on 2026-10-05 (head ≈ 11,846,500): Provider `getPool()` and
 * `getPriceOracle()` equal the Pool and Oracle below; Pool `ADDRESSES_PROVIDER()` equals the Provider; reserve id 3,
 * 8 decimals, active, not frozen or paused, borrowing enabled, no caps; the aToken and variable-debt token report this
 * underlying and Pool. USDC is not used here: its Sepolia supply cap is exceeded (Supply reverts with Aave error 51).
 * This deployment is Aave v3.0 (Pool revision 1), older than Base Sepolia's v3.4.
 */
export const AAVE_V3_ETHEREUM_SEPOLIA = Object.freeze({
  network: 'Ethereum Sepolia', chainId: 11155111, chain: 'eip155:11155111', chainHex: '0xaa36a7', protocol: 'aave-v3',
  pool: '0x6ae43d3271ff6888e7fc43fd7321a503ff738951',
  provider: '0x012bac54348c0e635dcac9d5fb99f06f24136c9a',
  asset: '0x29f2d40b0605204364af54ec677bd022da425d03', decimals: 8, symbol: 'WBTC',
  reserveId: 3,
  aToken: '0x1804bf30507dc2eb3bdebbbdd859991eaef6eeff',
  variableDebtToken: '0xeb016dfd303f19fbddfb6300eb4aeb2da7ceac37',
  oracle: '0x2da88497588bf89281816106c7259e31af45a663',
  faucet: '0xc959483dba39aa9e78757139af0e9a2edeb3f42d',
  explorer: 'https://sepolia.etherscan.io', rpc: 'https://ethereum-sepolia-rpc.publicnode.com',
  officialSource: 'https://github.com/aave-dao/aave-address-book/blob/main/src/AaveV3Sepolia.sol',
  /** Ethereum L1: the network cost is gasUsed × effectiveGasPrice; a receipt `l1Fee` would be unexplained. */
  l1DataFee: false,
});
/**
 * BUILD-BASE-001: Aave V3 on Base mainnet (real funds), USDC reserve only — the same one-asset-per-network semantics as Base Sepolia.
 * From the Aave DAO address book (`AaveV3Base.sol`, aave-dao/aave-address-book main b5da40f, 2026-10-11) and verified read-only on
 * 2026-10-11 (block 52,469,150): Provider `getPool()` and `getPriceOracle()` equal the Pool and Oracle below; Pool
 * `ADDRESSES_PROVIDER()` equals the Provider; `POOL_REVISION` 11 (Aave v3.7; supply/borrow/repay/withdraw accounting as v3.6);
 * reserve id 4, 6 decimals, active, not frozen or paused, borrowing enabled, no debt ceiling, LTV 75%, liquidation threshold 78%,
 * supply cap 230M and borrow cap 207M; the aToken and variable-debt token report this underlying and Pool; oracle base unit 1e8.
 * Real-funds owner execution needs the deployment's explicit opt-in; there is no faucet.
 */
export const AAVE_V3_BASE = Object.freeze({
  network: 'Base', chainId: 8453, chain: 'eip155:8453', chainHex: '0x2105', protocol: 'aave-v3',
  pool: '0xa238dd80c259a72e81d7e4664a9801593f98d1c5',
  provider: '0xe20fcbdbffc4dd138ce8b2e6fbb6cb49777ad64d',
  asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6, symbol: 'USDC',
  reserveId: 4,
  aToken: '0x4e65fe4dba92790696d040ac24aa414708f5c0ab',
  variableDebtToken: '0x59dca05b6c26dbd64b5381374aaac5cd05644c28',
  oracle: '0x2cc0fc26ed4563a5ce5e8bdcfe1a2878676ae156',
  faucet: null,
  explorer: 'https://basescan.org', rpc: 'https://mainnet.base.org',
  officialSource: 'https://github.com/aave-dao/aave-address-book/blob/main/src/AaveV3Base.sol',
  /** OP Stack: receipts carry a separate L1 data fee (`l1Fee`) that is part of the owner's network cost. */
  l1DataFee: true,
  environment: 'MAINNET',
} as const);
/** BUILD-ARB-001 Phase 5: freshly verified native USDC reserve id 12 at Arbitrum block 513958416.
 * Pool revision 11, provider/Pool/oracle and reserve token relationships verified against the Aave DAO address book.
 * One owner reserve, variable debt and ordinary collateral only. Nitro posting cost is included in total gas.
 */
export const AAVE_V3_ARBITRUM = Object.freeze({
  network: 'Arbitrum One', chainId: 42161, chain: 'eip155:42161', chainHex: '0xa4b1', protocol: 'aave-v3',
  pool: '0x794a61358d6845594f94dc1db02a252b5b4814ad',
  poolImplementation: '0xf05fd3cc911b4c5e36e53c00354f645e22922c9a',
  provider: '0xa97684ead0e402dc232d5a977953df7ecbab3cdb',
  asset: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', decimals: 6, symbol: 'USDC', reserveId: 12,
  aToken: '0x724dc807b04555b71ed48a6896b6f41593b8c637',
  variableDebtToken: '0xf611aeb5013fd2c0511c9cd55c7dc5c1140741a6',
  oracle: '0xb56c2f0b653b2e0b10c9b928c8580ac5df02c7c7',
  faucet: null, explorer: 'https://arbiscan.io', rpc: 'https://arb1.arbitrum.io/rpc',
  officialSource: 'https://github.com/aave-dao/aave-address-book/blob/main/src/AaveV3Arbitrum.sol',
  l1DataFee: false, environment: 'MAINNET', poolRevision: 11, ownerBeneficiary: true,
} as const);
export type AaveLendingProfile = typeof AAVE_V3_BASE_SEPOLIA | typeof AAVE_V3_ETHEREUM_SEPOLIA | typeof AAVE_V3_BASE | typeof AAVE_V3_ARBITRUM;
/** One verified asset per network. Profiles are chosen by the authored or reviewed chain, never by symbol. */
export const AAVE_V3_LENDING_PROFILES: readonly AaveLendingProfile[] = Object.freeze([AAVE_V3_BASE_SEPOLIA, AAVE_V3_ETHEREUM_SEPOLIA, AAVE_V3_BASE, AAVE_V3_ARBITRUM]);
/** The deployment environment of a lending profile (the testnet profiles predate the field). */
export const aaveEnvironment = (profile: AaveLendingProfile): 'PUBLIC_TESTNET' | 'MAINNET' => 'environment' in profile ? profile.environment : 'PUBLIC_TESTNET';
export function aaveLendingProfile(chain: string): AaveLendingProfile {
  const profile = AAVE_V3_LENDING_PROFILES.find(item => item.chain === chain);
  if (!profile) throw new Error('AAVE_PROFILE_UNSUPPORTED');
  return profile;
}
/** Rejects anything other than one of the frozen registered profiles (for example an object built by a caller). */
export function assertAaveLendingProfile(value: unknown): AaveLendingProfile {
  if (!AAVE_V3_LENDING_PROFILES.some(profile => profile === value)) throw new Error('AAVE_PROFILE_UNSUPPORTED');
  return value as AaveLendingProfile;
}
