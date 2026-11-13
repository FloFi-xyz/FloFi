// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: the ERC-4337 v0.7 bundler transport — a closed method allowlist in front of a JSON-RPC endpoint, and the
 * mapping of a bundler's refusals to FloFi's closed codes. A bundler only transmits operations the owner signed; it is repaid by the
 * EntryPoint from the owner account's own prefund. Nothing here signs, holds bytes beyond the call, or chooses a chain.
 *
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (ADR-0010): the same allowlist (no paymaster or gas-price method is added) also carries operations
 * whose network fee Circle's pinned USDC paymaster fronts and charges back to the owner in USDC, on EntryPoint v0.7 or v0.8 (`estimateCircle`,
 * `sendCircle`); every other paymaster is still refused before the bundler is asked.
 */
import { circlePaymaster, erc4337 } from '@defi-workflow-engine/reference-compiler';
import { assertExecutionEnabled } from '../server/execution-guard.ts';

type Rpc = (method: string, params: readonly unknown[]) => Promise<unknown>;
export const BUNDLER_METHODS: ReadonlySet<string> = new Set(['eth_chainId', 'eth_supportedEntryPoints', 'eth_estimateUserOperationGas', 'eth_sendUserOperation',
  'eth_getUserOperationReceipt', 'eth_getUserOperationByHash']);
export class BundlerError extends Error { readonly detail: string | null; constructor(code: string, detail: string | null = null) { super(code); this.name = 'BundlerError'; this.detail = detail; } }
/**
 * EntryPoint v0.7 validation codes (AAxx) in a bundler's error message, mapped to what the owner can act on. Every other refusal is
 * USER_OPERATION_REJECTED with the bundled message bounded to 200 characters (never a body echo).
 */
export function bundlerRefusal(message: string): BundlerError {
  const m = message.slice(0, 200);
  if (/AA10|AA13|AA14|AA20/.test(m)) return new BundlerError('EVM_ACCOUNT_NOT_UPGRADED', m);
  if (/AA21/.test(m)) return new BundlerError('USER_FUNDED_INSUFFICIENT_NATIVE_BALANCE', m);
  if (/AA22/.test(m)) return new BundlerError('USER_OPERATION_EXPIRED', m);
  if (/AA23/.test(m)) return new BundlerError('USER_OPERATION_VALIDATION_REVERTED', m);
  if (/AA24/.test(m)) return new BundlerError('USER_OPERATION_SIGNATURE_INVALID', m);
  if (/AA25/.test(m)) return new BundlerError('USER_OPERATION_NONCE_INVALID', m);
  if (/AA3[0-9]/.test(m)) return new BundlerError('ERC4337_SPONSORED_REFUSED', m);
  if (/AA4[0-9]|AA5[0-9]|AA9[0-9]/.test(m)) return new BundlerError('USER_OPERATION_REJECTED', m);
  if (/replacement|already known|underpriced|fee too low|maxFeePerGas/i.test(m)) return new BundlerError('USER_OPERATION_FEE_TOO_LOW', m);
  return new BundlerError('USER_OPERATION_REJECTED', m);
}
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (ADR-0010): a refusal of an operation that names Circle's paymaster. Its paymaster codes (AA3x) are
 * what the owner can act on: the permit (signature, nonce) is not valid, the account holds too little USDC for the paymaster's prefund, the
 * paymaster's gas limits do not fit, or Circle's paymaster refused it (deposit, price, pause). Every other refusal keeps `bundlerRefusal`'s code.
 */
export function circleBundlerRefusal(error: unknown): BundlerError {
  // A closed code (the transport's own, a malformed answer's) is kept as it is; a provider's text is mapped as any refusal.
  const e = error instanceof BundlerError ? error : error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.message) ? new BundlerError(error.message)
    : bundlerRefusal(error instanceof Error ? error.message : 'USER_OPERATION_REJECTED');
  const m = e.detail ?? '';
  if (!/AA3[0-9]/.test(m)) return e;
  if (/AA3[3-4]/.test(m) && /signature|permit|EIP2612|expired/i.test(m)) return new BundlerError('CIRCLE_PERMIT_INVALID', m);
  if (/AA33/.test(m) && /balance|allowance|insufficient/i.test(m)) return new BundlerError('CIRCLE_INSUFFICIENT_USDC', m);
  if (/AA36/.test(m)) return new BundlerError('CIRCLE_PAYMASTER_GAS_INVALID', m);
  return new BundlerError('CIRCLE_PAYMASTER_REFUSED', m);
}
/** A JSON-RPC 2.0 client over HTTPS with a timeout, allowing exactly the bundler methods. */
export function bundlerRpc(url: string, fetchImpl: typeof fetch = fetch, timeoutMs = 15_000): Rpc {
  let id = 0;
  return async (method, params) => {
    if (!BUNDLER_METHODS.has(method)) throw new BundlerError('USER_OPERATION_RPC_METHOD_FORBIDDEN');
    if (method === 'eth_sendUserOperation') assertExecutionEnabled();
    const response = await fetchImpl(url, { method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) })
      .catch(() => { throw new BundlerError('USER_OPERATION_BUNDLER_UNAVAILABLE'); });
    const body = await response.json().catch(() => null) as { result?: unknown; error?: { message?: unknown; data?: unknown } } | null;
    if (!body) throw new BundlerError('USER_OPERATION_BUNDLER_UNAVAILABLE');
    if (body.error) {
      const data = typeof body.error.data === 'string' ? body.error.data : body.error.data && typeof body.error.data === 'object' ? JSON.stringify(body.error.data).slice(0, 200) : '';
      throw bundlerRefusal(`${typeof body.error.message === 'string' ? body.error.message : 'USER_OPERATION_REJECTED'} ${data}`.trim());
    }
    return body.result;
  };
}
export type BundlerClient = {
  readonly chainId: number;
  /** Refuses a bundler of another chain, or one serving neither EntryPoint v0.7 nor v0.8 (checked once per client; each call names its EntryPoint). */
  readonly verify: () => Promise<void>;
  readonly estimate: (op: erc4337.PackedUserOperation) => Promise<ReturnType<typeof erc4337.bundlerGasEstimate>>;
  /** Submits the owner-signed operation; the bundler answers with the EntryPoint `userOpHash`, which must match FloFi's own computation. */
  readonly send: (op: erc4337.PackedUserOperation) => Promise<string>;
  readonly receipt: (userOpHash: string) => Promise<erc4337.BundlerReceipt | null>;
  /** Whether the bundler still holds (or mined) the operation: null when unknown to it (dropped or never received). */
  readonly known: (userOpHash: string) => Promise<boolean>;
  /**
   * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (ADR-0010): an operation whose `paymasterAndData` names CIRCLE's paymaster pinned for this chain and
   * `entryPoint` (v0.7 or v0.8) — any other paymaster is still refused (ERC4337_SPONSORED_REFUSED) before anything is asked. The estimate includes the
   * paymaster's limits; the send checks the bundler's hash against FloFi's own (`getUserOpHash` of that EntryPoint). Absent on a test double that
   * models no paymaster: the caller then refuses (USER_OPERATION_BUNDLER_UNAVAILABLE).
   */
  readonly estimateCircle?: (op: erc4337.PackedUserOperation, entryPoint: string, eip7702Auth?: erc4337.SignedEip7702Authorization) =>
    Promise<ReturnType<typeof erc4337.bundlerPaymasterGasEstimate>>;
  /**
   * `eip7702Auth` (owner requirement: FloFi Wallet's first use): the owner's signed EIP-7702 authorization of the pinned `Simple7702Account` v0.8 on
   * this chain — sent exactly with an operation that carries the EIP-7702 initCode marker on EntryPoint v0.8 (the bundler then applies it in its own
   * type-4 transaction before validation), and refused with any other operation (ERC4337_EIP7702_AUTH_REFUSED).
   */
  readonly sendCircle?: (op: erc4337.PackedUserOperation, entryPoint: string, eip7702Auth?: erc4337.SignedEip7702Authorization) => Promise<string>;
  /**
   * ADR-0010 review (C3): whether the bundler serves `entryPoint` (its `eth_supportedEntryPoints`, read once per client and cached on success).
   * Throws the transport's closed code (or USER_OPERATION_ENTRY_POINT_UNSUPPORTED when it serves neither v0.7 nor v0.8). Asked before Circle is
   * offered, so the owner never signs a permit for an operation this bundler cannot carry.
   */
  readonly servesEntryPoint?: (entryPoint: string) => Promise<boolean>;
};
export function createBundlerClient(chainId: number, rpc: Rpc): BundlerClient {
  let verified: ReadonlySet<string> | null = null;
  // The bundler must serve this chain and EntryPoint v0.7 (FloFi's owner-paid operations) or v0.8 (Circle with a Simple7702Account); each
  // operation then names an EntryPoint the bundler reported, or nothing is asked of it.
  const verify = async () => {
    if (verified) return;
    const chain = await rpc('eth_chainId', []);
    if (typeof chain !== 'string' || !/^0x[0-9a-fA-F]+$/.test(chain) || BigInt(chain) !== BigInt(chainId)) throw new BundlerError('USER_OPERATION_BUNDLER_CHAIN_MISMATCH');
    const entryPoints = await rpc('eth_supportedEntryPoints', []);
    const known = new Set(Array.isArray(entryPoints) ? entryPoints.filter((e): e is string => typeof e === 'string').map(e => e.toLowerCase())
      .filter(e => e === erc4337.ENTRY_POINT_V0_7 || e === erc4337.ENTRY_POINT_V0_8) : []);
    if (!known.size) throw new BundlerError('USER_OPERATION_ENTRY_POINT_UNSUPPORTED');
    verified = known;
  };
  const served = async (entryPoint: string) => {
    await verify();
    if (!verified!.has(entryPoint.toLowerCase())) throw new BundlerError('USER_OPERATION_ENTRY_POINT_UNSUPPORTED');
  };
  /** Only Circle's paymaster pinned for this chain and EntryPoint; anything else is a sponsorship FloFi never relays. */
  const circleOnly = (op: erc4337.PackedUserOperation, entryPoint: string) => {
    const pinned = circlePaymaster.circlePaymasterOf(chainId, entryPoint);
    let named: string | null = null;
    try { named = erc4337.unpackPaymasterAndData(op.paymasterAndData)?.paymaster ?? null; } catch { /* malformed: refused below */ }
    if (!pinned || named !== pinned) throw new BundlerError('ERC4337_SPONSORED_REFUSED');
  };
  /**
   * The owner's authorization travels only with an operation that carries the EIP-7702 marker, and only one designating the pinned v0.8 delegate on
   * THIS chain for the EntryPoint that delegate serves (the wire format then checks it is the sender's own); anything else is refused before the
   * bundler is asked. Returns the delegate the operation is hashed with.
   */
  const upgradeOf = (op: erc4337.PackedUserOperation, entryPoint: string, auth: erc4337.SignedEip7702Authorization | undefined): string | undefined => {
    const marker = op.initCode.toLowerCase() === erc4337.EIP7702_INIT_CODE_MARKER;
    if (!marker && auth === undefined) return undefined;
    // The marker never travels without the owner's authorization (refused as any initCode, ERC4337_INIT_CODE_REFUSED).
    if (marker && auth === undefined) throw new BundlerError('ERC4337_INIT_CODE_REFUSED');
    if (!marker || !auth || auth.address.toLowerCase() !== erc4337.SIMPLE_7702_ACCOUNT_V0_8 || auth.chainId !== chainId
      || entryPoint.toLowerCase() !== erc4337.ENTRY_POINT_V0_8) throw new BundlerError('ERC4337_EIP7702_AUTH_REFUSED');
    return erc4337.SIMPLE_7702_ACCOUNT_V0_8;
  };
  return {
    chainId, verify,
    async servesEntryPoint(entryPoint) { await verify(); return verified!.has(entryPoint.toLowerCase()); },
    async estimate(op) { await served(erc4337.ENTRY_POINT_V0_7); return erc4337.bundlerGasEstimate(await rpc('eth_estimateUserOperationGas', [erc4337.toBundlerUserOperation(op), erc4337.ENTRY_POINT_V0_7])); },
    async estimateCircle(op, entryPoint, eip7702Auth) {
      await served(entryPoint);
      circleOnly(op, entryPoint);
      upgradeOf(op, entryPoint, eip7702Auth);
      let wire: erc4337.BundlerPaymasterUserOperation;
      try { wire = erc4337.toBundlerUserOperationWithPaymaster(op, eip7702Auth); } catch (cause) { throw new BundlerError(cause instanceof Error ? cause.message : 'ERC4337_EIP7702_AUTH_REFUSED'); }
      try { return erc4337.bundlerPaymasterGasEstimate(await rpc('eth_estimateUserOperationGas', [wire, entryPoint.toLowerCase()])); }
      catch (cause) { throw circleBundlerRefusal(cause); }
    },
    async sendCircle(op, entryPoint, eip7702Auth) {
      await served(entryPoint);
      circleOnly(op, entryPoint);
      const delegate = upgradeOf(op, entryPoint, eip7702Auth);
      if (!/^0x[0-9a-f]{130}$/.test(op.signature)) throw new BundlerError('USER_OPERATION_SIGNATURE_INVALID');
      let wire: erc4337.BundlerPaymasterUserOperation;
      try { wire = erc4337.toBundlerUserOperationWithPaymaster(op, eip7702Auth); } catch (cause) { throw new BundlerError(cause instanceof Error ? cause.message : 'ERC4337_EIP7702_AUTH_REFUSED'); }
      const expected = erc4337.userOpHashFor(op, chainId, entryPoint, delegate);
      assertExecutionEnabled();
      let hash: unknown;
      try { hash = await rpc('eth_sendUserOperation', [wire, entryPoint.toLowerCase()]); }
      catch (cause) { throw circleBundlerRefusal(cause); }
      if (typeof hash !== 'string' || hash.toLowerCase() !== expected) throw new BundlerError('USER_OPERATION_HASH_MISMATCH');
      return expected;
    },
    async send(op) {
      await served(erc4337.ENTRY_POINT_V0_7);
      erc4337.assertUserFundedOperation(op);
      if (!/^0x[0-9a-f]{130}$/.test(op.signature)) throw new BundlerError('USER_OPERATION_SIGNATURE_INVALID');
      const expected = erc4337.userOpHash(op, chainId);
      assertExecutionEnabled();
      const hash = await rpc('eth_sendUserOperation', [erc4337.toBundlerUserOperation(op), erc4337.ENTRY_POINT_V0_7]);
      // The bundler's identity of the operation must be FloFi's: anything else means a different operation was accepted.
      if (typeof hash !== 'string' || hash.toLowerCase() !== expected) throw new BundlerError('USER_OPERATION_HASH_MISMATCH');
      return expected;
    },
    async receipt(userOpHash) { await verify(); return erc4337.bundlerReceipt(await rpc('eth_getUserOperationReceipt', [userOpHash])); },
    async known(userOpHash) { await verify(); const found = await rpc('eth_getUserOperationByHash', [userOpHash]); return found !== null && found !== undefined; },
  };
}
