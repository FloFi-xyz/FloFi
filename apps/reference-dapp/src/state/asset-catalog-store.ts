// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-RH-002: loads a catalog network's official catalog once per page (on demand) and registers it for authoring — Robinhood Chain by
 * default, and (BUILD-BASE-001) Base. States per network: idle → loading → ready | unavailable (retry allowed). Nothing here authorizes anything.
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { loadNetworkAssetCatalog } from '../app/asset-catalog-action';
import { networkCatalogsVersion, registerNetworkCatalog, ROBINHOOD_CHAIN, subscribeNetworkCatalogs } from '../domain/asset-catalogs';
import { CATALOG_NETWORK_IDENTITIES } from '../domain/network-registry';
import { universalBridgeDetails } from '../domain/universal-bridge-authoring';

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
  }).catch(() => { state.status = 'unavailable'; state.code = 'ASSET_CATALOG_UNAVAILABLE'; })
    .finally(() => { state.inflight = null; emit(); });
  return state.inflight;
}
export function useNetworkCatalog(chain: string = ROBINHOOD_CHAIN) {
  const version = useSyncExternalStore(subscribe, () => `${entry(chain).status}:${networkCatalogsVersion()}`, () => 'idle:0');
  const state = entry(chain);
  return { status: state.status, code: state.code, version, ensure: () => ensureNetworkCatalog(false, chain), retry: () => ensureNetworkCatalog(true, chain) };
}

/** The catalog networks a workflow's steps use (each step's network, and a bridge's destination), in catalog order. */
export function workflowCatalogChains(workflow: { readonly nodes: readonly { readonly chainId: string }[] }): readonly string[] {
  return CATALOG_NETWORK_IDENTITIES.filter(network => workflow.nodes.some(node => node.chainId === network.chain
    || universalBridgeDetails(node as Parameters<typeof universalBridgeDetails>[0])?.fields.destinationChain === network.chain)).map(network => network.chain);
}
/**
 * BUILD-FLOFI-EDITOR-VISUAL-FIDELITY-002: Simulate and Execute show the same cards and summaries as Create, so they load the same official
 * catalogs the Create Canvas loads (each catalog network a step uses, and a bridge's destination). Before, a workflow opened directly on Simulate or
 * Execute never loaded them and a listed token (AAVE on Arbitrum) read as the neutral "Token". Display only: identities still resolve only from the
 * server-validated catalog (a token it does not list stays unidentified), and Simulate re-validates every identity. Returns the catalogs' version so
 * a memoized view re-renders once one registers.
 */
export function useWorkflowNetworkCatalogs(workflow: { readonly nodes: readonly { readonly chainId: string }[] }): string {
  const { version } = useNetworkCatalog();
  // Decoded once per change of the workflow's steps (a bridge's destination needs its node decoded), never on every render.
  const chains = useMemo(() => workflowCatalogChains(workflow).join(), [workflow.nodes]);
  useEffect(() => { for (const chain of chains ? chains.split(',') : []) void ensureNetworkCatalog(false, chain); }, [chains]);
  return `${chains}|${version}`;
}
