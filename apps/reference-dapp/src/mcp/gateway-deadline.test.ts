// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-E2E-RELIABILITY-001 (MCP review): the gateway's OWN hard-deadline answer, exercised with an SDK handler that never answers and
 * never closes — so it is the gateway's backstop that answers, not a tool's own timeout. A `tools/call` gets a tool result with `isError` and
 * the classified body (an approval request's outcome UNKNOWN, no automatic retry, no next step that needs an approvalId); other methods keep a
 * JSON-RPC error; every request id of a batch is echoed; the answer is never held behind `handler.close()`.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@modelcontextprotocol/server', async original => ({ ...await original<typeof import('@modelcontextprotocol/server')>(),
  createMcpHandler: () => ({ fetch: () => new Promise<Response>(() => undefined), close: () => new Promise<void>(() => undefined) }) }));
const { credential, gatewayEnv, session } = await import('./gateway.test-harness');

const alice = { principal: 'dev-alice', token: credential(), wallets: ['0x1111111111111111111111111111111111111111'] };
const env = gatewayEnv([alice]);
const headers = { 'mcp-protocol-version': '2025-11-25' };

describe('BUILD-FLOFI-E2E-RELIABILITY-001 gateway hard-deadline answer', () => {
  it('a tools/call that never answers gets a tool RESULT (isError) with the classified UNKNOWN outcome, by the hard deadline even if close() hangs', async () => {
    const client = session({ env, token: alice.token, budgetMs: 1_200, marginMs: 400 }), started = Date.now();
    const response = await client.post({ jsonrpc: '2.0', id: 'r1', method: 'tools/call', params: { name: 'request_user_approval', arguments: {} } }, headers);
    expect(Date.now() - started).toBeLessThan(1_200 + 1_500);
    const message = response.message as { id?: unknown; error?: unknown; result?: { isError?: boolean; structuredContent?: Record<string, unknown> } };
    expect(message.id).toBe('r1');
    expect(message.error).toBeUndefined();
    expect(message.result?.isError).toBe(true);
    expect(message.result?.structuredContent).toMatchObject({ ok: false, code: 'MCP_REQUEST_TIMEOUT', outcome: 'UNKNOWN', automaticRetry: false, retryable: false, next: [],
      requestId: response.headers.get('x-flofi-request-id') });
    expect(JSON.stringify(message)).not.toMatch(/apr_|flofi_hs_|approvalUrl/);
  });
  it('a batch echoes every request id (long ids included); a non-tool method keeps a JSON-RPC error', async () => {
    const client = session({ env, token: alice.token, budgetMs: 1_200, marginMs: 400 });
    const long = 'x'.repeat(300);
    const response = await client.post([{ jsonrpc: '2.0', id: long, method: 'tools/list' },
      ...Array.from({ length: 120 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'get_supported_networks', arguments: {} } }))], headers);
    const answers = JSON.parse(response.text) as { id: unknown; error?: unknown; result?: { isError?: boolean } }[];
    expect(answers).toHaveLength(121);
    expect(answers[0]).toMatchObject({ id: long, error: { code: -32001 } });
    expect(answers.slice(1).every(answer => answer.result?.isError === true)).toBe(true);
  });
});
