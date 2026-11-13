// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-MAINNET-EXEC-002: FloFi's ERC-7677 paymaster web service — the URL a wallet's EIP-5792 `paymasterService` capability calls while it
 * builds the owner's user operation. It sponsors only what FloFi reviewed, and forwards to the configured provider with FloFi's server-side key:
 *
 *  1. the request is for this chain and the pinned EntryPoint (v0.7), with a FloFi grant in its context, unexpired;
 *  2. the operation's sender is the grant's owner, it deploys nothing (no factory), and its calls — decoded from the account's own encoding — are
 *     exactly the grant's reviewed calls (same targets, values and data, same order);
 *  3. (final data) the operation asks for no more per gas than the preparation's own fee ceiling, no more execution gas than its allowance, and
 *     bounded verification/pre-verification gas; its owner nonce is the grant's pinned nonce (the first final sponsorship fixes it), so at most
 *     ONE operation of a grant can ever land;
 *  4. the provider's answer names the pinned paymaster contract, and (final data) the operation's worst-case cost with the paymaster's gas is
 *     within the per-operation cap and today's budget (one reservation per grant in the ledger) — else the request is refused and the wallet's
 *     operation stays unsponsored. A stub answer never carries `isFinal` (ERC-7677: the wallet must then ask for final data, so every control
 *     above runs);
 *  5. the final operation's hash and nonce are recorded on the grant, so reconciliation proves exactly that operation landed and who paid.
 * Every refusal is a closed `GAS_SPONSOR_*` code; no internal or storage error text reaches the (unauthenticated) caller.
 * The owner still signs the operation (the paymaster pays gas only). FloFi's grant context is never forwarded; the provider's key never leaves
 * the server. Nothing here holds a key of the owner or signs anything.
 */
import { erc4337 } from '@defi-workflow-engine/reference-compiler';
import type { EvmSponsor } from './config.ts';
import { callsHash, GRANT_ID, GRANT_MAX_USES, type GrantUse, type GrantStore, type SponsorLedger } from './ledger.ts';

export type JsonRpcRequest = { readonly jsonrpc?: unknown; readonly id?: unknown; readonly method?: unknown; readonly params?: unknown };
export type JsonRpcResponse = { readonly jsonrpc: '2.0'; readonly id: unknown; readonly result?: unknown; readonly error?: { readonly code: number; readonly message: string } };
/** The provider's JSON-RPC transport (a fetch to `paymasterRpc` server-side; a loopback double in tests). */
export type PaymasterTransport = (url: string, body: unknown) => Promise<unknown>;
export type PaymasterServiceDeps = { readonly sponsor: EvmSponsor; readonly grants: GrantStore; readonly ledger: SponsorLedger; readonly transport: PaymasterTransport;
  readonly now?: () => Date };

const METHODS = ['pm_getPaymasterStubData', 'pm_getPaymasterData'] as const;
const QUANTITY = /^0x[0-9a-fA-F]{1,64}$/, ADDRESS = /^0x[0-9a-fA-F]{40}$/, DATA = /^0x(?:[0-9a-fA-F]{2})*$/;
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
class Refusal extends Error { constructor(readonly rpcCode: number, code: string) { super(code); } }
const refuse = (code: string, rpcCode = -32602): never => { throw new Refusal(rpcCode, code); };
/** A ledger/grant failure as a closed code: its own `GAS_SPONSOR_*` refusal, else UNAVAILABLE (never a storage or driver message). */
const closed = (cause: unknown) => cause instanceof Error && /^GAS_SPONSOR_[A-Z0-9_]{1,80}$/.test(cause.message) ? cause.message : 'GAS_SPONSOR_UNAVAILABLE';
/** Gas a sponsored operation may ask for beyond its execution: account validation (with an EIP-7702/smart-account signature check) and the bundler's
 * pre-verification charge (calldata, and the L1 data share on OP Stack chains). Anything above is refused; the per-operation cap bounds the total. */
export const MAX_VERIFICATION_GAS = 1_000_000n, MAX_PRE_VERIFICATION_GAS = 3_000_000n, MAX_PAYMASTER_GAS = 500_000n;
/** The execution-gas allowance of a grant: the preparation's simulated batch gas, doubled (a 4337 account's `execute` adds its own overhead). */
export const CALL_GAS_HEADROOM = 2n;

/** The operation fields FloFi forwards (the paymaster's own fields and any signature are the provider's to fill). */
function operationOf(value: unknown): erc4337.RpcUserOperation {
  if (!isRecord(value)) return refuse('GAS_SPONSOR_OPERATION_INVALID');
  const q = (k: string) => typeof value[k] === 'string' && QUANTITY.test(value[k] as string) ? value[k] as string : refuse('GAS_SPONSOR_OPERATION_INVALID');
  if (typeof value.sender !== 'string' || !ADDRESS.test(value.sender) || typeof value.callData !== 'string' || !DATA.test(value.callData)) refuse('GAS_SPONSOR_OPERATION_INVALID');
  // FloFi sponsors calls of an existing account (or an EIP-7702 account): never an account deployment it cannot review.
  if (value.factory !== undefined && value.factory !== null && value.factory !== '0x') refuse('GAS_SPONSOR_DEPLOYMENT_REFUSED');
  return { sender: (value.sender as string).toLowerCase(), nonce: q('nonce'), callData: (value.callData as string).toLowerCase(), callGasLimit: q('callGasLimit'),
    verificationGasLimit: q('verificationGasLimit'), preVerificationGas: q('preVerificationGas'), maxFeePerGas: q('maxFeePerGas'), maxPriorityFeePerGas: q('maxPriorityFeePerGas') };
}
type ProviderAnswer = { paymaster: string; paymasterData: string; paymasterVerificationGasLimit: string; paymasterPostOpGasLimit: string };
function answerOf(raw: unknown, sponsor: EvmSponsor, final: boolean): ProviderAnswer {
  if (!isRecord(raw) || raw.error !== undefined || !isRecord(raw.result)) return refuse('GAS_SPONSOR_PROVIDER_REFUSED', -32000);
  const r = raw.result as Record<string, unknown>;
  if (typeof r.paymaster !== 'string' || r.paymaster.toLowerCase() !== sponsor.paymaster) refuse('GAS_SPONSOR_PAYMASTER_UNEXPECTED', -32000);
  if (typeof r.paymasterData !== 'string' || !DATA.test(r.paymasterData)) refuse('GAS_SPONSOR_PROVIDER_ANSWER_INVALID', -32000);
  const gas = (k: string) => typeof r[k] === 'string' && QUANTITY.test(r[k] as string) && BigInt(r[k] as string) < 1n << 128n ? r[k] as string
    : final ? refuse('GAS_SPONSOR_PROVIDER_ANSWER_INVALID', -32000) : '0x0';
  // `isFinal` is never forwarded (review P1): a stub the wallet took as final would skip the cap, the budget, the nonce pin and the hash record.
  return { paymaster: sponsor.paymaster, paymasterData: (r.paymasterData as string).toLowerCase(), paymasterVerificationGasLimit: gas('paymasterVerificationGasLimit'),
    paymasterPostOpGasLimit: gas('paymasterPostOpGasLimit') };
}

/** One ERC-7677 JSON-RPC request. Every refusal is a JSON-RPC error (the wallet then does not use sponsorship); nothing is partially recorded. */
export async function handlePaymasterRpc(deps: PaymasterServiceDeps, request: JsonRpcRequest): Promise<JsonRpcResponse> {
  const id = request.id ?? null, now = deps.now ?? (() => new Date()), sponsor = deps.sponsor;
  try {
    if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') refuse('GAS_SPONSOR_REQUEST_INVALID', -32600);
    const method = request.method as string;
    if (!(METHODS as readonly string[]).includes(method)) refuse('GAS_SPONSOR_METHOD_UNSUPPORTED', -32601);
    const params = Array.isArray(request.params) ? request.params : refuse('GAS_SPONSOR_REQUEST_INVALID');
    const [rawOp, entryPoint, chainId, context] = params as unknown[];
    if (typeof entryPoint !== 'string' || entryPoint.toLowerCase() !== sponsor.entryPoint) refuse('GAS_SPONSOR_ENTRY_POINT_UNEXPECTED');
    if (typeof chainId !== 'string' || !QUANTITY.test(chainId) || BigInt(chainId) !== BigInt(sponsor.chainId)) refuse('GAS_SPONSOR_CHAIN_UNEXPECTED');
    const grantId = isRecord(context) && typeof context.flofiGrant === 'string' && GRANT_ID.test(context.flofiGrant) ? context.flofiGrant : refuse('GAS_SPONSOR_GRANT_REQUIRED');
    const found = await deps.grants.read(grantId);
    if (!found || found.grant.network !== sponsor.chain) return refuse('GAS_SPONSOR_GRANT_UNKNOWN');
    if (Date.parse(found.grant.expiresAt) <= now().getTime()) refuse('GAS_SPONSOR_GRANT_EXPIRED');
    const op = operationOf(rawOp);
    if (op.sender !== found.grant.owner) refuse('GAS_SPONSOR_SENDER_NOT_OWNER');
    let calls: ReturnType<typeof erc4337.decodeAccountCalls>;
    try { calls = erc4337.decodeAccountCalls(op.callData); } catch { return refuse('GAS_SPONSOR_CALLS_UNREADABLE'); }
    if (callsHash(calls) !== found.grant.callsHash) refuse('GAS_SPONSOR_CALLS_NOT_REVIEWED');
    const final = method === 'pm_getPaymasterData';
    const gas = { verificationGasLimit: BigInt(op.verificationGasLimit), callGasLimit: BigInt(op.callGasLimit), preVerificationGas: BigInt(op.preVerificationGas),
      maxFeePerGas: BigInt(op.maxFeePerGas), maxPriorityFeePerGas: BigInt(op.maxPriorityFeePerGas) };
    const nonce = BigInt(op.nonce), uses = found.uses as readonly GrantUse[];
    if (final) {
      // Review P1: fees and gas no larger than the owner's own reviewed batch would have used, and the grant's pinned nonce (one landing at most).
      if (gas.maxFeePerGas > BigInt(found.grant.maxFeePerGas) || gas.maxPriorityFeePerGas > gas.maxFeePerGas) refuse('GAS_SPONSOR_FEE_ABOVE_REVIEW');
      if (gas.callGasLimit > BigInt(found.grant.callGasLimit) * CALL_GAS_HEADROOM || gas.verificationGasLimit > MAX_VERIFICATION_GAS ||
          gas.preVerificationGas > MAX_PRE_VERIFICATION_GAS) refuse('GAS_SPONSOR_GAS_ABOVE_REVIEW');
      if (uses.length && uses[0]!.nonce !== nonce.toString()) refuse('GAS_SPONSOR_NONCE_CHANGED');
    }
    // The provider sees the operation and its own sponsorship context only — never FloFi's grant.
    const answer = answerOf(await deps.transport(sponsor.paymasterRpc, { jsonrpc: '2.0', id: 1, method, params: [op, sponsor.entryPoint, chainId, sponsor.context ?? {}] }),
      sponsor, final);
    if (final) {
      if (BigInt(answer.paymasterVerificationGasLimit) > MAX_PAYMASTER_GAS || BigInt(answer.paymasterPostOpGasLimit) > MAX_PAYMASTER_GAS)
        refuse('GAS_SPONSOR_PROVIDER_ANSWER_INVALID', -32000);
      const maxCost = erc4337.maxSponsoredCost(gas, { verificationGasLimit: BigInt(answer.paymasterVerificationGasLimit), postOpGasLimit: BigInt(answer.paymasterPostOpGasLimit) });
      if (maxCost > sponsor.maxWeiPerOp) refuse('GAS_SPONSOR_COST_ABOVE_CAP', -32000);
      const hash = erc4337.userOpHash(erc4337.packRpcUserOperation({ ...op, paymaster: answer.paymaster, paymasterData: answer.paymasterData,
        paymasterVerificationGasLimit: answer.paymasterVerificationGasLimit, paymasterPostOpGasLimit: answer.paymasterPostOpGasLimit }), sponsor.chainId, sponsor.entryPoint);
      // A grant past its uses is refused before anything is reserved (the budget is never held by an operation that cannot be sponsored).
      if (!uses.some(u => u.userOpHash === hash) && uses.length >= GRANT_MAX_USES) refuse('GAS_SPONSOR_GRANT_USED', -32000);
      // One reservation per grant (only one of its operations can land), on the grant's own day; released if the use cannot be recorded.
      const on = new Date(found.grant.createdAt);
      try { await deps.ledger.reserve(sponsor.chain, grantId, maxCost, sponsor.dailyBudgetWei, on); }
      catch (cause) { return refuse(closed(cause), -32000); }
      try { await deps.grants.use(grantId, hash, nonce, maxCost); }
      catch (cause) {
        if (!uses.length) await deps.ledger.release(sponsor.chain, grantId, on).catch(() => undefined);
        return refuse(closed(cause), -32000);
      }
    }
    return { jsonrpc: '2.0', id, result: { ...answer, sponsor: { name: 'FloFi' } } };
  } catch (cause) {
    if (cause instanceof Refusal) return { jsonrpc: '2.0', id, error: { code: cause.rpcCode, message: cause.message } };
    return { jsonrpc: '2.0', id, error: { code: -32603, message: 'GAS_SPONSOR_UNAVAILABLE' } };
  }
}

/** The provider transport: bounded JSON-RPC over HTTPS, no redirects (the URL carries the provider key and stays server-side). */
export function paymasterTransport(fetchImpl: typeof fetch = fetch): PaymasterTransport {
  return async (url, body) => {
    const response = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body),
      redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000) });
    const text = await response.text();
    if (text.length > 200_000) throw new Error('GAS_SPONSOR_PROVIDER_ANSWER_INVALID');
    return JSON.parse(text) as unknown;
  };
}

/**
 * Records the fee the sponsor actually paid for one of a grant's sponsored operations (the EntryPoint's `actualGasCost`, read from the chain by
 * the caller), replacing its reserved worst case in the ledger. Idempotent; an operation the grant never sponsored is refused.
 */
export async function settleSponsoredOperation(deps: Pick<PaymasterServiceDeps, 'sponsor' | 'grants' | 'ledger'>, grantId: string, userOpHash: string,
  actualGasCost: bigint): Promise<void> {
  const found = await deps.grants.read(grantId), use = found?.uses.find(u => u.userOpHash === userOpHash.toLowerCase());
  if (!found || !use) throw new Error('GAS_SPONSOR_OPERATION_UNKNOWN');
  // The grant's one reservation, on the grant's own day (never the day the operation happened to land on).
  await deps.ledger.settle(deps.sponsor.chain, grantId, actualGasCost, use.userOpHash, new Date(found.grant.createdAt));
}
/**
 * Reconciliation of a sponsored operation from its receipt logs: the EntryPoint's `UserOperationEvent` of one of the grant's sponsored hashes, from
 * the owner, paid by the pinned paymaster. Returns the fee the sponsor paid (`actualGasCost`) and settles the ledger; null when none of them is there.
 */
export async function reconcileSponsoredOperation(deps: Pick<PaymasterServiceDeps, 'sponsor' | 'grants' | 'ledger'>, grantId: string, owner: string,
  logs: readonly unknown[]): Promise<{ readonly userOpHash: string; readonly paidBy: string; readonly actualGasCost: bigint; readonly success: boolean } | null> {
  const found = await deps.grants.read(grantId);
  if (!found) return null;
  for (const use of found.uses) {
    const event = erc4337.userOperationEvent(logs, use.userOpHash, deps.sponsor.entryPoint);
    if (!event) continue;
    if (event.sender.toLowerCase() !== owner.toLowerCase() || event.paymaster.toLowerCase() !== deps.sponsor.paymaster) throw new Error('GAS_SPONSOR_RECEIPT_MISMATCH');
    await settleSponsoredOperation(deps, grantId, use.userOpHash, event.actualGasCost);
    return { userOpHash: use.userOpHash, paidBy: event.paymaster.toLowerCase(), actualGasCost: event.actualGasCost, success: event.success };
  }
  return null;
}
