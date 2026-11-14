// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (ADR-0010 §3): what a Circle-paid group's prepared artifact carries (`prepared.circle`) and the
 * pure derivations from it — the permit and the final operation the owner signs, their typed data, the signature check. Shared by the server
 * (`circle-gas.ts`, `groups.ts`) and the owner's browser (`components/user-funded-browser.ts`), which re-derives both typed data from these facts
 * and compares them with what the server handed it before asking the wallet: no server-only import here.
 */
import { circlePaymaster as C, erc4337 } from '@defi-workflow-engine/reference-compiler';
import type { GasPayment } from '../gas-abstraction/mechanism.ts';
import type { GroupStrategy } from '../workflow-runs/execution-groups.ts';

export type CircleGas = { readonly verificationGasLimit: string; readonly callGasLimit: string; readonly preVerificationGas: string; readonly maxFeePerGas: string;
  readonly maxPriorityFeePerGas: string; readonly paymasterVerificationGasLimit: string; readonly paymasterPostOpGasLimit: string };
/**
 * Owner requirement (FloFi Wallet's first use): the owner's plain account (no code) is upgraded to the pinned `Simple7702Account` v0.8 INSIDE this
 * Circle operation — the owner's EIP-7702 authorization travels beside it to the bundler, which includes it in its own type-4 transaction, so an
 * account holding no ETH is upgraded and its fee paid in USDC at once. `chainId` is this chain (never 0); `nonce` is the account's transaction
 * nonce FloFi read at a block where its code was empty (no pending transaction): while it is unchanged, nothing (no transaction, no other
 * authorization) touched the account since, so the authorization can never replace an existing delegation. `consentedAt`: the owner's explicit
 * consent in FloFi's own Review (recorded before the wallet is asked: Privy shows no confirmation screen for an authorization). `signature`: the
 * owner's authorization, verified (signer = the owner, exactly this tuple).
 */
export type CircleUpgrade = { readonly delegate: string; readonly chainId: number; readonly nonce: string; readonly consentedAt?: string; readonly signature?: string };
export type CircleFacts = {
  /**
   * AUTHORIZATION: an upgrade's consent and authorization come first (FloFi Wallet's first use); PERMIT: the owner signs the permit next;
   * OPERATION: the permit is signed and verified, the owner signs the operation next.
   */
  readonly stage: 'AUTHORIZATION' | 'PERMIT' | 'OPERATION';
  readonly accountKind: erc4337.OwnerAccountKind; readonly entryPoint: string; readonly paymaster: string; readonly usdc: string;
  /** The reviewed allowance cap (USDC base units): the most the owner can pay for this fee. */
  readonly permitCap: string; readonly permitNonce: string; readonly permitSignature?: string;
  readonly price: { readonly ethUsd: string; readonly usdcUsd: string | null; readonly observedAt: string };
  readonly surchargeBps: string; readonly marginBps: string;
  readonly nonce: string; readonly callData: string; readonly gas: CircleGas;
  /** What native gas would have needed (the batch's fee ceiling plus any native value): re-checked at authorization. */
  readonly nativeRequired: string;
  /** The group's own USDC need at its worst point (base units), reserved beside the cap. */
  readonly usdcSpend: string;
  /** The strategy the group was planned with (restored when this preparation expires). */
  readonly plannedStrategy: GroupStrategy;
  /**
   * Review C2: the unix second after which the operation's calls are refused on chain (its swaps' deadline, else the batch's deadline guard). The
   * operation is never (re)sent at or after it minus `CIRCLE_RELAY_MARGIN_SECONDS`: Circle would still take the owner's USDC for the sure revert.
   * Absent only on a preparation stored before it (then read from the calls themselves).
   */
  readonly deadline?: string;
  /** Owner requirement: the EIP-7702 upgrade inside this operation (FloFi Wallet's first use only); absent: the account is already a smart account. */
  readonly upgrade?: CircleUpgrade;
  /**
   * Final review (P1): this preparation's own identity (128 random bits, lowercase hex), kept through its stages. FloFi Wallet's single-use
   * signing claims name it: the account nonce and the USDC permit nonce do not change when a group is prepared again (a cancel in the wallet, a
   * retryable refusal, an expiry), so a claim bound to them alone would refuse every later preparation's signature. Absent only on a
   * preparation stored before it.
   */
  readonly preparationId?: string;
};
const DECIMAL = /^(0|[1-9][0-9]{0,77})$/;
/** A preparation's identity (`CircleFacts.preparationId`). */
export const CIRCLE_PREPARATION_ID = /^[0-9a-f]{32}$/;
/** A fresh preparation identity (Web Crypto: the same in the server and the owner's browser). */
export const newCirclePreparationId = (): string => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
/** The Circle facts of a prepared artifact (strictly read back), or null for any artifact that is not Circle-paid. */
export function circleFactsOf(prepared: Readonly<Record<string, unknown>> | null | undefined): CircleFacts | null {
  const c = prepared && typeof prepared === 'object' && prepared.circle && typeof prepared.circle === 'object' ? prepared.circle as Record<string, unknown> : null;
  if (!c || (c.stage !== 'AUTHORIZATION' && c.stage !== 'PERMIT' && c.stage !== 'OPERATION') || typeof c.accountKind !== 'string'
    || !(c.accountKind in erc4337.OWNER_ACCOUNT_KINDS)) return null;
  const strings = ['entryPoint', 'paymaster', 'usdc', 'permitCap', 'permitNonce', 'surchargeBps', 'marginBps', 'nonce', 'callData', 'nativeRequired', 'usdcSpend', 'plannedStrategy'];
  if (strings.some(k => typeof c[k] !== 'string') || !c.gas || typeof c.gas !== 'object' || !c.price || typeof c.price !== 'object') return null;
  if (![c.permitCap, c.permitNonce, c.nonce, c.nativeRequired, c.usdcSpend].every(v => DECIMAL.test(String(v)))) return null;
  if (c.deadline !== undefined && (typeof c.deadline !== 'string' || !/^[1-9][0-9]{0,15}$/.test(c.deadline))) return null;
  if (c.preparationId !== undefined && (typeof c.preparationId !== 'string' || !CIRCLE_PREPARATION_ID.test(c.preparationId))) return null;
  // An upgrade only ever designates the pinned Simple7702Account v0.8, on a specific chain, for that account kind; its stage order is enforced.
  const u = c.upgrade === undefined ? null : c.upgrade && typeof c.upgrade === 'object' ? c.upgrade as Record<string, unknown> : 'invalid';
  if (u === 'invalid' || (u && (u.delegate !== erc4337.SIMPLE_7702_ACCOUNT_V0_8 || c.accountKind !== 'SIMPLE_7702_V0_8' || typeof u.chainId !== 'number'
    || !Number.isSafeInteger(u.chainId) || u.chainId <= 0 || typeof u.nonce !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(u.nonce)
    || (u.consentedAt !== undefined && (typeof u.consentedAt !== 'string' || !Number.isFinite(Date.parse(u.consentedAt))))
    || (u.signature !== undefined && (typeof u.signature !== 'string' || !/^0x[0-9a-f]{130}$/.test(u.signature)))
    || (c.stage !== 'AUTHORIZATION' && u.signature === undefined)))) return null;
  if (!u && c.stage === 'AUTHORIZATION') return null;
  return c as unknown as CircleFacts;
}
/** The EIP-7702 tuple an upgrade's owner signs: this chain (never 0), the pinned delegate, the account's recorded transaction nonce. */
export function circleUpgradeAuthorization(c: CircleFacts): erc4337.Eip7702Authorization {
  if (!c.upgrade) throw new Error('CIRCLE_UPGRADE_ABSENT');
  return { chainId: c.upgrade.chainId, address: c.upgrade.delegate, nonce: BigInt(c.upgrade.nonce) };
}
/** The owner's signed authorization of an upgrade (re-verified: signer = the owner, exactly the recorded tuple), or null without an upgrade. */
export function circleSignedAuthorization(c: CircleFacts, owner: string): erc4337.SignedEip7702Authorization | null {
  if (!c.upgrade) return null;
  if (!c.upgrade.signature) throw new Error('CIRCLE_AUTHORIZATION_REQUIRED');
  return erc4337.signedEip7702Authorization(circleUpgradeAuthorization(c), c.upgrade.signature, owner);
}
/** The operation's identity for its EntryPoint (an upgrade's is hashed with its delegate in place of the EIP-7702 marker). */
export const circleUserOpHash = (c: CircleFacts, chainId: number, op: erc4337.PackedUserOperation): string =>
  erc4337.userOpHashFor(op, chainId, c.entryPoint, c.upgrade?.delegate);
/** The strategy a Circle preparation replaced (restored when it expires or must be prepared again), else null. */
export const plannedStrategyOf = (prepared: Readonly<Record<string, unknown>> | null | undefined): GroupStrategy | null => circleFactsOf(prepared)?.plannedStrategy ?? null;
export const gasOf = (g: CircleGas): erc4337.UserOperationGas => ({ verificationGasLimit: BigInt(g.verificationGasLimit), callGasLimit: BigInt(g.callGasLimit),
  preVerificationGas: BigInt(g.preVerificationGas), maxFeePerGas: BigInt(g.maxFeePerGas), maxPriorityFeePerGas: BigInt(g.maxPriorityFeePerGas) });
export const paymasterGasOf = (g: CircleGas) => ({ verificationGasLimit: BigInt(g.paymasterVerificationGasLimit), postOpGasLimit: BigInt(g.paymasterPostOpGasLimit) });
/** The token-paid fee the owner reviews and signs (`GasPayment`), from the facts. */
export function circleGasPayment(c: CircleFacts): Extract<GasPayment, { mechanism: 'CIRCLE_USDC_PAYMASTER' }> {
  return { mechanism: 'CIRCLE_USDC_PAYMASTER', maxFee: { token: c.usdc, symbol: 'USDC', decimals: C.CIRCLE_USDC_DECIMALS, amount: c.permitCap }, signatures: c.upgrade ? 3 : 2,
    paymaster: c.paymaster, entryPoint: c.entryPoint, permitCap: c.permitCap, ...c.upgrade ? { upgrade: { delegate: c.upgrade.delegate, chainId: c.upgrade.chainId } } : {} };
}
/** The permit the owner signs for these facts (pure: rebuilt identically by the server and by the owner's browser). */
export const circlePermitOf = (c: CircleFacts, chainId: number, owner: string) =>
  C.circlePermit({ chainId, entryPoint: c.entryPoint, owner, cap: BigInt(c.permitCap), nonce: BigInt(c.permitNonce) });
/** The final operation of a Circle group from its facts (the signed permit inside its paymasterAndData). */
export function circleOperationOf(c: CircleFacts, sender: string, signature = '0x'): erc4337.PackedUserOperation {
  if (!c.permitSignature) throw new Error('CIRCLE_PERMIT_REQUIRED');
  const pm = paymasterGasOf(c.gas);
  const op = erc4337.packedUserOperationWithPaymaster({ sender, nonce: BigInt(c.nonce), callData: c.callData, gas: gasOf(c.gas), signature,
    paymasterAndData: C.circlePaymasterAndData({ paymaster: c.paymaster, verificationGasLimit: pm.verificationGasLimit, postOpGasLimit: pm.postOpGasLimit, token: c.usdc,
      permitAmount: BigInt(c.permitCap), permitSignature: c.permitSignature }) });
  // An upgrade carries the EIP-7702 initCode marker (and nothing else): the EntryPoint then hashes the operation with the account's delegate.
  return c.upgrade ? { ...op, initCode: erc4337.EIP7702_INIT_CODE_MARKER } : op;
}
/** What the operation check expects of the operation built from these facts. */
export const expectationOf = (c: CircleFacts, chainId: number, owner: string): C.CircleOperationExpectation => ({ chainId, entryPoint: c.entryPoint, owner,
  accountKind: c.accountKind, permitCap: BigInt(c.permitCap), permitNonce: BigInt(c.permitNonce), ...c.upgrade ? { eip7702Upgrade: true } : {} });
/** The typed data the owner's wallet signs for the final operation (the account's own scheme). */
export function circleOperationTypedData(c: CircleFacts, chainId: number, op: erc4337.PackedUserOperation) {
  return c.accountKind === 'SIMPLE_7702_V0_8' ? erc4337.entryPointV08TypedData(chainId, op, c.entryPoint, c.upgrade?.delegate)
    : erc4337.delegatorUserOpTypedData(chainId, op, c.entryPoint);
}
/** Whether `signature` is the owner's signature of the final operation, as the owner's account validates it. */
export function verifyCircleOperationSignature(c: CircleFacts, chainId: number, op: erc4337.PackedUserOperation, signature: string): boolean {
  return c.accountKind === 'SIMPLE_7702_V0_8' ? erc4337.verifyOwnerUserOpSignatureV08(chainId, op, signature, c.entryPoint, c.upgrade?.delegate)
    : erc4337.verifyOwnerUserOpSignature(chainId, op, signature, c.entryPoint);
}
