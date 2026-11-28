// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (WS-REVENUE, F17/F18): controlled activation of fee accounting and fee collection.
 *
 * Accounting (the durable ledger of what completed executions owe) starts at an explicit instant, `FLOFI_PLATFORM_FEE_ACCOUNTING_FROM` (ISO 8601).
 * Executions created before it are never accounted, so nothing historical is ever charged retroactively (F13). Unset or invalid: off.
 *
 * Collection (moving the fee to FloFi, `settlement.ts`) is fail-closed. It needs, all at once: accounting active, the owner's switch
 * `FLOFI_PLATFORM_FEE_COLLECTION=on`, a verified treasury for each namespace (`FLOFI_PLATFORM_FEE_TREASURY_EVM`, `..._SOLANA`), the approved financial
 * accounting policy reference (`FLOFI_PLATFORM_FEE_POLICY_APPROVAL`) and, checked against the database by the collector, the certified 0038 table
 * that records the fee basis each Review disclosed (the cap a collector may charge). `code` names the first missing condition. The switch only
 * gates NEW collection attempts; it never touches reconciliation of anything already submitted.
 */
import { isChecksumAddress } from '@defi-workflow-engine/action-registry';
import { PLATFORM_FEE_POLICY_EFFECTIVE_FROM } from './policy.ts';

export type Env = Readonly<Record<string, string | undefined>>;
export type FeeActivation = {
  readonly accounting: { readonly active: boolean; readonly from: Date | null; readonly code: string | null };
  readonly collection: { readonly active: boolean; readonly code: string | null };
};

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/;
/** A real calendar instant: an impossible date (2026-11-31) is refused, never rolled forward. */
const realInstant = (raw: string, date: Date) => Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === raw.slice(0, 10);
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const APPROVAL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/;
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** Decoded byte length of a base58 string (a Solana public key is exactly 32 bytes; base58 itself has no checksum). */
function base58Length(text: string): number {
  let value = 0n;
  for (const char of text) value = value * 58n + BigInt(ALPHABET.indexOf(char));
  let bytes = 0; while (value > 0n) { value >>= 8n; bytes++; }
  return bytes + (text.match(/^1*/)?.[0].length ?? 0);
}

export function platformFeeActivation(env: Env): FeeActivation {
  const raw = env.FLOFI_PLATFORM_FEE_ACCOUNTING_FROM?.trim();
  const parsed = raw && ISO.test(raw) ? new Date(raw) : null;
  const from = parsed && realInstant(raw!, parsed) ? parsed : null;
  // Never before the current policy took effect: an execution created earlier was reviewed under another policy (F15).
  const start = from && Number.isFinite(from.getTime()) ? new Date(Math.max(from.getTime(), PLATFORM_FEE_POLICY_EFFECTIVE_FROM.getTime())) : null;
  const accounting = !raw ? { active: false, from: null, code: 'PLATFORM_FEE_ACCOUNTING_NOT_ACTIVATED' }
    : start ? { active: true, from: start, code: null } : { active: false, from: null, code: 'PLATFORM_FEE_ACCOUNTING_FROM_INVALID' };
  const blocker = accounting.active ? collectionBlocker(env) : 'PLATFORM_FEE_ACCOUNTING_NOT_ACTIVATED';
  return { accounting, collection: { active: blocker === null, code: blocker } };
}

/**
 * The first environment condition that keeps collection off, or null when every one is met (F17: a missing or invalid treasury can never collect).
 * The database condition (0038 present) is checked by the collector itself.
 */
export function collectionBlocker(env: Env, now = Date.now()): string | null {
  const raw = env.FLOFI_PLATFORM_FEE_ACCOUNTING_FROM?.trim(), from = raw && ISO.test(raw) ? new Date(raw) : null;
  if (!from || !realInstant(raw!, from)) return 'PLATFORM_FEE_ACCOUNTING_NOT_ACTIVATED';
  // Before accounting starts nothing is accounted: no Review may say the fee is charged yet.
  if (Math.max(from.getTime(), PLATFORM_FEE_POLICY_EFFECTIVE_FROM.getTime()) > now) return 'PLATFORM_FEE_ACCOUNTING_NOT_STARTED';
  if ((env.FLOFI_PLATFORM_FEE_COLLECTION ?? 'off').trim() !== 'on') return 'PLATFORM_FEE_COLLECTION_DISABLED';
  const evm = env.FLOFI_PLATFORM_FEE_TREASURY_EVM?.trim(), solana = env.FLOFI_PLATFORM_FEE_TREASURY_SOLANA?.trim();
  if (!evm || !solana) return 'PLATFORM_FEE_TREASURY_NOT_CONFIGURED';
  // A treasury must be exactly checksummed (EVM) or canonical base58 (Solana): never lower-cased, padded or guessed. The System Program id and
  // the zero address are never a treasury.
  if (!/^0x[0-9a-fA-F]{40}$/.test(evm) || !isChecksumAddress(evm) || /^0x0{40}$/i.test(evm) || !BASE58.test(solana) || /^1{32}$/.test(solana) || base58Length(solana) !== 32) return 'PLATFORM_FEE_TREASURY_INVALID';
  if (!APPROVAL.test(env.FLOFI_PLATFORM_FEE_POLICY_APPROVAL?.trim() ?? '')) return 'PLATFORM_FEE_POLICY_NOT_APPROVED';
  return null;
}

/** Whether an execution created at `createdAt` is accounted under this activation (never anything created before `from`). */
export const accountedExecution = (activation: FeeActivation, createdAt: Date): boolean =>
  activation.accounting.active && activation.accounting.from !== null && createdAt.getTime() >= activation.accounting.from.getTime();
