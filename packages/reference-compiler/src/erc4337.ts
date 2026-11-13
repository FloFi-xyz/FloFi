// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: ERC-4337 v0.7 user operations of the owner's OWN account (a MetaMask EIP-7702 smart account,
 * `EIP7702StatelessDeleGator` v1.3.0) — pure packing, hashing and the account's EIP-712 digest. Nothing here holds a key or sends anything.
 *
 * Why: the owner's account is the user operation's `sender`, so the EntryPoint takes the operation's gas from the owner's own balance
 * (`_payPrefund`), never from a FloFi-controlled address. A bundler only transmits the operation and is repaid by the EntryPoint from that
 * prefund (the protocol's own refund, never FloFi's). The call data is the account's `execute(mode, executions)` of exactly the workflow's
 * calls on that chain, atomic (one revert undoes every call), with no delegation, no caveats, no paymaster and no session signer: what the
 * owner's wallet signs IS the whole authority, and the operation's nonce makes it usable once, ever.
 *
 * Sources (read at MetaMask/delegation-framework main, v1.3.0 contracts): `src/EIP7702/EIP7702DeleGatorCore.sol` (`validateUserOp` verifies
 * the signature over `getPackedUserOperationTypedDataHash`, an EIP-712 digest of the PackedUserOperation with the ACCOUNT's own domain — not
 * the EntryPoint's `userOpHash`; `execute(ModeCode, bytes)` is `onlyEntryPointOrSelf`; `_payPrefund` pays the EntryPoint from the account),
 * `src/EIP7702/EIP7702StatelessDeleGator.sol` (domain name `EIP7702StatelessDeleGator`, version `1`; `_isValidSignature` = ECDSA recovery to
 * `address(this)`), `.env.example` (`ENTRYPOINT_ADDRESS` = EntryPoint v0.7), ERC-7579 `ModeLib` (call type 0x01 = batch, exec type 0x00 =
 * revert on failure) and `ExecutionLib` (`abi.encode(Execution[])`), and ERC-4337 v0.7 `UserOperationLib` (packed gas words, `getUserOpHash`).
 */
import { abiDecode, abiEncode, bytesOf, DELEGATION_FRAMEWORK_V1_3, EIP712_DOMAIN_TYPEHASH, evmAddress, hexOf, keccakHex, recoverDigestSigner, selectorOf, word,
  type Call } from './erc7710.js';
import { rlpEncode, rlpInteger } from './rlp.js';

function fail(code: string): never { throw new Error(code); }
const concat = (...parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
const UINT128_MAX = (1n << 128n) - 1n, UINT192_MAX = (1n << 192n) - 1n, UINT64_MAX = (1n << 64n) - 1n, UINT256_MAX = (1n << 256n) - 1n;
const uint = (value: unknown, max: bigint, code: string): bigint => typeof value === 'bigint' && value >= 0n && value <= max ? value : fail(code);
const HEX = /^0x(?:[0-9a-f]{2})*$/;
const data = (value: unknown, code: string): string => typeof value === 'string' && HEX.test(value.toLowerCase()) ? value.toLowerCase() : fail(code);

// ── EntryPoint v0.7 and the account's execute interface ─────────────────────────────────────────────────────────────────────
/** The canonical ERC-4337 v0.7 EntryPoint (the one the v1.3.0 delegator deployments are constructed with). */
export const ENTRY_POINT_V0_7 = '0x0000000071727de22e5e9d8baf0edac6f37da032';
/** The delegator implementation an upgraded owner account designates (`0xef0100 ‖ this`). */
export const DELEGATOR_IMPLEMENTATION = DELEGATION_FRAMEWORK_V1_3.eip7702StatelessDeleGator;
/** ERC-7821 / ERC-7579 `execute(bytes32 mode, bytes executionCalldata)`. */
export const EXECUTE_SELECTOR = selectorOf('execute(bytes32,bytes)');
/** ERC-7579 ModeCode: call type 0x01 (batch), exec type 0x00 (revert on the first failure), no selector, no payload. */
export const MODE_BATCH_DEFAULT = '0x01' + '00'.repeat(31);
/** ERC-7579 ModeCode: call type 0x00 (single), exec type 0x00. */
export const MODE_SINGLE_DEFAULT = '0x' + '00'.repeat(32);
export const MAX_BATCH_CALLS = 16;
const EXECUTION_TUPLE = { tuple: ['address', 'uint256', 'bytes'] } as const;

function call(c: Call): Call { return { target: evmAddress(c.target), value: uint(c.value, UINT256_MAX, 'ERC4337_CALL_INVALID'), data: data(c.data, 'ERC4337_CALL_INVALID') }; }
/** `ExecutionLib.encodeBatch`: `abi.encode(Execution[] { target, value, callData })`. */
export function encodeBatchExecutions(calls: readonly Call[]): string {
  if (!Array.isArray(calls) || !calls.length || calls.length > MAX_BATCH_CALLS) fail('ERC4337_BATCH_INVALID');
  return hexOf(abiEncode([{ array: EXECUTION_TUPLE }], [calls.map(c => { const x = call(c); return [x.target, x.value, x.data]; })]));
}
export function decodeBatchExecutions(executionCalldata: string): Call[] {
  const [items] = abiDecode([{ array: EXECUTION_TUPLE }], bytesOf(executionCalldata)) as [[string, bigint, string][]];
  if (!items.length || items.length > MAX_BATCH_CALLS) fail('ERC4337_BATCH_INVALID');
  return items.map(([target, value, calldata]) => ({ target, value, data: calldata }));
}
/** The account's `execute(MODE_BATCH_DEFAULT, encodeBatch(calls))`: every call of the workflow on this chain, in order, atomically. */
export function batchCallData(calls: readonly Call[]): string {
  return EXECUTE_SELECTOR + hexOf(abiEncode(['bytes32', 'bytes'], [MODE_BATCH_DEFAULT, encodeBatchExecutions(calls)])).slice(2);
}
/** The exact calls a batch call data executes, read back from the bytes alone (display, verification), else a closed refusal. */
export function decodeBatchCallData(callData: string): Call[] {
  const hex = data(callData, 'ERC4337_CALLDATA_INVALID');
  if (!hex.startsWith(EXECUTE_SELECTOR)) fail('ERC4337_CALLDATA_INVALID');
  const [mode, executions] = abiDecode(['bytes32', 'bytes'], bytesOf('0x' + hex.slice(10))) as [string, string];
  if (mode !== MODE_BATCH_DEFAULT) fail('ERC4337_MODE_UNSUPPORTED');
  return decodeBatchExecutions(executions);
}

// ── PackedUserOperation (v0.7) ───────────────────────────────────────────────────────────────────────────────────────────────
/** The on-chain struct the EntryPoint receives and the account hashes. `initCode` and `paymasterAndData` are always empty here. */
export type PackedUserOperation = {
  readonly sender: string; readonly nonce: bigint; readonly initCode: string; readonly callData: string; readonly accountGasLimits: string;
  readonly preVerificationGas: bigint; readonly gasFees: string; readonly paymasterAndData: string; readonly signature: string;
};
export type UserOperationGas = { readonly verificationGasLimit: bigint; readonly callGasLimit: bigint; readonly preVerificationGas: bigint;
  readonly maxPriorityFeePerGas: bigint; readonly maxFeePerGas: bigint };
/** `bytes32(uint256(high) << 128 | low)`. */
export function packUints(high: bigint, low: bigint): string {
  return hexOf(word((uint(high, UINT128_MAX, 'ERC4337_GAS_INVALID') << 128n) | uint(low, UINT128_MAX, 'ERC4337_GAS_INVALID')));
}
export function unpackUints(packed: string): readonly [bigint, bigint] {
  const bytes = bytesOf(data(packed, 'ERC4337_GAS_INVALID'));
  if (bytes.length !== 32) fail('ERC4337_GAS_INVALID');
  const value = BigInt(hexOf(bytes));
  return [value >> 128n, value & UINT128_MAX];
}
/**
 * A user operation of the owner's own account: no factory (the account exists: the owner's EIP-7702 designator), no paymaster (FloFi never
 * sponsors; the account pays its own prefund), the exact batch call data and the gas words the owner signs (the maximum they can be charged).
 */
export function packedUserOperation(input: { readonly sender: string; readonly nonce: bigint; readonly callData: string; readonly gas: UserOperationGas;
  readonly signature?: string }): PackedUserOperation {
  const g = input.gas;
  return { sender: evmAddress(input.sender), nonce: uint(input.nonce, UINT256_MAX, 'ERC4337_NONCE_INVALID'), initCode: '0x', callData: data(input.callData, 'ERC4337_CALLDATA_INVALID'),
    accountGasLimits: packUints(g.verificationGasLimit, g.callGasLimit), preVerificationGas: uint(g.preVerificationGas, UINT128_MAX, 'ERC4337_GAS_INVALID'),
    gasFees: packUints(g.maxPriorityFeePerGas, g.maxFeePerGas), paymasterAndData: '0x', signature: input.signature === undefined ? '0x' : data(input.signature, 'ERC4337_SIGNATURE_INVALID') };
}
export function userOperationGas(op: PackedUserOperation): UserOperationGas {
  const [verificationGasLimit, callGasLimit] = unpackUints(op.accountGasLimits), [maxPriorityFeePerGas, maxFeePerGas] = unpackUints(op.gasFees);
  return { verificationGasLimit, callGasLimit, preVerificationGas: op.preVerificationGas, maxPriorityFeePerGas, maxFeePerGas };
}
/** Refuses any operation that is not the shape FloFi signs: own account, no factory, no paymaster (`ERC4337_SPONSORED_REFUSED`), sane fees. */
export function assertUserFundedOperation(op: PackedUserOperation): void {
  evmAddress(op.sender);
  if (data(op.initCode, 'ERC4337_INIT_CODE_REFUSED') !== '0x') fail('ERC4337_INIT_CODE_REFUSED');
  if (data(op.paymasterAndData, 'ERC4337_SPONSORED_REFUSED') !== '0x') fail('ERC4337_SPONSORED_REFUSED');
  const gas = userOperationGas(op);
  if (gas.maxPriorityFeePerGas > gas.maxFeePerGas || gas.maxFeePerGas === 0n || gas.callGasLimit === 0n || gas.verificationGasLimit === 0n) fail('ERC4337_GAS_INVALID');
  decodeBatchCallData(op.callData);
}
/**
 * `EntryPoint.getUserOpHash` (v0.7): the bundler's and the receipt's identity of the operation (`UserOperationEvent.userOpHash`). The owner's
 * account does NOT sign this hash (see `delegatorUserOpDigest`).
 */
export function userOpHash(op: PackedUserOperation, chainId: number, entryPoint = ENTRY_POINT_V0_7): string {
  const inner = keccakHex(abiEncode(['address', 'uint256', 'bytes32', 'bytes32', 'bytes32', 'uint256', 'bytes32', 'bytes32'],
    [evmAddress(op.sender), op.nonce, keccakHex(bytesOf(op.initCode)), keccakHex(bytesOf(op.callData)), op.accountGasLimits, op.preVerificationGas, op.gasFees,
      keccakHex(bytesOf(op.paymasterAndData))]));
  return keccakHex(abiEncode(['bytes32', 'address', 'uint256'], [inner, evmAddress(entryPoint), BigInt(chainId)]));
}
/** The most the EntryPoint can take from the account for this operation (`requiredPrefund`, no paymaster): gas limits × `maxFeePerGas`. */
export function maxPrefund(gas: UserOperationGas): bigint {
  return (gas.verificationGasLimit + gas.callGasLimit + gas.preVerificationGas) * gas.maxFeePerGas;
}

// ── The delegator account's EIP-712 digest (what the owner's wallet signs) ──────────────────────────────────────────────────
export const DELEGATOR_DOMAIN = Object.freeze({ name: 'EIP7702StatelessDeleGator', version: '1' });
export const PACKED_USER_OP_TYPEHASH = keccakHex('PackedUserOperation(address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,'
  + 'uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,address entryPoint)');
/** `EIP712._domainSeparatorV4()` of the owner's own account: `verifyingContract` is the owner's address (the delegated EOA). */
export function delegatorDomainSeparator(chainId: number, account: string): string {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) fail('ERC4337_CHAIN_INVALID');
  return keccakHex(abiEncode(['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'],
    [EIP712_DOMAIN_TYPEHASH, keccakHex(DELEGATOR_DOMAIN.name), keccakHex(DELEGATOR_DOMAIN.version), BigInt(chainId), evmAddress(account)]));
}
/** `getPackedUserOperationHash`: the struct hash, including the account's immutable `entryPoint`. */
export function delegatorUserOpStructHash(op: PackedUserOperation, entryPoint = ENTRY_POINT_V0_7): string {
  return keccakHex(abiEncode(['bytes32', 'address', 'uint256', 'bytes32', 'bytes32', 'bytes32', 'uint256', 'bytes32', 'bytes32', 'address'],
    [PACKED_USER_OP_TYPEHASH, evmAddress(op.sender), op.nonce, keccakHex(bytesOf(op.initCode)), keccakHex(bytesOf(op.callData)), op.accountGasLimits, op.preVerificationGas,
      op.gasFees, keccakHex(bytesOf(op.paymasterAndData)), evmAddress(entryPoint)]));
}
/** `getPackedUserOperationTypedDataHash`: `0x1901 ‖ domainSeparator(account) ‖ structHash` — what `validateUserOp` recovers the owner from. */
export function delegatorUserOpDigest(chainId: number, op: PackedUserOperation, entryPoint = ENTRY_POINT_V0_7): string {
  return keccakHex(concat(Uint8Array.of(0x19, 0x01), bytesOf(delegatorDomainSeparator(chainId, op.sender)), bytesOf(delegatorUserOpStructHash(op, entryPoint))));
}
/** The `eth_signTypedData_v4` payload of the operation (the wallet shows every field; FloFi shows the decoded calls beside it). */
export function delegatorUserOpTypedData(chainId: number, op: PackedUserOperation, entryPoint = ENTRY_POINT_V0_7) {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) fail('ERC4337_CHAIN_INVALID');
  return {
    types: {
      EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
      PackedUserOperation: [{ name: 'sender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'initCode', type: 'bytes' }, { name: 'callData', type: 'bytes' },
        { name: 'accountGasLimits', type: 'bytes32' }, { name: 'preVerificationGas', type: 'uint256' }, { name: 'gasFees', type: 'bytes32' },
        { name: 'paymasterAndData', type: 'bytes' }, { name: 'entryPoint', type: 'address' }],
    },
    primaryType: 'PackedUserOperation' as const,
    domain: { name: DELEGATOR_DOMAIN.name, version: DELEGATOR_DOMAIN.version, chainId, verifyingContract: evmAddress(op.sender) },
    message: { sender: evmAddress(op.sender), nonce: op.nonce.toString(), initCode: op.initCode, callData: op.callData, accountGasLimits: op.accountGasLimits,
      preVerificationGas: op.preVerificationGas.toString(), gasFees: op.gasFees, paymasterAndData: op.paymasterAndData, entryPoint: evmAddress(entryPoint) },
  };
}
/** The address that signed the operation for the account on `chainId` (must equal `op.sender` for the delegator to accept it). */
export function recoverUserOpSigner(chainId: number, op: PackedUserOperation, signature: string, entryPoint = ENTRY_POINT_V0_7): string {
  return recoverDigestSigner(delegatorUserOpDigest(chainId, op, entryPoint), signature);
}
/** Whether `signature` is the owner's own signature of this operation (the only one `EIP7702StatelessDeleGator` accepts). */
export function verifyOwnerUserOpSignature(chainId: number, op: PackedUserOperation, signature: string, entryPoint = ENTRY_POINT_V0_7): boolean {
  try { return recoverUserOpSigner(chainId, op, signature, entryPoint) === evmAddress(op.sender); } catch { return false; }
}

// ── Nonces (EntryPoint v0.7 `NonceManager`: 192-bit key ‖ 64-bit sequence) ─────────────────────────────────────────────────
/** `nonce = (key << 64) | sequence`. A distinct key per workflow group keeps the owner's other operations independent of this one. */
export function userOpNonce(key: bigint, sequence: bigint): bigint {
  return (uint(key, UINT192_MAX, 'ERC4337_NONCE_INVALID') << 64n) | uint(sequence, UINT64_MAX, 'ERC4337_NONCE_INVALID');
}
export function userOpNonceParts(nonce: bigint): { readonly key: bigint; readonly sequence: bigint } {
  const n = uint(nonce, UINT256_MAX, 'ERC4337_NONCE_INVALID');
  return { key: n >> 64n, sequence: n & UINT64_MAX };
}
/** A nonce key derived from a FloFi group id: unique per group, never reused, so two groups of one owner never share a sequence. */
export function nonceKeyOf(groupId: string): bigint {
  if (typeof groupId !== 'string' || !groupId) fail('ERC4337_NONCE_INVALID');
  return BigInt(keccakHex(`flofi.user-operation.v1:${groupId}`)) & UINT192_MAX;
}
export const GET_NONCE_SELECTOR = selectorOf('getNonce(address,uint192)');
/** `eth_call` data for `EntryPoint.getNonce(sender, key)`. */
export function getNonceCall(sender: string, key: bigint): string {
  return GET_NONCE_SELECTOR + hexOf(abiEncode(['address', 'uint256'], [evmAddress(sender), uint(key, UINT192_MAX, 'ERC4337_NONCE_INVALID')])).slice(2);
}
export const INCREMENT_NONCE_SELECTOR = selectorOf('incrementNonce(uint192)');
/**
 * `EntryPoint.incrementNonce(key)` call data: sent by the OWNER's own account (their wallet confirms and pays), it consumes the key's next
 * sequence, so an operation signed for that key can never execute any more. The owner's revocation of a signed, unrelayed operation.
 */
export function incrementNonceCall(key: bigint): string {
  return INCREMENT_NONCE_SELECTOR + hexOf(abiEncode(['uint256'], [uint(key, UINT192_MAX, 'ERC4337_NONCE_INVALID')])).slice(2);
}
export function decodeGetNonce(result: unknown): bigint {
  const [nonce] = abiDecode(['uint256'], bytesOf(data(result, 'ERC4337_RPC_INVALID'))) as [bigint];
  return nonce;
}

// ── Receipts ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** `UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)`. */
export const USER_OPERATION_EVENT_TOPIC = keccakHex('UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)');
/** `UserOperationRevertReason(bytes32 indexed userOpHash, address indexed sender, uint256 nonce, bytes revertReason)`. */
export const USER_OPERATION_REVERT_REASON_TOPIC = keccakHex('UserOperationRevertReason(bytes32,address,uint256,bytes)');
/** `BeforeExecution()`: emitted once by the EntryPoint between the validation of every operation of a bundle and their executions. */
export const BEFORE_EXECUTION_TOPIC = keccakHex('BeforeExecution()');
export type UserOperationEvent = { readonly userOpHash: string; readonly sender: string; readonly paymaster: string; readonly nonce: bigint; readonly success: boolean;
  /** What the account actually paid for the operation, in wei (the EntryPoint's own accounting: gas used × effective price). */
  readonly actualGasCost: bigint; readonly actualGasUsed: bigint };
type Log = { readonly address?: unknown; readonly topics?: unknown; readonly data?: unknown };
const topicAddress = (topic: string) => { const w = BigInt(topic); if (w >> 160n) fail('ERC4337_RECEIPT_INVALID'); return '0x' + w.toString(16).padStart(40, '0'); };
/** The `UserOperationEvent` of `hash` among a transaction's logs (emitted by the EntryPoint), or null when the operation is not in it. */
export function userOperationEvent(logs: readonly unknown[], hash: string, entryPoint = ENTRY_POINT_V0_7): UserOperationEvent | null {
  const wanted = data(hash, 'ERC4337_RECEIPT_INVALID');
  for (const raw of logs) {
    const log = raw && typeof raw === 'object' ? raw as Log : null;
    const topics = Array.isArray(log?.topics) ? log.topics.map(t => typeof t === 'string' ? t.toLowerCase() : '') : [];
    if (!log || typeof log.address !== 'string' || log.address.toLowerCase() !== evmAddress(entryPoint) || topics[0] !== USER_OPERATION_EVENT_TOPIC || topics[1] !== wanted) continue;
    if (topics.length !== 4) fail('ERC4337_RECEIPT_INVALID');
    const [nonce, success, actualGasCost, actualGasUsed] = abiDecode(['uint256', 'bool', 'uint256', 'uint256'], bytesOf(data(log.data, 'ERC4337_RECEIPT_INVALID'))) as [bigint, boolean, bigint, bigint];
    return { userOpHash: wanted, sender: topicAddress(topics[2]!), paymaster: topicAddress(topics[3]!), nonce, success, actualGasCost, actualGasUsed };
  }
  return null;
}

// ── Bundler wire format (ERC-4337 v0.7 JSON-RPC: the UNPACKED representation) ───────────────────────────────────────────────
const quantity = (value: bigint) => '0x' + value.toString(16);
export type BundlerUserOperation = { readonly sender: string; readonly nonce: string; readonly callData: string; readonly callGasLimit: string; readonly verificationGasLimit: string;
  readonly preVerificationGas: string; readonly maxFeePerGas: string; readonly maxPriorityFeePerGas: string; readonly signature: string };
/** `eth_sendUserOperation` / `eth_estimateUserOperationGas` parameter: the same operation, unpacked (no factory, no paymaster fields). */
export function toBundlerUserOperation(op: PackedUserOperation): BundlerUserOperation {
  assertUserFundedOperation(op);
  const gas = userOperationGas(op);
  return { sender: op.sender, nonce: quantity(op.nonce), callData: op.callData, callGasLimit: quantity(gas.callGasLimit), verificationGasLimit: quantity(gas.verificationGasLimit),
    preVerificationGas: quantity(gas.preVerificationGas), maxFeePerGas: quantity(gas.maxFeePerGas), maxPriorityFeePerGas: quantity(gas.maxPriorityFeePerGas), signature: op.signature };
}
const parseQuantity = (value: unknown, code: string): bigint => typeof value === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(value) ? BigInt(value) : fail(code);
/** The limits a bundler estimated (`eth_estimateUserOperationGas`); paymaster limits are refused (FloFi never sponsors). */
export function bundlerGasEstimate(result: unknown): Pick<UserOperationGas, 'verificationGasLimit' | 'callGasLimit' | 'preVerificationGas'> {
  const r = result && typeof result === 'object' ? result as Record<string, unknown> : fail('ERC4337_RPC_INVALID');
  if (r.paymasterVerificationGasLimit !== undefined && parseQuantity(r.paymasterVerificationGasLimit, 'ERC4337_RPC_INVALID') !== 0n) fail('ERC4337_SPONSORED_REFUSED');
  if (r.paymasterPostOpGasLimit !== undefined && parseQuantity(r.paymasterPostOpGasLimit, 'ERC4337_RPC_INVALID') !== 0n) fail('ERC4337_SPONSORED_REFUSED');
  const verificationGasLimit = parseQuantity(r.verificationGasLimit, 'ERC4337_RPC_INVALID'), callGasLimit = parseQuantity(r.callGasLimit, 'ERC4337_RPC_INVALID'),
    preVerificationGas = parseQuantity(r.preVerificationGas, 'ERC4337_RPC_INVALID');
  if ([verificationGasLimit, callGasLimit, preVerificationGas].some(v => v === 0n || v > UINT128_MAX)) fail('ERC4337_RPC_INVALID');
  return { verificationGasLimit, callGasLimit, preVerificationGas };
}
/** `eth_getUserOperationReceipt` (v0.7): the fields FloFi reconciles from; null for a bundler that does not know the operation yet. */
export type BundlerReceipt = { readonly userOpHash: string; readonly sender: string; readonly nonce: bigint; readonly success: boolean; readonly actualGasCost: bigint;
  readonly actualGasUsed: bigint; readonly transactionHash: string; readonly blockNumber: bigint; readonly logs: readonly unknown[]; readonly reason: string | null };
export function bundlerReceipt(result: unknown): BundlerReceipt | null {
  if (result === null || result === undefined) return null;
  const r = result && typeof result === 'object' ? result as Record<string, unknown> : fail('ERC4337_RPC_INVALID');
  const receipt = r.receipt && typeof r.receipt === 'object' ? r.receipt as Record<string, unknown> : fail('ERC4337_RPC_INVALID');
  const transactionHash = typeof receipt.transactionHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(receipt.transactionHash) ? receipt.transactionHash.toLowerCase() : fail('ERC4337_RPC_INVALID');
  const success = r.success === true ? true : r.success === false ? false : fail('ERC4337_RPC_INVALID');
  return { userOpHash: data(r.userOpHash, 'ERC4337_RPC_INVALID'), sender: evmAddress(r.sender), nonce: parseQuantity(r.nonce, 'ERC4337_RPC_INVALID'), success,
    actualGasCost: parseQuantity(r.actualGasCost, 'ERC4337_RPC_INVALID'), actualGasUsed: parseQuantity(r.actualGasUsed, 'ERC4337_RPC_INVALID'), transactionHash,
    blockNumber: parseQuantity(receipt.blockNumber, 'ERC4337_RPC_INVALID'), logs: Array.isArray(receipt.logs) ? receipt.logs : [],
    reason: typeof r.reason === 'string' ? r.reason.slice(0, 200) : null };
}

// ── BUILD-FLOFI-MAINNET-EXEC-002: sponsored user operations (an ERC-4337 v0.7 paymaster, through an ERC-7677 paymaster web service) ──────
/**
 * A paymaster pays an operation's gas only through the EntryPoint (v0.7: `paymasterAndData` = paymaster ‖ uint128 verification gas ‖ uint128 post-op
 * gas ‖ paymaster data); it can never pay for a conventional `eth_sendTransaction`. These helpers pack, unpack and bound such an operation; the
 * paymaster address, the EntryPoint, the chain and the operation's calls are checked by the caller against its own pins and the reviewed calls.
 */
export type PaymasterFields = { readonly paymaster: string; readonly verificationGasLimit: bigint; readonly postOpGasLimit: bigint; readonly data: string };
export function packPaymasterAndData(p: PaymasterFields): string {
  const pm = evmAddress(p.paymaster);
  if (pm === '0x' + '0'.repeat(40)) fail('ERC4337_PAYMASTER_INVALID');
  const gas = (v: bigint) => uint(v, UINT128_MAX, 'ERC4337_GAS_INVALID').toString(16).padStart(32, '0');
  return pm + gas(p.verificationGasLimit) + gas(p.postOpGasLimit) + data(p.data, 'ERC4337_PAYMASTER_INVALID').slice(2);
}
export function unpackPaymasterAndData(value: string): PaymasterFields | null {
  const hex = data(value, 'ERC4337_PAYMASTER_INVALID');
  if (hex === '0x') return null;
  if (hex.length < 2 + 40 + 64) fail('ERC4337_PAYMASTER_INVALID');
  return { paymaster: '0x' + hex.slice(2, 42), verificationGasLimit: BigInt('0x' + hex.slice(42, 74)), postOpGasLimit: BigInt('0x' + hex.slice(74, 106)), data: '0x' + hex.slice(106) };
}
/** The worst-case gas cost of a sponsored operation: every gas limit (the paymaster's included) at its max fee per gas. */
export function maxSponsoredCost(gas: UserOperationGas, paymaster: Pick<PaymasterFields, 'verificationGasLimit' | 'postOpGasLimit'>): bigint {
  return (gas.verificationGasLimit + gas.callGasLimit + gas.preVerificationGas + paymaster.verificationGasLimit + paymaster.postOpGasLimit) * gas.maxFeePerGas;
}
/** An unpacked v0.7 operation as ERC-7677 / ERC-4337 JSON-RPC carries it (quantities as hex strings). */
export type RpcUserOperation = { readonly sender: string; readonly nonce: string; readonly factory?: string | null; readonly factoryData?: string | null;
  readonly callData: string; readonly callGasLimit: string; readonly verificationGasLimit: string; readonly preVerificationGas: string;
  readonly maxFeePerGas: string; readonly maxPriorityFeePerGas: string; readonly paymaster?: string | null; readonly paymasterVerificationGasLimit?: string | null;
  readonly paymasterPostOpGasLimit?: string | null; readonly paymasterData?: string | null; readonly signature?: string };
/** The packed v0.7 operation of an RPC one (initCode = factory ‖ factoryData), with `paymaster` fields when present. */
export function packRpcUserOperation(op: RpcUserOperation): PackedUserOperation {
  const q = (v: unknown, code: string) => parseQuantity(v, code);
  // EntryPoint v0.8's EIP-7702 marker travels as viem's short `factory: '0x7702'` (or its 20-byte padded form): packed as the 20-byte marker.
  const factory = typeof op.factory === 'string' && /^0x7702(?:0{36})?$/.test(op.factory.toLowerCase()) ? EIP7702_INIT_CODE_MARKER : op.factory ? evmAddress(op.factory) : null;
  const initCode = factory ? factory + data(op.factoryData ?? '0x', 'ERC4337_INIT_CODE_INVALID').slice(2) : '0x';
  const paymasterAndData = op.paymaster ? packPaymasterAndData({ paymaster: op.paymaster, verificationGasLimit: q(op.paymasterVerificationGasLimit ?? '0x0', 'ERC4337_RPC_INVALID'),
    postOpGasLimit: q(op.paymasterPostOpGasLimit ?? '0x0', 'ERC4337_RPC_INVALID'), data: op.paymasterData ?? '0x' }) : '0x';
  return { sender: evmAddress(op.sender), nonce: q(op.nonce, 'ERC4337_NONCE_INVALID'), initCode, callData: data(op.callData, 'ERC4337_CALLDATA_INVALID'),
    accountGasLimits: packUints(q(op.verificationGasLimit, 'ERC4337_RPC_INVALID'), q(op.callGasLimit, 'ERC4337_RPC_INVALID')),
    preVerificationGas: uint(q(op.preVerificationGas, 'ERC4337_RPC_INVALID'), UINT128_MAX, 'ERC4337_GAS_INVALID'),
    gasFees: packUints(q(op.maxPriorityFeePerGas, 'ERC4337_RPC_INVALID'), q(op.maxFeePerGas, 'ERC4337_RPC_INVALID')), paymasterAndData,
    signature: op.signature === undefined ? '0x' : data(op.signature, 'ERC4337_SIGNATURE_INVALID') };
}
/** Coinbase Smart Wallet `executeBatch((address target,uint256 value,bytes data)[])` and `execute(address,uint256,bytes)`. */
export const COINBASE_EXECUTE_BATCH_SELECTOR = selectorOf('executeBatch((address,uint256,bytes)[])');
export const COINBASE_EXECUTE_SELECTOR = selectorOf('execute(address,uint256,bytes)');
/**
 * The calls an account's `callData` executes, for the account encodings FloFi can verify: the MetaMask EIP-7702 DeleGator's ERC-7579 `execute(batch)`
 * and the Coinbase Smart Wallet's `executeBatch` / `execute`. Anything else is refused (`ERC4337_ACCOUNT_CALLDATA_UNSUPPORTED`): FloFi never sponsors
 * calls it cannot read.
 */
export function decodeAccountCalls(callData: string): Call[] {
  const hex = data(callData, 'ERC4337_CALLDATA_INVALID');
  if (hex.startsWith(EXECUTE_SELECTOR)) return decodeBatchCallData(hex);
  if (hex.startsWith(COINBASE_EXECUTE_BATCH_SELECTOR)) {
    const [items] = abiDecode([{ array: EXECUTION_TUPLE }], bytesOf('0x' + hex.slice(10))) as [[string, bigint, string][]];
    if (!items.length || items.length > MAX_BATCH_CALLS) fail('ERC4337_BATCH_INVALID');
    return items.map(([target, value, calldata]) => ({ target: target.toLowerCase(), value, data: calldata.toLowerCase() }));
  }
  if (hex.startsWith(COINBASE_EXECUTE_SELECTOR)) {
    const [target, value, calldata] = abiDecode(['address', 'uint256', 'bytes'], bytesOf('0x' + hex.slice(10))) as [string, bigint, string];
    return [{ target: target.toLowerCase(), value, data: calldata.toLowerCase() }];
  }
  return fail('ERC4337_ACCOUNT_CALLDATA_UNSUPPORTED');
}

// ── BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (ADR-0010): EntryPoint v0.8 and eth-infinitism `Simple7702Account` ────────────────────────
/**
 * The canonical ERC-4337 v0.8 EntryPoint (the one `Simple7702Account` v0.8 hard-codes in its pure `entryPoint()`, and Circle's v0.8 paymaster
 * serves). Its `getUserOpHash` is an EIP-712 digest: domain `ERC4337`/`1` (chainId, verifyingContract = the EntryPoint), primary type
 * `PackedUserOperation` without the `entryPoint` member — what a `Simple7702Account` recovers its own key from (`ECDSA.recover(userOpHash, sig)`),
 * so the owner signs it as typed data (`eth_signTypedData_v4`) and the bundler's / receipt's identity of the operation is the same digest.
 * Sources: eth-infinitism `EntryPoint.sol`/`UserOperationLib.sol` v0.8.0, `Simple7702Account.sol` v0.8.0 (`_checkSignature`), viem 2.57.8
 * `getUserOperationTypedData` / `getUserOperationHash` (`entryPointVersion: '0.8'`) / `getInitCode` (the EIP-7702 initCode rule).
 */
export const ENTRY_POINT_V0_8 = '0x4337084d9e255ff0702461cf8895ce9e3b5ff108';
/** eth-infinitism `Simple7702Account` v0.8 (the EIP-7702 delegate a v0.8 owner account designates: `0xef0100 ‖ this`). */
export const SIMPLE_7702_ACCOUNT_V0_8 = '0xe6cae83bde06e4c305530e199d7217f42808555b';
export const ERC4337_V08_DOMAIN = Object.freeze({ name: 'ERC4337', version: '1' });
export const PACKED_USER_OP_V08_TYPEHASH = keccakHex('PackedUserOperation(address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,'
  + 'uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData)');
/** The 20-byte EIP-7702 initCode marker of EntryPoint v0.8 (`INITCODE_EIP7702_MARKER`, right-padded with zeros). */
export const EIP7702_INIT_CODE_MARKER = '0x7702' + '0'.repeat(36);
/**
 * The owner account kinds a FloFi-relayed operation may come from (closed list). Each binds the account's EIP-7702 delegate, the EntryPoint
 * that delegate validates for, and how the owner signs: the DeleGator's own EIP-712 domain (v0.7) or the EntryPoint's typed `userOpHash` (v0.8).
 */
export const OWNER_ACCOUNT_KINDS = Object.freeze({
  METAMASK_DELEGATOR_V1_3: Object.freeze({ delegate: DELEGATOR_IMPLEMENTATION, entryPoint: ENTRY_POINT_V0_7 }),
  SIMPLE_7702_V0_8: Object.freeze({ delegate: SIMPLE_7702_ACCOUNT_V0_8, entryPoint: ENTRY_POINT_V0_8 }),
});
export type OwnerAccountKind = keyof typeof OWNER_ACCOUNT_KINDS;
/** The kind of an owner account from its code (`eth_getCode`): an EIP-7702 designator of a pinned delegate, else null (plain EOA or anything else). */
export function ownerAccountKindOfCode(code: unknown): OwnerAccountKind | null {
  const c = typeof code === 'string' ? code.toLowerCase() : '';
  for (const [kind, k] of Object.entries(OWNER_ACCOUNT_KINDS) as [OwnerAccountKind, (typeof OWNER_ACCOUNT_KINDS)[OwnerAccountKind]][])
    if (c === '0xef0100' + k.delegate.slice(2).toLowerCase()) return kind;
  return null;
}
/** The EIP-712 domain separator of EntryPoint v0.8 (`EIP712("ERC4337", "1")`) on `chainId`. */
export function entryPointV08DomainSeparator(chainId: number, entryPoint = ENTRY_POINT_V0_8): string {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) fail('ERC4337_CHAIN_INVALID');
  return keccakHex(abiEncode(['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'],
    [EIP712_DOMAIN_TYPEHASH, keccakHex(ERC4337_V08_DOMAIN.name), keccakHex(ERC4337_V08_DOMAIN.version), BigInt(chainId), evmAddress(entryPoint)]));
}
/**
 * The initCode as v0.8 hashes it: an EIP-7702 marker initCode is replaced by the account's delegate ‖ the rest (`delegate` given), or by the bare
 * 20-byte marker (no delegate), exactly as viem's `getInitCode({ forHash: true })`; any other initCode as is. FloFi never sends an initCode itself.
 */
function initCodeForHashV08(initCode: string, delegate?: string): string {
  const hex = data(initCode, 'ERC4337_INIT_CODE_INVALID');
  if (hex.length < EIP7702_INIT_CODE_MARKER.length || hex.slice(0, 42) !== EIP7702_INIT_CODE_MARKER) return hex;
  return delegate === undefined ? EIP7702_INIT_CODE_MARKER : evmAddress(delegate) + hex.slice(42);
}
/** `UserOperationLib.hash` (v0.8): the struct hash of the typed `PackedUserOperation` (no entryPoint member, no signature). */
export function userOpStructHashV08(op: PackedUserOperation, eip7702Delegate?: string): string {
  return keccakHex(abiEncode(['bytes32', 'address', 'uint256', 'bytes32', 'bytes32', 'bytes32', 'uint256', 'bytes32', 'bytes32'],
    [PACKED_USER_OP_V08_TYPEHASH, evmAddress(op.sender), op.nonce, keccakHex(bytesOf(initCodeForHashV08(op.initCode, eip7702Delegate))), keccakHex(bytesOf(op.callData)),
      op.accountGasLimits, op.preVerificationGas, op.gasFees, keccakHex(bytesOf(op.paymasterAndData))]));
}
/** `EntryPoint.getUserOpHash` (v0.8): `0x1901 ‖ domainSeparator ‖ structHash` — the bundler's and the receipt's identity, AND what a v0.8 account signs. */
export function userOpHashV08(op: PackedUserOperation, chainId: number, options: { readonly entryPoint?: string; readonly eip7702Delegate?: string } = {}): string {
  return keccakHex(concat(Uint8Array.of(0x19, 0x01), bytesOf(entryPointV08DomainSeparator(chainId, options.entryPoint ?? ENTRY_POINT_V0_8)),
    bytesOf(userOpStructHashV08(op, options.eip7702Delegate))));
}
/**
 * The operation's identity for its EntryPoint (`getUserOpHash`): v0.7's keccak form, or v0.8's EIP-712 digest. Any other EntryPoint is refused.
 * `eip7702Delegate`: v0.8 only — the delegate an operation carrying the EIP-7702 initCode marker is hashed with (the one its authorization names).
 */
export function userOpHashFor(op: PackedUserOperation, chainId: number, entryPoint: string, eip7702Delegate?: string): string {
  const ep = evmAddress(entryPoint);
  if (ep === ENTRY_POINT_V0_7 && eip7702Delegate === undefined) return userOpHash(op, chainId, ep);
  if (ep === ENTRY_POINT_V0_8) return userOpHashV08(op, chainId, { entryPoint: ep, ...eip7702Delegate !== undefined ? { eip7702Delegate } : {} });
  return fail('ERC4337_ENTRY_POINT_UNSUPPORTED');
}
/**
 * The `eth_signTypedData_v4` payload of a v0.8 operation (the wallet shows every field; its digest is `userOpHashV08`). An operation that carries
 * the EIP-7702 initCode marker (the owner's first upgrade inside it) is signed with the delegate in place of the marker, exactly as viem's
 * `getUserOperationTypedData` (`toPackedUserOperation({ forHash: true })`): `eip7702Delegate` is then required; any other initCode is refused.
 */
export function entryPointV08TypedData(chainId: number, op: PackedUserOperation, entryPoint = ENTRY_POINT_V0_8, eip7702Delegate?: string) {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) fail('ERC4337_CHAIN_INVALID');
  const initCode = data(op.initCode, 'ERC4337_INIT_CODE_INVALID');
  if (initCode === EIP7702_INIT_CODE_MARKER && eip7702Delegate !== undefined) return v08TypedData(chainId, { ...op, initCode: evmAddress(eip7702Delegate) }, entryPoint);
  if (initCode !== '0x' || eip7702Delegate !== undefined) fail('ERC4337_INIT_CODE_REFUSED');
  return v08TypedData(chainId, op, entryPoint);
}
function v08TypedData(chainId: number, op: PackedUserOperation, entryPoint: string) {
  return {
    types: {
      EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
      PackedUserOperation: [{ name: 'sender', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'initCode', type: 'bytes' }, { name: 'callData', type: 'bytes' },
        { name: 'accountGasLimits', type: 'bytes32' }, { name: 'preVerificationGas', type: 'uint256' }, { name: 'gasFees', type: 'bytes32' },
        { name: 'paymasterAndData', type: 'bytes' }],
    },
    primaryType: 'PackedUserOperation' as const,
    domain: { name: ERC4337_V08_DOMAIN.name, version: ERC4337_V08_DOMAIN.version, chainId, verifyingContract: evmAddress(entryPoint) },
    message: { sender: evmAddress(op.sender), nonce: op.nonce.toString(), initCode: op.initCode, callData: op.callData, accountGasLimits: op.accountGasLimits,
      preVerificationGas: op.preVerificationGas.toString(), gasFees: op.gasFees, paymasterAndData: op.paymasterAndData },
  };
}
/** Whether `signature` is the owner's raw ECDSA signature over the v0.8 `userOpHash` (the only one `Simple7702Account` accepts). */
export function verifyOwnerUserOpSignatureV08(chainId: number, op: PackedUserOperation, signature: string, entryPoint = ENTRY_POINT_V0_8, eip7702Delegate?: string): boolean {
  try { return recoverDigestSigner(userOpHashV08(op, chainId, { entryPoint, ...eip7702Delegate !== undefined ? { eip7702Delegate } : {} }), signature) === evmAddress(op.sender); }
  catch { return false; }
}

// ── The owner's EIP-7702 authorization (owner requirement: a FloFi Wallet upgraded inside its first Circle operation) ──────────────
/**
 * An EIP-7702 authorization tuple `[chain_id, address, nonce]`: the owner designates `address` as its account code. FloFi only ever builds one
 * for a SPECIFIC chain (never 0, which would be valid on every chain), with the account's current transaction nonce, and the caller pins `address`.
 */
export type Eip7702Authorization = { readonly chainId: number; readonly address: string; readonly nonce: bigint };
export type SignedEip7702Authorization = Eip7702Authorization & { readonly r: string; readonly s: string; readonly yParity: 0 | 1 };
const UINT64 = UINT64_MAX;
function authorizationOf(a: Eip7702Authorization): Eip7702Authorization {
  if (!a || !Number.isSafeInteger(a.chainId) || a.chainId <= 0) fail('EIP7702_AUTHORIZATION_CHAIN_INVALID');
  return { chainId: a.chainId, address: evmAddress(a.address), nonce: uint(a.nonce, UINT64, 'EIP7702_AUTHORIZATION_NONCE_INVALID') };
}
/** `keccak256(0x05 ‖ rlp([chain_id, address, nonce]))`, the digest the authority signs (EIP-7702; viem `hashAuthorization`). */
export function eip7702AuthorizationHash(authorization: Eip7702Authorization): string {
  const a = authorizationOf(authorization);
  return keccakHex(concat(Uint8Array.of(0x05), rlpEncode([rlpInteger(BigInt(a.chainId)), bytesOf(a.address), rlpInteger(a.nonce)])));
}
/**
 * The signed tuple from a 65-byte r ‖ s ‖ v signature (v 27/28 or 0/1) of exactly `authorization`, checked to recover (low-s) to `authority`;
 * anything else is a closed refusal (EIP7702_AUTHORIZATION_SIGNATURE_INVALID).
 */
export function signedEip7702Authorization(authorization: Eip7702Authorization, signature: string, authority: string): SignedEip7702Authorization {
  const a = authorizationOf(authorization);
  let signer: string;
  try { signer = recoverDigestSigner(eip7702AuthorizationHash(a), signature); } catch { return fail('EIP7702_AUTHORIZATION_SIGNATURE_INVALID'); }
  if (signer !== evmAddress(authority)) fail('EIP7702_AUTHORIZATION_SIGNATURE_INVALID');
  const raw = signature.toLowerCase(), v = parseInt(raw.slice(130, 132), 16);
  return { ...a, r: '0x' + raw.slice(2, 66), s: '0x' + raw.slice(66, 130), yParity: (v >= 27 ? v - 27 : v) as 0 | 1 };
}
/** The address that signed a tuple (low-s enforced), or a closed refusal. */
export function recoverEip7702AuthorizationSigner(signed: SignedEip7702Authorization): string {
  const r = typeof signed?.r === 'string' && /^0x[0-9a-fA-F]{64}$/.test(signed.r) ? signed.r.toLowerCase() : fail('EIP7702_AUTHORIZATION_SIGNATURE_INVALID');
  const s = typeof signed.s === 'string' && /^0x[0-9a-fA-F]{64}$/.test(signed.s) ? signed.s.toLowerCase() : fail('EIP7702_AUTHORIZATION_SIGNATURE_INVALID');
  if (signed.yParity !== 0 && signed.yParity !== 1) fail('EIP7702_AUTHORIZATION_SIGNATURE_INVALID');
  try { return recoverDigestSigner(eip7702AuthorizationHash(signed), r + s.slice(2) + (signed.yParity + 27).toString(16)); }
  catch { return fail('EIP7702_AUTHORIZATION_SIGNATURE_INVALID'); }
}
/** The bundler's `eip7702Auth` member of an operation (viem's `formatAuthorization`: quantities, r/s as 32-byte words, yParity as one byte). */
export type BundlerEip7702Auth = { readonly address: string; readonly chainId: string; readonly nonce: string; readonly r: string; readonly s: string; readonly yParity: string };
export function toBundlerEip7702Auth(signed: SignedEip7702Authorization): BundlerEip7702Auth {
  recoverEip7702AuthorizationSigner(signed);
  return { address: evmAddress(signed.address), chainId: quantity(BigInt(signed.chainId)), nonce: quantity(signed.nonce), r: signed.r.toLowerCase(), s: signed.s.toLowerCase(),
    yParity: signed.yParity === 1 ? '0x01' : '0x00' };
}
/** The signed tuple of a bundler `eip7702Auth` (strict; the bundler double reads what FloFi sent). */
export function fromBundlerEip7702Auth(value: unknown): SignedEip7702Authorization {
  const v = value && typeof value === 'object' ? value as Record<string, unknown> : fail('EIP7702_AUTHORIZATION_INVALID');
  const chainId = parseQuantity(v.chainId, 'EIP7702_AUTHORIZATION_INVALID'), yParity = parseQuantity(v.yParity, 'EIP7702_AUTHORIZATION_INVALID');
  if (chainId > BigInt(Number.MAX_SAFE_INTEGER) || yParity > 1n) fail('EIP7702_AUTHORIZATION_INVALID');
  const word32 = (x: unknown) => typeof x === 'string' && /^0x[0-9a-fA-F]{64}$/.test(x) ? x.toLowerCase() : fail('EIP7702_AUTHORIZATION_INVALID');
  return { chainId: Number(chainId), address: evmAddress(v.address), nonce: parseQuantity(v.nonce, 'EIP7702_AUTHORIZATION_INVALID'), r: word32(v.r), s: word32(v.s),
    yParity: Number(yParity) as 0 | 1 };
}
/** `BaseAccount.execute(address target, uint256 value, bytes data)` / `executeBatch(Call[])` (v0.8; the same selectors as Coinbase's). */
export const SIMPLE_7702_EXECUTE_SELECTOR = selectorOf('execute(address,uint256,bytes)');
export const SIMPLE_7702_EXECUTE_BATCH_SELECTOR = selectorOf('executeBatch((address,uint256,bytes)[])');
/** The `Simple7702Account` call data of exactly these calls: `execute` for one call, `executeBatch` (reverts on the first failure) otherwise. */
export function simple7702CallData(calls: readonly Call[]): string {
  if (!Array.isArray(calls) || !calls.length || calls.length > MAX_BATCH_CALLS) fail('ERC4337_BATCH_INVALID');
  const x = calls.map(call);
  if (x.length === 1) return SIMPLE_7702_EXECUTE_SELECTOR + hexOf(abiEncode(['address', 'uint256', 'bytes'], [x[0]!.target, x[0]!.value, x[0]!.data])).slice(2);
  return SIMPLE_7702_EXECUTE_BATCH_SELECTOR + hexOf(abiEncode([{ array: EXECUTION_TUPLE }], [x.map(c => [c.target, c.value, c.data])])).slice(2);
}
/** The calls a `Simple7702Account` call data executes (strict: exactly the two encodings above, re-encoded byte for byte), else a closed refusal. */
export function decodeSimple7702CallData(callData: string): Call[] {
  const hex = data(callData, 'ERC4337_CALLDATA_INVALID');
  let calls: Call[];
  try {
    if (hex.startsWith(SIMPLE_7702_EXECUTE_SELECTOR)) {
      const [target, value, calldata] = abiDecode(['address', 'uint256', 'bytes'], bytesOf('0x' + hex.slice(10))) as [string, bigint, string];
      calls = [{ target: target.toLowerCase(), value, data: calldata.toLowerCase() }];
    } else if (hex.startsWith(SIMPLE_7702_EXECUTE_BATCH_SELECTOR)) {
      const [items] = abiDecode([{ array: EXECUTION_TUPLE }], bytesOf('0x' + hex.slice(10))) as [[string, bigint, string][]];
      calls = items.map(([target, value, calldata]) => ({ target: target.toLowerCase(), value, data: calldata.toLowerCase() }));
    } else return fail('ERC4337_CALLDATA_INVALID');
    // Canonical only: one call is always `execute`, several `executeBatch`, and the bytes re-encode exactly (no trailing or padded data).
    if (simple7702CallData(calls) !== hex) fail('ERC4337_CALLDATA_INVALID');
  } catch { return fail('ERC4337_CALLDATA_INVALID'); }
  return calls;
}
/** The account call data of `calls` for an owner account kind (the DeleGator's ERC-7579 batch, or `Simple7702Account`'s execute / executeBatch). */
export function ownerAccountCallData(kind: OwnerAccountKind, calls: readonly Call[]): string {
  return kind === 'SIMPLE_7702_V0_8' ? simple7702CallData(calls) : batchCallData(calls);
}
/** The calls an owner account kind's call data executes (strict). */
export function decodeOwnerAccountCallData(kind: OwnerAccountKind, callData: string): Call[] {
  return kind === 'SIMPLE_7702_V0_8' ? decodeSimple7702CallData(callData) : decodeBatchCallData(callData);
}
/**
 * A user operation of the owner's own account WITH a paymaster (ADR-0010: Circle's, checked by the caller against its pins before anything is
 * built on it): no factory, the exact account call data, the gas words the owner signs and the given `paymasterAndData`.
 */
export function packedUserOperationWithPaymaster(input: { readonly sender: string; readonly nonce: bigint; readonly callData: string; readonly gas: UserOperationGas;
  readonly paymasterAndData: string; readonly signature?: string }): PackedUserOperation {
  const base = packedUserOperation(input), paymasterAndData = data(input.paymasterAndData, 'ERC4337_PAYMASTER_INVALID');
  if (unpackPaymasterAndData(paymasterAndData) === null) fail('ERC4337_PAYMASTER_INVALID');
  return { ...base, paymasterAndData };
}
/** The bundler wire format of an operation that names a paymaster: the unpacked v0.7/v0.8 fields with `paymaster*` (still no factory). */
export type BundlerPaymasterUserOperation = BundlerUserOperation & { readonly paymaster: string; readonly paymasterVerificationGasLimit: string;
  readonly paymasterPostOpGasLimit: string; readonly paymasterData: string;
  /** Only with the EIP-7702 initCode marker: viem's `factory: '0x7702'` / `factoryData: '0x'` and the owner's signed authorization. */
  readonly factory?: string; readonly factoryData?: string; readonly eip7702Auth?: BundlerEip7702Auth };
/**
 * The bundler wire format of an operation that names a paymaster. `eip7702Auth`: the owner's signed EIP-7702 authorization, given exactly when the
 * operation carries the EIP-7702 initCode marker (the bundler then includes the authorization in its own type-4 transaction, so the delegation is
 * applied before the EntryPoint validates the operation); refused for any other operation (ERC4337_EIP7702_AUTH_REFUSED), and the marker without it
 * is refused as any initCode (ERC4337_INIT_CODE_REFUSED).
 */
export function toBundlerUserOperationWithPaymaster(op: PackedUserOperation, eip7702Auth?: SignedEip7702Authorization): BundlerPaymasterUserOperation {
  const sender = evmAddress(op.sender), initCode = data(op.initCode, 'ERC4337_INIT_CODE_REFUSED');
  if (initCode !== '0x' && initCode !== EIP7702_INIT_CODE_MARKER) fail('ERC4337_INIT_CODE_REFUSED');
  const upgrade = initCode === EIP7702_INIT_CODE_MARKER;
  // The marker never travels without the owner's authorization (refused as any other initCode), and an authorization never without the marker.
  if (upgrade && eip7702Auth === undefined) fail('ERC4337_INIT_CODE_REFUSED');
  if (!upgrade && eip7702Auth !== undefined) fail('ERC4337_EIP7702_AUTH_REFUSED');
  // The authorization is the sender's own: an authorization of another key would delegate someone else's account (or fail on chain).
  if (eip7702Auth && recoverEip7702AuthorizationSigner(eip7702Auth) !== sender) fail('ERC4337_EIP7702_AUTH_REFUSED');
  const pm = unpackPaymasterAndData(op.paymasterAndData) ?? fail('ERC4337_PAYMASTER_INVALID');
  const gas = userOperationGas(op);
  if (gas.maxPriorityFeePerGas > gas.maxFeePerGas || gas.maxFeePerGas === 0n || gas.callGasLimit === 0n || gas.verificationGasLimit === 0n) fail('ERC4337_GAS_INVALID');
  return { sender: op.sender, nonce: quantity(op.nonce), ...upgrade ? { factory: '0x7702', factoryData: '0x' } : {}, callData: op.callData,
    callGasLimit: quantity(gas.callGasLimit), verificationGasLimit: quantity(gas.verificationGasLimit),
    preVerificationGas: quantity(gas.preVerificationGas), maxFeePerGas: quantity(gas.maxFeePerGas), maxPriorityFeePerGas: quantity(gas.maxPriorityFeePerGas), signature: op.signature,
    paymaster: pm.paymaster, paymasterVerificationGasLimit: quantity(pm.verificationGasLimit), paymasterPostOpGasLimit: quantity(pm.postOpGasLimit), paymasterData: pm.data,
    ...eip7702Auth ? { eip7702Auth: toBundlerEip7702Auth(eip7702Auth) } : {} };
}
/** The limits a bundler estimated for an operation with a paymaster: the account's three and the paymaster's two (absent: 0). */
export function bundlerPaymasterGasEstimate(result: unknown): Pick<UserOperationGas, 'verificationGasLimit' | 'callGasLimit' | 'preVerificationGas'>
  & { readonly paymasterVerificationGasLimit: bigint; readonly paymasterPostOpGasLimit: bigint } {
  const r = result && typeof result === 'object' ? result as Record<string, unknown> : fail('ERC4337_RPC_INVALID');
  const optional = (v: unknown) => v === undefined || v === null ? 0n : parseQuantity(v, 'ERC4337_RPC_INVALID');
  const verificationGasLimit = parseQuantity(r.verificationGasLimit, 'ERC4337_RPC_INVALID'), callGasLimit = parseQuantity(r.callGasLimit, 'ERC4337_RPC_INVALID'),
    preVerificationGas = parseQuantity(r.preVerificationGas, 'ERC4337_RPC_INVALID');
  const paymasterVerificationGasLimit = optional(r.paymasterVerificationGasLimit), paymasterPostOpGasLimit = optional(r.paymasterPostOpGasLimit);
  if ([verificationGasLimit, callGasLimit, preVerificationGas].some(v => v === 0n || v > UINT128_MAX)
    || [paymasterVerificationGasLimit, paymasterPostOpGasLimit].some(v => v > UINT128_MAX)) fail('ERC4337_RPC_INVALID');
  return { verificationGasLimit, callGasLimit, preVerificationGas, paymasterVerificationGasLimit, paymasterPostOpGasLimit };
}
