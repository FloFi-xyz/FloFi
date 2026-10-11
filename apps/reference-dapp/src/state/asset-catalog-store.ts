// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-RH-002: loads the official Robinhood Chain catalog once per page (on demand) and registers it for authoring.
 * States: idle → loading → ready | unavailable (retry allowed). Nothing here authorizes anything.
 */
import { useSyncExternalStore } from 'react';
import { loadNetworkAssetCatalog } from '../app/asset-catalog-action';
import { networkCatalogsVersion, registerNetworkCatalog, ROBINHOOD_CHAIN, subscribeNetworkCatalogs } from '../domain/asset-catalogs';

export type CatalogStatus = 'idle' | 'loading' | 'ready' | 'unavailable';
let status: CatalogStatus = 'idle', code: string | null = null, inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };
function subscribe(listener: () => void) {
  listeners.add(listener);
  const off = subscribeNetworkCatalogs(listener);
  return () => { listeners.delete(listener); off(); };
}
/** Starts (or joins) the catalog load; an unavailable catalog can be retried explicitly. */
export function ensureNetworkCatalog(retry = false): Promise<void> {
  if (status === 'ready' || (status === 'unavailable' && !retry)) return Promise.resolve();
  if (inflight) return inflight;
  status = 'loading'; code = null; emit();
  inflight = loadNetworkAssetCatalog(ROBINHOOD_CHAIN).then(result => {
    if (!result.ok) { status = 'unavailable'; code = result.code; return; }
    registerNetworkCatalog(result.catalog); status = 'ready';
  }).catch(() => { status = 'unavailable'; code = 'STOCK_REGISTRY_UNAVAILABLE'; }).finally(() => { inflight = null; emit(); });
  return inflight;
}
export function useNetworkCatalog() {
  const version = useSyncExternalStore(subscribe, () => `${status}:${networkCatalogsVersion()}`, () => 'idle:0');
  return { status, code, version, ensure: () => ensureNetworkCatalog(), retry: () => ensureNetworkCatalog(true) };
}
