// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CLOUD-PARITY-001: `GET /api/flofi/readiness[?probe=networks]` — the deployment's non-secret readiness (see
 * `src/server/readiness.ts`). 200 when its runtime is usable, 503 otherwise. No URL, key or upstream message is ever returned.
 */
import { cachedReadiness } from '../../../../server/readiness';

export const dynamic = 'force-dynamic';
// Bounded: each EVM probe makes at most three sequential 5-second requests (chain id, block, and the `eth_simulateV1` support probe of the
// Base, Ethereum and Arbitrum One mainnet endpoints and of every user-funded EVM endpoint); Solana makes two; all networks run concurrently.
export const maxDuration = 60;
const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

export async function GET(request: Request): Promise<Response> {
  const networks = new URL(request.url).searchParams.get('probe') === 'networks';
  try {
    const report = await cachedReadiness(networks);
    return Response.json(report, { status: report.ok ? 200 : 503, headers });
  } catch {
    return Response.json({ service: 'flofi-web', ok: false, code: 'READINESS_UNAVAILABLE' }, { status: 503, headers });
  }
}
