// SPDX-License-Identifier: AGPL-3.0-only
'use server';
import { cardProvider, cardProviderStatus as configuredCardProvider, type SafeProviderCard } from '../server/card-provider';
import { CARD_ENTRY_PATH, CARD_ORIGIN_PREREQUISITE, cardOrigin } from '../server/card-origin';

/**
 * Credentials → Add card. The browser mounts the provider's own secure fields and sends FloFi only the provider's one-time card
 * token and the email the provider keeps the saved card under. These actions accept no card number, expiry or security code
 * and never will; saving a card charges nothing.
 */
type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string };
const CODE = /^[A-Z][A-Z0-9_]{2,80}$/;
const failure = (cause: unknown): { ok: false; code: string } =>
  ({ ok: false, code: cause instanceof Error && CODE.test(cause.message) ? cause.message : 'CARD_PROVIDER_UNAVAILABLE' });

/**
 * Whether secure card entry is available here, and where it runs: the card origin's `/card-entry` page (src/server/card-origin.ts), never
 * the product origin, which hosts the Privy signer. Without a card origin, Add card is unavailable (nothing is collected). Never a secret.
 */
export type CardEntryStatus =
  | { readonly available: false; readonly code: string; readonly prerequisite: string }
  | { readonly available: true; readonly provider: { readonly id: string; readonly name: string }; readonly entry: string };
export async function cardProviderStatus(): Promise<CardEntryStatus> {
  const status = configuredCardProvider();
  if (!status.available) return status;
  const card = cardOrigin(process.env);
  return card ? { available: true, provider: status.provider, entry: `${card.origin}${CARD_ENTRY_PATH}` }
    : { available: false, code: 'CARD_ORIGIN_REQUIRED', prerequisite: CARD_ORIGIN_PREREQUISITE };
}
export async function addProviderCard(input: { readonly token: string; readonly email: string }): Promise<Result<SafeProviderCard>> {
  try {
    const provider = cardProvider();
    if (!provider) return { ok: false, code: 'CARD_TOKENIZATION_PROVIDER_REQUIRED' };
    const keys = input && typeof input === 'object' ? Object.keys(input).sort().join(',') : '';
    if (keys !== 'email,token') return { ok: false, code: 'CARD_INPUT_INVALID' };
    return { ok: true, value: await provider.finalizeTokenizedCard({ token: input.token, email: input.email }) };
  } catch (cause) { return failure(cause); }
}
/** Removes the saved-card reference at the provider (the card itself is unaffected). */
export async function removeProviderCard(binding: string): Promise<Result<null>> {
  try {
    const provider = cardProvider();
    if (!provider) return { ok: false, code: 'CARD_TOKENIZATION_PROVIDER_REQUIRED' };
    await provider.removeSavedCard({ binding });
    return { ok: true, value: null };
  } catch (cause) { return failure(cause); }
}
