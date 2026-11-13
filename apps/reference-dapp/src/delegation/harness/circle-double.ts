// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (ADR-0010): a MOCKED loopback model of Circle's USDC paymaster, the ERC-4337 EntryPoints v0.7/v0.8 and
 * an ERC-4337 bundler, on top of the EVM chain double (`evm-double.ts`). Never a public network, never Circle's bytecode: what it proves is
 * FloFi's logic against Circle's documented semantics, nothing about Circle's live behaviour.
 *
 *   chain        the EVM double's RPC plus what Circle's path reads: `EntryPoint.getNonce` (v0.7 and v0.8, `key << 64 | sequence`), the
 *                paymaster's code, `entryPoint()` and `additionalGasCharge()`, USDC's `name()`/`version()` (`USD Coin`/`2`) and `nonces(owner)`.
 *                `unverified` makes the paymaster or USDC contradict FloFi's pins (no code, another EntryPoint, another permit domain).
 *   bundler      a JSON-RPC double behind FloFi's own `createBundlerClient` (the real allowlist, wire format and hash check): it validates an
 *                operation as the EntryPoint would — an `eip7702Auth` is applied first, as the bundler's own type-4 transaction applies it (EIP-7702:
 *                the tuple's signer is the account, its chain this one or 0, its nonce the account's current one; else the tuple is skipped), and
 *                persisted on send (the account's code becomes `0xef0100 ‖ address`, its nonce moves) — then the owner account's 7702 delegate
 *                must serve the EntryPoint asked for (an operation with the EIP-7702 marker is hashed with that delegate); the key's nonce; on
 *                send, the owner's signature in the account's own scheme (DeleGator domain on v0.7, the EntryPoint's typed hash on v0.8); the
 *                paymaster must be Circle's for this chain and EntryPoint; its paymasterData's EIP-2612 permit must recover to the owner over
 *                USDC's domain with the owner's current permit nonce; the USDC prefund (the operation's worst-case gas at Circle's price plus its
 *                10 % surcharge) must fit the permit's allowance and the owner's USDC balance — refusals are the EntryPoint's AA3x/AA2x texts.
 *   execution    on send, one mined bundle (`entryPointOperation`): the permit (allowance set, nonce consumed, `Approval`), the prefund pulled
 *                from the owner (`Transfer` owner → paymaster), `BeforeExecution`, the calls as the owner's account, the postOp refund of what
 *                the actual gas did not use (`Transfer` paymaster → owner), the `UserOperationEvent` naming the paymaster.
 */
import { circlePaymaster as C, erc4337, erc7710 } from '@defi-workflow-engine/reference-compiler';
import { bundlerRefusal, createBundlerClient, type BundlerClient } from '../../user-funded/bundler.ts';
import type { EvmDouble } from './evm-double.ts';

const TRANSFER = erc7710.keccakHex('Transfer(address,address,uint256)'), APPROVAL = erc7710.keccakHex('Approval(address,address,uint256)');
const word = (v: bigint) => '0x' + v.toString(16).padStart(64, '0');
const topic = (a: string) => '0x' + a.toLowerCase().slice(2).padStart(64, '0');
const hex = (v: bigint) => '0x' + v.toString(16);
const abiString = (text: string) => erc7710.hexOf(erc7710.abiEncode(['bytes'], ['0x' + Buffer.from(text).toString('hex')]));
const BUNDLER = '0x' + 'b0'.repeat(20);

export type CircleDoubleOptions = {
  readonly chainId: number;
  /** Circle's price: USDC base units per 1 ETH (default 3,000 USDC) and its surcharge (default 10 %). */
  readonly usdcPerEth?: bigint; readonly surchargeBps?: bigint;
  readonly additionalGasCharge?: bigint | null;
  readonly supportedEntryPoints?: readonly string[];
  /** What the bundler's estimate answers (padded by FloFi). */
  readonly estimate?: { readonly verificationGasLimit: bigint; readonly callGasLimit: bigint; readonly preVerificationGas: bigint; readonly paymasterVerificationGasLimit: bigint;
    readonly paymasterPostOpGasLimit: bigint };
  /** The gas an executed operation actually used, and its price (the EntryPoint's `actualGasCost` = their product). */
  readonly actualGasUsed?: bigint; readonly gasPrice?: bigint;
};
export type CircleDouble = ReturnType<typeof createCircleDouble>;

export function createCircleDouble(evm: EvmDouble, options: CircleDoubleOptions) {
  const chainId = options.chainId, pins = C.circlePinsOf(chainId) ?? (() => { throw new Error('CIRCLE_CHAIN_NOT_MODELED'); })();
  const usdc = pins.usdc, usdcPerEth = options.usdcPerEth ?? 3_000_000_000n, surcharge = options.surchargeBps ?? 1_000n;
  const permitNonces = new Map<string, bigint>(), entryPointNonces = new Map<string, bigint>();
  const operations = new Map<string, { readonly txHash: string | null; readonly sender: string; readonly nonce: bigint }>();
  let unverified: 'NO_CODE' | 'WRONG_ENTRY_POINT' | 'WRONG_DOMAIN' | null = null, dropNext = false, sends = 0, estimates = 0, entryPointQueries = 0;
  let additional = options.additionalGasCharge === undefined ? 40_000n : options.additionalGasCharge;
  const paymasterEntryPoint = (paymaster: string) => Object.entries(pins.paymasters).find(([, pm]) => pm === paymaster.toLowerCase())?.[0] ?? null;
  const prefundOf = (nativeWei: bigint) => (nativeWei * usdcPerEth * (10_000n + surcharge) + 10n ** 18n * 10_000n - 1n) / (10n ** 18n * 10_000n);
  const nonceKey = (entryPoint: string, sender: string, key: bigint) => `${entryPoint}:${sender.toLowerCase()}:${key}`;

  // ── The chain RPC (FloFi's read transport wraps it) ──────────────────────────────────────────────────────────────────────
  const rpc = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    const p = params as unknown[];
    if (method === 'eth_getCode') {
      const address = String(p[0]).toLowerCase();
      if (paymasterEntryPoint(address)) return unverified === 'NO_CODE' ? '0x' : '0x6080';
    }
    if (method === 'eth_call') {
      const call = p[0] as { to: string; data: string }, to = call.to.toLowerCase(), selector = call.data.slice(0, 10);
      if ((to === erc4337.ENTRY_POINT_V0_7 || to === erc4337.ENTRY_POINT_V0_8) && selector === erc4337.GET_NONCE_SELECTOR) {
        const sender = '0x' + call.data.slice(34, 74), key = BigInt('0x' + call.data.slice(74, 138));
        return word((key << 64n) | (entryPointNonces.get(nonceKey(to, sender, key)) ?? 0n));
      }
      const ep = paymasterEntryPoint(to);
      if (ep && selector === C.CIRCLE_SELECTORS.entryPoint) return word(BigInt(unverified === 'WRONG_ENTRY_POINT' ? '0x' + '5f'.repeat(20) : ep));
      if (ep && selector === C.CIRCLE_SELECTORS.additionalGasCharge) { if (additional === null) throw new Error('execution reverted'); return word(additional); }
      if (to === usdc && selector === C.CIRCLE_SELECTORS.name) return abiString(unverified === 'WRONG_DOMAIN' ? 'USDC' : C.CIRCLE_USDC_PERMIT_DOMAIN.name);
      if (to === usdc && selector === C.CIRCLE_SELECTORS.version) return abiString(C.CIRCLE_USDC_PERMIT_DOMAIN.version);
      if (to === usdc && selector === C.CIRCLE_SELECTORS.nonces) return word(permitNonces.get('0x' + call.data.slice(34, 74)) ?? 0n);
    }
    return evm.rpc(method, params);
  };

  // ── The bundler (JSON-RPC behind FloFi's own client) ─────────────────────────────────────────────────────────────────────
  type Checked = { readonly op: erc4337.PackedUserOperation; readonly kind: erc4337.OwnerAccountKind; readonly paymaster: string; readonly data: C.CirclePaymasterData;
    readonly prefund: bigint; readonly delegate: string | undefined; readonly applyAuthorization: () => void };
  let authorizationsApplied = 0;
  async function validate(rpcOp: erc4337.RpcUserOperation & { readonly eip7702Auth?: unknown }, entryPoint: string, send: boolean): Promise<Checked> {
    const ep = entryPoint.toLowerCase(), refuse = (text: string): never => { throw bundlerRefusal(text); };
    const op = erc4337.packRpcUserOperation(rpcOp), sender = op.sender.toLowerCase();
    let code = String(await evm.rpc('eth_getCode', [sender, 'latest'])).toLowerCase(), applyAuthorization = () => { /* no authorization */ };
    // EIP-7702 in the bundler's own type-4 transaction, BEFORE the EntryPoint runs: a valid tuple of the sender sets its code; an invalid one is
    // skipped by the chain (the account then stays as it was and the operation fails validation below).
    if (rpcOp.eip7702Auth !== undefined) {
      let signed: erc4337.SignedEip7702Authorization | null, signer = '';
      try { signed = erc4337.fromBundlerEip7702Auth(rpcOp.eip7702Auth); signer = erc4337.recoverEip7702AuthorizationSigner(signed); } catch { signed = null; }
      const accountNonce = BigInt(String(await evm.rpc('eth_getTransactionCount', [sender, 'latest'])));
      const delegatable = code === '0x' || code.startsWith('0xef0100');
      if (signed && signer === sender && (signed.chainId === chainId || signed.chainId === 0) && signed.nonce === accountNonce && delegatable) {
        const designated = '0xef0100' + signed.address.slice(2).toLowerCase();
        code = designated;
        applyAuthorization = () => { evm.control.setCode(sender, designated); evm.control.setNonce(sender, accountNonce + 1n); authorizationsApplied += 1; };
      }
    }
    const kind = erc4337.ownerAccountKindOfCode(code);
    // EntryPoint v0.8 hashes an operation carrying the EIP-7702 marker with the sender's delegate, and reverts when the sender has none.
    const marker = op.initCode.toLowerCase() === erc4337.EIP7702_INIT_CODE_MARKER, delegate = marker ? kind ? erc4337.OWNER_ACCOUNT_KINDS[kind].delegate : null : undefined;
    if (!kind || delegate === null) return refuse('AA20 account not deployed');
    if (!marker && op.initCode !== '0x') return refuse('AA10 sender already constructed');
    // A delegate validates for its own EntryPoint only (the DeleGator's is immutable v0.7; Simple7702Account's v0.8).
    if (erc4337.OWNER_ACCOUNT_KINDS[kind].entryPoint !== ep) return refuse('AA23 reverted: not from EntryPoint');
    const { key, sequence } = erc4337.userOpNonceParts(op.nonce);
    if ((entryPointNonces.get(nonceKey(ep, sender, key)) ?? 0n) !== sequence) return refuse('AA25 invalid account nonce');
    // Both pinned accounts validate with OpenZeppelin's ECDSA.recover: a malformed or high-s signature REVERTS (estimation included); a canonical
    // one of another key only fails validation (tolerated by estimation, refused on send).
    try { erc7710.recoverDigestSigner(erc4337.userOpHashFor(op, chainId, ep, delegate), op.signature); } catch { return refuse('AA23 reverted: ECDSAInvalidSignature'); }
    if (send) {
      const valid = kind === 'SIMPLE_7702_V0_8' ? erc4337.verifyOwnerUserOpSignatureV08(chainId, op, op.signature, ep, delegate)
        : erc4337.verifyOwnerUserOpSignature(chainId, op, op.signature, ep);
      if (!valid) return refuse('AA24 signature error');
    }
    const pm = erc4337.unpackPaymasterAndData(op.paymasterAndData);
    if (!pm || pm.paymaster !== C.circlePaymasterOf(chainId, ep)) return refuse('AA30 paymaster not deployed');
    let data: C.CirclePaymasterData;
    try { data = C.decodeCirclePaymasterData(pm.data); } catch { return refuse('AA33 reverted: invalid paymaster data'); }
    if (data.token !== usdc) return refuse('AA33 reverted: unsupported token');
    const permit = { chainId, token: usdc, owner: sender, spender: pm.paymaster, value: data.permitAmount, nonce: permitNonces.get(sender) ?? 0n, deadline: C.CIRCLE_PERMIT_DEADLINE };
    let signer = '';
    try { signer = C.recoverPermitSigner(permit, data.permitSignature); } catch { /* invalid */ }
    if (signer !== sender) return refuse('AA33 reverted: EIP2612: invalid signature');
    const prefund = prefundOf(C.circleMaxNativeCost(erc4337.userOperationGas(op), pm));
    if (data.permitAmount < prefund) return refuse('AA33 reverted: ERC20: transfer amount exceeds allowance');
    if (evm.control.tokenBalance(usdc, sender) < prefund) return refuse('AA33 reverted: ERC20: transfer amount exceeds balance');
    return { op, kind, paymaster: pm.paymaster, data, prefund, delegate, applyAuthorization };
  }
  const usdcTransfer = (from: string, to: string, amount: bigint) => {
    evm.control.fundToken(from, usdc, evm.control.tokenBalance(usdc, from) - amount);
    evm.control.fundToken(to, usdc, evm.control.tokenBalance(usdc, to) + amount);
    return { address: usdc, topics: [TRANSFER, topic(from), topic(to)], data: word(amount) };
  };
  async function send(rpcOp: erc4337.RpcUserOperation, entryPoint: string): Promise<string> {
    const ep = entryPoint.toLowerCase(), c = await validate(rpcOp, ep, true), sender = c.op.sender.toLowerCase();
    const userOpHash = erc4337.userOpHashFor(c.op, chainId, ep, c.delegate), { key } = erc4337.userOpNonceParts(c.op.nonce);
    sends += 1;
    if (dropNext) { dropNext = false; return userOpHash; } // accepted, then lost: never mined, unknown to the bundler afterwards
    // The bundle's type-4 transaction applies the owner's authorization first (persisted whatever the operation's own outcome).
    c.applyAuthorization();
    const calls = erc4337.decodeOwnerAccountCallData(c.kind, c.op.callData);
    const actualGasCost = (options.actualGasUsed ?? 180_000n) * (options.gasPrice ?? 1_000_000_000n), charge = prefundOf(actualGasCost);
    const txHash = evm.control.entryPointOperation(sender, calls, { entryPoint: ep, userOpHash, paymaster: c.paymaster, bundler: BUNDLER, nonce: c.op.nonce, actualGasCost,
      validation: () => {
        // The paymaster's validation: USDC.permit (sets the allowance, consumes the nonce), then the prefund pulled against it.
        permitNonces.set(sender, (permitNonces.get(sender) ?? 0n) + 1n);
        evm.control.setAllowance(usdc, sender, c.paymaster, c.data.permitAmount - c.prefund);
        return [{ address: usdc, topics: [APPROVAL, topic(sender), topic(c.paymaster)], data: word(c.data.permitAmount) }, usdcTransfer(sender, c.paymaster, c.prefund)];
      },
      postOp: () => c.prefund > charge ? [usdcTransfer(c.paymaster, sender, c.prefund - charge)] : [] });
    entryPointNonces.set(nonceKey(ep, sender, key), (entryPointNonces.get(nonceKey(ep, sender, key)) ?? 0n) + 1n);
    operations.set(userOpHash, { txHash, sender, nonce: c.op.nonce });
    return userOpHash;
  }
  const bundlerRpc = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    const p = params as unknown[];
    switch (method) {
      case 'eth_chainId': return hex(BigInt(chainId));
      case 'eth_supportedEntryPoints': entryPointQueries += 1; return [...options.supportedEntryPoints ?? [erc4337.ENTRY_POINT_V0_7, erc4337.ENTRY_POINT_V0_8]];
      case 'eth_estimateUserOperationGas': {
        estimates += 1;
        await validate(p[0] as erc4337.RpcUserOperation, String(p[1]), false);
        const e = options.estimate ?? { verificationGasLimit: 110_000n, callGasLimit: 160_000n, preVerificationGas: 60_000n, paymasterVerificationGasLimit: 120_000n,
          paymasterPostOpGasLimit: 30_000n };
        return { verificationGasLimit: hex(e.verificationGasLimit), callGasLimit: hex(e.callGasLimit), preVerificationGas: hex(e.preVerificationGas),
          paymasterVerificationGasLimit: hex(e.paymasterVerificationGasLimit), paymasterPostOpGasLimit: hex(e.paymasterPostOpGasLimit) };
      }
      case 'eth_sendUserOperation': return send(p[0] as erc4337.RpcUserOperation, String(p[1]));
      case 'eth_getUserOperationReceipt': {
        const known = operations.get(String(p[0]).toLowerCase()), receipt = known?.txHash ? evm.control.receipt(known.txHash) : null;
        if (!known || !receipt) return null;
        const event = receipt.logs.find(l => l.topics[0] === erc4337.USER_OPERATION_EVENT_TOPIC && l.topics[1] === String(p[0]).toLowerCase());
        const words = event ? event.data.slice(2).match(/.{64}/g)!.map(w => BigInt('0x' + w)) : [0n, 0n, 0n, 0n];
        return { userOpHash: String(p[0]).toLowerCase(), sender: known.sender, nonce: hex(known.nonce), success: words[1] === 1n, actualGasCost: hex(words[2]!),
          actualGasUsed: hex(words[3]!), receipt: { transactionHash: known.txHash, blockNumber: hex(BigInt(receipt.blockNumber)), logs: receipt.logs } };
      }
      case 'eth_getUserOperationByHash': return operations.has(String(p[0]).toLowerCase()) ? { userOperation: {} } : null;
      default: throw bundlerRefusal('method not found');
    }
  };
  const bundler: BundlerClient = createBundlerClient(chainId, bundlerRpc);
  return { rpc, bundler, bundlerRpc,
    control: {
      /** The owner's USDC permit nonce (FiatToken `nonces`), and another permit of the owner consuming it (a permit signed for FloFi is then dead). */
      permitNonce: (owner: string) => permitNonces.get(owner.toLowerCase()) ?? 0n,
      usePermitNonce(owner: string) { permitNonces.set(owner.toLowerCase(), (permitNonces.get(owner.toLowerCase()) ?? 0n) + 1n); },
      setUnverified(mode: 'NO_CODE' | 'WRONG_ENTRY_POINT' | 'WRONG_DOMAIN' | null) { unverified = mode; },
      setAdditionalGasCharge(value: bigint | null) { additional = value; },
      /** The next accepted operation is lost (never mined, then unknown to the bundler): FloFi must resend the same bytes, never others. */
      dropNextSend() { dropNext = true; },
      sends: () => sends, estimates: () => estimates,
      /** How many EIP-7702 authorizations a mined bundle applied (an owner's first-use upgrade). */
      authorizationsApplied: () => authorizationsApplied,
      /** How many times the bundler was asked which EntryPoints it serves (FloFi's client caches the answer per process). */
      entryPointQueries: () => entryPointQueries,
      receiptOf: (userOpHash: string) => { const o = operations.get(userOpHash.toLowerCase()); return o?.txHash ? evm.control.receipt(o.txHash) : null; },
      prefundOf,
    } };
}
