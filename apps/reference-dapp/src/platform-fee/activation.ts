// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (WS-REVENUE, F17/F18): controlled activation of fee accounting and fee collection.
 *
 * Accounting (the durable ledger of what completed executions owe) starts at an explicit instant, `FLOFI_PLATFORM_FEE_ACCOUNTING_FROM` (ISO 8601).
 * Executions created before it are never accounted, so nothing historical is ever charged retroactively (F13). Unset or invalid: off.
 *
 * Collection (moving the fee to FloFi) is fail-closed and cannot be active in this build. It would need, all at once: the owner's switch
 * `FLOFI_PLATFORM_FEE_COLLECTION=on`, a verified treasury for each namespace (`FLOFI_PLATFORM_FEE_TREASURY_EVM`, `..._SOLANA`), the approved
 * financial accounting policy reference (`FLOFI_PLATFORM_FEE_POLICY_APPROVAL`) and an implemented, reviewed collection mechanism. No
 * collection mechanism is implemented (the rail is an owner decision: provider app fees, a separate owner-authorized transfer or an invoice), so
 * `collection.active` is always false and its code names the first missing condition. The switch only gates NEW collection attempts; it never
 * touches reconciliation of anything already submitted.
 */
import { isChecksumAddress } from '@defi-workflow-engine/action-registry';

export type Env = Readonly<Record<string, string | undefined>>;
export type FeeActivation = {
  readonly accounting: { readonly active: boolean; readonly from: Date | null; readonly code: string | null };
  readonly collection: { readonly active: false; readonly code: string };
};

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const APPROVAL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/;

export function platformFeeActivation(env: Env): FeeActivation {
  const raw = env.FLOFI_PLATFORM_FEE_ACCOUNTING_FROM?.trim();
  const from = raw && ISO.test(raw) ? new Date(raw) : null;
  const accounting = !raw ? { active: false, from: null, code: 'PLATFORM_FEE_ACCOUNTING_NOT_ACTIVATED' }
    : from && Number.isFinite(from.getTime()) ? { active: true, from, code: null } : { active: false, from: null, code: 'PLATFORM_FEE_ACCOUNTING_FROM_INVALID' };
  return { accounting, collection: { active: false, code: collectionBlocker(env) } };
}

/** The first condition that keeps collection off (F17: a missing or invalid treasury can never collect). */
function collectionBlocker(env: Env): string {
  if ((env.FLOFI_PLATFORM_FEE_COLLECTION ?? 'off').trim() !== 'on') return 'PLATFORM_FEE_COLLECTION_DISABLED';
  const evm = env.FLOFI_PLATFORM_FEE_TREASURY_EVM?.trim(), solana = env.FLOFI_PLATFORM_FEE_TREASURY_SOLANA?.trim();
  if (!evm || !solana) return 'PLATFORM_FEE_TREASURY_NOT_CONFIGURED';
  // A treasury must be exactly checksummed (EVM) or canonical base58 (Solana): never lower-cased, padded or guessed.
  if (!/^0x[0-9a-fA-F]{40}$/.test(evm) || !isChecksumAddress(evm) || /^0x0{40}$/i.test(evm) || !BASE58.test(solana)) return 'PLATFORM_FEE_TREASURY_INVALID';
  if (!APPROVAL.test(env.FLOFI_PLATFORM_FEE_POLICY_APPROVAL?.trim() ?? '')) return 'PLATFORM_FEE_POLICY_NOT_APPROVED';
  return 'PLATFORM_FEE_COLLECTOR_NOT_IMPLEMENTED';
}

/** Whether an execution created at `createdAt` is accounted under this activation (never anything created before `from`). */
export const accountedExecution = (activation: FeeActivation, createdAt: Date): boolean =>
  activation.accounting.active && activation.accounting.from !== null && createdAt.getTime() >= activation.accounting.from.getTime();
