// SPDX-License-Identifier: Apache-2.0
import { AAVE_V3_ADDRESS_BOOK, AAVE_V3_ADDRESS_BOOK_COMMIT, type AaveAddressBookReserve } from './aave-v3-reserves.generated.js';
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
/** BUILD-ARB-001 Phase 5: freshly verified native USDC reserve id 12 at Arbitrum block 513958416 (then Pool revision 11; revision 12 and its
 * implementation since Aave governance's 2026-11-11 upgrade, HOTFIX-FLOFI-PRODUCTION-RECOVERY-001, see AAVE_V3_POOL_UPGRADES). provider/Pool/oracle and reserve token relationships verified against the Aave DAO address book.
 * One owner reserve, variable debt and ordinary collateral only. Nitro posting cost is included in total gas.
 */
export const AAVE_V3_ARBITRUM = Object.freeze({
  network: 'Arbitrum One', chainId: 42161, chain: 'eip155:42161', chainHex: '0xa4b1', protocol: 'aave-v3',
  pool: '0x794a61358d6845594f94dc1db02a252b5b4814ad',
  // HOTFIX-FLOFI-PRODUCTION-RECOVERY-001: Aave governance upgraded this Pool to revision 12 (see AAVE_V3_POOL_UPGRADES).
  poolImplementation: '0xa6e7d235a5b2fc7811d10669bbe20fa14b658a1e',
  provider: '0xa97684ead0e402dc232d5a977953df7ecbab3cdb',
  asset: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', decimals: 6, symbol: 'USDC', reserveId: 12,
  aToken: '0x724dc807b04555b71ed48a6896b6f41593b8c637',
  variableDebtToken: '0xf611aeb5013fd2c0511c9cd55c7dc5c1140741a6',
  oracle: '0xb56c2f0b653b2e0b10c9b928c8580ac5df02c7c7',
  faucet: null, explorer: 'https://arbiscan.io', rpc: 'https://arb1.arbitrum.io/rpc',
  officialSource: 'https://github.com/aave-dao/aave-address-book/blob/main/src/AaveV3Arbitrum.sol',
  l1DataFee: false, environment: 'MAINNET', poolRevision: 12, ownerBeneficiary: true,
} as const);
/** Ethereum Aave V3 USDC reserve, verified PUBLIC_READ_ONLY against the DAO address book and block 26208660.
 * Current one-reserve engine: ordinary owner collateral, variable-rate debt, partial Repay/Withdraw. No native gateway.
 */
export const AAVE_V3_ETHEREUM = Object.freeze({
  network: 'Ethereum', chainId: 1, chain: 'eip155:1', chainHex: '0x1', protocol: 'aave-v3',
  pool: '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2', poolImplementation: '0x4295fe69b3e978eb511e4558b4407ad871612fcb', provider: '0x2f39d218133afab8f2b819b1066c7e434ad94e9e',
  asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6, symbol: 'USDC', reserveId: 3,
  aToken: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c', variableDebtToken: '0x72e95b8931767c79ba4eee721354d6e99a61d004',
  oracle: '0x54586be62e3c3580375ae3723c145253060ca0c2', faucet: null,
  explorer: 'https://etherscan.io', rpc: 'https://ethereum-rpc.publicnode.com',
  officialSource: 'https://github.com/aave-dao/aave-address-book/blob/main/src/AaveV3Ethereum.sol',
  l1DataFee: false, environment: 'MAINNET', poolRevision: 12, ownerBeneficiary: true, validateSupplyCap: true,
} as const);
/**
 * BUILD AAVE-V3-EXPANSION-001: every reserve of the Ethereum, Base and Arbitrum One Aave V3 Core markets.
 *
 * A mainnet reserve profile is the market's verified market-level profile above (Pool, PoolAddressesProvider, AaveOracle, pool implementation
 * pin and revision where recorded, explorer, network-cost model) with that reserve's identity from the pinned official address book
 * (`aave-v3-reserves.generated.ts`): reserve id, underlying, decimals, aToken and variable-debt token. The verified native-USDC profiles are the
 * same frozen objects as before, unchanged. Every other reserve is owner-beneficiary only and always checks its supply cap. A reserve is
 * identified by chain + Pool + underlying address + decimals, never by symbol: the symbol is a display label (and an authoring alias).
 * Listing here is not availability: active/frozen/paused, caps, liquidity, collateral and oracle state are read on chain at Simulate and
 * again immediately before every wallet request, and any mismatch with this identity fails closed.
 */
/**
 * HOTFIX-FLOFI-PRODUCTION-RECOVERY-001: Pool implementation upgrades Aave governance executed after the pinned address-book snapshot
 * (`AAVE_V3_ADDRESS_BOOK_COMMIT`), which still names the previous implementation. Each entry was verified read-only on chain on 2026-11-14:
 * the official Pool proxy's ERC-1967 implementation slot holds `to`; `to` has code, reports `POOL_REVISION()` 12 and `ADDRESSES_PROVIDER()` the
 * market's official PoolAddressesProvider; and that provider's `owner()` is the market's official Aave Governance V3 `EXECUTOR_LVL_1` (the only
 * account able to change the Pool implementation). Arbitrum One also has the executing transaction (provider `PoolUpdated(from, to)` and the
 * Pool proxy `Upgraded(to)` in one PayloadsController execution). An upgrade is accepted only from the exact snapshot implementation `from`:
 * any other snapshot or on-chain implementation still fails closed (AAVE_ADDRESS_BOOK_MARKET_MISMATCH at load, SUPPLY_DEPLOYMENT_MISMATCH at
 * every state read). Remove an entry once the address book snapshot is regenerated with the new implementation.
 */
export type AavePoolUpgrade = { readonly chain: string; readonly from: string; readonly to: string; readonly revision: number; readonly executor: string;
  readonly verifiedAtBlock: number; readonly transaction: string | null };
export const AAVE_V3_POOL_UPGRADES: readonly AavePoolUpgrade[] = Object.freeze([
  Object.freeze({ chain: 'eip155:1', from: '0x728a138a4823392c2efa55e028d434f526fe03cf', to: '0x4295fe69b3e978eb511e4558b4407ad871612fcb', revision: 12,
    executor: '0x5300a1a15135ea4dc7ad5a167152c01efc9b192a', verifiedAtBlock: 26410281, transaction: null }),
  Object.freeze({ chain: 'eip155:8453', from: '0xa4abc5fcba6d0d7e3d144d6dbf6cb6128599dfdb', to: '0xf248dd0adb01e78043e8a423b8504c8129f11918', revision: 12,
    executor: '0x9390b1735def18560c509e2d0bc090e9d6ba257a', verifiedAtBlock: 57167478, transaction: null }),
  Object.freeze({ chain: 'eip155:42161', from: '0xf05fd3cc911b4c5e36e53c00354f645e22922c9a', to: '0xa6e7d235a5b2fc7811d10669bbe20fa14b658a1e', revision: 12,
    executor: '0xff1137243698caa18ee364cc966cf0e02a4e6327', verifiedAtBlock: 524037413,
    transaction: '0x6f9dce2a81c9b8609b5927cb4b27144700c0ba05181f80ec39a955e081ce6936' }),
]);
/** The market's current Pool implementation: the snapshot's, or the recorded governance upgrade of exactly that snapshot implementation. */
export function aavePoolImplementation(chain: string, snapshotImplementation: string): string {
  const upgrade = AAVE_V3_POOL_UPGRADES.find(item => item.chain === chain);
  return upgrade && upgrade.from === snapshotImplementation ? upgrade.to : snapshotImplementation;
}
type MainnetMarketProfile = typeof AAVE_V3_BASE | typeof AAVE_V3_ARBITRUM | typeof AAVE_V3_ETHEREUM;
type ReserveIdentity = { readonly asset: string; readonly decimals: number; readonly symbol: string; readonly reserveId: number; readonly aToken: string;
  readonly variableDebtToken: string; readonly officialSource: string };
/** A non-USDC mainnet reserve: the market's profile, that reserve's identity, owner-only beneficiary and an exact supply-cap check. */
export type AaveReserveProfile<M extends MainnetMarketProfile = MainnetMarketProfile> = Readonly<Omit<M, keyof ReserveIdentity> & ReserveIdentity & {
  /** The address-book key (an authoring alias; e.g. `USDCn` for Arbitrum native USDC). */ readonly addressBookKey: string;
  /** The reserve's price source registered in the AaveOracle at the snapshot commit; discovery compares `getSourceOfAsset` with it. */ readonly priceSource: string;
  /** A market whose verified profile records no implementation pin (Base): the address-book Pool implementation, checked at every state read. */
  readonly pinnedImplementation?: string;
  readonly ownerBeneficiary: true; readonly validateSupplyCap: true }>;
/** Display labels where the address-book key is not the token's symbol. The label is never an identity. */
const RESERVE_LABELS: Readonly<Record<string, string>> = Object.freeze({ USDCn: 'USDC', USDCe: 'USDC.e', ONE_INCH: '1INCH', BTCb: 'BTC.b' });
export const aaveReserveLabel = (key: string): string => RESERVE_LABELS[key] ?? (key.startsWith('PT_') ? key.replaceAll('_', '-') : key);
const MAINNET_MARKETS: readonly MainnetMarketProfile[] = [AAVE_V3_ETHEREUM, AAVE_V3_BASE, AAVE_V3_ARBITRUM];
function reserveProfiles(market: MainnetMarketProfile): readonly (MainnetMarketProfile | AaveReserveProfile)[] {
  const book = AAVE_V3_ADDRESS_BOOK.find(item => item.chain === market.chain);
  // The snapshot must describe exactly the verified market (same Pool, provider and oracle) or the registry refuses to load.
  if (!book || book.pool !== market.pool || book.provider !== market.provider || book.oracle !== market.oracle ||
      ('poolImplementation' in market && aavePoolImplementation(book.chain, book.poolImplementation) !== market.poolImplementation)) throw new Error('AAVE_ADDRESS_BOOK_MARKET_MISMATCH');
  const verified = book.reserves.find(reserve => reserve.underlying === market.asset);
  if (!verified || verified.id !== market.reserveId || verified.decimals !== market.decimals || verified.aToken !== market.aToken ||
      verified.variableDebtToken !== market.variableDebtToken) throw new Error('AAVE_ADDRESS_BOOK_RESERVE_MISMATCH');
  // Labels are display names and authoring aliases: within one market they must never name two reserves.
  const labels = book.reserves.map(reserve => reserve.underlying === market.asset ? market.symbol : aaveReserveLabel(reserve.key)).map(label => label.toLowerCase());
  if (new Set(labels).size !== labels.length) throw new Error('AAVE_ADDRESS_BOOK_LABEL_DUPLICATE');
  return Object.freeze(book.reserves.map((reserve: AaveAddressBookReserve) => reserve.underlying === market.asset ? market : Object.freeze({
    ...market, asset: reserve.underlying, decimals: reserve.decimals, symbol: aaveReserveLabel(reserve.key), reserveId: reserve.id, aToken: reserve.aToken,
    variableDebtToken: reserve.variableDebtToken, addressBookKey: reserve.key, priceSource: reserve.oracle,
    ...'poolImplementation' in market ? {} : { pinnedImplementation: aavePoolImplementation(book.chain, book.poolImplementation) },
    officialSource: `https://github.com/aave-dao/aave-address-book/blob/${AAVE_V3_ADDRESS_BOOK_COMMIT}/src/ts/${book.library}.ts`,
    ownerBeneficiary: true as const, validateSupplyCap: true as const,
  }) as AaveReserveProfile));
}
export type AaveLendingProfile = typeof AAVE_V3_BASE_SEPOLIA | typeof AAVE_V3_ETHEREUM_SEPOLIA | MainnetMarketProfile | AaveReserveProfile;
/** One Aave V3 market: its verified Pool and every listed reserve profile (the native-USDC profile first). */
export type AaveMarket = { readonly network: MainnetMarketProfile['network']; readonly chain: MainnetMarketProfile['chain']; readonly chainId: number;
  readonly pool: string; readonly provider: string; readonly oracle: string; readonly dataProvider: string; readonly wethGateway: string;
  readonly primary: MainnetMarketProfile; readonly reserves: readonly AaveLendingProfile[]; readonly source: string };
export const AAVE_V3_MARKETS: readonly AaveMarket[] = Object.freeze(MAINNET_MARKETS.map(market => {
  const book = AAVE_V3_ADDRESS_BOOK.find(item => item.chain === market.chain)!, reserves = reserveProfiles(market);
  return Object.freeze({ network: market.network, chain: market.chain, chainId: market.chainId, pool: market.pool, provider: market.provider, oracle: market.oracle,
    dataProvider: book.dataProvider, wethGateway: book.wethGateway, primary: market,
    reserves: Object.freeze([market, ...reserves.filter(reserve => reserve !== market)]),
    source: `https://github.com/aave-dao/aave-address-book/tree/${AAVE_V3_ADDRESS_BOOK_COMMIT}/src/ts/${book.library}.ts` });
}));
/**
 * Every registered reserve profile. The testnet profiles keep one verified asset each; each mainnet market lists all its reserves, its native
 * USDC profile first. Profiles are chosen by the authored or reviewed chain AND underlying address, never by symbol.
 */
export const AAVE_V3_LENDING_PROFILES: readonly AaveLendingProfile[] = Object.freeze([AAVE_V3_BASE_SEPOLIA, AAVE_V3_ETHEREUM_SEPOLIA,
  ...[AAVE_V3_BASE, AAVE_V3_ARBITRUM, AAVE_V3_ETHEREUM].flatMap(market => AAVE_V3_MARKETS.find(item => item.chain === market.chain)!.reserves)]);
/** The deployment environment of a lending profile (the testnet profiles predate the field). */
export const aaveEnvironment = (profile: AaveLendingProfile): 'PUBLIC_TESTNET' | 'MAINNET' => 'environment' in profile ? profile.environment : 'PUBLIC_TESTNET';
/**
 * The chain's MARKET profile (its first registered reserve: native USDC on a mainnet, the one test asset on a testnet). Use it only for
 * market-level facts (Pool, provider, RPC, explorer, network cost); a reserve is resolved with `aaveReserveProfile(chain, asset)`.
 */
export function aaveLendingProfile(chain: string): AaveLendingProfile {
  const profile = AAVE_V3_LENDING_PROFILES.find(item => item.chain === chain);
  if (!profile) throw new Error('AAVE_PROFILE_UNSUPPORTED');
  return profile;
}
/** Every registered reserve of a chain's market (empty when Aave is not registered there). */
export const aaveMarketReserves = (chain: string): readonly AaveLendingProfile[] => AAVE_V3_LENDING_PROFILES.filter(item => item.chain === chain);
/** The reserve profile for an exact chain + underlying address (and decimals, when given). Never resolved by symbol. */
export function aaveReserveProfile(chain: string, asset: string, decimals?: number): AaveLendingProfile {
  const address = typeof asset === 'string' ? asset.toLowerCase() : '';
  const profile = AAVE_V3_LENDING_PROFILES.find(item => item.chain === chain && item.asset === address);
  if (!profile || (decimals !== undefined && profile.decimals !== decimals)) throw new Error('AAVE_PROFILE_UNSUPPORTED');
  return profile;
}
/** True for a reserve listed beyond a market's original single verified asset. */
export const isAaveExpansionReserve = (profile: AaveLendingProfile): profile is AaveReserveProfile => 'addressBookKey' in profile;
/** Rejects anything other than one of the frozen registered profiles (for example an object built by a caller). */
export function assertAaveLendingProfile(value: unknown): AaveLendingProfile {
  if (!AAVE_V3_LENDING_PROFILES.some(profile => profile === value)) throw new Error('AAVE_PROFILE_UNSUPPORTED');
  return value as AaveLendingProfile;
}
