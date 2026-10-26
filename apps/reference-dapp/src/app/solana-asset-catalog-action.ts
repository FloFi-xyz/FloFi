// SPDX-License-Identifier: AGPL-3.0-only
'use server';
import { loadSolanaCatalog } from '../server/solana-asset-catalog';
import type { SolanaAssetCatalog } from '../domain/solana-asset-catalog';
/** Public read-only discovery. Mint program, extensions and decimals are checked again on chain at Simulate. */
export async function loadSolanaAssetCatalog(): Promise<{ ok: true; catalog: SolanaAssetCatalog } | { ok: false; code: string }> {
  try { return { ok: true, catalog: await loadSolanaCatalog() }; }
  catch { return { ok: false, code: 'SOLANA_TOKEN_CATALOG_UNAVAILABLE' }; }
}
