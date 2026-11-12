// SPDX-License-Identifier: AGPL-3.0-only
'use server';
/**
 * P0 (owner test 2026-11-12, Arbitrum Swap → Base Bridge): before the Editor simulates for a wallet, the Flight decision the API will take for that
 * same wallet, as a value (a thrown code is redacted in production builds and used to surface as "Simulation failed"). Read-only: no grant,
 * binding or session is created, and only the signed-in account's own wallet records are consulted.
 */
import { flightWalletRefusal } from '../server/flight-access';

export async function flightWalletAccess(owner: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: string }> {
  const code = await flightWalletRefusal(owner);
  return code ? { ok: false, code } : { ok: true };
}
