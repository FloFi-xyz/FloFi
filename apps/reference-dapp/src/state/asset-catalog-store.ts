// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-RH-002: loads a catalog network's official catalog once per page (on demand) and registers it for authoring — Robinhood Chain by
 * default, and (BUILD-BASE-001) Base. States per network: idle → loading → ready | unavailable (retry allowed). Nothing here authorizes anything.
 */
import { useSyncExternalStore } from 'react';
import { loadNetworkAssetCatalog } from '../app/asset-catalog-action';
import { networkCatalogsVersion, registerNetworkCatalog, ROBINHOOD_CHAIN, subscribeNetworkCatalogs } from '../domain/asset-catalogs';

export type CatalogStatus = 'idle' | 'loading' | 'ready' | 'unavailable';
type Entry = { status: CatalogStatus; code: string | null; inflight: Promise<void> | null };
const entries = new Map<string, Entry>();
const entry = (chain: string): Entry => { let found = entries.get(chain); if (!found) { found = { status: 'idle', code: null, inflight: null }; entries.set(chain, found); } return found; };
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };
function subscribe(listener: () => void) {
  listeners.add(listener);
  const off = subscribeNetworkCatalogs(listener);
  return () => { listeners.delete(listener); off(); };
}
/** Starts (or joins) a network's catalog load; an unavailable catalog can be retried explicitly. */
export function ensureNetworkCatalog(retry = false, chain: string = ROBINHOOD_CHAIN): Promise<void> {
  const state = entry(chain);
  if (state.status === 'ready' || (state.status === 'unavailable' && !retry)) return Promise.resolve();
  if (state.inflight) return state.inflight;
  state.status = 'loading'; state.code = null; emit();
  state.inflight = loadNetworkAssetCatalog(chain).then(result => {
    if (!result.ok) { state.status = 'unavailable'; state.code = result.code; return; }
    registerNetworkCatalog(result.catalog); state.status = 'ready';
  }).catch(() => { state.status = 'unavailable'; state.code = chain === ROBINHOOD_CHAIN ? 'STOCK_REGISTRY_UNAVAILABLE' : 'BASE_TOKEN_LIST_UNAVAILABLE'; })
    .finally(() => { state.inflight = null; emit(); });
  return state.inflight;
}
export function useNetworkCatalog(chain: string = ROBINHOOD_CHAIN) {
  const version = useSyncExternalStore(subscribe, () => `${entry(chain).status}:${networkCatalogsVersion()}`, () => 'idle:0');
  const state = entry(chain);
  return { status: state.status, code: state.code, version, ensure: () => ensureNetworkCatalog(false, chain), retry: () => ensureNetworkCatalog(true, chain) };
}
