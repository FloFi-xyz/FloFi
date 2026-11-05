// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD AAVE-V3-EXPANSION-001: a scripted, read-only Aave V3 market — MOCKED test data, never a live read and never a public network.
 *
 * It answers exactly the reads `discoverAaveReserves` (src/aave-reserves.ts) makes, directly or through Multicall3 `aggregate3`:
 * PoolAddressesProvider `getPool`; Pool `getReservesList`, `getReserveData` (the 15-word legacy layout), `getReserveNormalizedIncome`,
 * `getUserAccountData`, `getUserConfiguration`, `getUserEMode`; aToken `scaledTotalSupply` / `balanceOf`; variable-debt token `totalSupply` /
 * `balanceOf`; underlying `balanceOf` (the aToken's liquidity and the owner's wallet); AaveOracle `getAssetPrice` / `getSourceOfAsset`. The
 * calldata is decoded and the answers ABI-encoded here, independently of the code under test.
 *
 * Shared by the unit tests (aave-reserves.test.ts) and the Base mainnet loopback e2e harness (apps/reference-dapp/e2e/base-mainnet-aave.ts),
 * which loads it unbuilt under `node` type stripping: only erasable TypeScript, type-only imports marked, and dependencies this package
 * resolves on its own (the action-registry build and @noble/hashes).
 */
import { keccak_256 } from '@noble/hashes/sha3.js';
import { AAVE_V3_ADDRESS_BOOK, AAVE_V3_MARKETS, type AaveLendingProfile, type AaveMarket } from '@defi-workflow-engine/action-registry';

/** Multicall3: the same deployment on Ethereum, Base and Arbitrum One. */
export const MULTICALL3_ADDRESS = '0xca11bde05977b3631167028862be2a173976ca11';
/** MOCKED synthetic runtime code (not Multicall3's bytecode): present, so a reader batches through `aggregate3`. */
export const MOCK_MULTICALL3_CODE = '0x60806040';
export const RAY = 10n ** 27n, WAD = 10n ** 18n, MAX_UINT256 = (1n << 256n) - 1n;

export function abiSelector(signature: string): string {
  return '0x' + Array.from(keccak_256(new TextEncoder().encode(signature)).slice(0, 4), byte => byte.toString(16).padStart(2, '0')).join('');
}
/** One ABI word (64 hex characters, no prefix) of an unsigned integer or an address. */
export function abiWord(value: bigint | string): string {
  const n = typeof value === 'string' ? BigInt(value) : value;
  if (n < 0n || n > MAX_UINT256) throw new Error('MOCK_ABI_WORD_INVALID');
  return n.toString(16).padStart(64, '0');
}
export const abiCall = (signature: string, ...args: readonly (bigint | string)[]): string => abiSelector(signature) + args.map(arg => abiWord(arg)).join('');
const SELECTOR = Object.freeze({
  aggregate3: abiSelector('aggregate3((address,bool,bytes)[])'), getEthBalance: abiSelector('getEthBalance(address)'),
  getPool: abiSelector('getPool()'), getReservesList: abiSelector('getReservesList()'), getReserveData: abiSelector('getReserveData(address)'),
  getReserveNormalizedIncome: abiSelector('getReserveNormalizedIncome(address)'), getUserAccountData: abiSelector('getUserAccountData(address)'),
  getUserConfiguration: abiSelector('getUserConfiguration(address)'), getUserEMode: abiSelector('getUserEMode(address)'),
  getAssetPrice: abiSelector('getAssetPrice(address)'), getSourceOfAsset: abiSelector('getSourceOfAsset(address)'),
  scaledTotalSupply: abiSelector('scaledTotalSupply()'), totalSupply: abiSelector('totalSupply()'), balanceOf: abiSelector('balanceOf(address)'),
});
export const MULTICALL3_SELECTORS = Object.freeze({ aggregate3: SELECTOR.aggregate3, getEthBalance: SELECTOR.getEthBalance });

/** The fields of Aave's `ReserveConfigurationMap` a reader checks (ReserveConfiguration.sol bit layout). Caps are whole tokens; 0 = no cap. */
export type AaveReserveConfigInput = {
  readonly ltvBps: number; readonly liquidationThresholdBps: number; readonly liquidationBonusBps?: number; readonly decimals: number;
  readonly active?: boolean; readonly frozen?: boolean; readonly borrowing?: boolean; readonly paused?: boolean; readonly siloed?: boolean;
  readonly borrowCap?: bigint; readonly supplyCap?: bigint; readonly debtCeiling?: bigint;
};
export function aaveReserveConfig(input: AaveReserveConfigInput): bigint {
  const field = (value: bigint, bits: bigint, at: bigint) => { if (value < 0n || value >= 1n << bits) throw new Error('MOCK_RESERVE_CONFIG_INVALID'); return value << at; };
  const flag = (value: boolean | undefined, at: bigint) => value ? 1n << at : 0n;
  return field(BigInt(input.ltvBps), 16n, 0n) | field(BigInt(input.liquidationThresholdBps), 16n, 16n) | field(BigInt(input.liquidationBonusBps ?? 0), 16n, 32n) |
    field(BigInt(input.decimals), 8n, 48n) | flag(input.active ?? true, 56n) | flag(input.frozen, 57n) | flag(input.borrowing ?? true, 58n) | flag(input.paused, 60n) |
    flag(input.siloed, 62n) | field(input.borrowCap ?? 0n, 36n, 80n) | field(input.supplyCap ?? 0n, 36n, 116n) | field(input.debtCeiling ?? 0n, 40n, 212n);
}

/** One reserve's MOCKED market state. Only `config` is required; the identity fields override what `getReserveData` answers (mismatch cases). */
export type AaveFixtureReserve = {
  readonly config: bigint;
  /** Returned by `getReservesList` (default true); an unlisted reserve still answers its reads. */ readonly listed?: boolean;
  readonly id?: number; readonly aToken?: string; readonly variableDebtToken?: string;
  /** AaveOracle price in the base currency, 8 decimals (default 1e8); null makes the read revert. */ readonly price?: bigint | null;
  /** AaveOracle source (default: the address-book snapshot's). */ readonly source?: string;
  /** Underlying `balanceOf(aToken)` (default 1e24). */ readonly liquidity?: bigint;
  /** aToken `scaledTotalSupply` and the treasury accrual (default 0). */ readonly scaledSupply?: bigint; readonly accruedToTreasury?: bigint;
  /** Variable-debt token `totalSupply` (default 0). */ readonly debt?: bigint;
  /** Current rates and the normalized income, in ray (default 0, 0 and RAY). */ readonly liquidityRate?: bigint; readonly variableBorrowRate?: bigint;
  readonly normalizedIncome?: bigint;
};
/** One owner position in one reserve, in base units: wallet (underlying), supplied (aToken), variable debt, collateral flag. */
export type AaveFixturePosition = { readonly wallet?: bigint; readonly supplied?: bigint; readonly debt?: bigint; readonly collateral?: boolean };
export type AaveFixtureAccount = {
  /** Account reads answer only for this owner; any address when omitted. */ readonly owner?: string;
  /** Positions by underlying address; a listed reserve without one uses `defaultPosition` (default: nothing held). */
  readonly positions?: ReadonlyMap<string, AaveFixturePosition>; readonly defaultPosition?: AaveFixturePosition;
  /** Derived from the positions when omitted (bit 2·id borrowing, 2·id+1 collateral). */ readonly userConfiguration?: bigint;
  /** `getUserAccountData` words; derived from the positions (Aave GenericLogic, E-Mode 0) when omitted. */ readonly accountData?: readonly bigint[];
  /** E-Mode category (default 0); null makes the read revert. */ readonly eMode?: bigint | null;
};
export type AaveFixtureState = {
  /** Reserve state by underlying address; a registered reserve without an entry answers none of its reads. */
  readonly reserves: ReadonlyMap<string, AaveFixtureReserve>;
  /** Further assets `getReservesList` returns (assets the registry does not list). */ readonly extraListed?: readonly string[];
  readonly account?: AaveFixtureAccount;
  /** Whether Multicall3 is deployed for the standalone `rpc` (default true). */ readonly multicall?: boolean;
};

export type Aggregate3Call = { readonly target: string; readonly allowFailure: boolean; readonly data: string };
/** Decodes `aggregate3((address target, bool allowFailure, bytes callData)[])` exactly, bounds-checked. */
export function decodeAggregate3Calls(calldata: string): Aggregate3Call[] {
  const input = calldata.toLowerCase();
  if (!input.startsWith(SELECTOR.aggregate3) || !/^0x[0-9a-f]*$/.test(input) || input.length % 2 !== 0) throw new Error('MOCK_MULTICALL_INVALID');
  const hex = input.slice(10), size = hex.length / 2;
  const at = (offset: number) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + 32 > size) throw new Error('MOCK_MULTICALL_INVALID');
    return BigInt('0x' + hex.slice(offset * 2, offset * 2 + 64));
  };
  const small = (offset: number) => { const value = at(offset); if (value > BigInt(size)) throw new Error('MOCK_MULTICALL_INVALID'); return Number(value); };
  const array = small(0), count = small(array), items = array + 32;
  if (count > 1_024) throw new Error('MOCK_MULTICALL_INVALID');
  return Array.from({ length: count }, (_, i) => {
    const tuple = items + small(items + 32 * i), target = at(tuple), allowFailure = at(tuple + 32), bytes = tuple + small(tuple + 64), length = small(bytes);
    if (target >> 160n || allowFailure > 1n || bytes + 32 + length > size) throw new Error('MOCK_MULTICALL_INVALID');
    return { target: '0x' + target.toString(16).padStart(40, '0'), allowFailure: allowFailure === 1n, data: '0x' + hex.slice((bytes + 32) * 2, (bytes + 32 + length) * 2) };
  });
}
/** Encodes `aggregate3` calldata (allowFailure as given, default true): what a reader sends. */
export function encodeAggregate3Calls(calls: readonly { readonly target: string; readonly data: string; readonly allowFailure?: boolean }[]): string {
  return SELECTOR.aggregate3 + encodeDynamicArray(calls.map(call => abiWord(call.target) + abiWord(call.allowFailure === false ? 0n : 1n) + abiWord(96n) + abiBytes(call.data)));
}
/** Encodes the `(bool success, bytes returnData)[]` answer; null is a failed call (empty return data). */
export function encodeAggregate3Results(results: readonly (string | null)[]): string {
  return '0x' + encodeDynamicArray(results.map(result => abiWord(result === null ? 0n : 1n) + abiWord(64n) + abiBytes(result ?? '0x')));
}
function abiBytes(data: string): string {
  const body = data.slice(2);
  return abiWord(BigInt(body.length / 2)) + body.padEnd(Math.ceil(body.length / 64) * 64, '0');
}
function encodeDynamicArray(tuples: readonly string[]): string {
  let offset = 32n * BigInt(tuples.length);
  const offsets = tuples.map(tuple => { const at = offset; offset += BigInt(tuple.length / 2); return abiWord(at); });
  return abiWord(32n) + abiWord(BigInt(tuples.length)) + offsets.join('') + tuples.join('');
}

/**
 * Aave V3's account aggregates (GenericLogic.calculateUserAccountData, E-Mode 0) over the fixture's positions: collateral and debt in the base
 * currency, available borrows, weighted liquidation threshold and LTV, and the health factor (max uint256 without debt).
 */
function accountData(market: AaveMarket, state: AaveFixtureState, position: (profile: AaveLendingProfile) => Required<AaveFixturePosition>): bigint[] {
  let collateral = 0n, debt = 0n, ltvSum = 0n, thresholdSum = 0n;
  for (const profile of market.reserves) {
    const reserve = state.reserves.get(profile.asset);
    if (!reserve) continue;
    const held = position(profile), price = reserve.price ?? 100_000_000n, unit = 10n ** BigInt(profile.decimals);
    const ltv = reserve.config & 0xffffn, threshold = (reserve.config >> 16n) & 0xffffn;
    if (held.collateral && held.supplied > 0n && threshold !== 0n) {
      const value = held.supplied * price / unit;
      collateral += value; ltvSum += value * ltv; thresholdSum += value * threshold;
    }
    if (held.debt > 0n) debt += (held.debt * price + unit - 1n) / unit;
  }
  const ltv = collateral ? ltvSum / collateral : 0n, threshold = collateral ? thresholdSum / collateral : 0n;
  const percentMul = (value: bigint, bps: bigint) => (value * bps + 5_000n) / 10_000n, power = percentMul(collateral, ltv);
  const health = debt === 0n ? MAX_UINT256 : (percentMul(collateral, threshold) * WAD + debt / 2n) / debt;
  return [collateral, debt, power > debt ? power - debt : 0n, threshold, ltv, health];
}

/**
 * The scripted market of a registered Aave V3 mainnet `chain`, answering from `state` (an object, or a getter read on every call so a harness
 * can change it). `answer` returns the call's return data, null for a call that reverts, or undefined for a call that is not this market's
 * (a harness passes it on to its chain). With `{ wallet: false }` the owner-wallet read of an underlying token (`balanceOf(owner)`) is left
 * undefined too: that token's ledger is not the market's.
 */
export function createAaveMarketFixture(chain: string, state: AaveFixtureState | (() => AaveFixtureState)) {
  const found = AAVE_V3_MARKETS.find(item => item.chain === chain), snapshot = AAVE_V3_ADDRESS_BOOK.find(item => item.chain === chain);
  if (!found || !snapshot) throw new Error('MOCK_AAVE_MARKET_UNSUPPORTED');
  const market: AaveMarket = found, book = snapshot;
  const current = typeof state === 'function' ? state : () => state;
  const byAsset = new Map(market.reserves.map(profile => [profile.asset, profile]));
  const byAToken = new Map(market.reserves.map(profile => [profile.aToken, profile]));
  const byDebtToken = new Map(market.reserves.map(profile => [profile.variableDebtToken, profile]));
  /** The market's own contracts: a read of one is answered here (or reverts), never by a chain. */
  const targets: ReadonlySet<string> = new Set([market.pool, market.provider, market.oracle, ...byAToken.keys(), ...byDebtToken.keys()]);
  const word = (value: bigint | string) => '0x' + abiWord(value);

  function answer(to: string, data: string, options: { readonly wallet?: boolean } = {}): string | null | undefined {
    const target = to.toLowerCase(), input = data.toLowerCase(), own = targets.has(target);
    const selector = input.slice(0, 10), body = input.slice(10);
    if (!/^0x[0-9a-f]{8}$/.test(selector) || !/^[0-9a-f]*$/.test(body) || body.length % 64 !== 0) return own ? null : undefined;
    const args = body.match(/.{64}/g) ?? [];
    const address = (i: number) => { const value = args[i]; return value && /^0{24}/.test(value) ? '0x' + value.slice(24) : null; };
    const s = current(), account = s.account;
    // A position is an owner's only when the account answers for that owner (any owner when none is named).
    const position = (owner: string | null, profile: AaveLendingProfile): Required<AaveFixturePosition> | null => {
      if (!account || owner === null || (account.owner !== undefined && account.owner.toLowerCase() !== owner)) return null;
      const held = account.positions?.get(profile.asset) ?? account.defaultPosition ?? {};
      return { wallet: held.wallet ?? 0n, supplied: held.supplied ?? 0n, debt: held.debt ?? 0n, collateral: held.collateral ?? false };
    };
    const arg0 = args.length === 1 ? address(0) : null;
    if (target === market.provider) return selector === SELECTOR.getPool && args.length === 0 ? word(market.pool) : null;
    if (target === market.pool) {
      if (selector === SELECTOR.getReservesList && args.length === 0) {
        const listed = [...[...s.reserves].filter(([, reserve]) => reserve.listed !== false).map(([asset]) => asset), ...s.extraListed ?? []];
        return '0x' + abiWord(32n) + abiWord(BigInt(listed.length)) + listed.map(asset => abiWord(asset)).join('');
      }
      const reserve = arg0 ? s.reserves.get(arg0) : undefined, profile = arg0 ? byAsset.get(arg0) : undefined;
      if (selector === SELECTOR.getReserveData && reserve && profile) {
        const words = Array.from({ length: 15 }, () => 0n);
        words[0] = reserve.config; words[1] = RAY; words[2] = reserve.liquidityRate ?? 0n; words[3] = RAY; words[4] = reserve.variableBorrowRate ?? 0n;
        words[7] = BigInt(reserve.id ?? profile.reserveId); words[8] = BigInt(reserve.aToken ?? profile.aToken);
        words[10] = BigInt(reserve.variableDebtToken ?? profile.variableDebtToken); words[12] = reserve.accruedToTreasury ?? 0n;
        return '0x' + words.map(value => abiWord(value)).join('');
      }
      if (selector === SELECTOR.getReserveNormalizedIncome && reserve) return word(reserve.normalizedIncome ?? RAY);
      if (!account || arg0 === null || (account.owner !== undefined && account.owner.toLowerCase() !== arg0)) return null;
      const held = (item: AaveLendingProfile) => position(arg0, item)!;
      if (selector === SELECTOR.getUserAccountData) return '0x' + (account.accountData ?? accountData(market, s, held)).map(value => abiWord(value)).join('');
      if (selector === SELECTOR.getUserConfiguration) {
        const derived = market.reserves.filter(item => s.reserves.has(item.asset)).reduce((bits, item) => {
          const p = held(item), id = BigInt(item.reserveId);
          return bits | (p.debt > 0n ? 1n << (2n * id) : 0n) | (p.collateral && p.supplied > 0n ? 1n << (2n * id + 1n) : 0n);
        }, 0n);
        return word(account.userConfiguration ?? derived);
      }
      if (selector === SELECTOR.getUserEMode) return account.eMode === null ? null : word(account.eMode ?? 0n);
      return null;
    }
    if (target === market.oracle) {
      const reserve = arg0 ? s.reserves.get(arg0) : undefined;
      if (!reserve || !arg0) return null;
      if (selector === SELECTOR.getAssetPrice) return reserve.price === null ? null : word(reserve.price ?? 100_000_000n);
      if (selector === SELECTOR.getSourceOfAsset) return word(reserve.source ?? book.reserves.find(item => item.underlying === arg0)?.oracle ?? 0n);
      return null;
    }
    const aToken = byAToken.get(target), debtToken = byDebtToken.get(target), token = aToken ?? debtToken;
    if (token) {
      const reserve = s.reserves.get(token.asset);
      if (!reserve) return null;
      if (aToken && selector === SELECTOR.scaledTotalSupply && args.length === 0) return word(reserve.scaledSupply ?? 0n);
      if (debtToken && selector === SELECTOR.totalSupply && args.length === 0) return word(reserve.debt ?? 0n);
      const held = selector === SELECTOR.balanceOf ? position(arg0, token) : null;
      return held ? word(aToken ? held.supplied : held.debt) : null;
    }
    // The underlying token itself is not the market's: only its balance at the aToken (liquidity) and the owner's wallet are scripted.
    const underlying = byAsset.get(target), reserve = underlying ? s.reserves.get(underlying.asset) : undefined;
    if (!underlying || !reserve || selector !== SELECTOR.balanceOf || arg0 === null) return undefined;
    if (arg0 === underlying.aToken) return word(reserve.liquidity ?? 10n ** 24n);
    const held = options.wallet === false ? null : position(arg0, underlying);
    return held ? word(held.wallet) : undefined;
  }
  /** One `aggregate3` answered call by call (`fallback` answers what is not this market's; default: it reverts). */
  async function aggregate3(calldata: string, fallback: (to: string, data: string) => string | null | Promise<string | null> = () => null): Promise<string> {
    const calls = decodeAggregate3Calls(calldata);
    const results = await Promise.all(calls.map(async call => { const value = answer(call.target, call.data); return value === undefined ? fallback(call.target, call.data) : value; }));
    if (calls.some((call, i) => !call.allowFailure && results[i] === null)) throw new Error('execution reverted: Multicall3: call failed');
    return encodeAggregate3Results(results);
  }
  /** A minimal standalone node for unit tests: this market only, at block 100. */
  async function rpc(method: string, params: readonly unknown[]): Promise<unknown> {
    const multicall = current().multicall !== false;
    if (method === 'eth_chainId') return '0x' + market.chainId.toString(16);
    if (method === 'eth_getBlockByNumber') return { number: '0x64', hash: '0x' + 'a'.repeat(64) };
    if (method === 'eth_getCode') return multicall && String(params[0]).toLowerCase() === MULTICALL3_ADDRESS ? MOCK_MULTICALL3_CODE : '0x';
    if (method !== 'eth_call') throw new Error('unexpected ' + method);
    const { to, data } = params[0] as { to: string; data: string };
    if (to.toLowerCase() === MULTICALL3_ADDRESS) {
      if (!multicall || !data.toLowerCase().startsWith(SELECTOR.aggregate3)) throw new Error('multicall unavailable');
      return aggregate3(data);
    }
    const result = answer(to, data);
    if (result === null || result === undefined) throw new Error('execution reverted');
    return result;
  }
  return { market, targets, answer, aggregate3, rpc };
}
export type AaveMarketFixture = ReturnType<typeof createAaveMarketFixture>;
