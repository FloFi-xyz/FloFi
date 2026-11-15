// SPDX-License-Identifier: AGPL-3.0-only
'use server';
/**
 * BUILD-FLOFI-UNIFIED-COPILOT-001: Saved Recipients server actions (Credentials → Saved recipients; the Copilot reads the same list through
 * `state/saved-recipients-store.ts`).
 *
 * The account is the verified FloFi session of this request (sealed HttpOnly cookie + unrevoked server-side record), never an argument; the
 * embedded approval route never reaches it. Arguments are a name, a public address, an ecosystem or a recipient id: never a key, phrase or
 * code. Writes are rate-limited per account. Each recipient's status is derived here from the account's VERIFIED wallets (its saved wallets
 * and sign-in wallets) and the wallets proven in this browser: a name never makes an address "your wallet". None of these actions signs,
 * submits or authorizes anything; a saved recipient is not a delegation, an allowlist entry or proof of ownership.
 *
 * Closed codes: ACCOUNTS_NOT_CONFIGURED, ACCOUNTS_UNAVAILABLE, ACCOUNT_SESSION_REQUIRED, ACCOUNT_NOT_FOUND, RECIPIENTS_UNAVAILABLE (0028 is not
 * applied on this deployment yet), RECIPIENTS_RATE_LIMITED, RECIPIENT_LABEL_INVALID, RECIPIENT_ADDRESS_INVALID, RECIPIENT_LABEL_TAKEN,
 * RECIPIENT_EXISTS (with the existing record), RECIPIENT_LIMIT, RECIPIENT_NOT_FOUND, RECIPIENTS_REQUEST_FAILED.
 */
import { headers } from 'next/headers';
import { accountHost, currentAccountSession, type AccountHost } from '../accounts/account-host';
import { createRecipientStore, type RecipientStore } from '../accounts/recipient-store';
import { ecosystemOfAddress, recipientStatus, type SavedRecipient, type SavedRecipientView } from '../domain/saved-recipients';
import { fixedWindow } from '../platform/fixed-window';
import { EMBEDDED_APPROVAL_PATH } from '../server/embedded-approval';
import { platformStateHost } from '../server/platform-state-host';
import { currentWalletPrincipals } from '../server/session-principal';

type Result<T> = { ok: true; value: T } | { ok: false; code: string };
/** A save that found the same ecosystem and address already saved: nothing was written, and the existing record is returned. */
export type SaveRecipientResult = Result<SavedRecipientView> | { ok: false; code: 'RECIPIENT_EXISTS'; existing: SavedRecipientView };
export type SaveRecipientInput = { readonly label: string; readonly address: string; readonly ecosystem?: 'EVM' | 'SOLANA' | undefined };

const CODE = /^[A-Z][A-Z0-9_]{2,80}$/;
const failure = (cause: unknown, fallback = 'RECIPIENTS_REQUEST_FAILED'): { ok: false; code: string } =>
  ({ ok: false, code: cause instanceof Error && CODE.test(cause.message) ? cause.message : fallback });
const fail = (code: string): never => { throw new Error(code); };
/** Writes per account per window (opaque bucket `recipients:<account id>`): generous for a person, a bound for automation. */
const WRITE_LIMIT = 60, WRITE_WINDOW_SECONDS = 600;

type Context = { readonly host: AccountHost; readonly accountId: string; readonly recipients: RecipientStore; readonly allow: ReturnType<typeof fixedWindow>['allow'] };
async function signedIn(): Promise<Context> {
  // The embedded approval route's wallet authority stays isolated from the account (as for history principals).
  if ((await headers()).get('x-flofi-pathname') === EMBEDDED_APPROVAL_PATH) fail('ACCOUNT_SESSION_REQUIRED');
  let host: AccountHost | null;
  try { host = await accountHost(); } catch (error) { throw new Error(failure(error, 'ACCOUNTS_UNAVAILABLE').code, { cause: error }); }
  if (!host) return fail('ACCOUNTS_NOT_CONFIGURED');
  const session = await currentAccountSession(host) ?? fail('ACCOUNT_SESSION_REQUIRED');
  const { db, tenantId } = await platformStateHost();
  return { host, accountId: session.accountId, recipients: createRecipientStore(db, tenantId), allow: fixedWindow(db, tenantId).allow };
}
/** Saved recipients are dark until 0028 is applied; checked before any write is counted. Then one hit of this account's write bucket. */
async function writable(context: Context): Promise<void> {
  if (!await context.recipients.available()) fail('RECIPIENTS_UNAVAILABLE');
  if (!await context.allow(`recipients:${context.accountId}`, WRITE_LIMIT, WRITE_WINDOW_SECONDS, new Date())) fail('RECIPIENTS_RATE_LIMITED');
}
/** Each recipient with its status, from the account's verified wallets and this browser's proven wallets (never from the name). */
async function views(context: Context, recipients: readonly SavedRecipient[]): Promise<SavedRecipientView[]> {
  if (!recipients.length) return [];
  const [account, connected] = await Promise.all([context.host.store.walletAddresses(context.accountId).catch(() => []), currentWalletPrincipals().catch(() => [])]);
  const verified = (ecosystem: SavedRecipient['ecosystem'], list: readonly { namespace: string; address: string }[]) =>
    list.filter(wallet => wallet.namespace === (ecosystem === 'EVM' ? 'eip155' : 'solana')).map(wallet => wallet.address);
  return recipients.map(recipient => ({ ...recipient,
    status: recipientStatus(recipient, { account: verified(recipient.ecosystem, account), connected: verified(recipient.ecosystem, connected) }) }));
}
const text = (value: unknown) => (typeof value === 'string' ? value : '');

/** The signed-in account's saved recipients, each with its derived status. Signed out: ACCOUNT_SESSION_REQUIRED (nothing is read). */
export async function listSavedRecipients(): Promise<Result<SavedRecipientView[]>> {
  try {
    const context = await signedIn();
    return { ok: true, value: await views(context, await context.recipients.list(context.accountId)) };
  } catch (cause) { return failure(cause); }
}
/**
 * Saves a public address under a name for the signed-in account. The ecosystem is inferred from the address when not given; an address shaped
 * for the other ecosystem is RECIPIENT_ADDRESS_INVALID. The same address already saved returns RECIPIENT_EXISTS with that record, unchanged.
 */
export async function saveRecipient(input: SaveRecipientInput): Promise<SaveRecipientResult> {
  try {
    const context = await signedIn();
    const address = text(input?.address), ecosystem = input?.ecosystem ?? ecosystemOfAddress(address) ?? fail('RECIPIENT_ADDRESS_INVALID');
    await writable(context);
    const saved = await context.recipients.create(context.accountId, { label: input?.label, address, ecosystem });
    const [view] = await views(context, [saved.recipient]);
    return saved.created ? { ok: true, value: view! } : { ok: false, code: 'RECIPIENT_EXISTS', existing: view! };
  } catch (cause) { return failure(cause); }
}
/** Renames one of the signed-in account's recipients (its address never changes; to change an address, remove it and save the new one). */
export async function renameSavedRecipient(id: string, label: string): Promise<Result<SavedRecipientView>> {
  try {
    const context = await signedIn();
    await writable(context);
    const [view] = await views(context, [await context.recipients.rename(context.accountId, text(id), label)]);
    return { ok: true, value: view! };
  } catch (cause) { return failure(cause); }
}
/** Removes one of the signed-in account's recipients. Only FloFi's saved name and address are removed; no wallet or funds are affected. */
export async function removeSavedRecipient(id: string): Promise<Result<null>> {
  try {
    const context = await signedIn();
    await writable(context);
    await context.recipients.remove(context.accountId, text(id));
    return { ok: true, value: null };
  } catch (cause) { return failure(cause); }
}
