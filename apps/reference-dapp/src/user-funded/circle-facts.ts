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
export type CircleFacts = {
  /** PERMIT: the owner signs the permit next; OPERATION: the permit is signed and verified, the owner signs the operation next. */
  readonly stage: 'PERMIT' | 'OPERATION';
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
};
const DECIMAL = /^(0|[1-9][0-9]{0,77})$/;
/** The Circle facts of a prepared artifact (strictly read back), or null for any artifact that is not Circle-paid. */
export function circleFactsOf(prepared: Readonly<Record<string, unknown>> | null | undefined): CircleFacts | null {
  const c = prepared && typeof prepared === 'object' && prepared.circle && typeof prepared.circle === 'object' ? prepared.circle as Record<string, unknown> : null;
  if (!c || (c.stage !== 'PERMIT' && c.stage !== 'OPERATION') || typeof c.accountKind !== 'string' || !(c.accountKind in erc4337.OWNER_ACCOUNT_KINDS)) return null;
  const strings = ['entryPoint', 'paymaster', 'usdc', 'permitCap', 'permitNonce', 'surchargeBps', 'marginBps', 'nonce', 'callData', 'nativeRequired', 'usdcSpend', 'plannedStrategy'];
  if (strings.some(k => typeof c[k] !== 'string') || !c.gas || typeof c.gas !== 'object' || !c.price || typeof c.price !== 'object') return null;
  if (![c.permitCap, c.permitNonce, c.nonce, c.nativeRequired, c.usdcSpend].every(v => DECIMAL.test(String(v)))) return null;
  if (c.deadline !== undefined && (typeof c.deadline !== 'string' || !/^[1-9][0-9]{0,15}$/.test(c.deadline))) return null;
  return c as unknown as CircleFacts;
}
/** The strategy a Circle preparation replaced (restored when it expires or must be prepared again), else null. */
export const plannedStrategyOf = (prepared: Readonly<Record<string, unknown>> | null | undefined): GroupStrategy | null => circleFactsOf(prepared)?.plannedStrategy ?? null;
export const gasOf = (g: CircleGas): erc4337.UserOperationGas => ({ verificationGasLimit: BigInt(g.verificationGasLimit), callGasLimit: BigInt(g.callGasLimit),
  preVerificationGas: BigInt(g.preVerificationGas), maxFeePerGas: BigInt(g.maxFeePerGas), maxPriorityFeePerGas: BigInt(g.maxPriorityFeePerGas) });
export const paymasterGasOf = (g: CircleGas) => ({ verificationGasLimit: BigInt(g.paymasterVerificationGasLimit), postOpGasLimit: BigInt(g.paymasterPostOpGasLimit) });
/** The token-paid fee the owner reviews and signs (`GasPayment`), from the facts. */
export function circleGasPayment(c: CircleFacts): Extract<GasPayment, { mechanism: 'CIRCLE_USDC_PAYMASTER' }> {
  return { mechanism: 'CIRCLE_USDC_PAYMASTER', maxFee: { token: c.usdc, symbol: 'USDC', decimals: C.CIRCLE_USDC_DECIMALS, amount: c.permitCap }, signatures: 2,
    paymaster: c.paymaster, entryPoint: c.entryPoint, permitCap: c.permitCap };
}
/** The permit the owner signs for these facts (pure: rebuilt identically by the server and by the owner's browser). */
export const circlePermitOf = (c: CircleFacts, chainId: number, owner: string) =>
  C.circlePermit({ chainId, entryPoint: c.entryPoint, owner, cap: BigInt(c.permitCap), nonce: BigInt(c.permitNonce) });
/** The final operation of a Circle group from its facts (the signed permit inside its paymasterAndData). */
export function circleOperationOf(c: CircleFacts, sender: string, signature = '0x'): erc4337.PackedUserOperation {
  if (!c.permitSignature) throw new Error('CIRCLE_PERMIT_REQUIRED');
  const pm = paymasterGasOf(c.gas);
  return erc4337.packedUserOperationWithPaymaster({ sender, nonce: BigInt(c.nonce), callData: c.callData, gas: gasOf(c.gas), signature,
    paymasterAndData: C.circlePaymasterAndData({ paymaster: c.paymaster, verificationGasLimit: pm.verificationGasLimit, postOpGasLimit: pm.postOpGasLimit, token: c.usdc,
      permitAmount: BigInt(c.permitCap), permitSignature: c.permitSignature }) });
}
/** What the operation check expects of the operation built from these facts. */
export const expectationOf = (c: CircleFacts, chainId: number, owner: string): C.CircleOperationExpectation => ({ chainId, entryPoint: c.entryPoint, owner,
  accountKind: c.accountKind, permitCap: BigInt(c.permitCap), permitNonce: BigInt(c.permitNonce) });
/** The typed data the owner's wallet signs for the final operation (the account's own scheme). */
export function circleOperationTypedData(c: CircleFacts, chainId: number, op: erc4337.PackedUserOperation) {
  return c.accountKind === 'SIMPLE_7702_V0_8' ? erc4337.entryPointV08TypedData(chainId, op, c.entryPoint) : erc4337.delegatorUserOpTypedData(chainId, op, c.entryPoint);
}
/** Whether `signature` is the owner's signature of the final operation, as the owner's account validates it. */
export function verifyCircleOperationSignature(c: CircleFacts, chainId: number, op: erc4337.PackedUserOperation, signature: string): boolean {
  return c.accountKind === 'SIMPLE_7702_V0_8' ? erc4337.verifyOwnerUserOpSignatureV08(chainId, op, signature, c.entryPoint)
    : erc4337.verifyOwnerUserOpSignature(chainId, op, signature, c.entryPoint);
}
