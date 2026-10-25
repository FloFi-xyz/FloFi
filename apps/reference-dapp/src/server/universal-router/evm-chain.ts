// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CROSSCHAIN-UNIVERSAL-001: EVM chain reads and proofs for the universal router — token facts, the pinned Depository, exact
 * `eth_simulateV1` of the reviewed calls, fee bounds, the owner's submission, and the destination delivery / refund of an order.
 * Read-only: the transports allowlist read methods; nothing here can sign or send.
 */
import { createHash } from 'node:crypto';
import type { UniversalEvmDeployment } from '@defi-workflow-engine/action-registry';
import { decodeRelayDepositLog, RELAY_TOPICS, type RelayEvmLog } from '@defi-workflow-engine/reference-compiler';
import type { UniversalRoute } from '@defi-workflow-engine/workflow-contracts';
import { nitroGasLimit, nitroMaxFeePerGas, nitroPostingGas } from '../arbitrum-fees.ts';
import { verifyOwnerSubmission, type Rpc } from '../public-testnet-service.ts';

const HEX = /^0x[0-9a-fA-F]*$/, HASH = /^0x[0-9a-f]{64}$/, ADDRESS = /^0x[0-9a-f]{40}$/;
const fail = (code: string): never => { throw new Error(code); };
export const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export const hex = (value: unknown): string => typeof value === 'string' && HEX.test(value) ? value.toLowerCase() : fail('UNIVERSAL_RPC_INVALID');
export const quantity = (value: unknown): bigint => { const h = hex(value); return h === '0x' ? fail('UNIVERSAL_RPC_INVALID') : BigInt(h); };
export const tag = (n: number | bigint) => '0x' + n.toString(16);
const word = (n: bigint) => n.toString(16).padStart(64, '0');
const addrWord = (a: string) => a.slice(2).padStart(64, '0');
const wordAt = (data: string, index: number) => { if (data.length < 66 + index * 64) fail('UNIVERSAL_RPC_INVALID'); return BigInt('0x' + data.slice(2 + index * 64, 66 + index * 64)); };
export const sha256Hex = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export const SEL = Object.freeze({ balanceOf: '0x70a08231', allowance: '0xdd62ed3e', decimals: '0x313ce567' });
export type EvmBlock = { number: number; hash: string; timestamp: number; baseFee: bigint };

export async function evmHead(rpc: Rpc, d: UniversalEvmDeployment): Promise<EvmBlock> {
  if (quantity(await rpc('eth_chainId', [])) !== BigInt(d.chainId)) fail('UNIVERSAL_WRONG_CHAIN');
  const block = await rpc('eth_getBlockByNumber', ['latest', false]);
  if (!isObject(block)) fail('UNIVERSAL_RPC_INVALID');
  const b = block as Record<string, unknown>, number = Number(quantity(b.number)), hash = hex(b.hash);
  if (!Number.isSafeInteger(number) || !HASH.test(hash)) fail('UNIVERSAL_RPC_INVALID');
  return { number, hash, timestamp: Number(quantity(b.timestamp)), baseFee: b.baseFeePerGas === undefined ? 0n : quantity(b.baseFeePerGas) };
}
export const evmCall = async (rpc: Rpc, to: string, data: string, at: string) => hex(await rpc('eth_call', [{ to, data }, at]));
export async function evmCodeSha256(rpc: Rpc, target: string, at: string): Promise<string> {
  const code = hex(await rpc('eth_getCode', [target, at]));
  if (code.length <= 2) fail('UNIVERSAL_CONTRACT_CODE_MISSING');
  return sha256Hex(Buffer.from(code.slice(2), 'hex'));
}
/** The pinned Relay Depository at a block: its runtime code must be exactly the verified deployment. */
export async function assertEvmDepository(rpc: Rpc, d: UniversalEvmDeployment, at: string, pin = d.relayDepositoryCodeSha256): Promise<string> {
  const sha = await evmCodeSha256(rpc, d.relayDepository, at);
  if (sha !== pin) fail('UNIVERSAL_UNEXPECTED_CONTRACT');
  return sha;
}
/** On-chain decimals of an ERC-20 (code must exist). */
export async function evmTokenDecimals(rpc: Rpc, token: string, at = 'latest'): Promise<number> {
  await evmCodeSha256(rpc, token, at);
  let data: string;
  try { data = await evmCall(rpc, token, SEL.decimals, at); } catch { return fail('UNIVERSAL_TOKEN_DECIMALS_UNAVAILABLE'); }
  const decimals = wordAt(data, 0);
  if (decimals > 36n) fail('UNIVERSAL_TOKEN_DECIMALS_INVALID');
  return Number(decimals);
}
export async function evmBalance(rpc: Rpc, owner: string, token: string | null, at: string): Promise<bigint> {
  return token === null ? quantity(await rpc('eth_getBalance', [owner, at])) : wordAt(await evmCall(rpc, token, SEL.balanceOf + addrWord(owner), at), 0);
}
export const evmAllowance = async (rpc: Rpc, token: string, owner: string, spender: string, at: string) =>
  wordAt(await evmCall(rpc, token, SEL.allowance + addrWord(owner) + addrWord(spender), at), 0);

export type EvmCall = { purpose: 'APPROVAL' | 'BRIDGE_DEPOSIT'; to: string; data: string; value: string };
export type EvmLog = RelayEvmLog;
/** Real public-network simulation of the exact call sequence, from the owner, at the observed block. */
export async function evmSimulate(rpc: Rpc, owner: string, calls: readonly EvmCall[], at: number): Promise<{ purpose: EvmCall['purpose']; gasUsed: bigint; logs: EvmLog[] }[]> {
  let result: unknown;
  try { result = await rpc('eth_simulateV1', [{ blockStateCalls: [{ calls: calls.map(c => ({ from: owner, to: c.to, data: c.data, value: tag(BigInt(c.value)) })) }],
    validation: false, traceTransfers: false }, tag(at)]); }
  catch (cause) { if (cause instanceof Error && cause.message === 'PUBLIC_RPC_METHOD_DENIED') throw cause; return fail('UNIVERSAL_SIMULATION_UNAVAILABLE'); }
  const outputs = Array.isArray(result) && result.length === 1 && isObject(result[0]) && Array.isArray((result[0] as Record<string, unknown>).calls)
    ? (result[0] as Record<string, unknown>).calls as unknown[] : null;
  if (!outputs || outputs.length !== calls.length) fail('UNIVERSAL_SIMULATION_INVALID');
  return calls.map((c, i) => {
    const out = outputs![i];
    if (!isObject(out)) fail('UNIVERSAL_SIMULATION_INVALID');
    const o = out as Record<string, unknown>;
    if (quantity(o.status) !== 1n) fail(c.purpose === 'APPROVAL' ? 'UNIVERSAL_SIMULATION_APPROVAL_REVERTED' : 'UNIVERSAL_SIMULATION_DEPOSIT_REVERTED');
    return { purpose: c.purpose, gasUsed: quantity(o.gasUsed), logs: Array.isArray(o.logs) ? o.logs.filter(isObject) as unknown as EvmLog[] : [] };
  });
}
/** Exactly one Depository deposit of the reviewed order and amount from the owner, and (tokens) exactly the amount debited from the owner. */
export function assertDepositEffects(route: UniversalRoute, d: UniversalEvmDeployment, logs: readonly EvmLog[], owner: string): { ownerDebit: bigint } {
  const deposits = logs.map(l => decodeRelayDepositLog(l, d.relayDepository)).filter(e => e !== null);
  const token = route.inputToken.kind === 'TOKEN' ? route.inputToken.address : null;
  if (deposits.length !== 1) fail('UNIVERSAL_DEPOSIT_EVENT_MISMATCH');
  const e = deposits[0]!;
  if (e.kind !== (token ? 'ERC20' : 'NATIVE') || e.from !== owner || e.token !== token || e.amount !== BigInt(route.inputAmount) || e.id !== route.order.orderId)
    fail('UNIVERSAL_DEPOSIT_EVENT_MISMATCH');
  if (!token) return { ownerDebit: e.amount };
  const debits = logs.filter(l => String(l.address).toLowerCase() === token && String(l.topics?.[0]).toLowerCase() === RELAY_TOPICS.transfer && l.topics.length === 3 &&
    '0x' + String(l.topics[1]).slice(26).toLowerCase() === owner);
  if (debits.length !== 1 || BigInt(String(debits[0]!.data)) !== BigInt(route.inputAmount) || '0x' + String(debits[0]!.topics[2]).slice(26).toLowerCase() !== d.relayDepository)
    fail('UNIVERSAL_OWNER_DEBIT_MISMATCH');
  return { ownerDebit: BigInt(route.inputAmount) };
}

/** Fee pricing per chain family: Nitro (Arbitrum One) uses gasPrice and posting gas; the others EIP-1559 with a 2× base-fee bound. */
export async function evmFeePrice(rpc: Rpc, d: UniversalEvmDeployment, baseFee: bigint): Promise<{ priority: bigint; maximum: bigint }> {
  if (d.nitro) {
    const price = quantity(await rpc('eth_gasPrice', []));
    if (price <= 0n || price >= 1n << 128n) fail('UNIVERSAL_FEE_INVALID');
    return { priority: 0n, maximum: nitroMaxFeePerGas(price) };
  }
  const priority = quantity(await rpc('eth_maxPriorityFeePerGas', []));
  return { priority, maximum: baseFee * 2n + priority };
}
export async function evmGasLimit(rpc: Rpc, d: UniversalEvmDeployment, owner: string, call: EvmCall, gasUsed: bigint, at: string): Promise<bigint> {
  return d.nitro ? nitroGasLimit(gasUsed + await nitroPostingGas(rpc, owner, call, at, 'UNIVERSAL_NITRO_FEE_UNAVAILABLE')) : gasUsed * 13n / 10n + 25_000n;
}
/** OP Stack L1 data fee upper bound (GasPriceOracle `getL1FeeUpperBound`); zero elsewhere; null when unavailable. */
export async function evmL1FeeUpperBound(rpc: Rpc, d: UniversalEvmDeployment, dataBytes: number, at: string): Promise<bigint | null> {
  if (!d.l1DataFee) return 0n;
  try { return wordAt(await evmCall(rpc, '0x420000000000000000000000000000000000000f', '0xf1c7a58b' + word(BigInt(dataBytes + 120)), at), 0); } catch { return null; }
}

export type EvmReceiptFacts = { status: 0 | 1; blockNumber: number; blockHash: string; from: string; gasCostWei: bigint; direct: boolean; nonce: bigint | null };
/**
 * The owner's submission of an attempt: value-carrying (native) deposits must be direct transactions from the owner with exactly the
 * reviewed target, data and value; value-free calls reuse the shared verifier (direct or the owner's EIP-7702 delegation).
 */
export async function verifyEvmSubmission(rpc: Rpc, d: UniversalEvmDeployment, attempt: { hash: string; owner: string; to: string; data: string; value: bigint; preBlock: number },
  raw: Record<string, unknown>): Promise<EvmReceiptFacts> {
  const tx = await rpc('eth_getTransactionByHash', [attempt.hash]);
  if (attempt.value === 0n) {
    const v = await verifyOwnerSubmission(rpc, { txHash: attempt.hash, account: attempt.owner, target: attempt.to, data: attempt.data, preBlock: attempt.preBlock },
      tx, raw, d.chainId, d.l1DataFee);
    return { status: v.status as 0 | 1, blockNumber: v.blockNumber, blockHash: hex(raw.blockHash), from: v.txFrom, gasCostWei: v.gasUsed * v.effectiveGasPrice + v.l1Fee,
      direct: v.direct, nonce: isObject(tx) ? quantity((tx as Record<string, unknown>).nonce) : null };
  }
  if (!isObject(tx)) fail('TRANSACTION_MISMATCH');
  const t = tx as Record<string, unknown>;
  if (Number(quantity(t.chainId)) !== d.chainId || hex(t.hash) !== attempt.hash || hex(t.from) !== attempt.owner || hex(t.to) !== attempt.to || hex(t.input) !== attempt.data ||
      quantity(t.value) !== attempt.value) fail('TRANSACTION_MISMATCH');
  const status = Number(quantity(raw.status)), blockNumber = Number(quantity(raw.blockNumber)), blockHash = hex(raw.blockHash);
  if (![0, 1].includes(status) || blockNumber < attempt.preBlock || hex(raw.transactionHash) !== attempt.hash || hex(raw.from) !== attempt.owner) fail('RECEIPT_INVALID');
  if (/^0x0{64}$/.test(blockHash)) fail('RECEIPT_NOT_CANONICAL');
  const canonical = await rpc('eth_getBlockByNumber', [tag(blockNumber), false]);
  if (!isObject(canonical) || hex((canonical as Record<string, unknown>).hash) !== blockHash || !Array.isArray((canonical as Record<string, unknown>).transactions) ||
      !((canonical as Record<string, unknown>).transactions as unknown[]).some(e => String(isObject(e) ? (e as Record<string, unknown>).hash : e).toLowerCase() === attempt.hash))
    fail('RECEIPT_NOT_CANONICAL');
  const l1Fee = d.l1DataFee ? quantity(raw.l1Fee) : 0n;
  return { status: status as 0 | 1, blockNumber, blockHash, from: attempt.owner, gasCostWei: quantity(raw.gasUsed) * quantity(raw.effectiveGasPrice) + l1Fee, direct: true,
    nonce: quantity(t.nonce) };
}
export async function evmSafeHead(rpc: Rpc): Promise<number> {
  const block = await rpc('eth_getBlockByNumber', ['safe', false]);
  if (!isObject(block)) fail('UNIVERSAL_RPC_INVALID');
  return Number(quantity((block as Record<string, unknown>).number));
}
/** Canonical inclusion of a transaction (non-zero block hash that is the canonical block at that height and lists it). */
export async function evmCanonicalReceipt(rpc: Rpc, hash: string): Promise<(Record<string, unknown> & { timestamp: number }) | null> {
  const raw = await rpc('eth_getTransactionReceipt', [hash]);
  if (raw === null) return null;
  if (!isObject(raw) || hex((raw as Record<string, unknown>).transactionHash) !== hash) fail('UNIVERSAL_RECEIPT_INVALID');
  const r = raw as Record<string, unknown>, blockHash = hex(r.blockHash);
  if (/^0x0{64}$/.test(blockHash)) return null;
  const block = await rpc('eth_getBlockByNumber', [tag(Number(quantity(r.blockNumber))), false]);
  if (!isObject(block)) return null;
  const b = block as Record<string, unknown>;
  if (hex(b.hash) !== blockHash || !Array.isArray(b.transactions) || !(b.transactions as unknown[]).some(e => String(isObject(e) ? (e as Record<string, unknown>).hash : e).toLowerCase() === hash))
    return null;
  return { ...r, timestamp: Number(quantity(b.timestamp)) };
}

export type DeliveryCheck = { ok: true; amount: bigint; blockNumber: number; blockHash: string; timestamp: number; orderBound: boolean; contentHash: string }
  | { ok: false; reason: 'NOT_CANONICAL' | 'REVERTED' | 'NO_CREDIT' | 'BELOW_MINIMUM' | 'UNVERIFIABLE_NATIVE' };
/**
 * Independent proof that one destination transaction credited `recipient` with `token` (null = native). ERC-20: net Transfer logs to
 * the recipient. Native: a direct value transfer to the recipient (Relay's native fills carry the order id as calldata). Whether the
 * order id appears in the transaction's calldata or logs is recorded as an additional binding.
 */
export async function verifyEvmCredit(rpc: Rpc, input: { hash: string; recipient: string; token: string | null; minimum: bigint; orderId: string }): Promise<DeliveryCheck> {
  const raw = await evmCanonicalReceipt(rpc, input.hash);
  if (!raw) return { ok: false, reason: 'NOT_CANONICAL' };
  if (quantity(raw.status) !== 1n) return { ok: false, reason: 'REVERTED' };
  const tx = await rpc('eth_getTransactionByHash', [input.hash]);
  if (!isObject(tx)) return { ok: false, reason: 'NOT_CANONICAL' };
  const t = tx as Record<string, unknown>, logs = Array.isArray(raw.logs) ? raw.logs.filter(isObject) as unknown as EvmLog[] : [];
  const id = input.orderId.slice(2), orderBound = hex(t.input).includes(id) || logs.some(l => String(l.data).toLowerCase().includes(id) || l.topics.some(x => String(x).toLowerCase() === input.orderId));
  let amount = 0n;
  if (input.token) {
    for (const l of logs) {
      if (String(l.address).toLowerCase() !== input.token || String(l.topics?.[0]).toLowerCase() !== RELAY_TOPICS.transfer || l.topics.length !== 3) continue;
      const from = '0x' + String(l.topics[1]).slice(26).toLowerCase(), to = '0x' + String(l.topics[2]).slice(26).toLowerCase(), value = BigInt(String(l.data));
      if (to === input.recipient) amount += value;
      if (from === input.recipient) amount -= value;
    }
  } else {
    const to = typeof t.to === 'string' ? t.to.toLowerCase() : null;
    if (to !== input.recipient) return { ok: false, reason: 'UNVERIFIABLE_NATIVE' };
    amount = quantity(t.value);
  }
  if (amount <= 0n) return { ok: false, reason: 'NO_CREDIT' };
  if (amount < input.minimum) return { ok: false, reason: 'BELOW_MINIMUM' };
  return { ok: true, amount, blockNumber: Number(quantity(raw.blockNumber)), blockHash: hex(raw.blockHash), timestamp: raw.timestamp, orderBound,
    contentHash: '0x' + sha256Hex(JSON.stringify(raw)) };
}
export const isEvmAddress = (value: unknown): value is string => typeof value === 'string' && ADDRESS.test(value);
