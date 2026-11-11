// SPDX-License-Identifier: AGPL-3.0-only
import { parseJsonBytes } from '@defi-workflow-engine/workflow-contracts';
import { quoteFailure } from '../../../server/quote-failure';
import { readBuildEstimate } from '../../../server/build-estimate';
import { randomUUID } from 'node:crypto';
import { createLogger, parseTraceparent, withSpan } from '@defi-workflow-engine/cloud-runtime';
import { withFlightAccess } from '../../../server/flight-access';
export const maxDuration = 45;
export async function POST(request: Request) {
  try { return await withFlightAccess(() => estimate(request)); }
  catch (error) { return Response.json({ ok: false, code: error instanceof Error && /^BETA_[A-Z_]+$/.test(error.message)
    ? error.message : 'BETA_ACCESS_UNAVAILABLE' }, { status: 403, headers: { 'cache-control': 'no-store' } }); }
}
async function estimate(request: Request) {
  const supplied = request.headers.get('x-quote-correlation-id');
  const correlationId = supplied && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(supplied) ? supplied : randomUUID();
  const reply = (result: Awaited<ReturnType<typeof readBuildEstimate>>, status = 200) => Response.json(result.ok ? {
    ...result, estimate: { ...result.estimate, correlationId } } : { ...result, correlationId }, { status, headers: { 'cache-control': 'no-store', 'x-quote-correlation-id': correlationId } });
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > 262_144) return reply(quoteFailure(new Error('ESTIMATE_INVALID'), correlationId), 413);
  try {
    const logger = createLogger({ service: 'flofi-quotes' });
    // The span sees the estimate itself (not the HTTP response), so a refused quote is logged `refused` with its code (telemetry.ts).
    const result = await withSpan(logger, 'quote.endpoint', { correlation_id: correlationId }, async () => {
      // P0 catalog reliability: a browser that cancels (a newer edit superseded this estimate) cancels the API preview behind it too.
      const started = performance.now();
      const estimate = await readBuildEstimate(parseJsonBytes(new Uint8Array(bytes)), process.env, { correlationId, signal: request.signal });
      logger.info('quote.response', { correlation_id: correlationId, status: estimate.ok ? 'QUOTE_AVAILABLE' : estimate.code,
        outcome: estimate.ok ? 'ok' : request.signal.aborted ? 'cancelled' : 'refused', duration_ms: Math.round(performance.now() - started),
        ...estimate.ok ? { provider: estimate.estimate.provider, chain: estimate.estimate.chain } : {} });
      return estimate;
    }, parseTraceparent(`00-${correlationId.replaceAll('-', '')}-0000000000000001-01`));
    return reply(result);
  } catch { return reply(quoteFailure(new Error('ESTIMATE_INVALID'), correlationId), 400); }
}
