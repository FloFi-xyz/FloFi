// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (ADR-0010 §5): 0x Gasless API v2 answers, parsed strictly from the official OpenAPI schemas
 * (`/gasless/quote`, `/gasless/submit`, `/gasless/status/{tradeHash}`, `/gasless/chains`), and the pre-sign checklist that turns a quote into
 * the binding the owner reviews. Nothing 0x says is trusted on its word: both EIP-712 digests are recomputed and must equal 0x's `hash`; the
 * Permit2 domain, the permitted token and amount, the spender (the genuine MetaTxn Settler read from 0x's on-chain registry), the deadline,
 * the slippage struct (recipient = the owner, buy token, a minimum at least FloFi's slippage minimum), the first action and the fees are all
 * checked against what FloFi asked for. A zero or absent gas fee is refused: FloFi never lets the owner's swap be sponsored by anyone.
 *
 * Closed codes are shaped for `domain/build-estimate.ts` (`ZEROX_NO_LIQUIDITY` → liquidity, `ZEROX_PROVIDER_HTTP_*` → unavailable,
 * `ZEROX_SELL_AMOUNT_TOO_LOW` → below the minimum, `ZEROX_QUOTE_EXPIRED`, `*_MISMATCH`, `ZEROX_INSUFFICIENT_BALANCE`, …).
 */
import { eip712, erc7710 } from '@defi-workflow-engine/reference-compiler';
import type { Rpc } from '../public-testnet-service.ts';

/** Uniswap's canonical Permit2 — the only allowance spender 0x Gasless uses (never the Settler). */
export const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';
/** 0x's Settler deployer/registry (an ERC-721 whose token 3 is the current MetaTxn Settler); the Settler itself is never hard-coded. */
export const SETTLER_REGISTRY = '0x00000000000004533fe15556b1e086bb1a72ceae';
export const METATXN_FEATURE = 3n;
export const NATIVE_TOKEN = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
export const OWNER_OF_SELECTOR = erc7710.selectorOf('ownerOf(uint256)');
export const PREV_SELECTOR = erc7710.selectorOf('prev(uint128)');
/** Permit2 `PermitTransferFrom` as the ABI encodes it: `((address token, uint256 amount) permitted, uint256 nonce, uint256 deadline)`, four static words. */
const PERMIT_TRANSFER_FROM = '((address,uint256),uint256,uint256)';
/** Settler `METATXN_TRANSFER_FROM(address recipient, PermitTransferFrom permit)`. */
export const METATXN_TRANSFER_FROM_SELECTOR = erc7710.selectorOf(`METATXN_TRANSFER_FROM(address,${PERMIT_TRANSFER_FROM})`);
/**
 * The witness-aware actions SettlerMetaTxn accepts as the FIRST action (0x-settler `ISettlerActions.sol`, every `METATXN_*` declaration, canonical
 * signatures): selector → signature. Each one is a VIP action that "should always start with `recipient` address and the `permit` from the taker"
 * — its first five words are the recipient and the four static words of the taker's Permit2 permit, which FloFi binds to the signed permit.
 * Which of them a given Settler dispatches is the Settler's business (an action it does not dispatch reverts the trade before anything moves).
 */
export const METATXN_FIRST_ACTIONS: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries([
  `METATXN_TRANSFER_FROM(address,${PERMIT_TRANSFER_FROM})`,
  `METATXN_RFQ_VIP(address,${PERMIT_TRANSFER_FROM},${PERMIT_TRANSFER_FROM},address,bytes)`,
  `METATXN_UNISWAPV4_VIP(address,${PERMIT_TRANSFER_FROM},uint8,bool,uint256,uint256,bytes,uint256)`,
  `METATXN_BALANCERV3_VIP(address,${PERMIT_TRANSFER_FROM},bool,uint256,uint256,bytes,uint256)`,
  `METATXN_PANCAKE_INFINITY_VIP(address,${PERMIT_TRANSFER_FROM},uint8,bool,uint256,uint256,bytes,uint256)`,
  `METATXN_UNISWAPV3_VIP(address,${PERMIT_TRANSFER_FROM},bytes,uint256)`,
  `METATXN_CURVE_TRICRYPTO_VIP(address,${PERMIT_TRANSFER_FROM},uint80,uint256)`,
  `METATXN_EKUBOV3_VIP(address,${PERMIT_TRANSFER_FROM},bool,uint256,uint256,bytes,uint256)`,
].map(signature => [erc7710.selectorOf(signature), signature])));
/** SettlerMetaTxn `executeMetaTxn((address,address,uint256) slippage, bytes[] actions, bytes32 zid, address msgSender, bytes sig)`. */
export const EXECUTE_METATXN_SELECTOR = erc7710.selectorOf('executeMetaTxn((address,address,uint256),bytes[],bytes32,address,bytes)');
const MAX_UINT256 = (1n << 256n) - 1n;

export type TypedData = eip712.TypedData;
export type ZeroExFee = { readonly token: string; readonly amount: string };
export type GaslessQuoteRequest = { readonly chainId: number; readonly taker: string; readonly sellToken: string; readonly buyToken: string;
  readonly sellAmount: string; readonly slippageBps: number };
export type ParsedApproval = { readonly type: string; readonly hash: string; readonly eip712: TypedData };
export type ParsedQuote = { readonly liquidityAvailable: false; readonly zid: string } | { readonly liquidityAvailable: true; readonly zid: string;
  readonly allowanceTarget: string | null; readonly approval: ParsedApproval | null; readonly blockNumber: string; readonly buyAmount: string;
  readonly buyToken: string; readonly sellAmount: string; readonly sellToken: string; readonly minBuyAmount: string; readonly target: string;
  readonly fees: { readonly integratorFee: ZeroExFee | null; readonly integratorFees: readonly ZeroExFee[] | null; readonly zeroExFee: ZeroExFee | null; readonly gasFee: ZeroExFee | null };
  readonly issues: { readonly allowance: { readonly actual: string; readonly spender: string } | null;
    readonly balance: { readonly token: string; readonly actual: string; readonly expected: string } | null;
    readonly simulationIncomplete: boolean; readonly invalidSourcesPassed: readonly string[] };
  readonly route: { readonly fills: readonly { readonly from: string; readonly to: string; readonly source: string; readonly proportionBps: string }[];
    readonly tokens: readonly { readonly address: string; readonly symbol: string }[] };
  readonly taxes: readonly (string | null)[];
  readonly trade: { readonly type: string; readonly hash: string; readonly eip712: TypedData } };
/**
 * What the owner reviews and signs for a gasless swap, bound into the reviewed manifest. `sellAmount` is the owner's whole debit (the Permit2
 * permitted amount); `buyAmount`/`minBuyAmount` are net of every fee (0x takes its gas fee and its own fee out of the trade).
 */
export type ZeroExGaslessBinding = { readonly provider: '0x-gasless-v2'; readonly zid: string; readonly rawHash: string; readonly quotedAt: string;
  readonly chainId: number; readonly taker: string; readonly sellToken: string; readonly buyToken: string; readonly sellAmount: string;
  readonly buyAmount: string; readonly minBuyAmount: string; readonly slippageBps: number;
  /** The genuine MetaTxn Settler the trade is signed for (the registry's `ownerOf(3)`, or `prev(3)` during 0x's dwell period). */
  readonly settler: string; readonly settlerSource: 'ownerOf' | 'prev'; readonly permit2: string;
  readonly trade: { readonly hash: string; readonly eip712: TypedData; readonly nonce: string; readonly deadline: number };
  /** A gasless EIP-2612 approval of Permit2 (never the Settler), or null when the owner's Permit2 allowance already covers the sell amount. */
  readonly approval: { readonly type: 'permit' | 'erc7597Permit'; readonly hash: string; readonly eip712: TypedData; readonly value: string;
    readonly unlimited: boolean; readonly nonce: string; readonly deadline: number } | null;
  readonly gasFee: ZeroExFee; readonly zeroExFee: ZeroExFee | null;
  /** 0x's route sources (shown under Technical details), and 0x's informational submission target. */
  readonly sources: readonly string[]; readonly target: string };

const fail = (code: string): never => { throw new Error(code); };
const ADDRESS = /^0x[0-9a-fA-F]{40}$/, HASH = /^0x[0-9a-fA-F]{64}$/, UNITS = /^(0|[1-9][0-9]{0,77})$/;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const rec = (value: unknown): Record<string, unknown> => isRecord(value) ? value : fail('ZEROX_PROVIDER_RESPONSE_INVALID');
const addr = (value: unknown): string => typeof value === 'string' && ADDRESS.test(value) ? value.toLowerCase() : fail('ZEROX_PROVIDER_RESPONSE_INVALID');
const units = (value: unknown): string => typeof value === 'string' && UNITS.test(value) ? value : fail('ZEROX_PROVIDER_RESPONSE_INVALID');
const text = (value: unknown, max = 200): string => typeof value === 'string' && value.length >= 1 && value.length <= max ? value : fail('ZEROX_PROVIDER_RESPONSE_INVALID');
const zid = (value: unknown): string => typeof value === 'string' && /^[0-9A-Za-z_-]{1,80}$/.test(value) ? value : fail('ZEROX_PROVIDER_RESPONSE_INVALID');
const nullable = <T,>(value: unknown, parse: (v: unknown) => T): T | null => value === null || value === undefined ? null : parse(value);
const fee = (value: unknown): ZeroExFee => { const r = rec(value); return { token: addr(r.token), amount: units(r.amount) }; };
/** EIP-712 payload shape (types/domain/message/primaryType); its values are checked by the hasher and the checklist, not here. */
function typedData(value: unknown): TypedData {
  const r = rec(value);
  if (!isRecord(r.types) || !isRecord(r.domain) || !isRecord(r.message) || typeof r.primaryType !== 'string' || JSON.stringify(r).length > 64_000)
    fail('ZEROX_PROVIDER_RESPONSE_INVALID');
  return { types: r.types as eip712.TypedDataTypes, domain: r.domain as Record<string, unknown>, message: r.message as Record<string, unknown>, primaryType: r.primaryType as string };
}

/** `/gasless/quote` 200, strictly: the `liquidityAvailable: false` variant carries only `zid`. */
export function parseGaslessQuote(body: unknown): ParsedQuote {
  const r = rec(body);
  if (r.liquidityAvailable === false) return { liquidityAvailable: false, zid: zid(r.zid) };
  if (r.liquidityAvailable !== true) fail('ZEROX_PROVIDER_RESPONSE_INVALID');
  const fees = rec(r.fees), issues = rec(r.issues), route = rec(r.route), trade = rec(r.trade), metadata = rec(r.tokenMetadata);
  const approval = nullable(r.approval, v => { const a = rec(v); return { type: text(a.type, 64), hash: typeof a.hash === 'string' && HASH.test(a.hash) ? a.hash.toLowerCase() : fail('ZEROX_PROVIDER_RESPONSE_INVALID'), eip712: typedData(a.eip712) }; });
  if (!Array.isArray(route.fills) || !Array.isArray(route.tokens) || route.fills.length > 32 || route.tokens.length > 32 ||
      !Array.isArray(issues.invalidSourcesPassed) || typeof issues.simulationIncomplete !== 'boolean' ||
      !(fees.integratorFees === null || fees.integratorFees === undefined || Array.isArray(fees.integratorFees))) fail('ZEROX_PROVIDER_RESPONSE_INVALID');
  const tax = (value: unknown): (string | null)[] => { const t = rec(value); return [t.buyTaxBps, t.sellTaxBps, t.transferTaxBps].map(x => nullable(x, units)); };
  return { liquidityAvailable: true, zid: zid(r.zid), allowanceTarget: nullable(r.allowanceTarget, addr), approval, blockNumber: units(r.blockNumber),
    buyAmount: units(r.buyAmount), buyToken: addr(r.buyToken), sellAmount: units(r.sellAmount), sellToken: addr(r.sellToken), minBuyAmount: units(r.minBuyAmount),
    target: addr(r.target),
    fees: { integratorFee: nullable(fees.integratorFee, fee), integratorFees: Array.isArray(fees.integratorFees) ? fees.integratorFees.map(fee) : null,
      zeroExFee: nullable(fees.zeroExFee, fee), gasFee: nullable(fees.gasFee, fee) },
    issues: { allowance: nullable(issues.allowance, v => { const a = rec(v); return { actual: units(a.actual), spender: addr(a.spender) }; }),
      balance: nullable(issues.balance, v => { const b = rec(v); return { token: addr(b.token), actual: units(b.actual), expected: units(b.expected) }; }),
      simulationIncomplete: issues.simulationIncomplete as boolean, invalidSourcesPassed: (issues.invalidSourcesPassed as unknown[]).map(s => text(s, 80)) },
    route: { fills: (route.fills as unknown[]).map(v => { const f = rec(v); return { from: addr(f.from), to: addr(f.to), source: text(f.source, 80), proportionBps: units(f.proportionBps) }; }),
      tokens: (route.tokens as unknown[]).map(v => { const t = rec(v); return { address: addr(t.address), symbol: text(t.symbol, 40) }; }) },
    taxes: [...tax(metadata.buyToken), ...tax(metadata.sellToken)],
    trade: { type: text(trade.type, 64), hash: typeof trade.hash === 'string' && HASH.test(trade.hash) ? trade.hash.toLowerCase() : fail('ZEROX_PROVIDER_RESPONSE_INVALID'), eip712: typedData(trade.eip712) } };
}
/** `/gasless/chains` 200: `{ chains: [{ chainId, chainName }], zid }` (the published example's string ids are tolerated as integers). */
export function parseGaslessChains(body: unknown): readonly number[] {
  const r = rec(body);
  if (!Array.isArray(r.chains) || r.chains.length > 256) fail('ZEROX_PROVIDER_RESPONSE_INVALID');
  return (r.chains as unknown[]).map(v => { const c = rec(v); text(c.chainName, 80);
    const id = typeof c.chainId === 'number' ? c.chainId : typeof c.chainId === 'string' && /^[1-9][0-9]{0,15}$/.test(c.chainId) ? Number(c.chainId) : NaN;
    return Number.isSafeInteger(id) && id > 0 ? id : fail('ZEROX_PROVIDER_RESPONSE_INVALID'); });
}
export type GaslessStatus = { readonly status: 'pending' | 'submitted' | 'succeeded' | 'confirmed' | 'failed'; readonly reason: string | null;
  readonly transactions: readonly string[]; readonly approvalTransactions: readonly string[]; readonly zid: string };
const STATUS_REASONS = ['transaction_simulation_failed', 'order_expired', 'last_look_declined', 'transaction_reverted', 'market_maker_sigature_error',
  'insufficient_allowance', 'insufficient_balance', 'internal_error'];
/** `/gasless/status/{tradeHash}` 200. An unknown status or reason is malformed (never read as success). */
export function parseGaslessStatus(body: unknown): GaslessStatus {
  const r = rec(body);
  if (!['pending', 'submitted', 'succeeded', 'confirmed', 'failed'].includes(String(r.status))) fail('ZEROX_PROVIDER_RESPONSE_INVALID');
  const hashes = (value: unknown) => value === undefined ? [] : Array.isArray(value) && value.length <= 16 ? value.map(v => { const t = rec(v);
    if (typeof t.hash !== 'string' || !HASH.test(t.hash) || typeof t.timestamp !== 'number' || t.timestamp < 0) fail('ZEROX_PROVIDER_RESPONSE_INVALID');
    return (t.hash as string).toLowerCase(); }) : fail('ZEROX_PROVIDER_RESPONSE_INVALID');
  const failed = r.status === 'failed';
  if (failed !== (r.reason !== undefined) || failed && !STATUS_REASONS.includes(String(r.reason))) fail('ZEROX_PROVIDER_RESPONSE_INVALID');
  return { status: r.status as GaslessStatus['status'], reason: failed ? String(r.reason) : null, transactions: hashes(r.transactions),
    approvalTransactions: hashes(r.approvalTransactions), zid: zid(r.zid) };
}
/** 0x's closed error names → FloFi's closed `ZEROX_*` codes. An unknown or malformed envelope keeps only the HTTP status. */
const ERROR_CODES: Readonly<Record<string, string>> = Object.freeze({
  INPUT_INVALID: 'ZEROX_REQUEST_INVALID', INSUFFICIENT_BALANCE: 'ZEROX_INSUFFICIENT_BALANCE', INSUFFICIENT_BALANCE_OR_ALLOWANCE: 'ZEROX_INSUFFICIENT_BALANCE',
  RECIPIENT_NOT_SUPPORTED: 'ZEROX_RECIPIENT_NOT_SUPPORTED', SMART_WALLET_NOT_SUPPORTED: 'ZEROX_SMART_WALLET_NOT_SUPPORTED',
  UNABLE_TO_CALCULATE_GAS_FEE: 'ZEROX_GAS_FEE_UNAVAILABLE', SELL_AMOUNT_TOO_SMALL: 'ZEROX_SELL_AMOUNT_TOO_LOW', SWAP_VALIDATION_FAILED: 'ZEROX_SWAP_VALIDATION_FAILED',
  TOKEN_NOT_SUPPORTED: 'ZEROX_TOKEN_NOT_SUPPORTED', USER_NOT_AUTHORIZED: 'ZEROX_TAKER_NOT_AUTHORIZED', TOKEN_PAIR_NOT_SUPPORTED: 'ZEROX_PAIR_NO_ROUTE',
  TAKER_NOT_AUTHORIZED_FOR_TRADE: 'ZEROX_TAKER_NOT_AUTHORIZED', RECIPIENT_NOT_AUTHORIZED_FOR_TRADE: 'ZEROX_TAKER_NOT_AUTHORIZED',
  XSTOCKS_NOT_AUTHORIZED: 'ZEROX_STOCK_TOKEN_NOT_AUTHORIZED', BUY_TOKEN_NOT_AUTHORIZED_FOR_TRADE: 'ZEROX_TOKEN_NOT_AUTHORIZED',
  SELL_TOKEN_NOT_AUTHORIZED_FOR_TRADE: 'ZEROX_TOKEN_NOT_AUTHORIZED', INVALID_APPROVAL: 'ZEROX_APPROVAL_REFUSED', INVALID_SIGNATURE: 'ZEROX_SIGNATURE_REFUSED',
  INVALID_SIGNER: 'ZEROX_SIGNATURE_REFUSED', META_TRANSACTION_EXPIRY_TOO_SOON: 'ZEROX_QUOTE_EXPIRED', META_TRANSACTION_INVALID: 'ZEROX_TRADE_REFUSED',
  PENDING_TRADES_ALREADY_EXIST: 'ZEROX_PENDING_TRADE_EXISTS', TRADE_ALREADY_SUBMITTED: 'ZEROX_TRADE_ALREADY_SUBMITTED',
  META_TRANSACTION_STATUS_NOT_FOUND: 'ZEROX_STATUS_NOT_FOUND',
});
export function zeroExErrorCode(status: number, body: unknown): string {
  const name = isRecord(body) && typeof body.name === 'string' && isRecord(body.data) ? body.name : null;
  return name && Object.hasOwn(ERROR_CODES, name) ? ERROR_CODES[name]! : `ZEROX_PROVIDER_HTTP_${status}`;
}

/**
 * Whether a read failed because the CALL reverted (an answer about the call), never because the node did not answer. FloFi's production read
 * client (`public-testnet-rpc.ts`) never passes the node's text on: it throws `PUBLIC_RPC_RESPONSE_INVALID` marked `rpcReverted: true` (JSON-RPC
 * code 3, or revert text under any code). A raw client's "execution reverted" message is the same answer. Anything else (an outage, a missing
 * history, a malformed answer) is not a revert and is thrown on.
 */
export const callReverted = (cause: unknown): boolean => cause instanceof Error &&
  ((cause as Error & { readonly rpcReverted?: unknown }).rpcReverted === true || /revert/i.test(cause.message));
/** The genuine MetaTxn Settler(s), read from 0x's registry on FloFi's own read client at `block`. A revert of `ownerOf(3)` means paused. */
export async function readGenuineSettlers(rpc: Rpc, block: string): Promise<{ readonly current: string; readonly previous: string | null }> {
  const code = await rpc('eth_getCode', [SETTLER_REGISTRY, block]);
  if (typeof code !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(code)) fail('ZEROX_SETTLER_UNVERIFIED');
  const feature = METATXN_FEATURE.toString(16).padStart(64, '0');
  const read = async (selector: string): Promise<string | null> => {
    let answer: unknown;
    try { answer = await rpc('eth_call', [{ to: SETTLER_REGISTRY, data: selector + feature }, block]); }
    // `ownerOf(3)` reverts while the MetaTxn feature is paused; `prev(3)` reverts when there is no previous Settler (outside a dwell period).
    catch (cause) { if (callReverted(cause)) return null; throw cause; }
    if (typeof answer !== 'string' || !/^0x0{24}[0-9a-fA-F]{40}$/.test(answer)) return fail('ZEROX_SETTLER_UNVERIFIED');
    const settler = '0x' + answer.slice(-40).toLowerCase();
    return /^0x0{40}$/.test(settler) ? null : settler;
  };
  const current = await read(OWNER_OF_SELECTOR);
  if (!current) fail('ZEROX_SETTLER_PAUSED');
  const previous = await read(PREV_SELECTOR);
  const settlerCode = await rpc('eth_getCode', [current, block]);
  if (typeof settlerCode !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(settlerCode)) fail('ZEROX_SETTLER_UNVERIFIED');
  return { current: current!, previous: previous && previous !== current ? previous : null };
}

const TRADE_TYPES: Readonly<Record<string, readonly eip712.TypedDataField[]>> = Object.freeze({
  PermitWitnessTransferFrom: [{ name: 'permitted', type: 'TokenPermissions' }, { name: 'spender', type: 'address' }, { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' }, { name: 'slippageAndActions', type: 'SlippageAndActions' }],
  TokenPermissions: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }],
  SlippageAndActions: [{ name: 'recipient', type: 'address' }, { name: 'buyToken', type: 'address' }, { name: 'minAmountOut', type: 'uint256' }, { name: 'actions', type: 'bytes[]' }],
});
const PERMIT_FIELDS: readonly eip712.TypedDataField[] = Object.freeze([{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' },
  { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }]);
const sameFields = (a: unknown, b: readonly eip712.TypedDataField[]) => Array.isArray(a) && a.length === b.length &&
  a.every((f, i) => isRecord(f) && Object.keys(f).length === 2 && f.name === b[i]!.name && f.type === b[i]!.type);
/** An integer EIP-712 value as a decimal string (0x sends numbers or strings); anything else is unverifiable. */
const integer = (value: unknown, code: string): bigint => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && UNITS.test(value)) return BigInt(value);
  return fail(code);
};
const lower = (value: unknown, code: string): string => typeof value === 'string' && ADDRESS.test(value) ? value.toLowerCase() : fail(code);

export type GaslessCheckContext = {
  /** The genuine Settlers read from the registry at this quote (current and, during the dwell period, the previous one). */
  readonly settlers: { readonly current: string; readonly previous: string | null };
  readonly nowMs: number;
  /** The trade deadline must leave at least this long for Review and signatures (ms), and be at most this far away (s). */
  readonly minimumLifetimeMs: number; readonly maximumLifetimeSeconds: number;
};
/**
 * The pre-sign checklist (research-0x.md §6.3). Returns the binding the Review shows and the owner signs, or throws the closed reason this
 * quote cannot be used gaslessly. Pure: the Settler answer and the clock are inputs.
 */
export function verifyGaslessQuote(parsed: ParsedQuote, rawHash: string, request: GaslessQuoteRequest, context: GaslessCheckContext): ZeroExGaslessBinding {
  if (!parsed.liquidityAvailable) return fail('ZEROX_NO_LIQUIDITY');
  const q = parsed, sellToken = request.sellToken.toLowerCase(), buyToken = request.buyToken.toLowerCase(), taker = request.taker.toLowerCase();
  if (q.sellToken !== sellToken || q.buyToken !== buyToken || q.sellAmount !== request.sellAmount) fail('ZEROX_QUOTE_MISMATCH');
  // FloFi asked for no integrator fee: any is unexpected. A fee-on-transfer token cannot be reconciled to the exact signed debit.
  if (q.fees.integratorFee || (q.fees.integratorFees?.length ?? 0) > 0 || q.taxes.some(tax => tax !== null && tax !== '0')) fail('ZEROX_TRADE_UNVERIFIABLE');
  // FloFi is never the sponsor: the owner pays a positive gas fee in a token of this swap.
  const gasFee = q.fees.gasFee ?? fail('ZEROX_SPONSORED_QUOTE_REFUSED');
  if (BigInt(gasFee.amount) <= 0n || ![sellToken, buyToken].includes(gasFee.token)) fail('ZEROX_SPONSORED_QUOTE_REFUSED');
  const zeroExFee = q.fees.zeroExFee && BigInt(q.fees.zeroExFee.amount) > 0n ? q.fees.zeroExFee : null;
  if (zeroExFee && ![sellToken, buyToken].includes(zeroExFee.token)) fail('ZEROX_TRADE_UNVERIFIABLE');
  if (q.issues.balance) fail('ZEROX_INSUFFICIENT_BALANCE');
  if (q.issues.simulationIncomplete) fail('ZEROX_SIMULATION_INCOMPLETE');
  if (q.allowanceTarget !== null && q.allowanceTarget !== PERMIT2) fail('ZEROX_TRADE_UNVERIFIABLE');
  if (q.issues.allowance && q.issues.allowance.spender !== PERMIT2) fail('ZEROX_TRADE_UNVERIFIABLE');
  // A missing Permit2 allowance needs 0x's gasless approval: without one the owner would have to send an approval and pay ETH.
  if (q.issues.allowance && !q.approval) fail('ZEROX_GASLESS_APPROVAL_UNAVAILABLE');
  if (!q.issues.allowance && q.approval) fail('ZEROX_TRADE_UNVERIFIABLE');
  // --- the trade (Permit2 PermitWitnessTransferFrom for the MetaTxn Settler) ---
  const trade = q.trade.eip712, domain = trade.domain;
  if (q.trade.type !== 'settler_metatransaction' || trade.primaryType !== 'PermitWitnessTransferFrom' ||
      Object.keys(domain).sort().join() !== 'chainId,name,verifyingContract' || domain.name !== 'Permit2' || Number(domain.chainId) !== request.chainId ||
      (typeof domain.chainId !== 'number' && typeof domain.chainId !== 'string') || lower(domain.verifyingContract, 'ZEROX_TRADE_UNVERIFIABLE') !== PERMIT2 ||
      Object.keys(trade.types).filter(t => t !== 'EIP712Domain').sort().join() !== 'PermitWitnessTransferFrom,SlippageAndActions,TokenPermissions' ||
      Object.entries(TRADE_TYPES).some(([name, fields]) => !sameFields(trade.types[name], fields))) fail('ZEROX_TRADE_UNVERIFIABLE');
  let tradeHash: string;
  try { tradeHash = eip712.hashTypedData(trade); } catch { return fail('ZEROX_TRADE_UNVERIFIABLE'); }
  if (tradeHash !== q.trade.hash) fail('ZEROX_TRADE_HASH_MISMATCH');
  const message = trade.message as Record<string, unknown>, permitted = rec(message.permitted), witness = rec(message.slippageAndActions);
  if (lower(permitted.token, 'ZEROX_TRADE_UNVERIFIABLE') !== sellToken || integer(permitted.amount, 'ZEROX_TRADE_UNVERIFIABLE').toString() !== request.sellAmount) fail('ZEROX_QUOTE_MISMATCH');
  const spender = lower(message.spender, 'ZEROX_TRADE_UNVERIFIABLE');
  const settlerSource = spender === context.settlers.current ? 'ownerOf' as const : spender === context.settlers.previous ? 'prev' as const : fail('ZEROX_SETTLER_MISMATCH');
  const nonce = integer(message.nonce, 'ZEROX_TRADE_UNVERIFIABLE'), deadline = integer(message.deadline, 'ZEROX_TRADE_UNVERIFIABLE');
  const nowSeconds = BigInt(Math.floor(context.nowMs / 1000));
  if (deadline * 1000n < BigInt(context.nowMs + context.minimumLifetimeMs)) fail('ZEROX_QUOTE_EXPIRED');
  if (deadline > nowSeconds + BigInt(context.maximumLifetimeSeconds)) fail('ZEROX_TRADE_UNVERIFIABLE');
  // The populated slippage struct is the owner's protection: 0x may zero it and move the minimum into the last action, which FloFi does not
  // decode — such a quote is refused rather than trusted.
  const minimum = integer(witness.minAmountOut, 'ZEROX_TRADE_UNVERIFIABLE'), slippageFloor = BigInt(q.buyAmount) * BigInt(10_000 - request.slippageBps) / 10_000n;
  if (lower(witness.recipient, 'ZEROX_TRADE_UNVERIFIABLE') !== taker || lower(witness.buyToken, 'ZEROX_TRADE_UNVERIFIABLE') !== buyToken || minimum <= 0n)
    fail('ZEROX_TRADE_UNVERIFIABLE');
  if (minimum.toString() !== q.minBuyAmount || minimum > BigInt(q.buyAmount)) fail('ZEROX_QUOTE_MISMATCH');
  if (minimum < slippageFloor) fail('ZEROX_MINIMUM_BELOW_SLIPPAGE');
  // actions[0] must be one of the Settler's witness-aware METATXN_* actions (the one that authenticates the rest) whose permit words are exactly
  // the signed permit: METATXN_TRANSFER_FROM, exactly the permit paid to the Settler; a METATXN_*_VIP, the permit right after its recipient (the
  // first hop's output target: the Settler, or the next pool under 0x's custody optimisation). Whatever the route, the owner's protection is the
  // populated slippage struct checked above, which the Settler enforces last (its own balance of the buy token ≥ the minimum, paid to the owner),
  // and the receipt reconciliation. Anything else is refused.
  const actions = witness.actions;
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > 32) return fail('ZEROX_TRADE_UNVERIFIABLE');
  const first = typeof actions[0] === 'string' ? actions[0].toLowerCase() : '';
  const w = (n: bigint) => n.toString(16).padStart(64, '0'), a = (address: string) => address.slice(2).padStart(64, '0');
  const selector = first.slice(0, 10), recipientWord = first.slice(10, 74), permitWords = first.slice(74, 330);
  // Whole ABI words after the selector; the recipient an address word, never zero.
  if (!/^0x[0-9a-f]{8}(?:[0-9a-f]{64}){5,}$/.test(first) || !Object.hasOwn(METATXN_FIRST_ACTIONS, selector) ||
      permitWords !== a(sellToken) + w(BigInt(request.sellAmount)) + w(nonce) + w(deadline) || !/^0{24}[0-9a-f]{40}$/.test(recipientWord) || /^0{64}$/.test(recipientWord))
    fail('ZEROX_TRADE_UNVERIFIABLE');
  if (selector === METATXN_TRANSFER_FROM_SELECTOR ? first.length !== 10 + 5 * 64 || recipientWord !== a(spender) : first.length <= 10 + 5 * 64)
    fail('ZEROX_TRADE_UNVERIFIABLE');
  // --- the optional gasless approval (EIP-2612 permit of Permit2) ---
  let approval: ZeroExGaslessBinding['approval'] = null;
  if (q.approval) {
    if (q.approval.type !== 'permit' && q.approval.type !== 'erc7597Permit') fail('ZEROX_GASLESS_APPROVAL_UNAVAILABLE');
    const data = q.approval.eip712, d = data.domain, m = data.message;
    if (data.primaryType !== 'Permit' || !sameFields(data.types.Permit, PERMIT_FIELDS) || Object.keys(data.types).some(t => t !== 'Permit' && t !== 'EIP712Domain') ||
        lower(d.verifyingContract, 'ZEROX_APPROVAL_MISMATCH') !== sellToken || Number(d.chainId) !== request.chainId || d.salt !== undefined ||
        lower(m.owner, 'ZEROX_APPROVAL_MISMATCH') !== taker || lower(m.spender, 'ZEROX_APPROVAL_MISMATCH') !== PERMIT2) fail('ZEROX_APPROVAL_MISMATCH');
    const value = integer(m.value, 'ZEROX_APPROVAL_MISMATCH'), approvalDeadline = integer(m.deadline, 'ZEROX_APPROVAL_MISMATCH');
    if (value < BigInt(request.sellAmount) || approvalDeadline * 1000n < BigInt(context.nowMs + context.minimumLifetimeMs)) fail('ZEROX_APPROVAL_MISMATCH');
    let approvalHash: string;
    try { approvalHash = eip712.hashTypedData(data); } catch { return fail('ZEROX_APPROVAL_MISMATCH'); }
    if (approvalHash !== q.approval.hash) fail('ZEROX_APPROVAL_HASH_MISMATCH');
    approval = { type: q.approval.type as 'permit' | 'erc7597Permit', hash: approvalHash, eip712: data, value: value.toString(), unlimited: value === MAX_UINT256,
      nonce: integer(m.nonce, 'ZEROX_APPROVAL_MISMATCH').toString(), deadline: Number(approvalDeadline) };
  }
  const sources = [...new Set(q.route.fills.map(fill => fill.source))].slice(0, 16);
  return { provider: '0x-gasless-v2', zid: q.zid, rawHash, quotedAt: new Date(context.nowMs).toISOString(), chainId: request.chainId, taker,
    sellToken, buyToken, sellAmount: request.sellAmount, buyAmount: q.buyAmount, minBuyAmount: q.minBuyAmount, slippageBps: request.slippageBps,
    settler: spender, settlerSource, permit2: PERMIT2, trade: { hash: tradeHash, eip712: trade, nonce: nonce.toString(), deadline: Number(deadline) },
    approval, gasFee, zeroExFee, sources, target: q.target };
}
