// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WALLET_PRINCIPAL_HEADER } from '../server/run-ownership';
import { credential, gatewayEnv, session } from './gateway.test-harness';
import { deploymentRuntime } from './runtime';

const OWNER = '0x1111111111111111111111111111111111111111', RUN = 'xroute-' + 'a'.repeat(32);
const INTERNAL = credential();
const REMOTE = { API_BASE_URL: 'https://api.flofi.test', API_AUTH_TOKEN: INTERNAL };
afterEach(() => { vi.restoreAllMocks(); });
type Seen = { url: string; method: string; headers: Record<string, string>; body: string | null };
function fakeApi(answer: (seen: Seen) => { status: number; body: unknown }) {
  const seen: Seen[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = { url: String(input), method: init?.method ?? 'GET', headers: Object.fromEntries(new Headers(init?.headers).entries()), body: (init?.body as string | undefined) ?? null };
    seen.push(request);
    const { status, body } = answer(request);
    return Response.json(body, { status });
  });
  return seen;
}

describe('BUILD-MCP-001 runtime selection for the gateway (BUILD-CLOUD-PARITY-001 runtimes, no second runtime)', () => {
  it('preserves per-network transfer enablement from the runtime and discards malformed network facts', async () => {
    for (const networks of [['ethereum-sepolia'], undefined, [1]]) {
      fakeApi(() => ({ status: 200, body: { ok: true, value: { executionEnabled: true, networks } } }));
      expect(await deploymentRuntime(REMOTE).info!('robinhood-transfer')).toEqual({ executionEnabled: true,
        ...(networks?.[0] === 'ethereum-sepolia' ? { networks } : {}) });
    }
  });
  it.each([REMOTE, { ...REMOTE, DATABASE_URL: 'postgres://db/platform', VERCEL: '1', VERCEL_ENV: 'production' }])(
    'remote: previews and owner-scoped reads go to the Flofi API with the internal credential, including with DATABASE_URL (%j)', async env => {
    const seen = fakeApi(({ url }) => url.endsWith('/v1/previews/crosschain-router-testnet') ? { status: 200, body: { ok: false, code: 'ROUTER_NO_EXECUTABLE_ROUTE' } }
      : url.includes('/journal') ? { status: 200, body: { ok: true, value: { items: [], next: null } } }
      : url.includes('/v1/flows/') ? { status: 200, body: { ok: true, value: { evidence: null, verdict: 'PENDING' } } }
      : url.endsWith(`/v1/runs/${RUN}`) ? { status: 200, body: { ok: true, value: { runId: RUN, ownerAccount: OWNER } } } : { status: 404, body: { ok: false, code: 'RUN_NOT_FOUND' } });
    const runtime = deploymentRuntime(env);
    expect(runtime.kind).toBe('remote');
    // BUILD-FLOFI-MAINNET-PRODUCT-001: a hosted deployment (VERCEL=1) is the Mainnet-only product: its test-network preview never reaches the API.
    const hostedProduct = 'VERCEL' in env && env.VERCEL === '1';
    expect(await runtime.preview('crosschain-router-testnet', [{ workflowId: 'w', nodes: [] }, OWNER]))
      .toEqual({ ok: false, code: hostedProduct ? 'TEST_NETWORK_NOT_AVAILABLE' : 'ROUTER_NO_EXECUTABLE_ROUTE' });
    expect(await runtime.run(RUN, OWNER)).toEqual({ ok: true, value: { runId: RUN, ownerAccount: OWNER } });
    expect(await runtime.run('xroute-' + 'b'.repeat(32), OWNER)).toEqual({ ok: true, value: null });
    expect(await runtime.journal(RUN, OWNER, 3, 10)).toEqual({ ok: true, value: { items: [], next: null } });
    expect(await runtime.evidence('crosschain-router-testnet', RUN, OWNER)).toEqual({ ok: true, value: null });
    // Reading a run and its evidence is history: it stays available for a test-network run.
    const reads = [`GET https://api.flofi.test/v1/runs/${RUN}`, `GET https://api.flofi.test/v1/runs/xroute-${'b'.repeat(32)}`,
      `GET https://api.flofi.test/v1/runs/${RUN}/journal?limit=10&after=3`, 'POST https://api.flofi.test/v1/flows/crosschain-router-testnet/status'];
    expect(seen.map(s => `${s.method} ${s.url}`)).toEqual(hostedProduct ? reads : ['POST https://api.flofi.test/v1/previews/crosschain-router-testnet', ...reads]);
    expect(seen.every(s => s.headers.authorization === `Bearer ${INTERNAL}`)).toBe(true);
    // A preview names no principal and carries no idempotency key (nothing durable happens); reads are made AS the owner wallet.
    if (!hostedProduct) {
      expect(seen[0]!.headers[WALLET_PRINCIPAL_HEADER]).toBeUndefined();
      expect(seen[0]!.headers['idempotency-key']).toBeUndefined();
      expect(JSON.parse(seen[0]!.body!)).toEqual({ args: [{ workflowId: 'w', nodes: [] }, OWNER] });
    }
    for (const s of seen.slice(hostedProduct ? 0 : 1)) expect(s.headers[WALLET_PRINCIPAL_HEADER]).toBe(OWNER);
  });

  it('an API deployed before BUILD-MCP-001 has no preview route: fail closed', async () => {
    fakeApi(() => ({ status: 404, body: { ok: false, code: 'NOT_FOUND' } }));
    expect(await deploymentRuntime(REMOTE).preview('aave-supply', [{}, OWNER])).toEqual({ ok: false, code: 'CLOUD_API_PREVIEW_UNAVAILABLE' });
  });

  it('local and unconfigured runtimes fail closed: no file journal, /tmp or process state is ever used', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const local = deploymentRuntime({ GRYLOO_ROUTER_TESTNET_JOURNAL: '/tmp/journal', GRYLOO_ROUTER_TESTNET_HARNESS: 'MOCKED_LOOPBACK_ONLY' });
    expect(local.kind).toBe('local');
    expect(await local.mode('crosschain-router-testnet')).toBeNull();
    for (const result of [await local.preview('crosschain-router-testnet', []), await local.run(RUN, OWNER), await local.journal(RUN, OWNER, null, 25),
      await local.evidence('crosschain-router-testnet', RUN, OWNER)]) expect(result).toEqual({ ok: false, code: 'MCP_CLOUD_RUNTIME_REQUIRED' });
    const hosted = deploymentRuntime({ VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'claude/build-mcp-001', GRYLOO_ROUTER_TESTNET_JOURNAL: '/tmp/journal' });
    expect(hosted.kind).toBe('unconfigured');
    expect(await hosted.mode('crosschain-router-testnet')).toBe('off');
    for (const result of [await hosted.preview('crosschain-router', []), await hosted.run(RUN, OWNER), await hosted.evidence('crosschain-router-testnet', RUN, OWNER)])
      expect(result).toEqual({ ok: false, code: 'CLOUD_RUNTIME_NOT_CONFIGURED' });
    // BUILD-FLOFI-MAINNET-PRODUCT-001: a hosted deployment is the Mainnet-only product: a test-network preview is refused before any runtime.
    expect(await hosted.preview('crosschain-router-testnet', [])).toEqual({ ok: false, code: 'TEST_NETWORK_NOT_AVAILABLE' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the MCP credential never leaves the gateway: the API sees only the internal credential', async () => {
    const seen = fakeApi(() => ({ status: 200, body: { ok: true, value: 'live' } }));
    const alice = { principal: 'dev-alice', token: credential(), wallets: [OWNER] };
    const client = session({ env: gatewayEnv([alice], REMOTE), token: alice.token });
    const caps = await client.callTool('get_capabilities', { network: 'base-sepolia' });
    expect(caps.output).toMatchObject({ ok: true, runtime: 'remote' });
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) {
      expect(JSON.stringify(s)).not.toContain(alice.token);
      expect(s.headers.authorization).toBe(`Bearer ${INTERNAL}`);
    }
  });
});
