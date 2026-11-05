// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD AAVE-V3-CARD-CATALOG-FIX-001: one shared live Aave market read per market and owner for every card and form on the page (the server
 * paces public RPCs and refuses more than two uncached reads at once). A successful read is reused for 30 s; a failure is never cached; and
 * `forgetAaveReserves()` — called when an owner's step executes — drops every read and makes mounted readers read again, so positions the
 * owner just changed are never shown from before the change. Advisory only: Simulate re-reads every fact it relies on.
 */
import { useSyncExternalStore } from 'react';
import type { AaveMarketCatalog } from '@defi-workflow-engine/reference-compiler';
import { supplyReserves } from '../app/supply-action';

export type ReserveRead = { readonly catalog: AaveMarketCatalog | null; readonly failed: boolean; readonly code: string | null };
const READS = new Map<string, { readonly at: number; readonly read: Promise<ReserveRead> }>();
const READ_TTL_MS = 30_000;
let generation = 0;
const listeners = new Set<() => void>();
export function readAaveReserves(chain: string, account: string | null, fresh: boolean): Promise<ReserveRead> {
  const key = `${chain}|${account ?? ''}`, cached = READS.get(key);
  if (!fresh && cached && Date.now() - cached.at < READ_TTL_MS) return cached.read;
  const read = supplyReserves(chain, account ?? undefined).then(result => result.ok ? { catalog: result.value, failed: false, code: null } : { catalog: null, failed: true, code: result.code },
    () => ({ catalog: null, failed: true, code: null }));
  READS.set(key, { at: Date.now(), read });
  void read.then(result => { if (result.failed && READS.get(key)?.read === read) READS.delete(key); });
  return read;
}
/** Drops every shared read and tells mounted readers to read again (after the owner's own transaction). */
export function forgetAaveReserves(): void {
  READS.clear(); generation += 1;
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
/** The current read generation: it changes whenever the shared reads are forgotten. */
export function useAaveReadGeneration(): number { return useSyncExternalStore(subscribe, () => generation, () => 0); }
