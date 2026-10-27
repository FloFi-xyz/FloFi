// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { catalogNetworksNamed } from '../domain/network-registry';
import { registerSolanaDisplayCatalog, solanaDisplayCatalogLoaded } from '../domain/solana-asset-catalog';
import { loadSolanaAuthoringAssetCatalog } from '../app/solana-asset-catalog-action';
import { ensureNetworkCatalog } from './asset-catalog-store';

let solanaInflight: Promise<void> | null = null;
async function ensureSolana(): Promise<void> {
  if (solanaDisplayCatalogLoaded()) return;
  solanaInflight ??= loadSolanaAuthoringAssetCatalog().then(result => { if (result.ok) registerSolanaDisplayCatalog(result.catalog); })
    .catch(() => undefined).finally(() => { solanaInflight = null; });
  return solanaInflight;
}
/** Same validated loading path for initial intents and local replies. Failed reads retry on the next turn; no recorded fallback. */
export async function ensureCopilotCatalogs(text: string, intent?: unknown): Promise<void> {
  const shape = JSON.stringify(intent) ?? '';
  await Promise.all([...catalogNetworksNamed(text, intent).map(n => ensureNetworkCatalog(true, n.chain)),
    ...(/\bsolana\b/i.test(text) || /"(?:network|sourceNetwork|destinationNetwork)":"SOLANA"/.test(shape) ? [ensureSolana()] : [])]);
}
