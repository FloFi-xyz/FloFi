// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useSyncExternalStore } from 'react';
import { networkCatalogsVersion, subscribeNetworkCatalogs } from '../domain/asset-catalogs';

/**
 * BUILD-FLOFI-EDITOR-VISUAL-FIDELITY-002: re-renders a view once any official token catalog registers (a listed token then reads by its symbol).
 * Subscription only — loading stays with the Canvas (`useWorkflowNetworkCatalogs`), so a shared component never pulls the catalog loader in.
 */
export function useNetworkCatalogsVersion(): number {
  return useSyncExternalStore(subscribeNetworkCatalogs, networkCatalogsVersion, () => 0);
}
