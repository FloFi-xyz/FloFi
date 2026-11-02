// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-MCP-001: `POST /api/mcp` — the FloFi Remote MCP Gateway (Streamable HTTP, stateless; see `src/mcp/gateway.ts`).
 * Disabled unless `FLOFI_MCP=enabled` with `FLOFI_MCP_CLIENTS`; every request needs a FloFi MCP bearer credential.
 */
import { handleMcpRequest, type GatewayLogger } from '../../../mcp/gateway';

export const dynamic = 'force-dynamic';
// The platform limit. Every request answers well before it: the gateway's request budget (`src/mcp/deadline.ts`, 150 s) bounds each
// store, runtime and provider read and each tool, and the gateway answers by itself at its hard deadline. Never raise this to hide a hang.
export const maxDuration = 300;

let logger: Promise<GatewayLogger> | null = null;
// Loaded on first use, like the embedded runtime: the structured, redacting logger of the cloud runtime.
const log = () => logger ??= import('@defi-workflow-engine/cloud-runtime').then(runtime => runtime.createLogger({ service: 'flofi-mcp' }));

async function serve(request: Request): Promise<Response> {
  return handleMcpRequest(request, { logger: await log() });
}
export const POST = serve;
// Stateless serving: GET and DELETE (2025 session operations) are authenticated, then answered by the SDK (405).
export const GET = serve;
export const DELETE = serve;
