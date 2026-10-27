// SPDX-License-Identifier: AGPL-3.0-only
import { parseJsonBytes } from '@defi-workflow-engine/workflow-contracts';
import { quoteFailure } from '../../../server/quote-failure';
import { readBuildEstimate } from '../../../server/build-estimate';
export const maxDuration = 45;
export async function POST(request: Request) {
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > 262_144) return Response.json(quoteFailure(new Error('ESTIMATE_INVALID')), { status: 413 });
  try { return Response.json(await readBuildEstimate(parseJsonBytes(new Uint8Array(bytes)))); }
  catch { return Response.json(quoteFailure(new Error('ESTIMATE_INVALID')), { status: 400 }); }
}
