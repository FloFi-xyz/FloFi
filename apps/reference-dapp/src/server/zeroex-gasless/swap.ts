// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (ADR-0010 §5): the 0x Gasless path of the Robinhood Chain catalog swap (`robinhood-swap`, `rhs-`
 * runs), as pure pieces the shared swap service (`public-testnet-service.ts`) composes. The swap's intent is unchanged (the catalog-swap IR,
 * protocols `['uniswap']`); how its network fee is paid is an execution choice bound into the reviewed manifest:
 *
 *   NATIVE_WALLET_GAS   the existing Uniswap v3 path, the owner's wallet pays ETH — always first, whenever the owner's ETH covers the native
 *                       path's worst case (an unknown coverage is never treated as short);
 *   ZEROX_GASLESS_SWAP  only when ETH is short AND 0x proved eligible for exactly this swap: the owner signs typed data only (a gasless EIP-2612
 *                       approval of Permit2 when needed, then the Permit2 witness trade for 0x's genuine MetaTxn Settler); 0x's relayer sends it
 *                       and takes its gas fee out of the trade, in the swap's own tokens. FloFi never pays and never lets the trade be sponsored.
 *
 * The trade is executed by 0x's Settler with the route 0x chose (its sources are disclosed under Technical details), not by the Uniswap v3
 * pool the native path would use: the authored `uniswap` constraint names the native path; the gasless alternative is chosen per execution
 * and shown before anything is signed (a recorded design choice of this build, see the build report).
 */
import { eip712, erc7710, ownerAccountCode } from '@defi-workflow-engine/reference-compiler';
import type { GasMechanism, GasPayment, MechanismCandidate, MechanismUnavailable, TokenAmount } from '../../gas-abstraction/mechanism.ts';
import type { ZeroExGaslessConfig } from '../../gas-abstraction/config.ts';
import type { PublicReceipt, Rpc } from '../public-testnet-service.ts';
import type { ZeroExGaslessClient, GaslessSignature } from './client.ts';
import { EXECUTE_METATXN_SELECTOR, NATIVE_TOKEN, PERMIT2, readGenuineSettlers, verifyGaslessQuote, type GaslessReference, type TypedData,
  type ZeroExGaslessBinding } from './quote.ts';

export type { ZeroExGaslessBinding } from './quote.ts';
/** The gasless runtime of a catalog network: its configuration (off unless `FLOFI_ZEROX_GASLESS=enabled`) and its 0x client. */
export type GaslessRuntime = { readonly config: ZeroExGaslessConfig; readonly client: ZeroExGaslessClient | null };
/**
 * How the reviewed swap's network fee is paid, decided at Simulate for the owner who will sign and bound into the manifest. `native` is what the
 * policy saw: the owner's ETH and the native path's worst-case fee (null when it could not be estimated, never assumed short).
 */
export type QuoteGas = { readonly owner: string; readonly mechanism: GasMechanism; readonly nativeShort: boolean;
  readonly unavailable: readonly MechanismUnavailable[]; readonly native: { readonly balanceWei: string; readonly worstCaseWei: string | null };
  readonly payment: GasPayment; readonly zeroEx: ZeroExGaslessBinding | null };
export type GaslessAttemptState = 'SIGNING' | 'ABANDONED' | 'REJECTED' | 'SUBMITTING' | 'SUBMITTED' | 'UNKNOWN' | 'REFUSED' | 'PENDING' | 'CONFIRMED' | 'FAILED';
/**
 * One gasless execution attempt. `SIGNING`: the owner's wallet is asked for the reviewed typed data (nothing exists outside the browser yet);
 * `SUBMITTING` is recorded durably BEFORE the one POST to 0x; `SUBMITTED`/`UNKNOWN`/`PENDING` are observed by trade hash only (never submitted
 * again); `CONFIRMED` once the settlement transaction is proven on chain; `FAILED` with 0x's reason (`final` once the signed trade's deadline
 * passed with its Permit2 nonce unused, so it can never execute); `REFUSED` with 0x's definitive refusal. Signatures are never stored.
 */
export type GaslessAttempt = { readonly attemptId: string; readonly executionId: string; readonly state: GaslessAttemptState; readonly createdAt: string;
  readonly account: string; readonly manifestHash: string; readonly tradeHash: string; readonly approvalHash: string | null; readonly deadline: number;
  readonly preBlock: number; readonly nativeBefore: string; readonly inputBefore: string; readonly outputBefore: string;
  readonly signedAt: string | null; readonly submittedAt: string | null; readonly code: string | null;
  /** 0x's last status answer (a hint only) and every settlement transaction it named. */
  readonly hint: { readonly status: string; readonly reason: string | null; readonly checkedAt: string } | null; readonly candidates: readonly string[];
  /** The settlement transaction proven on chain, and its receipt record (gas payer = 0x's relayer). */
  readonly txHash: string | null; readonly receipt: PublicReceipt | null; readonly final: boolean };
export const ACTIVE_GASLESS: readonly GaslessAttemptState[] = Object.freeze(['SUBMITTING', 'SUBMITTED', 'UNKNOWN', 'PENDING']);
/** States in which nothing was (or can ever be) submitted for the attempt. */
export const UNSUBMITTED_GASLESS: readonly GaslessAttemptState[] = Object.freeze(['SIGNING', 'ABANDONED', 'REJECTED', 'REFUSED']);
/** Whether a gasless attempt still needs observation (an in-flight trade, or a failure not yet final). */
export const gaslessNeedsObservation = (attempt: GaslessAttempt | undefined): boolean =>
  !!attempt && (ACTIVE_GASLESS.includes(attempt.state) || attempt.state === 'FAILED' && !attempt.final);

/** The trade must leave at least this long after Simulate for Review and two wallet prompts; a quote whose deadline is closer is re-quoted. */
export const GASLESS_MINIMUM_LIFETIME_MS = 45_000;
/** A trade deadline further away than this is not what 0x documents (~5 minutes): refused as unverifiable. */
export const GASLESS_MAXIMUM_LIFETIME_SECONDS = 1_800;
/** The Review closes this long before the signed trade's deadline (0x refuses a submission whose expiry is too soon). */
export const GASLESS_DEADLINE_MARGIN_MS = 30_000;
/** When an approval is still needed, the swap's own gas cannot be estimated before it: this bound stands in for it in the worst case. */
export const NATIVE_SWAP_GAS_BOUND = 400_000n;

const fail = (code: string): never => { throw new Error(code); };
const quantity = (value: unknown): bigint => typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value) ? BigInt(value) : fail('RPC_RESPONSE_INVALID');
const addressWord = (value: string) => value.toLowerCase().slice(2).padStart(64, '0');
const word = (value: bigint) => value.toString(16).padStart(64, '0');

/** A token amount of one of the swap's two sides, as the Review shows it. */
export function sideAmount(token: string, amount: string, sides: { readonly input: { token: string; symbol: string; decimals: number };
  readonly output: { token: string; symbol: string; decimals: number } }): TokenAmount {
  const side = token === sides.input.token ? sides.input : token === sides.output.token ? sides.output : fail('ZEROX_TRADE_UNVERIFIABLE');
  return { token, symbol: side.symbol, decimals: side.decimals, amount };
}

/** What the native path costs the owner at worst, with the same multiplier the existing `begin` check applies (gas × gas price × 2). */
export async function nativeCoverage(rpc: Rpc, input: { readonly owner: string; readonly block: string; readonly calls: readonly { readonly to: string;
  readonly data: string; readonly value: string; readonly estimate: boolean }[]; readonly nativeSpend: bigint }): Promise<{ readonly balanceWei: bigint;
  readonly worstCaseWei: bigint | null; readonly covers: boolean | null }> {
  const [balanceWei, gasPrice] = await Promise.all([rpc('eth_getBalance', [input.owner, input.block]).then(quantity), rpc('eth_gasPrice', []).then(quantity)]);
  let gas = 0n;
  for (const call of input.calls) {
    if (!call.estimate) { gas += NATIVE_SWAP_GAS_BOUND; continue; }
    try { gas += quantity(await rpc('eth_estimateGas', [{ from: input.owner, to: call.to, data: call.data, value: call.value }])); }
    // A call that cannot be estimated (it would revert, or the node did not answer) leaves the coverage unknown: never treated as short.
    catch { return { balanceWei, worstCaseWei: null, covers: null }; }
  }
  if (gasPrice <= 0n || gas <= 0n) return { balanceWei, worstCaseWei: null, covers: null };
  const worstCaseWei = gas * gasPrice * 2n + input.nativeSpend;
  return { balanceWei, worstCaseWei, covers: balanceWei >= worstCaseWei };
}

/**
 * 0x's eligibility for exactly this swap and owner: the configuration, the swap's kind (selling native ETH, buying native ETH and WETH9
 * conversions are not gasless), a plain EOA owner (0x's EIP-712 signature type 2; a contract or EIP-7702 account would be verified by
 * ERC-1271 on chain, which FloFi has not proven for 0x), the chain in `/gasless/chains`, the genuine Settler, and the verified quote.
 */
export async function gaslessCandidate(runtime: GaslessRuntime | undefined, rpc: Rpc, input: { readonly chainId: number; readonly owner: string;
  readonly block: string; readonly sellToken: string; readonly buyToken: string; readonly sellAmount: string; readonly slippageBps: number;
  readonly conversion: boolean; readonly nowMs: number;
  /** FloFi's own Uniswap v3 quote of exactly this swap at `block`: 0x's minimum is never accepted below it net of 0x's disclosed fees. */
  readonly reference: GaslessReference }): Promise<{ readonly candidate: MechanismCandidate; readonly binding: ZeroExGaslessBinding | null }> {
  const refuse = (code: string) => ({ candidate: { mechanism: 'ZEROX_GASLESS_SWAP' as const, eligible: false as const, code }, binding: null });
  if (!runtime) return refuse('TOKEN_GAS_NOT_CONFIGURED');
  if (!runtime.config.enabled) return refuse(runtime.config.code);
  if (!runtime.config.chains.includes(`eip155:${input.chainId}`) || !runtime.client) return refuse('ZEROX_GASLESS_CHAIN_UNSUPPORTED');
  if (input.sellToken === NATIVE_TOKEN || input.conversion) return refuse('ZEROX_GASLESS_NATIVE_SELL_UNSUPPORTED');
  if (input.buyToken === NATIVE_TOKEN) return refuse('ZEROX_GASLESS_NATIVE_BUY_UNSUPPORTED');
  try {
    if (ownerAccountCode(await rpc('eth_getCode', [input.owner, input.block])).kind !== 'EOA') return refuse('ZEROX_OWNER_NOT_EOA');
    if (!await runtime.client.supports(input.chainId)) return refuse('ZEROX_GASLESS_CHAIN_UNSUPPORTED');
    const settlers = await readGenuineSettlers(rpc, input.block);
    const request = { chainId: input.chainId, taker: input.owner, sellToken: input.sellToken, buyToken: input.buyToken, sellAmount: input.sellAmount,
      slippageBps: input.slippageBps };
    const { parsed, rawHash } = await runtime.client.quote(request);
    const binding = verifyGaslessQuote(parsed, rawHash, request, { settlers, reference: input.reference, nowMs: input.nowMs,
      minimumLifetimeMs: GASLESS_MINIMUM_LIFETIME_MS, maximumLifetimeSeconds: GASLESS_MAXIMUM_LIFETIME_SECONDS });
    return { candidate: { mechanism: 'ZEROX_GASLESS_SWAP', eligible: true }, binding };
  } catch (cause) {
    const code = cause instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(cause.message) ? cause.message : 'ZEROX_PROVIDER_UNAVAILABLE';
    return refuse(code);
  }
}

/** The fee the owner authorizes for the reviewed mechanism (ADR-0010 GasPayment). */
export function gasPaymentOf(mechanism: GasMechanism, binding: ZeroExGaslessBinding | null, native: { readonly worstCaseWei: string | null; readonly signatures: number },
  sides: Parameters<typeof sideAmount>[2]): GasPayment {
  if (mechanism !== 'ZEROX_GASLESS_SWAP') return { mechanism: 'NATIVE_WALLET_GAS', maxFee: native.worstCaseWei === null ? null : { amount: native.worstCaseWei, unit: 'wei' },
    signatures: native.signatures };
  const b = binding ?? fail('ZEROX_TRADE_UNVERIFIABLE');
  return { mechanism: 'ZEROX_GASLESS_SWAP', maxFee: sideAmount(b.gasFee.token, b.gasFee.amount, sides), signatures: b.approval ? 2 : 1,
    zeroExFee: b.zeroExFee ? sideAmount(b.zeroExFee.token, b.zeroExFee.amount, sides) : null };
}

/** The exact typed data the owner signs, in order: the approval (when needed), then the trade. */
export function gaslessTypedData(binding: ZeroExGaslessBinding): { readonly approval: TypedData | null; readonly trade: TypedData } {
  return { approval: binding.approval?.eip712 ?? null, trade: binding.trade.eip712 };
}
/** The owner's signatures, recovered against the reviewed digests (recomputed, never taken from 0x or the page); type 2 parts for 0x. */
export function verifyGaslessSignatures(binding: ZeroExGaslessBinding, owner: string, signatures: { readonly trade: string; readonly approval: string | null }):
  { readonly trade: GaslessSignature; readonly approval: GaslessSignature | null } {
  const part = (typed: TypedData, expectedHash: string, signature: string | null): GaslessSignature => {
    if (eip712.hashTypedData(typed) !== expectedHash) fail('ZEROX_TRADE_HASH_MISMATCH');
    if (typeof signature !== 'string') return fail('ZEROX_SIGNATURE_INVALID');
    let signer: string;
    try { signer = eip712.recoverTypedDataSigner(expectedHash, signature); } catch { return fail('ZEROX_SIGNATURE_INVALID'); }
    if (signer !== owner) fail('ZEROX_SIGNER_MISMATCH');
    const { v, r, s } = eip712.splitSignature(signature);
    return { signatureType: 2, v, r, s };
  };
  if (!binding.approval && signatures.approval !== null) fail('ZEROX_SIGNATURE_INVALID');
  return { approval: binding.approval ? part(binding.approval.eip712, binding.approval.hash, signatures.approval) : null,
    trade: part(binding.trade.eip712, binding.trade.hash, signatures.trade) };
}

/** Permit2 `nonceBitmap(owner, wordPos)`: whether the trade's unordered nonce was consumed at `block` (the signature can then never run again). */
const NONCE_BITMAP_SELECTOR = erc7710.selectorOf('nonceBitmap(address,uint256)');
export async function permit2NonceUsed(rpc: Rpc, owner: string, nonce: string, block: string): Promise<boolean> {
  const n = BigInt(nonce), position = n >> 8n, bit = n & 0xffn;
  const answer = await rpc('eth_call', [{ to: PERMIT2, data: NONCE_BITMAP_SELECTOR + addressWord(owner) + word(position) }, block]);
  if (typeof answer !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(answer)) fail('RPC_RESPONSE_INVALID');
  return ((BigInt(answer as string) >> bit) & 1n) === 1n;
}

/** A 0x status failure reason as FloFi's closed code (shown to the owner with what to do next). */
export function gaslessFailureCode(reason: string | null): string {
  switch (reason) {
    case 'order_expired': return 'ZEROX_ORDER_EXPIRED';
    case 'insufficient_balance': return 'ZEROX_INSUFFICIENT_BALANCE';
    case 'insufficient_allowance': return 'ZEROX_INSUFFICIENT_ALLOWANCE';
    case 'transaction_reverted': return 'ZEROX_TRADE_REVERTED';
    case 'transaction_simulation_failed': return 'ZEROX_TRADE_SIMULATION_FAILED';
    case 'last_look_declined': case 'market_maker_sigature_error': return 'ZEROX_MARKET_MAKER_DECLINED';
    default: return 'ZEROX_TRADE_FAILED';
  }
}

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const APPROVAL_TOPIC = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const topicAddress = (value: unknown): string => typeof value === 'string' && /^0x0{24}[0-9a-fA-F]{40}$/.test(value) ? '0x' + value.slice(-40).toLowerCase() : fail('RECEIPT_INVALID');
const address = (value: unknown): string => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : fail('RECEIPT_INVALID');
/**
 * The owner's side of a settled gasless trade, proven from the receipt's own logs (owner-centric: the Settler, pools and market makers in
 * between may log anything). The owner's only debit is exactly the signed sell amount of the sell token; its only credits are of the buy token
 * and add up to at least the signed minimum; the only other owner log allowed is the sell token's `Approval(owner, Permit2, …)` bookkeeping
 * (the gasless permit, and Permit2's transferFrom on tokens that log the remaining allowance). A Stock Token's ERC-8056 `TransferWithScaledUI`
 * companion is not a Transfer and is not counted. Returns what was spent and received.
 */
export function gaslessReceiptSwap(logs: unknown, binding: ZeroExGaslessBinding): { readonly spent: bigint; readonly received: bigint } {
  if (!Array.isArray(logs)) return fail('RECEIPT_INVALID');
  const owner = binding.taker;
  let spent = 0n, received = 0n;
  for (const log of logs) {
    if (!isRecord(log) || !Array.isArray(log.topics)) fail('RECEIPT_INVALID');
    const record = log as Record<string, unknown> & { topics: unknown[] }, token = address(record.address), topic = record.topics[0];
    if (topic === TRANSFER_TOPIC && record.topics.length === 3) {
      const from = topicAddress(record.topics[1]), to = topicAddress(record.topics[2]);
      if (from !== owner && to !== owner) continue;
      if (from === owner && to === owner) fail('TRANSACTION_MISMATCH');
      const amount = quantity(record.data);
      if (from === owner) { if (token !== binding.sellToken) fail('TRANSACTION_MISMATCH'); spent += amount; }
      else { if (token !== binding.buyToken) fail('TRANSACTION_MISMATCH'); received += amount; }
    } else if (topic === APPROVAL_TOPIC && record.topics.length === 3 && topicAddress(record.topics[1]) === owner) {
      if (token !== binding.sellToken || topicAddress(record.topics[2]) !== PERMIT2) fail('TRANSACTION_MISMATCH');
    }
  }
  if (spent !== BigInt(binding.sellAmount) || received < BigInt(binding.minBuyAmount)) fail('RECONCILIATION_MISMATCH');
  return { spent, received };
}
/** The settlement transaction's own identity: on this chain, sent by a relayer (never the owner) to the reviewed genuine Settler's `executeMetaTxn`. */
export function gaslessSettlementShape(tx: unknown, chainId: number, txHash: string, binding: ZeroExGaslessBinding): { readonly relayer: string } {
  if (!isRecord(tx) || typeof tx.hash !== 'string' || tx.hash.toLowerCase() !== txHash || quantity(tx.chainId) !== BigInt(chainId) || quantity(tx.value) !== 0n ||
      typeof tx.input !== 'string' || !tx.input.toLowerCase().startsWith(EXECUTE_METATXN_SELECTOR) || address(tx.to) !== binding.settler) fail('TRANSACTION_MISMATCH');
  const relayer = address((tx as Record<string, unknown>).from);
  if (relayer === binding.taker) fail('TRANSACTION_MISMATCH');
  return { relayer };
}
