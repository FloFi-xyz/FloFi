// SPDX-License-Identifier: AGPL-3.0-only
/** The platform-fee server actions: strict argument shape, the principal only from the verified session, and the API call they forward. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callCloudPlatformFee } from '../server/cloud-api-client';
import { platformFeeSettle, platformFeeStatus } from './platform-fee-action';

const f = vi.hoisted(() => ({ evm: null as string | null, solana: null as string | null, access: [] as string[], calls: [] as unknown[][] }));
vi.mock('../server/session-principal', () => ({
  currentWalletSession: async () => f.evm ? { account: f.evm } : null, currentSolanaSession: async () => f.solana ? { account: f.solana } : null }));
vi.mock('../server/flight-access', async original => ({ ...await original<typeof import('../server/flight-access')>(),
  requireFlightMethodAccess: async (method: string) => { f.access.push(method); return null; } }));
vi.mock('../server/cloud-api-client', async original => ({ ...await original<typeof import('../server/cloud-api-client')>(),
  callCloudPlatformFee: vi.fn(async (...args: unknown[]) => { f.calls.push(args); return { ok: true, value: { state: 'COLLECTED', transfers: [] } }; }) }));

const EVM = '0x' + 'a'.repeat(40), WFR = 'wfr_' + 'a'.repeat(26);
beforeEach(() => { f.evm = null; f.solana = null; f.access = []; f.calls = []; });

describe('platform-fee server actions', () => {
  it('refuse any argument that is not exactly one run id or workflow run id, before any session or network work', async () => {
    f.evm = EVM;
    for (const bad of [null, 'run-1', [], {}, { runId: '' }, { runId: 'wfr_' + 'a'.repeat(26) }, { runId: 'run-1', workflowRunId: WFR }, { runId: 'run-1', principal: EVM },
      { workflowRunId: 'wfr_short' }, { runId: '../x' }, { runId: 'a'.repeat(129) }, { runId: 5 }]) {
      expect(await platformFeeStatus(bad)).toEqual({ ok: false, code: 'ARGUMENTS_INVALID' });
      expect(await platformFeeSettle(bad)).toEqual({ ok: false, code: 'ARGUMENTS_INVALID' });
    }
    expect(f.calls).toEqual([]); expect(f.access).toEqual([]);
  });
  it('need a verified wallet session', async () => {
    expect(await platformFeeStatus({ runId: 'run-1' })).toEqual({ ok: false, code: 'WALLET_PRINCIPAL_REQUIRED' });
    expect(f.calls).toEqual([]);
  });
  it('forward the exact execution as the session wallet, with the flow-method access of status (owner read) and settle', async () => {
    f.evm = EVM;
    await platformFeeStatus({ runId: 'run-1' }); await platformFeeSettle({ workflowRunId: WFR });
    expect(f.access).toEqual(['status', 'settle']);
    expect(f.calls.map(([path, execution, options]) => [path, execution, (options as { principal: string }).principal])).toEqual([
      ['status', { runId: 'run-1' }, EVM], ['settle', { workflowRunId: WFR }, EVM]]);
    expect(vi.mocked(callCloudPlatformFee)).toHaveBeenCalledTimes(2);
  });
  it('use the Solana session when there is no EVM one, or when it is asked for', async () => {
    f.solana = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpAAAAAAAAAAAA'; f.evm = EVM;
    await platformFeeSettle({ runId: 'run-1' }, 'solana');
    f.evm = null; await platformFeeSettle({ runId: 'run-1' });
    expect(f.calls.map(([, , options]) => (options as { principal: string }).principal)).toEqual([f.solana, f.solana]);
  });
});

describe('callCloudPlatformFee', () => {
  const env = { API_BASE_URL: 'https://api.example.test/', API_AUTH_TOKEN: 'tok' };
  const real = async () => (await vi.importActual<typeof import('../server/cloud-api-client')>('../server/cloud-api-client')).callCloudPlatformFee;
  const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  it('posts the execution with the bearer token and wallet principal header, without an idempotency key', async () => {
    const calls: { url: string; headers: Headers; body: unknown }[] = [];
    const transport = (async (url: URL, init: RequestInit) => { calls.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(String(init.body)) }); return respond(200, { ok: true, value: { a: 1 } }); }) as unknown as typeof fetch;
    expect(await (await real())('status', { runId: 'run-1' }, { env, transport, principal: EVM, betaIdentity: null })).toEqual({ ok: true, value: { a: 1 } });
    expect(calls[0]!.url).toBe('https://api.example.test/v1/platform-fees/status');
    expect(calls[0]!.body).toEqual({ execution: { runId: 'run-1' } });
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer tok'); expect(calls[0]!.headers.get('idempotency-key')).toBeNull();
    expect(calls[0]!.headers.get('x-flofi-wallet-principal') ?? [...calls[0]!.headers.values()].find(v => v === EVM)).toBe(EVM);
  });
  it('retries status on 503 and transport errors, but settle at most twice', async () => {
    const run = async (path: 'status' | 'settle', statuses: number[]) => {
      let n = 0; const transport = (async () => { const s = statuses[n++]; if (s === 0) throw new Error('down'); return respond(s!, s === 200 ? { ok: true, value: 1 } : { ok: false, code: 'X_FAILED' }); }) as unknown as typeof fetch;
      return { result: await (await real())(path, { runId: 'run-1' }, { env, transport, sleep: async () => undefined, principal: EVM, betaIdentity: null }), attempts: n };
    };
    expect(await run('status', [503, 0, 200])).toEqual({ result: { ok: true, value: 1 }, attempts: 3 });
    expect((await run('settle', [0, 200])).attempts).toBe(1);
    expect((await run('settle', [503, 503, 200])).attempts).toBe(2);
  });
});
