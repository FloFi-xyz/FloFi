// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ADMIN-001: Copilot runtime settings end to end against PostgreSQL.
 *
 *  - The settings API (OPERATOR only, CSRF) validates, versions, rolls back and resets; stale writers conflict; every change is audited.
 *  - A change is picked up by the very next model request of independent runtime instances (separate pools and interpreters, no shared
 *    memory): the Channel Core interpreter per channel scope and FloFi's web chat server action, both through their real entry points,
 *    against a stubbed Responses API endpoint (no network, no key, no model).
 *  - The live probe sends the strict FloFi request with candidate settings and reports only allow-listed upstream rejection fields.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from '@defi-workflow-engine/cloud-runtime';
import { createTestDatabase, type TestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import { createTestWallet } from '../../../../packages/reference-reconciler/test/test-wallet.ts';
import { channelInterpreter } from '../channels/core/interpreter.ts';
import { channelLiveCopilot, hostSettingsReader, resolveCopilotLive } from '../server/copilot-runtime.ts';
import { COPILOT_SETTINGS_SCHEMA, type CopilotRuntimeSettings } from '../server/copilot-settings.ts';
import { runAdminCommand } from './cli-commands.ts';
import { adminConfig } from './config.ts';
import { handleAdminChallenge, handleAdminSignIn, type AdminHttpOptions } from './http.ts';
import { adminCsrfToken, readAdminSession } from './session.ts';
import { handleCopilotSettings, PROBE_LIMIT } from './settings-http.ts';

const ORIGIN = 'https://admin.flofi.example', DOMAIN = 'admin.flofi.example';
const adminEnv = { FLOFI_ADMIN: 'enabled', FLOFI_ADMIN_SESSION_SECRET: randomBytes(32).toString('hex') };
const copilotEnv = { FLOFI_COPILOT: 'live', OPENAI_API_KEY: 'sk-test-not-a-real-key', OPENAI_COPILOT_MODEL: 'gpt-4.1-mini', DATABASE_URL: 'postgres://placeholder' };
const key = (() => { const c = adminConfig(adminEnv); if (!c.enabled) throw new Error(c.code); return c.key; })();
const replay = JSON.parse(readFileSync(new URL('../../e2e/copilot/replay-v2.json', import.meta.url), 'utf8')) as { entries: { user: string[]; answer: { output: unknown } }[] };
const RECORDED = replay.entries.find(entry => entry.user.length === 1 && entry.user[0] === 'Put 1 USDC into Aave on Base Sepolia')!;
const okBody = (model: string) => JSON.stringify({ id: 'resp_test', object: 'response', status: 'completed', model,
  output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(RECORDED.answer.output), annotations: [] }] }],
  usage: { input_tokens: 1200, output_tokens: 80, output_tokens_details: { reasoning_tokens: 16 } } });

let t: TestDatabase;
const now = new Date('2026-10-14T12:00:00.000Z');
const options = (): AdminHttpOptions => ({ env: { ...adminEnv, ...copilotEnv }, host: { db: t.db, tenantId: 'default' }, now: () => now });
type Session = { cookie: string; csrf: string };
async function adminSession(role: 'VIEWER' | 'OPERATOR'): Promise<Session> {
  const wallet = createTestWallet();
  await runAdminCommand('grant', { wallet: wallet.address, role }, t.db, 'default');
  const headers = (cookie = '') => ({ host: DOMAIN, 'x-forwarded-proto': 'https', origin: ORIGIN, 'content-type': 'application/json', cookie });
  const challenge = await handleAdminChallenge(new Request(`${ORIGIN}/admin/api/session/challenge`, { method: 'POST', headers: headers(),
    body: JSON.stringify({ address: wallet.address, chainId: 1 }) }), options());
  const challengeCookie = challenge.headers.getSetCookie()[0]!.split(';')[0]!, { message } = await challenge.json() as { message: string };
  const signedIn = await handleAdminSignIn(new Request(`${ORIGIN}/admin/api/session`, { method: 'POST', headers: headers(challengeCookie),
    body: JSON.stringify({ address: wallet.address, chainId: 1, signature: wallet.signMessage(message) }) }), options());
  const cookie = signedIn.headers.getSetCookie().map(c => c.split(';')[0]!).find(c => c.startsWith('flofi_admin_session='))!;
  const reference = readAdminSession(key, cookie.slice('flofi_admin_session='.length), now, DOMAIN)!;
  return { cookie, csrf: adminCsrfToken(key, reference.sessionId) };
}
async function settings(session: Session, body: Record<string, unknown>, extra: Partial<Parameters<typeof handleCopilotSettings>[1]> = {}) {
  const response = await handleCopilotSettings(new Request(`${ORIGIN}/admin/api/settings/copilot`, { method: 'POST', body: JSON.stringify(body),
    headers: { host: DOMAIN, 'x-forwarded-proto': 'https', origin: ORIGIN, 'content-type': 'application/json', cookie: session.cookie, 'x-flofi-admin-csrf': session.csrf } }),
  { ...options(), ...extra });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
const runtime: CopilotRuntimeSettings = { model: 'gpt-5-mini', temperature: null, reasoningEffort: 'low', maxOutputTokens: 6000, timeoutMs: 30_000, acknowledgedUnverified: false };
const documentWith = (model: string, telegram: string | null = null) => ({ schema: COPILOT_SETTINGS_SCHEMA, default: { ...runtime, model },
  overrides: telegram ? { TELEGRAM: { ...runtime, model: telegram, temperature: 0.2, reasoningEffort: null } } : {} });

/** A stubbed Responses API: records the model and parameters of every request; never reaches the network. */
const sent: { model: string; temperature?: number; reasoning?: { effort: string }; max_output_tokens: number }[] = [];
function stubOpenAI() {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    expect(url).toBe('https://api.openai.com/v1/responses');
    const body = JSON.parse(String(init.body)) as (typeof sent)[number];
    sent.push(body);
    return new Response(okBody(body.model), { status: 200, headers: { 'content-type': 'application/json' } });
  });
}
const request = { version: '2', messages: [{ role: 'user', text: 'Put 1 USDC into Aave on Base Sepolia' }] } as const;

beforeAll(async () => { t = await createTestDatabase(); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); sent.length = 0; });
afterAll(async () => {
  // The web chat path opened this process's platform-state pool on the test database; close it before dropping the database.
  const hosts = (globalThis as unknown as Record<symbol, Map<string, Promise<{ db: Database }>> | undefined>)[Symbol.for('flofi.platform-state')];
  for (const host of hosts?.values() ?? []) await host.then(h => h.db.close(), () => undefined);
  hosts?.clear();
  await t?.drop();
});

describe('BUILD-ADMIN-001 Copilot settings API (PostgreSQL)', () => {
  it('only operators change settings; viewers are refused and audited', async () => {
    const viewer = await adminSession('VIEWER');
    expect(await settings(viewer, { action: 'save', expectedVersion: 0, document: documentWith('gpt-5-mini') }))
      .toEqual({ status: 403, body: { ok: false, code: 'ADMIN_ROLE_INSUFFICIENT' } });
    expect((await t.db.query(`SELECT count(*)::int AS n FROM admin_settings_versions`)).rows).toEqual([{ n: 0 }]);
    const missingCsrf = await handleCopilotSettings(new Request(`${ORIGIN}/admin/api/settings/copilot`, { method: 'POST', body: '{}',
      headers: { host: DOMAIN, 'x-forwarded-proto': 'https', origin: ORIGIN, 'content-type': 'application/json', cookie: viewer.cookie } }), options());
    expect(missingCsrf.status).toBe(403);
  });

  it('validates, versions, conflicts, rolls back and resets; every change is audited', async () => {
    const operator = await adminSession('OPERATOR');
    expect(await settings(operator, { action: 'save', expectedVersion: 0, document: documentWith('gpt-5-mini', 'gpt-4o-mini'), reason: 'Move to GPT-5 mini' }))
      .toEqual({ status: 200, body: { ok: true, version: 1 } });
    expect(await settings(operator, { action: 'save', expectedVersion: 0, document: documentWith('gpt-5') }))
      .toEqual({ status: 409, body: { ok: false, code: 'ADMIN_SETTINGS_VERSION_CONFLICT', activeVersion: 1 } });
    expect(await settings(operator, { action: 'save', expectedVersion: 1, document: documentWith('gpt-5-mini', 'gpt-4o-mini') }))
      .toEqual({ status: 409, body: { ok: false, code: 'ADMIN_SETTINGS_UNCHANGED' } });
    expect(await settings(operator, { action: 'save', expectedVersion: 1, document: { ...documentWith('gpt-5'), default: { ...runtime, model: 'gpt-5', temperature: 0.3 } } }))
      .toEqual({ status: 400, body: { ok: false, code: 'COPILOT_SETTINGS_TEMPERATURE_UNSUPPORTED', field: 'default.temperature' } });
    expect(await settings(operator, { action: 'save', expectedVersion: 1, document: documentWith('acme-model') }))
      .toEqual({ status: 400, body: { ok: false, code: 'COPILOT_SETTINGS_MODEL_UNVERIFIED', field: 'default.model' } });
    expect(await settings(operator, { action: 'save', expectedVersion: 1, document: { ...documentWith('gpt-5'), apiKey: 'sk-x' } }))
      .toEqual({ status: 400, body: { ok: false, code: 'COPILOT_SETTINGS_SHAPE_INVALID', field: null } });
    expect(await settings(operator, { action: 'save', expectedVersion: 1, document: documentWith('gpt-5'), reason: 'bad\nreason' }))
      .toEqual({ status: 400, body: { ok: false, code: 'ADMIN_SETTINGS_REASON_INVALID' } });
    expect(await settings(operator, { action: 'save', expectedVersion: 1, document: documentWith('gpt-5') })).toEqual({ status: 200, body: { ok: true, version: 2 } });
    expect(await settings(operator, { action: 'rollback', expectedVersion: 2, toVersion: 2 })).toEqual({ status: 400, body: { ok: false, code: 'ADMIN_SETTINGS_VERSION_UNKNOWN' } });
    expect(await settings(operator, { action: 'rollback', expectedVersion: 2, toVersion: 1, reason: 'GPT-5 too slow' })).toEqual({ status: 200, body: { ok: true, version: 3 } });
    expect(await settings(operator, { action: 'reset', expectedVersion: 3 })).toEqual({ status: 200, body: { ok: true, version: 4 } });
    expect(await settings(operator, { action: 'reset', expectedVersion: 4 })).toEqual({ status: 409, body: { ok: false, code: 'ADMIN_SETTINGS_UNCHANGED' } });
    expect(await settings(operator, { action: 'drop', expectedVersion: 4 })).toEqual({ status: 400, body: { ok: false, code: 'ADMIN_REQUEST_INVALID' } });
    const versions = (await t.db.query<{ version: number; model: string | null; restored_from: number | null; reason: string | null }>(`SELECT version,
      document->'default'->>'model' AS model, restored_from, reason FROM admin_settings_versions ORDER BY version`)).rows;
    expect(versions).toEqual([{ version: 1, model: 'gpt-5-mini', restored_from: null, reason: 'Move to GPT-5 mini' }, { version: 2, model: 'gpt-5', restored_from: null, reason: null },
      { version: 3, model: 'gpt-5-mini', restored_from: 1, reason: 'GPT-5 too slow' }, { version: 4, model: null, restored_from: null, reason: null }]);
    const audit = (await t.db.query<{ kind: string; outcome: string; code: string | null; detail: Record<string, unknown> | null }>(`SELECT kind, outcome, code, detail
      FROM admin_audit_events WHERE kind LIKE 'ADMIN_COPILOT_SETTINGS_%' ORDER BY event_id`)).rows;
    expect(audit.map(e => [e.kind, e.outcome, e.code])).toEqual([['ADMIN_COPILOT_SETTINGS_SAVED', 'OK', null],
      ['ADMIN_COPILOT_SETTINGS_SAVED', 'REFUSED', 'COPILOT_SETTINGS_TEMPERATURE_UNSUPPORTED'], ['ADMIN_COPILOT_SETTINGS_SAVED', 'REFUSED', 'COPILOT_SETTINGS_MODEL_UNVERIFIED'],
      ['ADMIN_COPILOT_SETTINGS_SAVED', 'REFUSED', 'COPILOT_SETTINGS_SHAPE_INVALID'], ['ADMIN_COPILOT_SETTINGS_SAVED', 'OK', null],
      ['ADMIN_COPILOT_SETTINGS_ROLLED_BACK', 'OK', null], ['ADMIN_COPILOT_SETTINGS_RESET', 'OK', null]]);
    expect(audit[0]!.detail).toEqual({ version: 1, restoredFrom: null, model: 'gpt-5-mini', overrides: 'TELEGRAM' });
  });

  it('lets exactly one of two concurrent writers of the same version win', async () => {
    const operator = await adminSession('OPERATOR');
    const active = (await t.db.query<{ v: number }>(`SELECT max(version)::int AS v FROM admin_settings_versions`)).rows[0]!.v;
    const results = await Promise.all([settings(operator, { action: 'save', expectedVersion: active, document: documentWith('gpt-5-nano') }),
      settings(operator, { action: 'save', expectedVersion: active, document: documentWith('o4-mini') })]);
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    expect(results.find(r => r.status === 409)!.body.code).toBe('ADMIN_SETTINGS_VERSION_CONFLICT');
  });

  it('a change applies to the next request of every independent instance — channels and the web chat — and a reset restores the bootstrap', async () => {
    stubOpenAI();
    const operator = await adminSession('OPERATOR');
    const baseline = (await t.db.query<{ v: number }>(`SELECT max(version)::int AS v FROM admin_settings_versions`)).rows[0]!.v;
    await settings(operator, { action: 'reset', expectedVersion: baseline });
    // Two runtime instances: separate pools, separate interpreters, nothing shared but the database.
    const instances = [t.open(2), t.open(2)].map(db => ({ db,
      telegram: channelInterpreter(copilotEnv, { enabled: true, live: channelLiveCopilot(copilotEnv, 'TELEGRAM', { db, tenantId: 'default' }) })!,
      web: () => resolveCopilotLive(copilotEnv, 'WEB', hostSettingsReader({ db, tenantId: 'default' })) }));
    for (const instance of instances) expect(await instance.telegram(request)).toMatchObject({ ok: true, intent: { kind: 'ACTION' } });
    expect(sent.map(s => s.model)).toEqual(['gpt-4.1-mini', 'gpt-4.1-mini']);
    expect(sent[0]).toMatchObject({ temperature: 0, max_output_tokens: 4096 });

    const active = (await t.db.query<{ v: number }>(`SELECT max(version)::int AS v FROM admin_settings_versions`)).rows[0]!.v;
    expect((await settings(operator, { action: 'save', expectedVersion: active, document: documentWith('gpt-5-mini', 'gpt-4o-mini') })).status).toBe(200);
    sent.length = 0;
    for (const instance of instances) {
      expect(await instance.telegram(request)).toMatchObject({ ok: true });
      expect(await instance.web()).toMatchObject({ ok: true, source: 'RUNTIME', version: active + 1, settings: { model: 'gpt-5-mini' } });
    }
    expect(sent).toEqual([expect.objectContaining({ model: 'gpt-4o-mini', temperature: 0.2, max_output_tokens: 6000 }),
      expect.objectContaining({ model: 'gpt-4o-mini', temperature: 0.2, max_output_tokens: 6000 })]);
    expect(sent.every(s => s.reasoning === undefined)).toBe(true);

    // FloFi's web chat server action, through its real entry point and this process's platform-state pool.
    vi.stubEnv('FLOFI_COPILOT', 'live'); vi.stubEnv('OPENAI_API_KEY', copilotEnv.OPENAI_API_KEY); vi.stubEnv('OPENAI_COPILOT_MODEL', 'gpt-4.1-mini');
    vi.stubEnv('DATABASE_URL', t.url); vi.stubEnv('TENANT_ID', 'default'); vi.stubEnv('API_BASE_URL', undefined); vi.stubEnv('VERCEL', undefined);
    vi.stubEnv('FLOFI_RUNTIME', undefined); vi.stubEnv('FLOFI_COPILOT_RUNTIME_CONFIG', undefined);
    const { copilotInterpret, copilotStatus } = await import('../app/copilot-action.ts');
    sent.length = 0;
    expect(await copilotStatus()).toEqual({ mode: 'live' });
    expect(await copilotInterpret(request)).toMatchObject({ ok: true, intent: { kind: 'ACTION' } });
    expect(sent).toEqual([expect.objectContaining({ model: 'gpt-5-mini', reasoning: { effort: 'low' }, max_output_tokens: 6000 })]);
    expect(sent[0]!.temperature).toBeUndefined();

    // Rollback to the bootstrap: every instance, on its next request.
    await settings(operator, { action: 'reset', expectedVersion: active + 1 });
    sent.length = 0;
    for (const instance of instances) await instance.telegram(request);
    await copilotInterpret(request);
    expect(sent.map(s => s.model)).toEqual(['gpt-4.1-mini', 'gpt-4.1-mini', 'gpt-4.1-mini']);

    // The break-glass flag ignores the database entirely.
    await settings(operator, { action: 'save', expectedVersion: active + 2, document: documentWith('gpt-5') });
    vi.stubEnv('FLOFI_COPILOT_RUNTIME_CONFIG', 'disabled');
    sent.length = 0;
    await copilotInterpret(request);
    expect(sent.map(s => s.model)).toEqual(['gpt-4.1-mini']);
    for (const instance of instances) await instance.db.close();
  });

  it('probes candidate settings with one strict live request, reporting only allow-listed upstream fields, rate-limited', async () => {
    const operator = await adminSession('OPERATOR');
    const calls: string[] = [];
    const ok = await settings(operator, { action: 'probe', settings: { ...runtime, model: 'gpt-5-nano' } },
      { fetch: async (_url, init) => { calls.push(String(init?.body)); return new Response(okBody('gpt-5-nano-2025-08-07'), { status: 200 }); } });
    expect(ok).toMatchObject({ status: 200, body: { ok: true, probe: { ok: true, code: null, intentKind: 'ACTION', upstream: null, inputTokens: 1200, outputTokens: 80,
      reasoningTokens: 16, responseModel: 'gpt-5-nano-2025-08-07' } } });
    expect(JSON.parse(calls[0]!)).toMatchObject({ model: 'gpt-5-nano', store: false, text: { format: { type: 'json_schema', strict: true } }, reasoning: { effort: 'low' } });
    const rejected = await settings(operator, { action: 'probe', settings: { ...runtime, model: 'my-model', temperature: 0.5, reasoningEffort: null, acknowledgedUnverified: true } },
      { fetch: async () => new Response(JSON.stringify({ error: { message: 'Unsupported parameter: temperature … sk-should-not-echo', type: 'invalid_request_error',
        param: 'temperature', code: 'unsupported_parameter' } }), { status: 400 }) });
    expect(rejected.body).toMatchObject({ ok: true, probe: { ok: false, code: 'COPILOT_UPSTREAM_REJECTED', upstream: { code: 'unsupported_parameter', param: 'temperature' } } });
    expect(JSON.stringify(rejected.body)).not.toContain('sk-should-not-echo');
    expect(await settings(operator, { action: 'probe', settings: { ...runtime, model: 'gpt-5', temperature: 0.4 } }))
      .toMatchObject({ status: 400, body: { code: 'COPILOT_SETTINGS_TEMPERATURE_UNSUPPORTED' } });
    expect(await settings(operator, { action: 'probe', settings: runtime }, { env: { ...adminEnv, FLOFI_COPILOT: 'replay' } }))
      .toEqual({ status: 409, body: { ok: false, code: 'COPILOT_NOT_LIVE' } });
    for (let i = 2; i < PROBE_LIMIT; i++) await settings(operator, { action: 'probe', settings: runtime }, { fetch: async () => new Response(okBody('gpt-5-mini'), { status: 200 }) });
    expect(await settings(operator, { action: 'probe', settings: runtime }, { fetch: async () => { throw new Error('must not be called'); } }))
      .toEqual({ status: 429, body: { ok: false, code: 'ADMIN_PROBE_RATE_LIMITED' } });
    const probes = (await t.db.query<{ outcome: string; detail: Record<string, unknown> }>(`SELECT outcome, detail FROM admin_audit_events WHERE kind = 'ADMIN_COPILOT_PROBE' ORDER BY event_id`)).rows;
    expect(probes.length).toBe(PROBE_LIMIT);
    expect(probes[1]).toEqual({ outcome: 'FAILED', detail: { model: 'my-model', upstreamParam: 'temperature' } });
  });
});
