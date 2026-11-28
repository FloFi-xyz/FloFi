// SPDX-License-Identifier: AGPL-3.0-only
'use server';
/**
 * The owner's read of one execution's FloFi platform fee and the start of its collection (API `/v1/platform-fees/*`, `backend/platform-fee-api.ts`).
 * The wallet principal is always the verified session of this request (never a client field), and Flight access is checked as for a run-id flow
 * method: `status` is an owner read, `settle` needs product access. Nothing here signs or submits: the owner's wallet signs each returned
 * transfer through the existing transfer actions.
 */
import { requireFlightMethodAccess, walletPrincipalOf } from '../server/flight-access';
import { callCloudPlatformFee } from '../server/cloud-api-client';
import { platformFeeExecutionOf } from '../domain/platform-fee-execution';

export type PlatformFeeLine = { readonly chainId: string; readonly address: string; readonly decimals: number; readonly principal: string; readonly fee: string };
export type PlatformFeeStatus = {
  readonly policyId: string; readonly rateBps: number;
  readonly collection: { readonly active: boolean; readonly code: string | null };
  readonly authorized: { readonly status: string; readonly lines: readonly PlatformFeeLine[]; readonly basisSha256: string } | null;
  readonly ledger: { readonly state: string; readonly lines: readonly PlatformFeeLine[]; readonly transfers: readonly unknown[]; readonly transactions: readonly unknown[];
    readonly code: string | null; readonly attention: boolean } | null;
};
export type PlatformFeeTransfer = { readonly flow: string; readonly runId: string; readonly chainId: string; readonly address: string; readonly decimals: number;
  readonly amount: string; readonly recipient: string; readonly workflowHash: string; readonly workflow?: unknown };
export type PlatformFeeSettlement = { readonly state: 'COLLECTION_PENDING' | 'COLLECTED'; readonly transfers: readonly PlatformFeeTransfer[] };
export type PlatformFeeResult<T> = { ok: true; value: T } | { ok: false; code: string };

/** The wallet session of this request in the asked namespace (default: the EVM session, else the Solana session). */
async function sessionPrincipal(namespace: unknown): Promise<string | null> {
  const { currentSolanaSession, currentWalletSession } = await import('../server/session-principal');
  if (namespace === 'solana') return (await currentSolanaSession().catch(() => null))?.account ?? null;
  const evm = (await currentWalletSession().catch(() => null))?.account ?? null;
  if (evm || namespace === 'eip155') return evm;
  return (await currentSolanaSession().catch(() => null))?.account ?? null;
}

async function call<T>(path: 'status' | 'settle', execution: unknown, namespace: unknown): Promise<PlatformFeeResult<T>> {
  const ref = platformFeeExecutionOf(execution);
  if (!ref) return { ok: false, code: 'ARGUMENTS_INVALID' };
  const account = await sessionPrincipal(namespace === 'eip155' || namespace === 'solana' ? namespace : undefined);
  const proven = walletPrincipalOf(account);
  if (!proven) return { ok: false, code: 'WALLET_PRINCIPAL_REQUIRED' };
  // `status` is an owner read (recovery boundary); `settle` starts new work (product access), as for any other run-id flow method.
  const identity = await requireFlightMethodAccess(path, proven);
  return callCloudPlatformFee<T>(path, ref, { principal: proven.address, betaIdentity: identity });
}

export async function platformFeeStatus(execution: unknown, namespace?: 'eip155' | 'solana'): Promise<PlatformFeeResult<PlatformFeeStatus>> {
  return call<PlatformFeeStatus>('status', execution, namespace);
}
export async function platformFeeSettle(execution: unknown, namespace?: 'eip155' | 'solana'): Promise<PlatformFeeResult<PlatformFeeSettlement>> {
  return call<PlatformFeeSettlement>('settle', execution, namespace);
}
