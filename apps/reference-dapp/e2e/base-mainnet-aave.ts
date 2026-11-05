// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The MOCKED Aave V3 Base market of the Base mainnet loopback harness (base-mainnet-serve.ts, 127.0.0.1:8562). Test data only: never a live
 * market read, never a public network, nothing signs or sends.
 *
 * Every reserve registered for eip155:8453 (`AAVE_V3_MARKETS`, from the action-registry build) answers with its registered identity (Pool,
 * reserve id, aToken, variable-debt token, decimals, oracle source), so live discovery verifies each one and reads it completely. The reads are
 * scripted by packages/reference-compiler/test/aave-market-fixture.ts, the same fixture the discovery unit tests use.
 *
 * Default MOCKED market: every reserve listed, active, unpaused, with positive liquidity, prices, variable rates and caps with headroom;
 * `USDbC` is FROZEN and `cbBTC` has borrowing DISABLED. Default MOCKED account (whatever owner is queried): wallet 250 USDC and 0.4 WETH (every
 * other wallet balance 0), 100 USDC supplied as collateral, 0.01 WETH variable debt, E-Mode 0; account aggregates are derived as Aave does.
 *
 * Multicall3 is deployed on this chain (synthetic code). A batch that calls the Aave market (Pool, provider, oracle, aToken or debt token) is an
 * Aave read and sees the MOCKED account's wallet balances above; any other batch (for example the dashboard portfolio) and every direct
 * `eth_call` still read the in-memory chain's own ERC-20 ledger, so transfer, swap and wallet journeys on this harness are unchanged. Direct
 * reads of the Aave contracts are answered here too. Simulate/Review of an Aave run is not scripted (no Pool code, implementation pin,
 * `eth_simulateV1` or allowance state): they fail closed on this harness.
 *
 * Control — `POST /__harness/aave` with one JSON patch, validated whole and applied atomically (any invalid field: HTTP 400, nothing changes):
 *   { "reset": true,                                         // first restore the default MOCKED market and account
 *     "reserves": { "<symbol>": {                            // a registered Base reserve label, e.g. "USDC", "WETH", "cbBTC", "EURC"
 *       "listed"?, "active"?, "frozen"?, "paused"?, "borrowingEnabled"?, "collateral"?: boolean,
 *       "supplyCap"?, "borrowCap"?: whole tokens (integer or digit string; 0 = no cap),
 *       "priceUsd"?: "2500.00" (AaveOracle, 8 decimals; "0" = oracle unavailable),
 *       "liquidity"?: tokens available to borrow ("0" = no liquidity),
 *       "walletBalance"?, "supplied"?, "debt"?: the MOCKED account's amounts in token units ("250", "0.4") } },
 *     "account": { "eMode"?: integer category, or null for an account whose state cannot be read } }
 * It answers `{ result: <summary> }`; `GET /__harness/aave` answers the same summary plus `reads` (Aave batches served). The chain's own
 * `POST /__harness/chain {"action":"reset"}` also restores this default market, so reset the chain first and patch after; until the chain is
 * started `/rpc` answers 503 and this endpoint refuses with HTTP 409.
 */
import { AAVE_V3_MARKETS, type AaveLendingProfile } from '@defi-workflow-engine/action-registry';
import { aaveReserveConfig, abiWord, createAaveMarketFixture, decodeAggregate3Calls, encodeAggregate3Results, MOCK_MULTICALL3_CODE, MULTICALL3_ADDRESS,
  MULTICALL3_SELECTORS, RAY, type AaveFixturePosition, type AaveFixtureReserve, type AaveFixtureState } from '../../../packages/reference-compiler/test/aave-market-fixture.ts';

export const BASE_AAVE_CHAIN = 'eip155:8453';
/** The default MOCKED market's exceptions (registered Base reserve labels). */
export const BASE_AAVE_FROZEN = 'USDbC', BASE_AAVE_BORROWING_DISABLED = 'cbBTC';
/** The default MOCKED account (any owner), in token units. */
export const BASE_AAVE_ACCOUNT = Object.freeze({ USDC: { walletBalance: '250', supplied: '100', debt: '0', collateral: true },
  WETH: { walletBalance: '0.4', supplied: '0', debt: '0.01', collateral: false } });
const market = AAVE_V3_MARKETS.find(item => item.chain === BASE_AAVE_CHAIN);
if (!market) throw new Error('MOCK_AAVE_MARKET_UNSUPPORTED');
const reserves: readonly AaveLendingProfile[] = market.reserves;

type Rpc = (method: string, params: readonly unknown[]) => Promise<unknown>;
type ReserveState = {
  listed: boolean; active: boolean; frozen: boolean; paused: boolean; borrowingEnabled: boolean; ltvBps: number; liquidationThresholdBps: number;
  supplyCap: bigint; borrowCap: bigint; price: bigint; supplied: bigint; borrowed: bigint; liquidity: bigint; supplyAprBps: bigint; borrowAprBps: bigint;
  walletBalance: bigint; accountSupplied: bigint; accountDebt: bigint; collateral: boolean;
};
type MarketState = { readonly reserves: Map<string, ReserveState>; eMode: bigint | null };

/**
 * MOCKED, illustrative market figures (never a live read): price in USD, LTV and liquidation threshold (bps), supply and borrow caps (whole
 * tokens), total supplied and borrowed (tokens), current supply and borrow APR (bps). A reserve registered later without a row uses `OTHER`.
 */
type Row = readonly [price: string, ltv: number, threshold: number, supplyCap: number, borrowCap: number, supplied: string, borrowed: string, supplyApr: number, borrowApr: number];
const MOCKED_ROWS: Readonly<Record<string, Row>> = Object.freeze({
  USDC: ['1.00', 7500, 7800, 600_000_000, 550_000_000, '412000000', '338000000', 410, 560],
  WETH: ['2500.00', 8000, 8300, 250_000, 220_000, '120000', '96000', 190, 260],
  cbETH: ['2750.00', 7500, 7900, 12_000, 600, '3800', '85', 2, 60],
  USDbC: ['1.00', 7500, 7800, 5_000_000, 4_000_000, '1200000', '700000', 300, 520],
  wstETH: ['3000.00', 7500, 7950, 15_000, 1_500, '9200', '310', 3, 70],
  weETH: ['2650.00', 7250, 7750, 30_000, 1_500, '21000', '450', 2, 65],
  cbBTC: ['95000.00', 7300, 7800, 10_000, 900, '5400', '0', 1, 40],
  ezETH: ['2600.00', 7250, 7500, 4_000, 400, '2100', '12', 1, 45],
  GHO: ['1.00', 0, 0, 30_000_000, 25_000_000, '9000000', '6500000', 450, 620],
  wrsETH: ['2580.00', 7250, 7500, 2_500, 250, '1400', '9', 1, 45],
  LBTC: ['95000.00', 7000, 7500, 800, 80, '420', '3', 1, 35],
  EURC: ['1.08', 7500, 7800, 10_000_000, 9_000_000, '5600000', '3900000', 280, 450],
  AAVE: ['180.00', 6600, 7300, 10_000, 1_000, '3200', '20', 1, 55],
  tBTC: ['95000.00', 7300, 7800, 350, 35, '120', '2', 1, 35],
  syrupUSDC: ['1.12', 7500, 7800, 40_000_000, 4_000_000, '18000000', '400000', 10, 450],
});
const OTHER: Row = ['1.00', 5000, 6500, 1_000_000, 500_000, '100000', '20000', 100, 300];

const deny = (reason: string): never => { throw new Error('MOCK_AAVE_CONTROL_DENIED ' + reason); };
/** A non-negative decimal amount in token units as base units (at most `decimals` fraction digits). */
function units(value: unknown, decimals: number, field: string): bigint {
  const match = typeof value === 'string' ? /^(\d{1,40})(?:\.(\d+))?$/.exec(value) : null;
  if (!match || (match[2] ?? '').length > decimals) return deny(field);
  return BigInt(match[1]!) * 10n ** BigInt(decimals) + BigInt((match[2] ?? '').padEnd(decimals, '0') || '0');
}
const format = (value: bigint, decimals: number) => {
  const unit = 10n ** BigInt(decimals), fraction = (value % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
  return (value / unit).toString() + (fraction ? '.' + fraction : '');
};
function cap(value: unknown, field: string): bigint {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== 'string' || !/^\d{1,11}$/.test(text) || BigInt(text) >= 1n << 36n) return deny(field);
  return BigInt(text);
}
const flag = (value: unknown, field: string): boolean => typeof value === 'boolean' ? value : deny(field);

function defaults(): MarketState {
  return { eMode: 0n, reserves: new Map(reserves.map(profile => {
    const [price, ltv, threshold, supplyCap, borrowCap, supplied, borrowed, supplyApr, borrowApr] = MOCKED_ROWS[profile.symbol] ?? OTHER;
    const d = profile.decimals, account = (BASE_AAVE_ACCOUNT as Readonly<Record<string, (typeof BASE_AAVE_ACCOUNT)['USDC']>>)[profile.symbol];
    const total = units(supplied, d, 'supplied'), debt = units(borrowed, d, 'borrowed');
    return [profile.symbol, { listed: true, active: true, paused: false, frozen: profile.symbol === BASE_AAVE_FROZEN,
      borrowingEnabled: profile.symbol !== BASE_AAVE_BORROWING_DISABLED, ltvBps: ltv, liquidationThresholdBps: threshold,
      supplyCap: BigInt(supplyCap), borrowCap: BigInt(borrowCap), price: units(price, 8, 'price'), supplied: total, borrowed: debt, liquidity: total - debt,
      supplyAprBps: BigInt(supplyApr), borrowAprBps: BigInt(borrowApr), walletBalance: account ? units(account.walletBalance, d, 'wallet') : 0n,
      accountSupplied: account ? units(account.supplied, d, 'supplied') : 0n, accountDebt: account ? units(account.debt, d, 'debt') : 0n,
      collateral: account?.collateral ?? false }] as const;
  })) };
}
const RESERVE_FIELDS = new Set(['listed', 'active', 'frozen', 'paused', 'borrowingEnabled', 'collateral', 'supplyCap', 'borrowCap', 'priceUsd', 'liquidity',
  'walletBalance', 'supplied', 'debt']);
/** Applies one control patch to a copy of `state`; throws (nothing changed) on any field it does not recognise or accept. */
function patched(state: MarketState, control: unknown): MarketState {
  if (!control || typeof control !== 'object' || Array.isArray(control)) return deny('body');
  const body = control as Record<string, unknown>;
  for (const key of Object.keys(body)) if (!['reset', 'reserves', 'account'].includes(key)) deny(key);
  if (body.reset !== undefined && body.reset !== true) deny('reset');
  const base = body.reset === true ? defaults() : state;
  const next: MarketState = { eMode: base.eMode, reserves: new Map([...base.reserves].map(([symbol, reserve]) => [symbol, { ...reserve }])) };
  if (body.reserves !== undefined) {
    if (!body.reserves || typeof body.reserves !== 'object' || Array.isArray(body.reserves)) deny('reserves');
    for (const [symbol, input] of Object.entries(body.reserves as Record<string, unknown>)) {
      const reserve = next.reserves.get(symbol), profile = reserves.find(item => item.symbol === symbol);
      if (!reserve || !profile) return deny('reserve ' + symbol);
      if (!input || typeof input !== 'object' || Array.isArray(input)) return deny(symbol);
      const p = input as Record<string, unknown>, d = profile.decimals;
      for (const key of Object.keys(p)) if (!RESERVE_FIELDS.has(key)) deny(`${symbol}.${key}`);
      if (p.listed !== undefined) reserve.listed = flag(p.listed, 'listed');
      if (p.active !== undefined) reserve.active = flag(p.active, 'active');
      if (p.frozen !== undefined) reserve.frozen = flag(p.frozen, 'frozen');
      if (p.paused !== undefined) reserve.paused = flag(p.paused, 'paused');
      if (p.borrowingEnabled !== undefined) reserve.borrowingEnabled = flag(p.borrowingEnabled, 'borrowingEnabled');
      if (p.collateral !== undefined) reserve.collateral = flag(p.collateral, 'collateral');
      if (p.supplyCap !== undefined) reserve.supplyCap = cap(p.supplyCap, 'supplyCap');
      if (p.borrowCap !== undefined) reserve.borrowCap = cap(p.borrowCap, 'borrowCap');
      if (p.priceUsd !== undefined) reserve.price = units(p.priceUsd, 8, 'priceUsd');
      if (p.liquidity !== undefined) reserve.liquidity = units(p.liquidity, d, 'liquidity');
      if (p.walletBalance !== undefined) reserve.walletBalance = units(p.walletBalance, d, 'walletBalance');
      if (p.supplied !== undefined) reserve.accountSupplied = units(p.supplied, d, 'supplied');
      if (p.debt !== undefined) reserve.accountDebt = units(p.debt, d, 'debt');
    }
  }
  if (body.account !== undefined) {
    if (!body.account || typeof body.account !== 'object' || Array.isArray(body.account)) deny('account');
    const account = body.account as Record<string, unknown>;
    for (const key of Object.keys(account)) if (key !== 'eMode') deny('account.' + key);
    if ('eMode' in account) next.eMode = account.eMode === null ? null : typeof account.eMode === 'number' && Number.isInteger(account.eMode) &&
      account.eMode >= 0 && account.eMode <= 255 ? BigInt(account.eMode) : deny('account.eMode');
  }
  return next;
}
/** The fixture's view of the market state: registered identities, configuration bits, rates and the account positions. */
function fixtureState(state: MarketState): AaveFixtureState {
  const market = new Map<string, AaveFixtureReserve>(), positions = new Map<string, AaveFixturePosition>();
  for (const profile of reserves) {
    const r = state.reserves.get(profile.symbol)!;
    market.set(profile.asset, { listed: r.listed, price: r.price, liquidity: r.liquidity, scaledSupply: r.supplied, debt: r.borrowed,
      liquidityRate: r.supplyAprBps * RAY / 10_000n, variableBorrowRate: r.borrowAprBps * RAY / 10_000n,
      config: aaveReserveConfig({ ltvBps: r.ltvBps, liquidationThresholdBps: r.liquidationThresholdBps, liquidationBonusBps: r.liquidationThresholdBps ? 10_500 : 0,
        decimals: profile.decimals, active: r.active, frozen: r.frozen, borrowing: r.borrowingEnabled, paused: r.paused, supplyCap: r.supplyCap, borrowCap: r.borrowCap }) });
    positions.set(profile.asset, { wallet: r.walletBalance, supplied: r.accountSupplied, debt: r.accountDebt, collateral: r.collateral });
  }
  return { reserves: market, account: { positions, eMode: state.eMode } };
}

/** The MOCKED Base Aave market over a chain's read client: `rpc` answers the market's reads and Multicall3, and passes the rest to `chain`. */
export function createBaseAaveMarket() {
  let state = defaults(), view = fixtureState(state), reads = 0;
  const fixture = createAaveMarketFixture(BASE_AAVE_CHAIN, () => view);
  const revert = (message = 'execution reverted') => new Error(message);
  const lower = (value: unknown) => typeof value === 'string' ? value.toLowerCase() : '';
  function summary() {
    return { chain: BASE_AAVE_CHAIN, provenance: 'MOCKED', reads, eMode: state.eMode === null ? null : Number(state.eMode),
      reserves: reserves.map(profile => {
        const r = state.reserves.get(profile.symbol)!, d = profile.decimals;
        return { symbol: profile.symbol, asset: profile.asset, listed: r.listed, active: r.active, frozen: r.frozen, paused: r.paused, borrowingEnabled: r.borrowingEnabled,
          priceUsd: format(r.price, 8), supplyCap: r.supplyCap.toString(), borrowCap: r.borrowCap.toString(), liquidity: format(r.liquidity, d),
          walletBalance: format(r.walletBalance, d), supplied: format(r.accountSupplied, d), debt: format(r.accountDebt, d), collateral: r.collateral };
      }) };
  }
  /** One call as this chain's node answers it outside an Aave batch: the market's own contracts here, Multicall3's ETH balance, else the chain. */
  async function single(chain: Rpc, to: string, data: string, tag: unknown): Promise<string> {
    if (to === MULTICALL3_ADDRESS && data.startsWith(MULTICALL3_SELECTORS.getEthBalance) && data.length === 74)
      return '0x' + abiWord(BigInt(String(await chain('eth_getBalance', ['0x' + data.slice(34), tag]))));
    const aave = fixture.answer(to, data, { wallet: false });
    if (aave === null) throw revert();
    if (aave !== undefined) return aave;
    return String(await chain('eth_call', [{ to, data }, tag]));
  }
  async function rpc(method: string, params: readonly unknown[], chain: Rpc): Promise<unknown> {
    if (method === 'eth_getCode' && lower(params[0]) === MULTICALL3_ADDRESS) return MOCK_MULTICALL3_CODE;
    if (method !== 'eth_call') return chain(method, params);
    const request = params[0] as { to?: unknown; data?: unknown } | undefined, to = lower(request?.to), data = lower(request?.data), tag = params[1];
    if (to !== MULTICALL3_ADDRESS && !fixture.targets.has(to) && fixture.answer(to, data, { wallet: false }) === undefined) return chain(method, params);
    if (to !== MULTICALL3_ADDRESS || !data.startsWith(MULTICALL3_SELECTORS.aggregate3)) return single(chain, to, data, tag);
    let calls: ReturnType<typeof decodeAggregate3Calls>;
    try { calls = decodeAggregate3Calls(data); } catch { throw revert(); }
    // An Aave read batch sees the MOCKED account's wallet balances; any other batch reads the chain's own ledger.
    const aaveBatch = calls.some(call => fixture.targets.has(call.target));
    if (aaveBatch) reads += 1;
    const results = await Promise.all(calls.map(async call => {
      const aave = aaveBatch ? fixture.answer(call.target, call.data) : undefined;
      if (aave !== undefined) return aave;
      try { return await single(chain, call.target, call.data, tag); } catch { return null; }
    }));
    if (calls.some((call, i) => !call.allowFailure && results[i] === null)) throw revert('execution reverted: Multicall3: call failed');
    return encodeAggregate3Results(results);
  }
  return {
    rpc, summary,
    /** Restores the default MOCKED market and account (the chain's reset calls it). */
    reset() { state = defaults(); view = fixtureState(state); reads = 0; },
    /** Applies one control patch (see the header) atomically and returns the summary. */
    control(body: unknown) { const next = patched(state, body); state = next; view = fixtureState(next); return summary(); },
  };
}
export type BaseAaveMarket = ReturnType<typeof createBaseAaveMarket>;
