// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-CHAT-E2E-DASHBOARD-UX-001: the balance a Solana Token-2022 holding shows on the Dashboard portfolio. Read-only and pure.
 *
 * A Token-2022 account stores a raw `amount`; some mint extensions define a different amount for people:
 *  - Scaled UI Amount (extension 25): shown = raw × the mint's current multiplier (`newMultiplier` once the cluster clock reaches its
 *    effective timestamp, otherwise `multiplier`).
 *  - Interest-Bearing (extension 10): shown = raw × e^(pre-update average rate × pre-update time) × e^(current rate × time since the last
 *    rate update), rates in basis points per year of 365.24 days — the token program's own continuous-compounding formula.
 * Both use the mint's on-chain state and the cluster's own `Clock` sysvar time from the same read, in IEEE-754 doubles as the token program
 * does, and the shown amount is truncated to the mint's base unit (never rounded up). The raw amount always stays the canonical balance.
 *
 * Fail closed per token: a mint that is missing, owned by another program, malformed or uninitialized, carries an extension FloFi does not
 * classify (or both scaling extensions), stores a non-finite or non-positive multiplier, or yields an unrepresentable amount is
 * UNAVAILABLE; so is an account with a confidential balance (its encrypted part cannot be read). Other tokens are unaffected.
 */
import { TOKEN_2022_EXTENSIONS } from '@defi-workflow-engine/action-registry';
import { decodeSplMint, type DecodedMint, type RawSolanaAccount } from '@defi-workflow-engine/reference-compiler';

export const SOLANA_TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const SOLANA_CLOCK_SYSVAR = 'SysvarC1ock11111111111111111111111111111111';
const SYSVAR_OWNER = 'Sysvar1111111111111111111111111111111111111';
/** The token program's year (spl-token-2022 `SECONDS_PER_YEAR`) and basis-point unit. */
export const SECONDS_PER_YEAR = 60 * 60 * 24 * 365.24, ONE_IN_BASIS_POINTS = 10_000;

const E = TOKEN_2022_EXTENSIONS;
/** Mint extensions that never change what an account's `amount` means (fees, hooks, authorities, metadata, groups, pausing, confidentiality config). */
const NEUTRAL_MINT: ReadonlySet<number> = new Set([E.TransferFeeConfig, E.MintCloseAuthority, E.ConfidentialTransferMint, E.DefaultAccountState,
  E.NonTransferable, E.PermanentDelegate, E.TransferHook, E.ConfidentialTransferFeeConfig, E.MetadataPointer, E.TokenMetadata, E.GroupPointer,
  E.TokenGroup, E.GroupMemberPointer, E.TokenGroupMember, E.ConfidentialMintBurn, E.Pausable]);
/** Account extensions that leave the public `amount` the whole balance (a ConfidentialTransferAccount does not). */
const NEUTRAL_ACCOUNT: ReadonlySet<number> = new Set([E.TransferFeeAmount, E.ImmutableOwner, E.MemoTransfer, E.CpiGuard, E.NonTransferableAccount,
  E.TransferHookAccount, E.ConfidentialTransferFeeAmount, E.PausableAccount]);

export type Token2022Basis = 'RAW' | 'SCALED_UI_AMOUNT' | 'INTEREST_BEARING';
/** How one mint's balances are shown at the read time, or why they cannot be. */
export type Token2022Rule = { readonly ok: true; readonly decimals: number; readonly basis: Token2022Basis; readonly factor: number }
  | { readonly ok: false; readonly code: string };
export type Token2022Display = { readonly ok: true; readonly units: bigint; readonly basis: Token2022Basis } | { readonly ok: false; readonly code: string };

const unavailable = (code: string) => ({ ok: false as const, code });
const view = (value: Uint8Array) => new DataView(value.buffer, value.byteOffset, value.byteLength);

/** The reason a Token-2022 account's public `amount` is not its whole balance, or null (extension types in account order). */
export function token2022AccountIssue(extensionTypes: readonly number[]): string | null {
  if (extensionTypes.includes(E.ConfidentialTransferAccount)) return 'SOLANA_TOKEN_CONFIDENTIAL_BALANCE';
  return extensionTypes.every(type => NEUTRAL_ACCOUNT.has(type)) ? null : 'SOLANA_TOKEN_EXTENSION_UNSUPPORTED';
}

/** The cluster's `unix_timestamp` from the Clock sysvar (slot, epoch_start_timestamp, epoch, leader_schedule_epoch, unix_timestamp). */
export function clockUnixTimestamp(account: RawSolanaAccount): bigint {
  if (!account || account.owner !== SYSVAR_OWNER || account.data.length !== 40) throw new Error('SOLANA_CLOCK_UNAVAILABLE');
  return view(account.data).getBigInt64(32, true);
}

/** ScaledUiAmountConfig: authority (32), multiplier f64, new_multiplier_effective_timestamp i64, new_multiplier f64. */
function scaledMultiplier(value: Uint8Array, now: bigint): number | null {
  if (value.length !== 56) return null;
  const data = view(value), multiplier = data.getFloat64(32, true), effectiveAt = data.getBigInt64(40, true), next = data.getFloat64(48, true);
  if (![multiplier, next].every(m => Number.isFinite(m) && m > 0)) return null;
  return now >= effectiveAt ? next : multiplier;
}
/** InterestBearingConfig: rate authority (32), initialization_timestamp i64, pre_update_average_rate i16, last_update_timestamp i64, current_rate i16. */
function interestScale(value: Uint8Array, now: bigint): number | null {
  if (value.length !== 52) return null;
  const data = view(value), initializedAt = data.getBigInt64(32, true), averageRate = data.getInt16(40, true);
  const updatedAt = data.getBigInt64(42, true), currentRate = data.getInt16(50, true);
  // The program multiplies in i128 and converts to f64 before dividing; BigInt products converted once match that order.
  const growth = (rate: number, seconds: bigint) => Math.exp(Number(BigInt(rate) * seconds) / SECONDS_PER_YEAR / ONE_IN_BASIS_POINTS);
  const scale = growth(averageRate, updatedAt - initializedAt) * growth(currentRate, now - updatedAt);
  return Number.isFinite(scale) && scale > 0 ? scale : null;
}

/** The display rule of one Token-2022 mint account, read at the cluster time `now` (Clock sysvar). */
export function token2022Rule(account: RawSolanaAccount, now: bigint): Token2022Rule {
  if (!account) return unavailable('SOLANA_TOKEN_MINT_UNAVAILABLE');
  if (account.owner !== SOLANA_TOKEN_2022_PROGRAM) return unavailable('SOLANA_TOKEN_MINT_MISMATCH');
  let mint: DecodedMint;
  try { mint = decodeSplMint(account.data, true); } catch { return unavailable('SOLANA_TOKEN_MINT_INVALID'); }
  if (!mint.initialized) return unavailable('SOLANA_TOKEN_MINT_INVALID');
  const scaled = mint.extensions.find(extension => extension.type === E.ScaledUiAmount);
  const interest = mint.extensions.find(extension => extension.type === E.InterestBearingConfig);
  const others = mint.extensions.filter(extension => extension !== scaled && extension !== interest);
  if ((scaled && interest) || others.some(extension => !NEUTRAL_MINT.has(extension.type))) return unavailable('SOLANA_TOKEN_EXTENSION_UNSUPPORTED');
  if (scaled) {
    const factor = scaledMultiplier(scaled.value, now);
    return factor === null ? unavailable('SOLANA_TOKEN_EXTENSION_INVALID') : { ok: true, decimals: mint.decimals, basis: 'SCALED_UI_AMOUNT', factor };
  }
  if (interest) {
    const factor = interestScale(interest.value, now);
    return factor === null ? unavailable('SOLANA_TOKEN_EXTENSION_INVALID') : { ok: true, decimals: mint.decimals, basis: 'INTEREST_BEARING', factor };
  }
  return { ok: true, decimals: mint.decimals, basis: 'RAW', factor: 1 };
}

/** The shown balance of a raw Token-2022 amount under its mint's rule: truncated to a base unit; a factor of exactly 1 keeps the raw amount. */
export function token2022Display(raw: bigint, rule: Token2022Rule): Token2022Display {
  if (!rule.ok) return rule;
  if (rule.factor === 1) return { ok: true, units: raw, basis: rule.basis };
  const shown = Number(raw) * rule.factor;
  if (!Number.isFinite(shown) || shown < 0) return unavailable('SOLANA_TOKEN_AMOUNT_UNREPRESENTABLE');
  return { ok: true, units: BigInt(Math.floor(shown)), basis: rule.basis };
}
