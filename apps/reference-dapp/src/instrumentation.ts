// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Next.js server start. BUILD-FLOFI-FLIGHT-001: registers the Flight FloFi simulation record (`flight/simulation-evidence.ts`) as the
 * flow runtime's simulation observer, in the Node.js runtime only. The record reads the signed-in account and the campaign database;
 * the flow runtime itself never imports either.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') await import('./instrumentation-node');
}
