// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: the ERC-4337 v0.7 bundler transport — a closed method allowlist in front of a JSON-RPC endpoint, and the
 * mapping of a bundler's refusals to FloFi's closed codes. A bundler only transmits operations the owner signed; it is repaid by the
 * EntryPoint from the owner account's own prefund. Nothing here signs, holds bytes beyond the call, or chooses a chain.
 */
import { erc4337 } from '@defi-workflow-engine/reference-compiler';

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
/** A JSON-RPC 2.0 client over HTTPS with a timeout, allowing exactly the bundler methods. */
export function bundlerRpc(url: string, fetchImpl: typeof fetch = fetch, timeoutMs = 15_000): Rpc {
  let id = 0;
  return async (method, params) => {
    if (!BUNDLER_METHODS.has(method)) throw new BundlerError('USER_OPERATION_RPC_METHOD_FORBIDDEN');
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
  /** Refuses a bundler that does not serve EntryPoint v0.7 or another chain (checked once per client). */
  readonly verify: () => Promise<void>;
  readonly estimate: (op: erc4337.PackedUserOperation) => Promise<ReturnType<typeof erc4337.bundlerGasEstimate>>;
  /** Submits the owner-signed operation; the bundler answers with the EntryPoint `userOpHash`, which must match FloFi's own computation. */
  readonly send: (op: erc4337.PackedUserOperation) => Promise<string>;
  readonly receipt: (userOpHash: string) => Promise<erc4337.BundlerReceipt | null>;
  /** Whether the bundler still holds (or mined) the operation: null when unknown to it (dropped or never received). */
  readonly known: (userOpHash: string) => Promise<boolean>;
};
export function createBundlerClient(chainId: number, rpc: Rpc): BundlerClient {
  let verified = false;
  const verify = async () => {
    if (verified) return;
    const chain = await rpc('eth_chainId', []);
    if (typeof chain !== 'string' || !/^0x[0-9a-fA-F]+$/.test(chain) || BigInt(chain) !== BigInt(chainId)) throw new BundlerError('USER_OPERATION_BUNDLER_CHAIN_MISMATCH');
    const entryPoints = await rpc('eth_supportedEntryPoints', []);
    if (!Array.isArray(entryPoints) || !entryPoints.some(e => typeof e === 'string' && e.toLowerCase() === erc4337.ENTRY_POINT_V0_7)) throw new BundlerError('USER_OPERATION_ENTRY_POINT_UNSUPPORTED');
    verified = true;
  };
  return {
    chainId, verify,
    async estimate(op) { await verify(); return erc4337.bundlerGasEstimate(await rpc('eth_estimateUserOperationGas', [erc4337.toBundlerUserOperation(op), erc4337.ENTRY_POINT_V0_7])); },
    async send(op) {
      await verify();
      erc4337.assertUserFundedOperation(op);
      if (!/^0x[0-9a-f]{130}$/.test(op.signature)) throw new BundlerError('USER_OPERATION_SIGNATURE_INVALID');
      const expected = erc4337.userOpHash(op, chainId);
      const hash = await rpc('eth_sendUserOperation', [erc4337.toBundlerUserOperation(op), erc4337.ENTRY_POINT_V0_7]);
      // The bundler's identity of the operation must be FloFi's: anything else means a different operation was accepted.
      if (typeof hash !== 'string' || hash.toLowerCase() !== expected) throw new BundlerError('USER_OPERATION_HASH_MISMATCH');
      return expected;
    },
    async receipt(userOpHash) { await verify(); return erc4337.bundlerReceipt(await rpc('eth_getUserOperationReceipt', [userOpHash])); },
    async known(userOpHash) { await verify(); const found = await rpc('eth_getUserOperationByHash', [userOpHash]); return found !== null && found !== undefined; },
  };
}
