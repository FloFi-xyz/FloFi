// SPDX-License-Identifier: AGPL-3.0-only
import { parseJsonBytes } from '@defi-workflow-engine/workflow-contracts';
import { quoteFailure } from '../../../server/quote-failure';
import { readBuildEstimate } from '../../../server/build-estimate';
import { randomUUID } from 'node:crypto';
import { createLogger, parseTraceparent, withSpan } from '@defi-workflow-engine/cloud-runtime';
export const maxDuration = 45;
export async function POST(request: Request) {
  const supplied = request.headers.get('x-quote-correlation-id');
  const correlationId = supplied && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(supplied) ? supplied : randomUUID();
  const reply = (result: Awaited<ReturnType<typeof readBuildEstimate>>, status = 200) => Response.json(result.ok ? {
    ...result, estimate: { ...result.estimate, correlationId } } : { ...result, correlationId }, { status, headers: { 'cache-control': 'no-store', 'x-quote-correlation-id': correlationId } });
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > 262_144) return reply(quoteFailure(new Error('ESTIMATE_INVALID'), correlationId), 413);
  try {
    const logger = createLogger({ service: 'flofi-quotes' });
    return await withSpan(logger, 'quote.endpoint', { correlation_id: correlationId }, async () => {
      // P0 catalog reliability: a browser that cancels (a newer edit superseded this estimate) cancels the API preview behind it too.
      const started = performance.now();
      const result = await readBuildEstimate(parseJsonBytes(new Uint8Array(bytes)), process.env, { correlationId, signal: request.signal });
      logger.info('quote.response', { correlation_id: correlationId, status: result.ok ? 'QUOTE_AVAILABLE' : result.code,
        outcome: result.ok ? 'ok' : request.signal.aborted ? 'cancelled' : 'refused', duration_ms: Math.round(performance.now() - started),
        ...result.ok ? { provider: result.estimate.provider, chain: result.estimate.chain } : {} });
      return reply(result);
    }, parseTraceparent(`00-${correlationId.replaceAll('-', '')}-0000000000000001-01`));
  } catch { return reply(quoteFailure(new Error('ESTIMATE_INVALID'), correlationId), 400); }
}
