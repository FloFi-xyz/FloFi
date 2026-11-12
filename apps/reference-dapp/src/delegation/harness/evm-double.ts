// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-AUTOMATION-002: a MOCKED loopback EVM chain for delegated-execution tests (unit, PostgreSQL and browser). Never a public network.
 *
 * It models exactly what the delegated path touches: ERC-20 balances/allowances of the public swap profile's USDC and WETH, a Uniswap-like
 * router and quoter at a fixed price, EIP-7702 designators of upgraded owner accounts, and the MetaMask Delegation Framework v1.3.0
 * `DelegationManager.redeemDelegations` — signature recovery over the EIP-712 digest, delegate/authority/disabled checks, and the
 * `erc7710` enforcer MODEL (not the bytecode) before and after the call — plus the owner's own `disableDelegation` self-call. A refused
 * redemption mines as a reverted transaction (status 0, no effect but the nonce), like the real manager. Evidence from it is MOCKED.
 *
 * P0 workflow execution: optionally a mainnet swap profile (e.g. Arbitrum One's registered Uniswap v3 router/quoter/USDC/WETH) and a minimal
 * Aave V3 Pool model (supply / variable borrow / variable repay / withdraw / `getUserAccountData`, fixed oracle prices, per-reserve LTV and liquidation threshold, auto
 * collateral on first supply, Aave's borrow capacity rule), plus `eth_simulateV1` (calls applied in order to a copy of the state, then discarded).
 *
 * P0 universal execution: tokens report their real decimals and carry code by default; a test may make one contradict its catalog entry
 * (`setDecimals`), remove its code (`setCode(token, '0x')`) or charge a fee on every transfer of it (`setTransferFeeBps`: the recipient gets
 * less than was sent, while the router still returns the pool's full output, as with a real fee-on-transfer token).
 *
 * P0 hotfix (E1): optionally an Across SpokePool MODEL (not the bytecode) — on an origin chain `deposit(...)` (the bytes32 variant the Router's
 * codec decodes) pulls the input from the caller against its allowance and emits `FundsDeposited` with the next deposit id; on a destination
 * chain `control.acrossFill` plays a relayer's fill (`FilledRelay` + the output transfer to the recipient) and `control.acrossRefund` a refund on
 * the origin; the views the Router reads (chainId, paused flags, buffers) answer; `eth_getLogs` filters every mined log; the `safe` head lags
 * `latest` by a controllable number of blocks.
 */
import { uniswapV3PoolAddress } from '@defi-workflow-engine/action-registry';
import { decodeAcrossDeposit, encodeErc20TransferLog, encodeFilledRelayLog, encodeFundsDepositedLog, erc4337, erc7710,
  ROUTER_SELECTORS as ROUTER_SEL } from '@defi-workflow-engine/reference-compiler';
import { publicSwapProfile, type PublicSwapProfile } from '../../domain/public-testnet-swap.ts';

const D = erc7710, F = D.DELEGATION_FRAMEWORK_V1_3;
const TRANSFER = D.keccakHex('Transfer(address,address,uint256)'), APPROVAL = D.keccakHex('Approval(address,address,uint256)');
const BALANCE_OF = D.selectorOf('balanceOf(address)'), ALLOWANCE = D.selectorOf('allowance(address,address)'), DECIMALS = D.selectorOf('decimals()');
const QUOTE = '0xc6a5026a', GET_USER_ACCOUNT_DATA = D.selectorOf('getUserAccountData(address)'), MULTICALL_DEADLINE = '0x5ae401dc';
/** OP Stack GasPriceOracle predeploy, `getL1FeeUpperBound(uint256)` and the modelled L1 data price (wei per calldata byte). */
const GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000f', L1_FEE_UPPER_BOUND = '0xf1c7a58b', L1_WEI_PER_BYTE = 2_000_000n;
const word = (v: bigint) => '0x' + v.toString(16).padStart(64, '0');
const topic = (a: string) => '0x' + a.slice(2).padStart(64, '0');
const lower = (a: string) => a.toLowerCase();
type Receipt = { status: 0 | 1; logs: { address: string; topics: string[]; data: string }[]; blockNumber: number; from: string; to: string; reason: string | null };
type Tx = { hash: string; from: string; to: string; input: string; nonce: bigint; blockNumber: number };

export class EvmDoubleError extends Error {}
export type EvmDouble = ReturnType<typeof createEvmDouble>;
/** One MOCKED chain (the public swap profile of `chainId`). `clock` returns the block timestamp in seconds. */
/** A swap profile the double can model: the public testnet pairs, or a mainnet profile's router/quoter/USDC/WETH (a synthetic pool holds liquidity). */
export type DoubleSwapProfile = { readonly router: string; readonly quoter: string; readonly usdc: string; readonly weth: string; readonly pool?: string };
/** One Aave V3 reserve of the modelled Pool: identity, oracle price (base currency, 8 decimals) and risk parameters (basis points). */
export type DoubleAaveReserve = { readonly asset: string; readonly aToken: string; readonly variableDebtToken: string; readonly decimals: number;
  readonly price: bigint; readonly ltvBps: bigint; readonly liquidationThresholdBps: bigint };
/** An Across SpokePool model: its address and runtime code (pinned by tests), the token it moves, and this chain's role. */
export type DoubleAcrossSpokePool = { readonly spokePool: string; readonly token: string; readonly code: string; readonly role: 'origin' | 'destination' };
export type EvmDoubleOptions = { readonly profile?: DoubleSwapProfile; readonly aave?: { readonly pool: string; readonly reserves: readonly DoubleAaveReserve[] };
  /** P0 hotfix (E1): an Across SpokePool model on this chain. */ readonly across?: DoubleAcrossSpokePool;
  /** The fee tiers whose canonical pool of the modelled pair exists (default: every tier of a catalog profile). */ readonly deployedTiers?: readonly number[] };
export function createEvmDouble(chainId: number, clock: () => number = () => Math.floor(Date.now() / 1000), options: EvmDoubleOptions = {}) {
  const testnet = publicSwapProfile(chainId);
  const custom = options.profile ? { ...options.profile, router: lower(options.profile.router), quoter: lower(options.profile.quoter), usdc: lower(options.profile.usdc),
    weth: lower(options.profile.weth), pool: lower(options.profile.pool ?? '0x0000000000000000000000000000000000500011') } : null;
  const profile = (custom ?? testnet ?? (() => { throw new EvmDoubleError('PROFILE_REQUIRED'); })()) as PublicSwapProfile;
  const aave = options.aave ? { pool: lower(options.aave.pool), reserves: options.aave.reserves.map(r => ({ ...r, asset: lower(r.asset), aToken: lower(r.aToken),
    variableDebtToken: lower(r.variableDebtToken) })) } : null;
  const reserveOf = (asset: string) => aave?.reserves.find(r => r.asset === lower(asset)) ?? null;
  /** Aave positions per user: supplied (collateral when enabled) and variable debt, by reserve asset. */
  const supplied = new Map<string, bigint>(), debt = new Map<string, bigint>(), collateralOn = new Set<string>();
  const balances = new Map<string, bigint>(), allowances = new Map<string, bigint>(), code = new Map<string, string>(), nonces = new Map<string, bigint>();
  const native = new Map<string, bigint>(), disabled = new Set<string>(), callCounts = new Map<string, bigint>(), usedIds = new Set<string>();
  const receipts = new Map<string, Receipt>(), txs = new Map<string, Tx>();
  const pool = profile.pool, opStack = chainId === 8453;
  const across = options.across ? { ...options.across, spokePool: lower(options.across.spokePool), token: lower(options.across.token) } : null;
  /** Across: the next deposit id, the paused flags, and how many blocks the `safe` head lags `latest`. */
  let nextDepositId = 7n, depositsPaused = false, fillsPaused = false, safeLag = 0;
  /**
   * The canonical Uniswap v3 pools of the modelled pair (CREATE2 from the profile's factory) at the fee tiers the double deploys: a catalog
   * profile's tiers by default, `deployedTiers` to model a pair that has only some of them.
   */
  const catalog = options.profile as (DoubleSwapProfile & { factory?: string; poolInitCodeHash?: string; feeTiers?: readonly { fee: number }[] }) | undefined;
  const canonicalPools = catalog?.factory && catalog.poolInitCodeHash ? (options.deployedTiers ?? catalog.feeTiers?.map(t => t.fee) ?? [])
    .map(fee => lower(uniswapV3PoolAddress(catalog.factory!, catalog.poolInitCodeHash!, profile.usdc, profile.weth, fee))) : [];
  let block = 100, wethPerUsdc = 400_000_000_000_000n, dropNext = false, sends = 0, simulateSupported = true, simulations = 0;
  /** Test overrides: a token's decimals() answer, and a fee-on-transfer token's fee (basis points of each transfer, burned). */
  const decimalsOverride = new Map<string, number>(), transferFeeBps = new Map<string, bigint>();
  const feeOf = (token: string, amount: bigint) => amount * (transferFeeBps.get(lower(token)) ?? 0n) / 10_000n;
  /** What the last executed swap's pool sent (SwapRouter02's return value), whatever a fee-on-transfer token then delivered to the recipient. */
  let routerOut = 0n;
  const ZERO = '0x' + '0'.repeat(40);
  const key = (token: string, owner: string) => `${lower(token)}|${lower(owner)}`;
  const bal = (token: string, owner: string) => balances.get(key(token, owner)) ?? 0n;
  const setBal = (token: string, owner: string, v: bigint) => balances.set(key(token, owner), v);
  const allowanceKey = (token: string, owner: string, spender: string) => `${key(token, owner)}|${lower(spender)}`;
  const quote = (tokenIn: string, amountIn: bigint) => lower(tokenIn) === profile.usdc ? amountIn * wethPerUsdc / 1_000_000n : amountIn * 1_000_000n / wethPerUsdc;
  const fail = (reason: string): never => { throw new EvmDoubleError(reason); };

  /** Executes one call AS `account` (the owner's 7702 account), returning its logs. Throws (revert) on any failure. */
  function execute(account: string, call: erc7710.Call): Receipt['logs'] {
    if (call.value !== 0n) fail('VALUE_UNSUPPORTED');
    const method = call.data.slice(0, 10), target = lower(call.target);
    if (method === D.APPROVE_METHOD && tokens().includes(target)) {
      const [spender, amount] = D.abiDecode(['address', 'uint256'], D.bytesOf('0x' + call.data.slice(10))) as [string, bigint];
      allowances.set(allowanceKey(target, account, spender), amount);
      return [{ address: target, topics: [APPROVAL, topic(account), topic(spender)], data: word(amount) }];
    }
    if (method === D.EXACT_INPUT_SINGLE_METHOD && target === profile.router) {
      const [tokenIn, tokenOut, , recipient, amountIn, minOut] = D.abiDecode(['address', 'address', 'uint256', 'address', 'uint256', 'uint256', 'uint256'],
        D.bytesOf('0x' + call.data.slice(10))) as [string, string, bigint, string, bigint, bigint, bigint];
      const allowance = allowances.get(allowanceKey(tokenIn, account, profile.router)) ?? 0n;
      if (allowance < amountIn) fail('STF');
      if (bal(tokenIn, account) < amountIn) fail('STF');
      const out = quote(tokenIn, amountIn);
      if (out < minOut) fail('Too little received');
      // A v3 pool refuses an input it did not fully receive (a fee-on-transfer input token).
      if (feeOf(tokenIn, amountIn) > 0n) fail('IIA');
      allowances.set(allowanceKey(tokenIn, account, profile.router), allowance - amountIn);
      setBal(tokenIn, account, bal(tokenIn, account) - amountIn); setBal(tokenIn, pool, bal(tokenIn, pool) + amountIn);
      // The router checks and returns the pool's output; a fee-on-transfer output token then delivers less to the recipient.
      const fee = feeOf(tokenOut, out);
      setBal(tokenOut, pool, bal(tokenOut, pool) - out); setBal(tokenOut, recipient, bal(tokenOut, recipient) + out - fee);
      routerOut = out;
      return [{ address: lower(tokenIn), topics: [TRANSFER, topic(account), topic(pool)], data: word(amountIn) },
        ...fee > 0n ? [{ address: lower(tokenOut), topics: [TRANSFER, topic(pool), topic(ZERO)], data: word(fee) }] : [],
        { address: lower(tokenOut), topics: [TRANSFER, topic(pool), topic(recipient)], data: word(out - fee) }];
    }
    // P0 universal execution: SwapRouter02 `multicall(uint256 deadline, bytes[] data)` — refused after the deadline ('Transaction too old'), else
    // each inner call to the router itself, in order (the batched swap's deadline guard).
    if (method === MULTICALL_DEADLINE && target === profile.router) {
      const [deadline, inner] = D.abiDecode(['uint256', { array: 'bytes' }], D.bytesOf('0x' + call.data.slice(10))) as [bigint, string[]];
      if (BigInt(clock()) > deadline) fail('Transaction too old');
      return inner.flatMap(data => execute(account, { target, value: 0n, data }));
    }
    // BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: an owner's ERC-20 transfer (user-funded batches).
    if (method === D.ERC20_TRANSFER_METHOD && tokens().includes(target)) {
      const [to, amount] = D.abiDecode(['address', 'uint256'], D.bytesOf('0x' + call.data.slice(10))) as [string, bigint];
      if (bal(target, account) < amount) fail('ERC20: transfer amount exceeds balance');
      const fee = feeOf(target, amount);
      setBal(target, account, bal(target, account) - amount); setBal(target, lower(to), bal(target, lower(to)) + amount - fee);
      return [...fee > 0n ? [{ address: target, topics: [TRANSFER, topic(account), topic(ZERO)], data: word(fee) }] : [],
        { address: target, topics: [TRANSFER, topic(account), topic(lower(to))], data: word(amount - fee) }];
    }
    // P0 workflow execution: Aave V3 Pool `supply` and variable-rate `borrow` (the owner as onBehalfOf / beneficiary).
    if (aave && target === aave.pool && method === D.AAVE_V3_SUPPLY_METHOD) {
      const [asset, amount, onBehalfOf] = D.abiDecode(['address', 'uint256', 'address', 'uint256'], D.bytesOf('0x' + call.data.slice(10))) as [string, bigint, string, bigint];
      const r = reserveOf(asset) ?? fail('RESERVE_NOT_MODELED');
      const allowance = allowances.get(allowanceKey(r.asset, account, aave.pool)) ?? 0n;
      if (allowance < amount || bal(r.asset, account) < amount) fail('ERC20: transfer amount exceeds allowance');
      allowances.set(allowanceKey(r.asset, account, aave.pool), allowance - amount);
      setBal(r.asset, account, bal(r.asset, account) - amount); setBal(r.asset, r.aToken, bal(r.asset, r.aToken) + amount);
      const k = key(r.asset, onBehalfOf);
      // First supply of a reserve with an LTV enables it as collateral (Aave's automatic use as collateral).
      if ((supplied.get(k) ?? 0n) === 0n && r.ltvBps > 0n) collateralOn.add(k);
      supplied.set(k, (supplied.get(k) ?? 0n) + amount);
      return [{ address: r.asset, topics: [TRANSFER, topic(account), topic(r.aToken)], data: word(amount) },
        { address: r.aToken, topics: [TRANSFER, topic('0x' + '0'.repeat(40)), topic(lower(onBehalfOf))], data: word(amount) }];
    }
    if (aave && target === aave.pool && method === D.AAVE_V3_BORROW_METHOD) {
      const [asset, amount, mode, , onBehalfOf] = D.abiDecode(['address', 'uint256', 'uint256', 'uint256', 'address'], D.bytesOf('0x' + call.data.slice(10))) as [string, bigint, bigint, bigint, string];
      const r = reserveOf(asset) ?? fail('RESERVE_NOT_MODELED');
      if (mode !== 2n || lower(onBehalfOf) !== account) fail('BORROW_NOT_MODELED');
      if (bal(r.asset, r.aToken) < amount) fail('NOT_ENOUGH_AVAILABLE_USER_BALANCE');
      const before = accountData(account), value = (amount * r.price + 10n ** BigInt(r.decimals) - 1n) / 10n ** BigInt(r.decimals);
      // Aave: the new debt must fit the collateral's LTV capacity (COLLATERAL_CANNOT_COVER_NEW_BORROW).
      if (before.collateral === 0n || before.debt + value > before.collateral * before.ltv / 10_000n) fail('COLLATERAL_CANNOT_COVER_NEW_BORROW');
      setBal(r.asset, r.aToken, bal(r.asset, r.aToken) - amount); setBal(r.asset, account, bal(r.asset, account) + amount);
      debt.set(key(r.asset, account), (debt.get(key(r.asset, account)) ?? 0n) + amount);
      return [{ address: r.asset, topics: [TRANSFER, topic(r.aToken), topic(account)], data: word(amount) },
        { address: r.variableDebtToken, topics: [TRANSFER, topic('0x' + '0'.repeat(40)), topic(account)], data: word(amount) }];
    }
    // P0 universal execution: variable-rate `repay` (Aave pulls min(amount, debt) from the payer into the aToken and burns that much debt) and
    // `withdraw` (burns the owner's aTokens, pays the underlying from the aToken; refused above the position or when it would leave the account
    // unable to cover its debt at the liquidation threshold).
    if (aave && target === aave.pool && method === D.AAVE_V3_REPAY_METHOD) {
      const [asset, amount, mode, onBehalfOf] = D.abiDecode(['address', 'uint256', 'uint256', 'address'], D.bytesOf('0x' + call.data.slice(10))) as [string, bigint, bigint, string];
      const r = reserveOf(asset) ?? fail('RESERVE_NOT_MODELED');
      const k = key(r.asset, onBehalfOf), owed = debt.get(k) ?? 0n;
      if (mode !== 2n) fail('REPAY_NOT_MODELED');
      if (owed === 0n) fail('NO_DEBT_OF_SELECTED_TYPE');
      const paid = amount < owed ? amount : owed, allowance = allowances.get(allowanceKey(r.asset, account, aave.pool)) ?? 0n;
      if (allowance < paid || bal(r.asset, account) < paid) fail('ERC20: transfer amount exceeds allowance');
      allowances.set(allowanceKey(r.asset, account, aave.pool), allowance - paid);
      setBal(r.asset, account, bal(r.asset, account) - paid); setBal(r.asset, r.aToken, bal(r.asset, r.aToken) + paid);
      debt.set(k, owed - paid);
      return [{ address: r.variableDebtToken, topics: [TRANSFER, topic(lower(onBehalfOf)), topic('0x' + '0'.repeat(40))], data: word(paid) },
        { address: r.asset, topics: [TRANSFER, topic(account), topic(r.aToken)], data: word(paid) }];
    }
    if (aave && target === aave.pool && method === D.AAVE_V3_WITHDRAW_METHOD) {
      const [asset, amount, to] = D.abiDecode(['address', 'uint256', 'address'], D.bytesOf('0x' + call.data.slice(10))) as [string, bigint, string];
      const r = reserveOf(asset) ?? fail('RESERVE_NOT_MODELED');
      const k = key(r.asset, account), position = supplied.get(k) ?? 0n;
      if (amount === 0n || amount > position) fail('NOT_ENOUGH_AVAILABLE_USER_BALANCE');
      if (bal(r.asset, r.aToken) < amount) fail('NOT_ENOUGH_AVAILABLE_LIQUIDITY');
      supplied.set(k, position - amount);
      // Aave's HEALTH_FACTOR_LOWER_THAN_LIQUIDATION_THRESHOLD: the account must stay at or above 1.0 after the withdrawal.
      if (accountData(account).hf < 10n ** 18n) { supplied.set(k, position); fail('HEALTH_FACTOR_LOWER_THAN_LIQUIDATION_THRESHOLD'); }
      if (position === amount) collateralOn.delete(k);
      setBal(r.asset, r.aToken, bal(r.asset, r.aToken) - amount); setBal(r.asset, lower(to), bal(r.asset, lower(to)) + amount);
      return [{ address: r.aToken, topics: [TRANSFER, topic(account), topic('0x' + '0'.repeat(40))], data: word(amount) },
        { address: r.asset, topics: [TRANSFER, topic(r.aToken), topic(lower(to))], data: word(amount) }];
    }
    // P0 hotfix (E1): Across SpokePool `deposit` (bytes32 variant) on the origin chain: the caller pays the input against its allowance.
    if (across && across.role === 'origin' && target === across.spokePool && method === ROUTER_SEL.acrossDeposit) {
      const d = decodeAcrossDeposit(call.data);
      if (depositsPaused) fail('DepositsArePaused');
      if (lower(d.inputToken) !== across.token) fail('InvalidInputToken');
      if (BigInt(d.fillDeadline) <= BigInt(clock()) || BigInt(d.quoteTimestamp) + 3_600n < BigInt(clock())) fail('InvalidQuoteTimestampOrFillDeadline');
      const allowance = allowances.get(allowanceKey(across.token, account, across.spokePool)) ?? 0n;
      if (allowance < d.inputAmount || bal(across.token, account) < d.inputAmount) fail('ERC20: transfer amount exceeds allowance');
      allowances.set(allowanceKey(across.token, account, across.spokePool), allowance - d.inputAmount);
      setBal(across.token, account, bal(across.token, account) - d.inputAmount); setBal(across.token, across.spokePool, bal(across.token, across.spokePool) + d.inputAmount);
      const depositId = nextDepositId++;
      const event = encodeFundsDepositedLog({ spokePool: across.spokePool, destinationChainId: d.destinationChainId, depositId, depositor: d.depositor,
        inputToken: d.inputToken, outputToken: d.outputToken, inputAmount: d.inputAmount, outputAmount: d.outputAmount, quoteTimestamp: d.quoteTimestamp,
        fillDeadline: d.fillDeadline, exclusivityDeadline: 0, recipient: d.recipient, exclusiveRelayer: topic(d.exclusiveRelayer), message: d.message });
      return [{ address: across.token, topics: [TRANSFER, topic(account), topic(across.spokePool)], data: word(d.inputAmount) },
        { address: event.address, topics: [...event.topics], data: event.data }];
    }
    return fail('CALL_NOT_MODELED');
  }
  /** The tokens the double keeps balances for: the swap pair, every modelled Aave reserve and an Across SpokePool's token. */
  function tokens(): string[] { return [profile.usdc, profile.weth, ...aave?.reserves.map(r => r.asset) ?? [], ...across && across.token !== profile.usdc ? [across.token] : []]; }
  /** Aave `getUserAccountData` in the base currency (8 decimals): collateral, debt, weighted LTV and liquidation threshold, health factor (1e18). */
  function accountData(user: string) {
    let collateral = 0n, debtBase = 0n, ltvWeighted = 0n, ltWeighted = 0n;
    for (const r of aave?.reserves ?? []) {
      const k = key(r.asset, user), unit = 10n ** BigInt(r.decimals);
      if (collateralOn.has(k)) { const v = (supplied.get(k) ?? 0n) * r.price / unit; collateral += v; ltvWeighted += v * r.ltvBps; ltWeighted += v * r.liquidationThresholdBps; }
      debtBase += ((debt.get(k) ?? 0n) * r.price + unit - 1n) / unit;
    }
    const ltv = collateral ? ltvWeighted / collateral : 0n, lt = collateral ? ltWeighted / collateral : 0n;
    const hf = debtBase === 0n ? (1n << 256n) - 1n : collateral * lt * 10n ** 18n / (10_000n * debtBase);
    return { collateral, debt: debtBase, ltv, lt, hf, available: collateral * ltv / 10_000n > debtBase ? collateral * ltv / 10_000n - debtBase : 0n };
  }
  /** A call's return data in the double (what `eth_simulateV1` reports): a swap's output, `true` for approvals and transfers, nothing for Aave writes. */
  function returnDataOf(call: erc7710.Call, logs: Receipt['logs']): string {
    const method = call.data.slice(0, 10);
    if (method === D.EXACT_INPUT_SINGLE_METHOD) return word(routerOut);
    // A deadline multicall of one swap returns `bytes[]` holding that swap's output word (a guard with no inner call: zero).
    if (method === MULTICALL_DEADLINE) return '0x' + [32n, 1n, 32n, 32n, logs.length ? routerOut : 0n].map(v => v.toString(16).padStart(64, '0')).join('');
    if (method === D.APPROVE_METHOD || method === D.ERC20_TRANSFER_METHOD) return word(1n);
    return '0x';
  }
  function snapshotState() {
    return { balances: new Map(balances), allowances: new Map(allowances), supplied: new Map(supplied), debt: new Map(debt), collateralOn: new Set(collateralOn),
      depositId: nextDepositId };
  }
  function restoreState(snapshot: ReturnType<typeof snapshotState>) {
    balances.clear(); snapshot.balances.forEach((v, k) => balances.set(k, v)); allowances.clear(); snapshot.allowances.forEach((v, k) => allowances.set(k, v));
    supplied.clear(); snapshot.supplied.forEach((v, k) => supplied.set(k, v)); debt.clear(); snapshot.debt.forEach((v, k) => debt.set(k, v));
    collateralOn.clear(); snapshot.collateralOn.forEach(v => collateralOn.add(v));
    nextDepositId = snapshot.depositId;
  }
  /** `DelegationManager.redeemDelegations` for single-call, depth-1 contexts (what FloFi's executor sends). */
  function redeem(sender: string, data: string): Receipt['logs'] {
    const r = D.decodeRedeemCalldata(data), logs: Receipt['logs'] = [];
    // Snapshot for atomicity: any failure reverts every effect of this transaction.
    const snapshot = { balances: new Map(balances), allowances: new Map(allowances), callCounts: new Map(callCounts), usedIds: new Set(usedIds) };
    try {
      r.contexts.forEach((context, i) => {
        const chain = D.decodePermissionContext(context);
        if (chain.length !== 1) fail('DEPTH_NOT_MODELED');
        const d = chain[0]!, hash = D.delegationHash(d);
        if (lower(d.delegate) !== lower(sender) && lower(d.delegate) !== '0x0000000000000000000000000000000000000a11') fail('InvalidDelegate');
        if (code.get(lower(d.delegator)) !== D.DELEGATOR_DESIGNATOR) fail('DELEGATOR_NOT_UPGRADED');
        let signer: string;
        try { signer = D.recoverDigestSigner(D.delegationDigest(chainId, d), d.signature); } catch { return fail('InvalidERC1271Signature'); }
        if (signer !== lower(d.delegator)) fail('InvalidERC1271Signature');
        if (disabled.has(hash)) fail('CannotUseADisabledDelegation');
        if (d.authority !== D.ROOT_AUTHORITY) fail('InvalidAuthority');
        if (r.modes[i] !== D.MODE_SINGLE_DEFAULT) fail('MODE_NOT_MODELED');
        const call = D.decodeSingleExecution(r.executions[i]!);
        const verdict = D.modelBeforeHooks(d, { redeemer: sender, call, blockTimestamp: BigInt(clock()), delegationHash: hash, callCount: callCounts.get(hash) ?? 0n, usedIds });
        if (!verdict.ok) throw new EvmDoubleError(verdict.code);
        const before = verdict.balanceRules.map(rule => bal(rule.token, rule.recipient));
        if (verdict.countsCall) callCounts.set(hash, (callCounts.get(hash) ?? 0n) + 1n);
        verdict.usedIds.forEach(id => usedIds.add(id));
        logs.push(...execute(lower(d.delegator), call));
        verdict.balanceRules.forEach((rule, k) => { const after = D.modelAfterHook(rule, before[k]!, bal(rule.token, rule.recipient)); if (!after.ok) fail(after.code); });
        logs.push({ address: F.delegationManager, topics: [D.REDEEMED_DELEGATION_TOPIC, topic(lower(d.delegator)), topic(lower(sender))], data: '0x' });
      });
      return logs;
    } catch (cause) {
      balances.clear(); snapshot.balances.forEach((v, k) => balances.set(k, v));
      allowances.clear(); snapshot.allowances.forEach((v, k) => allowances.set(k, v));
      callCounts.clear(); snapshot.callCounts.forEach((v, k) => callCounts.set(k, v));
      usedIds.clear(); snapshot.usedIds.forEach(v => usedIds.add(v));
      throw cause;
    }
  }
  function mine(hash: string, from: string, to: string, input: string, nonce: bigint, run: () => Receipt['logs']): string {
    block += 1;
    let receipt: Receipt;
    try { receipt = { status: 1, logs: run(), blockNumber: block, from, to, reason: null }; }
    catch (cause) { receipt = { status: 0, logs: [], blockNumber: block, from, to, reason: cause instanceof Error ? cause.message : 'REVERT' }; }
    receipts.set(hash, receipt); txs.set(hash, { hash, from, to, input, nonce, blockNumber: block });
    return hash;
  }
  const blockOf = (n: number) => ({ number: '0x' + n.toString(16), hash: word(BigInt(n) + 0xb10c0000n), timestamp: '0x' + clock().toString(16), transactions: [...txs.values()]
    .filter(t => t.blockNumber === n).map(t => t.hash) });
  /** A block tag: latest/pending, the `safe`/`finalized` head (lagging by `safeLag`), or a number. */
  const blockAt = (tag: unknown) => tag === 'latest' || tag === 'pending' ? block : tag === 'safe' || tag === 'finalized' ? Math.max(0, block - safeLag) : Number(BigInt(String(tag)));

  const rpc = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    const p = params as unknown[];
    switch (method) {
      case 'eth_chainId': return '0x' + chainId.toString(16);
      case 'eth_blockNumber': return '0x' + block.toString(16);
      case 'eth_gasPrice': return '0x3b9aca00';
      case 'eth_maxPriorityFeePerGas': return '0x5f5e100';
      case 'eth_estimateGas': return '0x61a80';
      case 'eth_getBlockByNumber': return blockOf(blockAt(p[0]));
      // P0 hotfix (E1): every mined log matching an address, a block range and topic filters (null: any), as a node's `eth_getLogs`.
      case 'eth_getLogs': {
        const f = p[0] as { address?: string; fromBlock?: string; toBlock?: string; topics?: (string | null)[] };
        const from = f.fromBlock === undefined ? 0 : blockAt(f.fromBlock), to = f.toBlock === undefined ? block : blockAt(f.toBlock);
        const out: unknown[] = [];
        for (const [hash, r] of receipts) {
          if (r.status !== 1 || r.blockNumber < from || r.blockNumber > to) continue;
          r.logs.forEach((l, logIndex) => {
            if (f.address && lower(l.address) !== lower(f.address)) return;
            if ((f.topics ?? []).some((t, i) => t !== null && t !== undefined && lower(String(l.topics[i] ?? '')) !== lower(t))) return;
            out.push({ ...l, blockNumber: '0x' + r.blockNumber.toString(16), blockHash: blockOf(r.blockNumber).hash, transactionHash: hash, logIndex: '0x' + logIndex.toString(16), removed: false });
          });
        }
        return out;
      }
      case 'eth_getCode': if (across && lower(String(p[0])) === across.spokePool) return across.code;
        return code.get(lower(String(p[0]))) ?? ([...tokens(), profile.router, profile.quoter, F.delegationManager, ...Object.values(F.enforcers),
        ...aave ? [aave.pool] : [], ...canonicalPools].includes(lower(String(p[0]))) ? '0x6080' : '0x');
      case 'eth_getBalance': return '0x' + (native.get(lower(String(p[0]))) ?? 0n).toString(16);
      case 'eth_getTransactionCount': return '0x' + (nonces.get(lower(String(p[0]))) ?? 0n).toString(16);
      case 'eth_getTransactionReceipt': {
        const r = receipts.get(String(p[0])), t = txs.get(String(p[0]));
        return r && t ? { transactionHash: t.hash, status: r.status ? '0x1' : '0x0', blockNumber: '0x' + r.blockNumber.toString(16), blockHash: blockOf(r.blockNumber).hash,
          from: r.from, to: r.to, gasUsed: '0x30d40', effectiveGasPrice: '0x3b9aca00',
          // OP Stack (Base): the L1 data fee of the transaction's calldata, charged on top of gasUsed × effectiveGasPrice.
          l1Fee: opStack ? '0x' + (BigInt((t.input.length - 2) / 2 + 120) * L1_WEI_PER_BYTE).toString(16) : '0x0', logs: r.logs } : null;
      }
      case 'eth_getTransactionByHash': {
        const t = txs.get(String(p[0]));
        return t ? { hash: t.hash, from: t.from, to: t.to, input: t.input, nonce: '0x' + t.nonce.toString(16), value: '0x0', type: '0x2', chainId: '0x' + chainId.toString(16),
          blockNumber: '0x' + t.blockNumber.toString(16), blockHash: blockOf(t.blockNumber).hash } : null;
      }
      case 'eth_call': {
        const call = p[0] as { to: string; data: string }, to = lower(call.to), selector = call.data.slice(0, 10);
        if (to === F.delegationManager && selector === D.DISABLED_DELEGATIONS_SELECTOR) return word(disabled.has('0x' + call.data.slice(10)) ? 1n : 0n);
        if (tokens().includes(to) && selector === BALANCE_OF) return word(bal(to, '0x' + call.data.slice(34, 74)));
        // An Aave variable-debt token's balance is the account's debt; an aToken's is its supplied position.
        const debtReserve = aave?.reserves.find(r => r.variableDebtToken === to), aReserve = aave?.reserves.find(r => r.aToken === to);
        if (debtReserve && selector === BALANCE_OF) return word(debt.get(key(debtReserve.asset, '0x' + call.data.slice(34, 74))) ?? 0n);
        if (aReserve && selector === BALANCE_OF) return word(supplied.get(key(aReserve.asset, '0x' + call.data.slice(34, 74))) ?? 0n);
        if (tokens().includes(to) && selector === ALLOWANCE) return word(allowances.get(allowanceKey(to, '0x' + call.data.slice(34, 74), '0x' + call.data.slice(98, 138))) ?? 0n);
        if (tokens().includes(to) && selector === DECIMALS) return word(decimalsOverride.has(to) ? BigInt(decimalsOverride.get(to)!)
          : to === profile.usdc ? 6n : reserveOf(to) ? BigInt(reserveOf(to)!.decimals) : 18n);
        if (aave && to === aave.pool && selector === GET_USER_ACCOUNT_DATA) return userAccountDataWords('0x' + call.data.slice(34, 74));
        if (to === profile.quoter && selector === QUOTE) return word(quote('0x' + call.data.slice(34, 74), BigInt('0x' + call.data.slice(138, 202)))) + '0'.repeat(192);
        // OP Stack (Base): the GasPriceOracle's `getL1FeeUpperBound(unsignedTxSize)`, at a fixed modelled price per byte.
        if (opStack && to === GAS_PRICE_ORACLE && selector === L1_FEE_UPPER_BOUND) return word(BigInt('0x' + call.data.slice(10)) * L1_WEI_PER_BYTE);
        // P0 hotfix (E1): the Across SpokePool views the Router reads before quoting.
        if (across && to === across.spokePool) {
          if (selector === ROUTER_SEL.chainId) return word(BigInt(chainId));
          if (selector === ROUTER_SEL.pausedDeposits) return word(depositsPaused ? 1n : 0n);
          if (selector === ROUTER_SEL.pausedFills) return word(fillsPaused ? 1n : 0n);
          if (selector === ROUTER_SEL.depositQuoteTimeBuffer) return word(3_600n);
          if (selector === ROUTER_SEL.fillDeadlineBuffer) return word(21_600n);
        }
        return fail('CALL_NOT_MODELED');
      }
      case 'eth_sendRawTransaction': {
        const signed = D.decodeSignedEip1559(String(p[0]));
        if (signed.tx.chainId !== BigInt(chainId)) fail('WRONG_CHAIN');
        if (txs.has(signed.hash)) return signed.hash; // a re-broadcast of the same bytes is idempotent
        const expected = nonces.get(signed.from) ?? 0n;
        if (signed.tx.nonce < expected) fail('nonce too low');
        if (signed.tx.nonce > expected) fail('nonce too high');
        if (dropNext) { dropNext = false; return signed.hash; } // accepted by the node, then lost: never mined
        sends += 1;
        nonces.set(signed.from, expected + 1n);
        native.set(signed.from, (native.get(signed.from) ?? 0n) - 200_000n * 1_000_000_000n);
        return mine(signed.hash, signed.from, lower(signed.tx.to), signed.tx.data, signed.tx.nonce, () => {
          if (lower(signed.tx.to) !== F.delegationManager || !signed.tx.data.startsWith(D.REDEEM_DELEGATIONS_SELECTOR)) fail('CALL_NOT_MODELED');
          return redeem(signed.from, signed.tx.data);
        });
      }
      case 'eth_simulateV1': {
        if (!simulateSupported) return fail('the method eth_simulateV1 does not exist/is not available');
        const request = p[0] as { blockStateCalls?: { calls?: { from: string; to: string; data: string; value?: string }[] }[] };
        const calls = request.blockStateCalls?.[0]?.calls ?? [];
        const snapshot = snapshotState(), results: unknown[] = [];
        try {
          for (const c of calls) {
            const to = lower(c.to), call: erc7710.Call = { target: to, value: BigInt(c.value ?? '0x0'), data: c.data };
            if (aave && to === aave.pool && c.data.startsWith(GET_USER_ACCOUNT_DATA)) { results.push({ status: '0x1', returnData: userAccountDataWords('0x' + c.data.slice(34, 74)), gasUsed: '0x7530', logs: [] }); continue; }
            // A read-only balanceOf between the simulated calls (what an account holds at that point of the sequence).
            if (tokens().includes(to) && c.data.startsWith(BALANCE_OF)) { results.push({ status: '0x1', returnData: word(bal(to, '0x' + c.data.slice(34, 74))), gasUsed: '0x5dc0', logs: [] }); continue; }
            const before = snapshotState();
            try { const logs = execute(lower(c.from), call); results.push({ status: '0x1', returnData: returnDataOf(call, logs), gasUsed: '0x' + gasOf(call).toString(16), logs }); }
            catch (cause) { restoreState(before); results.push({ status: '0x0', returnData: '0x', gasUsed: '0x5208', logs: [], error: { message: cause instanceof Error ? cause.message : 'REVERT' } }); }
          }
        } finally { restoreState(snapshot); }
        simulations += 1;
        return [{ number: '0x' + (block + 1).toString(16), calls: results }];
      }
      default: return fail('METHOD_NOT_MODELED');
    }
  };
  function userAccountDataWords(user: string): string {
    const d = accountData(lower(user));
    return '0x' + [d.collateral, d.debt, d.available, d.lt, d.ltv, d.hf].map(v => v.toString(16).padStart(64, '0')).join('');
  }
  /** A plausible gas figure per modelled call (the double's simulation only needs it positive and stable). */
  function gasOf(call: erc7710.Call): bigint {
    const m = call.data.slice(0, 10);
    return m === D.APPROVE_METHOD ? 46_000n : m === D.EXACT_INPUT_SINGLE_METHOD || m === MULTICALL_DEADLINE ? 140_000n : m === D.AAVE_V3_SUPPLY_METHOD ? 220_000n : m === D.AAVE_V3_BORROW_METHOD ? 300_000n
      : m === D.AAVE_V3_REPAY_METHOD ? 210_000n : m === D.AAVE_V3_WITHDRAW_METHOD ? 250_000n : 60_000n;
  }
  /** Test and harness controls (never reachable through the product's RPC allowlist). */
  const control = {
    fund(owner: string, token: 'USDC' | 'WETH', amount: bigint) { setBal(token === 'USDC' ? profile.usdc : profile.weth, lower(owner), amount); },
    fundNative(account: string, wei: bigint) { native.set(lower(account), wei); },
    /** The owner's wallet upgraded its EOA to the MetaMask EIP-7702 stateless delegator (FloFi never does this). */
    upgrade(owner: string) { code.set(lower(owner), D.DELEGATOR_DESIGNATOR); },
    downgrade(owner: string) { code.delete(lower(owner)); },
    /** The owner's own `disableDelegation` self-call (sent by the owner's wallet). */
    ownerSend(from: string, to: string, data: string): string {
      const owner = lower(from), n = nonces.get(owner) ?? 0n;
      nonces.set(owner, n + 1n);
      const hash = D.keccakHex(`${owner}:${n}:${data}`);
      return mine(hash, owner, lower(to), data, n, () => {
        if (owner !== lower(to) || code.get(owner) !== D.DELEGATOR_DESIGNATOR) fail('NotEntryPointOrSelf');
        const d = D.decodeDisableDelegationCalldata(data);
        if (lower(d.delegator) !== owner) fail('InvalidDelegator');
        const hash2 = D.delegationHash(d);
        if (disabled.has(hash2)) fail('AlreadyDisabled');
        disabled.add(hash2);
        return [{ address: F.delegationManager, topics: [D.DISABLED_DELEGATION_TOPIC, hash2, topic(owner), topic(lower(d.delegate))], data: '0x' }];
      });
    },
    disableExternally(hash: string) { disabled.add(lower(hash)); },
    /**
     * BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: what an EIP-5792 wallet does with `wallet_sendCalls` (atomic): ONE transaction from the owner's own
     * account to itself executing every call, all or nothing; the owner pays its gas. `from` lets a test forge a batch sent by someone else.
     */
    walletBatch(owner: string, calls: readonly erc7710.Call[], from = owner): string {
      const sender = lower(from), n = nonces.get(sender) ?? 0n;
      nonces.set(sender, n + 1n);
      const hash = D.keccakHex(`batch:${sender}:${n}:${calls.map(c => c.data).join('')}`);
      const snapshot = snapshotState();
      // The transaction a 7702 wallet sends: a self-call `execute(batch)` carrying exactly these calls (reconciliation decodes it).
      return mine(hash, sender, lower(owner), erc4337.batchCallData(calls), n, () => {
        try { return calls.flatMap(c => execute(lower(owner), c)); }
        catch (cause) { restoreState(snapshot); throw cause; }
      });
    },
    setPrice(wethPerUsdcUnits: bigint) { wethPerUsdc = wethPerUsdcUnits; },
    /** A node without `eth_simulateV1` (the product must then refuse to offer a batch that depends on Aave state). */
    disableSimulation() { simulateSupported = false; },
    simulations: () => simulations,
    /** Funds any modelled token (Aave reserves included) to an account. */
    fundToken(owner: string, token: string, amount: bigint) { setBal(lower(token), lower(owner), amount); },
    tokenBalance: (token: string, owner: string) => bal(lower(token), lower(owner)),
    allowance: (token: string, owner: string, spender: string) => allowances.get(allowanceKey(token, owner, spender)) ?? 0n,
    setAllowance(token: string, owner: string, spender: string, amount: bigint) { allowances.set(allowanceKey(token, owner, spender), amount); },
    /** A modelled token whose decimals() answers `decimals` (a catalog entry the chain contradicts). */
    setDecimals(token: string, decimals: number) { decimalsOverride.set(lower(token), decimals); },
    /** Replaces an account's code (`'0x'`: a token address without code). */
    setCode(account: string, bytecode: string) { code.set(lower(account), bytecode); },
    /** A fee-on-transfer token: each transfer of it delivers `bps` basis points less to the recipient (the fee is burned). */
    setTransferFeeBps(token: string, bps: bigint) { transferFeeBps.set(lower(token), bps); },
    accountData: (user: string) => accountData(lower(user)),
    /**
     * P0 hotfix (E1), destination chain: a relayer fills an Across deposit — the output to the recipient and the SpokePool's `FilledRelay`, in one
     * mined transaction. `overrides` forge a fill that disagrees with the deposit (another recipient, amount, ...).
     */
    acrossFill(fill: { readonly originChainId: bigint; readonly depositId: bigint; readonly depositor: string; readonly recipient: string; readonly inputToken: string;
      readonly inputAmount: bigint; readonly outputAmount: bigint; readonly fillDeadline: number; readonly relayer?: string;
      readonly overrides?: { readonly updatedRecipient?: string; readonly updatedOutputAmount?: bigint; readonly transferAmount?: bigint } }): string {
      if (!across || across.role !== 'destination') return fail('ACROSS_NOT_MODELED');
      if (fillsPaused) fail('FillsArePaused');
      const relayer = lower(fill.relayer ?? '0x' + 'e1'.repeat(20)), recipient = lower(fill.overrides?.updatedRecipient ?? fill.recipient);
      const output = fill.overrides?.updatedOutputAmount ?? fill.outputAmount, transfer = fill.overrides?.transferAmount ?? output;
      const n = nonces.get(relayer) ?? 0n;
      nonces.set(relayer, n + 1n);
      const hash = D.keccakHex(`fill:${relayer}:${n}:${fill.depositId}`);
      const event = encodeFilledRelayLog({ spokePool: across.spokePool, originChainId: fill.originChainId, depositId: fill.depositId, relayer: topic(relayer),
        inputToken: lower(fill.inputToken), outputToken: across.token, inputAmount: fill.inputAmount, outputAmount: fill.outputAmount, repaymentChainId: BigInt(chainId),
        fillDeadline: fill.fillDeadline, exclusivityDeadline: 0, exclusiveRelayer: topic(ZERO), depositor: lower(fill.depositor), recipient: lower(fill.recipient),
        messageHash: word(0n), updatedRecipient: recipient, updatedMessageHash: word(0n), updatedOutputAmount: output, fillType: 0 });
      const out = encodeErc20TransferLog(across.token, relayer, recipient, transfer);
      return mine(hash, relayer, across.spokePool, '0x', n, () => {
        setBal(across.token, recipient, bal(across.token, recipient) + transfer);
        return [{ address: out.address, topics: [...out.topics], data: out.data }, { address: event.address, topics: [...event.topics], data: event.data }];
      });
    },
    /** P0 hotfix (E1), origin chain: the SpokePool refunds a deposit's input to its depositor (one mined transaction). */
    acrossRefund(to: string, amount: bigint): string {
      if (!across || across.role !== 'origin') return fail('ACROSS_NOT_MODELED');
      const n = nonces.get(across.spokePool) ?? 0n;
      nonces.set(across.spokePool, n + 1n);
      const hash = D.keccakHex(`refund:${n}:${lower(to)}:${amount}`);
      return mine(hash, across.spokePool, across.spokePool, '0x', n, () => {
        setBal(across.token, across.spokePool, bal(across.token, across.spokePool) - amount); setBal(across.token, lower(to), bal(across.token, lower(to)) + amount);
        return [{ address: across.token, topics: [TRANSFER, topic(across.spokePool), topic(lower(to))], data: word(amount) }];
      });
    },
    /** Mines `n` empty blocks (confirmations). */
    mineBlocks(n: number) { block += n; },
    /** How many blocks the `safe` head lags `latest` (default 0). */
    setSafeLag(lag: number) { safeLag = lag; },
    pauseAcross(deposits: boolean, fills: boolean) { depositsPaused = deposits; fillsPaused = fills; },
    dropNextSubmission() { dropNext = true; },
    balance: (token: 'USDC' | 'WETH', owner: string) => bal(token === 'USDC' ? profile.usdc : profile.weth, lower(owner)),
    callCount: (hash: string) => callCounts.get(lower(hash)) ?? 0n,
    receipt: (hash: string) => receipts.get(hash) ?? null,
    sends: () => sends,
    profile,
  };
  setBal(profile.usdc, pool, 10n ** 15n); setBal(profile.weth, pool, 10n ** 24n);
  for (const r of aave?.reserves ?? []) setBal(r.asset, r.aToken, 10n ** BigInt(r.decimals + 9));
  return { rpc, control };
}
