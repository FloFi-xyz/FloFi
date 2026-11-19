// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: the Dashboard's per-wallet position scan cache, on its own so a position server action can drop a stale
 * scan without importing the scan itself (and, through it, model code: channel approval paths stay model-free — channels/boundaries.test.ts).
 *
 * Held on globalThis: the Dashboard route and the position server actions can run as separate bundles of one server process, and the actions must
 * reach the very cache the route serves (`forgetWalletPositions`).
 */
import { positionsWalletKey, type PositionScan, type PositionWallet } from '../domain/defi-positions';

export type CachedPositionScan = { readonly read: Promise<readonly PositionScan[]>; readonly startedAt: number; expires: number };
const shared = globalThis as unknown as Record<symbol, Map<string, CachedPositionScan> | undefined>;
export const positionScanCache: Map<string, CachedPositionScan> = (shared[Symbol.for('flofi.defi-positions.cache')] ??= new Map());

/**
 * The owner's own position operation landed at `changedAt` (its reconciliation time), so a cached scan of that wallet that STARTED before it no
 * longer describes the positions: it is dropped, and the next Dashboard or chat read scans again instead of serving the pre-operation facts for up
 * to 30 s. A scan started after the change is already fresh and kept. Reads nothing; true when a scan was dropped.
 */
export function forgetWalletPositions(owner: PositionWallet, changedAt: number): boolean {
  const key = positionsWalletKey(owner), entry = positionScanCache.get(key);
  if (!entry || !Number.isFinite(changedAt) || entry.startedAt >= changedAt) return false;
  positionScanCache.delete(key);
  return true;
}
