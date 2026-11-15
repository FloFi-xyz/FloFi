// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ADMIN-AI-PROVIDERS-001: the Copilot settings API with providers, on its own disposable loopback database (its probe budget and
 * append-only history are separate from `settings.pg.test.ts`). Provider APIs are scripted `fetch` stubs; nothing reaches the network.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@defi-workflow-engine/cloud-runtime';
import { createTestDatabase, type TestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import { createTestWallet } from '../../../../packages/reference-reconciler/test/test-wallet.ts';
import { COPILOT_SETTINGS_SCHEMA, type StoredRuntimeSettings } from '../server/copilot-settings.ts';
import { runAdminCommand } from './cli-commands.ts';
import { adminConfig } from './config.ts';
import { handleAdminChallenge, handleAdminSignIn, type AdminHttpOptions } from './http.ts';
import { adminCsrfToken, readAdminSession } from './session.ts';
import { handleCopilotSettings } from './settings-http.ts';

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
const runtime: StoredRuntimeSettings = { model: 'gpt-5-mini', temperature: null, reasoningEffort: 'low', maxOutputTokens: 6000, timeoutMs: 30_000, acknowledgedUnverified: false };
const documentWith = (model: string, telegram: string | null = null) => ({ schema: COPILOT_SETTINGS_SCHEMA, default: { ...runtime, model },
  overrides: telegram ? { TELEGRAM: { ...runtime, model: telegram, temperature: 0.2, reasoningEffort: null } } : {} });

const request = { version: '2', messages: [{ role: 'user', text: 'Put 1 USDC into Aave on Base Sepolia' }] } as const;

beforeAll(async () => { t = await createTestDatabase(); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
afterAll(async () => {
  // The web chat path opened this process's platform-state pool on the test database; close it before dropping the database.
  const hosts = (globalThis as unknown as Record<symbol, Map<string, Promise<{ db: Database }>> | undefined>)[Symbol.for('flofi.platform-state')];
  for (const host of hosts?.values() ?? []) await host.then(h => h.db.close(), () => undefined);
  hosts?.clear();
  await t?.drop();
});

describe('BUILD-ADMIN-AI-PROVIDERS-001 provider-aware settings (PostgreSQL)', () => {
  const claude = { provider: 'ANTHROPIC', model: 'claude-sonnet-5-5', temperature: null, reasoningEffort: 'medium', maxOutputTokens: 4096, timeoutMs: 30_000,
    acknowledgedUnverified: false } as const;
  const both = { ...adminEnv, ...copilotEnv, ANTHROPIC_API_KEY: 'test-ant-key' };
  const anthropicReply = () => new Response(JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify(RECORDED.answer.output) }], usage: { input_tokens: 1500, output_tokens: 90 } }), { status: 200 });
  // Versions and the audit trail are append-only: each test works from the head it finds and reads only the events written after it started.
  let since = 0, v0 = 0;
  beforeEach(async () => { since = (await t.db.query<{ n: number }>('SELECT coalesce(max(event_id), 0)::int AS n FROM admin_audit_events')).rows[0]!.n;
    v0 = (await t.db.query<{ n: number }>("SELECT coalesce(max(version), 0)::int AS n FROM admin_settings_versions WHERE tenant_id = 'default' AND setting_key = 'copilot'")).rows[0]!.n; });

  it('saves per-channel providers in the canonical stored form, refuses a provider whose key is missing, and rolls back old versions', async () => {
    const operator = await adminSession('OPERATOR');
    // An old-style (pre-provider) OpenAI document, exactly as the previous build writes it.
    expect(await settings(operator, { action: 'save', expectedVersion: v0, document: documentWith('gpt-5-nano') }, { env: both })).toEqual({ status: 200, body: { ok: true, version: v0 + 1 } });
    const mixed = { schema: COPILOT_SETTINGS_SCHEMA, default: { ...runtime, provider: 'OPENAI' }, overrides: { WEB: claude, WHATSAPP: { ...claude, model: 'claude-haiku-5-5', reasoningEffort: 'low' } } };
    // Without ANTHROPIC_API_KEY on a live Copilot, activating Anthropic is refused (it would fail closed on the next request).
    expect(await settings(operator, { action: 'save', expectedVersion: v0 + 1, document: mixed })).toEqual({ status: 409, body: { ok: false, code: 'COPILOT_PROVIDER_NOT_CONFIGURED', provider: 'ANTHROPIC' } });
    expect(await settings(operator, { action: 'save', expectedVersion: v0 + 1, document: mixed, reason: 'Web on Claude' }, { env: both })).toEqual({ status: 200, body: { ok: true, version: v0 + 2 } });
    const stored = (await t.db.query<{ version: number; document: Record<string, Record<string, unknown>> }>(`SELECT version, document FROM admin_settings_versions
      WHERE version > $1 ORDER BY version`, [v0])).rows;
    expect(stored[0]!.document.default).not.toHaveProperty('provider');
    expect(stored[1]!.document.default).not.toHaveProperty('provider');
    expect((stored[1]!.document.overrides as Record<string, Record<string, unknown>>).WEB).toMatchObject({ provider: 'ANTHROPIC', model: 'claude-sonnet-5-5' });
    // Re-saving the same document (with an explicit OPENAI provider) is unchanged, not a new version.
    expect(await settings(operator, { action: 'save', expectedVersion: v0 + 2, document: mixed }, { env: both })).toEqual({ status: 409, body: { ok: false, code: 'ADMIN_SETTINGS_UNCHANGED' } });
    // Rolling back to the old-style version still works and appends a version.
    expect(await settings(operator, { action: 'rollback', expectedVersion: v0 + 2, toVersion: v0 + 1 }, { env: both })).toEqual({ status: 200, body: { ok: true, version: v0 + 3 } });
    // Restoring the Anthropic version where its key is missing is refused, never silently applied.
    expect(await settings(operator, { action: 'rollback', expectedVersion: v0 + 3, toVersion: v0 + 2 })).toEqual({ status: 409, body: { ok: false, code: 'COPILOT_PROVIDER_NOT_CONFIGURED', provider: 'ANTHROPIC' } });
    const audit = (await t.db.query<{ outcome: string; code: string | null; detail: Record<string, unknown> }>(`SELECT outcome, code, detail FROM admin_audit_events
      WHERE kind LIKE 'ADMIN_COPILOT_SETTINGS_%' AND event_id > $1 ORDER BY event_id`, [since])).rows;
    expect(audit.map(row => [row.outcome, row.code])).toEqual([['OK', null], ['REFUSED', 'COPILOT_PROVIDER_NOT_CONFIGURED'], ['OK', null], ['OK', null], ['REFUSED', 'COPILOT_PROVIDER_NOT_CONFIGURED']]);
    expect(audit[2]!.detail).toMatchObject({ version: v0 + 2, providers: 'OPENAI,ANTHROPIC', overrides: 'WEB,WHATSAPP' });
  });

  it('probes Anthropic settings through the Messages API with its own key, reporting latency, usage and an estimated cost', async () => {
    const operator = await adminSession('OPERATOR');
    const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => { calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return anthropicReply(); }) as typeof fetch;
    const later = {};
    const probed = await settings(operator, { action: 'probe', settings: claude }, { env: both, fetch: fetchImpl, ...later });
    expect(probed).toMatchObject({ status: 200, body: { ok: true, probe: { ok: true, provider: 'ANTHROPIC', model: 'claude-sonnet-5-5', intentKind: 'ACTION', inputTokens: 1500,
      outputTokens: 90, responseModel: 'claude-sonnet-5-5' } } });
    expect((probed.body.probe as { estimatedCostUsd: number }).estimatedCostUsd).toBeCloseTo((1500 * 2 + 90 * 10) / 1e6, 9);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0]!.headers['x-api-key']).toBe('test-ant-key');
    // The live tool definitions are offered so the provider's schema limits are probed as in production, but no tool can run.
    expect(calls[0]!.body.tool_choice).toEqual({ type: 'none' });
    expect((calls[0]!.body.messages as { content: { text: string }[] }[])[0]!.content[0]!.text).toBe('Swap 1 USDC to WETH on Base with 0.5% slippage');
    // Provider readiness is checked before anything is sent; an Anthropic error keeps only allow-listed diagnostics.
    expect(await settings(operator, { action: 'probe', settings: claude }, { fetch: async () => { throw new Error('must not be called'); }, ...later }))
      .toEqual({ status: 409, body: { ok: false, code: 'COPILOT_PROVIDER_NOT_CONFIGURED', provider: 'ANTHROPIC' } });
    const billing = await settings(operator, { action: 'probe', settings: claude }, { env: both, ...later, fetch: async () => new Response(JSON.stringify({ type: 'error',
      error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. sk-should-not-echo' } }), { status: 400 }) });
    expect(billing.body).toMatchObject({ ok: true, probe: { ok: false, code: 'COPILOT_UPSTREAM_BILLING', upstream: { code: 'invalid_request_error', status: 400 } } });
    expect(JSON.stringify(billing.body)).not.toContain('sk-should-not-echo');
    const probes = (await t.db.query<{ detail: Record<string, unknown> }>(`SELECT detail FROM admin_audit_events WHERE kind = 'ADMIN_COPILOT_PROBE' AND event_id > $1 ORDER BY event_id`,
      [since])).rows;
    expect(probes.map(row => row.detail.provider)).toEqual(['ANTHROPIC', 'ANTHROPIC']);
  });

  // BUILD-FLOFI-UNIFIED-COPILOT-001: an Anthropic double that enforces the documented structured-output limits (at most 16 union-typed parameters
  // across the request's strict schemas) answers exactly what production answered before the fix, and accepts the fixed request.
  it('passes the probe against an Anthropic double that enforces the documented schema limits, and names the cause when they are exceeded', async () => {
    const operator = await adminSession('OPERATOR');
    const { schemaComplexity } = await import('../server/copilot-providers.ts');
    const sent: Record<string, unknown>[] = [];
    const enforcing = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { output_config?: { format?: { schema?: unknown } }; tools?: { strict?: boolean; input_schema: unknown }[] };
      sent.push(body as Record<string, unknown>);
      const strict = [body.output_config?.format?.schema, ...(body.tools ?? []).filter(tool => tool.strict).map(tool => tool.input_schema)].filter(Boolean);
      if (schemaComplexity(strict).unionParameters > 16) return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error',
        message: `Schema contains too many parameters with union types (${schemaComplexity(strict).unionParameters} parameters with type arrays or anyOf). The limit is 16.` } }), { status: 400 });
      return anthropicReply();
    }) as typeof fetch;
    for (const effort of ['medium', null] as const) {
      const probed = await settings(operator, { action: 'probe', settings: { ...claude, reasoningEffort: effort } }, { env: both, fetch: enforcing });
      expect(probed.body).toMatchObject({ ok: true, probe: { ok: true, code: null, upstream: null, intentKind: 'ACTION',
        scope: 'WEB', toolsOffered: true,
        structure: { output: 'PROMPTED', toolsStrict: true, strictTools: 9, optionalParameters: 0, limits: { unionParameters: 16 } } } });
    }
    // The probe meets the provider's limits exactly as a live turn does: the output contract is prompted, the live tool definitions stay strict,
    // and no tool may run (tool_choice none).
    expect(sent.every(body => !(body.output_config as { format?: unknown } | undefined)?.format)).toBe(true);
    expect(sent.every(body => (body.tools as unknown[]).length === 9 && (body.tool_choice as { type: string }).type === 'none')).toBe(true);
    expect(await settings(operator, { action: 'probe', settings: claude, scope: 'TELEGRAM' }, { env: both, fetch: enforcing })).toMatchObject({ status: 200,
      body: { probe: { ok: true, scope: 'TELEGRAM' } } });
    expect(await settings(operator, { action: 'probe', settings: claude, scope: 'EMAIL' }, { env: both, fetch: enforcing })).toEqual({ status: 400,
      body: { ok: false, code: 'ADMIN_REQUEST_INVALID' } });
    // The pre-fix request shape (the V2 schema as output_config.format) is what the double refuses, and the operator sees why.
    const refused = await settings(operator, { action: 'probe', settings: claude }, { env: both, fetch: async () => new Response(JSON.stringify({ type: 'error',
      error: { type: 'invalid_request_error', message: 'Schema is too complex for compilation.' } }), { status: 400 }) });
    expect(refused.body).toMatchObject({ ok: true, probe: { ok: false, code: 'COPILOT_UPSTREAM_REJECTED',
      upstream: { code: 'invalid_request_error', status: 400, reason: 'SCHEMA_TOO_COMPLEX' } } });
    expect(JSON.stringify(refused.body)).not.toContain('too complex for compilation');
    const audit = (await t.db.query<{ detail: Record<string, unknown> }>(`SELECT detail FROM admin_audit_events WHERE kind = 'ADMIN_COPILOT_PROBE' AND event_id > $1 ORDER BY event_id`,
      [since])).rows;
    expect(audit.at(-1)!.detail).toMatchObject({ provider: 'ANTHROPIC', scope: 'WEB', upstreamStatus: 400, upstreamReason: 'SCHEMA_TOO_COMPLEX', structure: 'PROMPTED' });
  });

  it('activates Anthropic per channel independently: changing one override leaves the others, and rollback restores the previous provider', async () => {
    const operator = await adminSession('OPERATOR');
    const { resolveCopilotLive, hostSettingsReader } = await import('../server/copilot-runtime.ts');
    const reader = hostSettingsReader({ db: t.db, tenantId: 'default' });
    const resolved = async () => Object.fromEntries(await Promise.all((['WEB', 'TELEGRAM', 'WHATSAPP'] as const).map(async scope => {
      const live = await resolveCopilotLive(both, scope, reader);
      return [scope, live.ok ? `${live.provider}:${live.settings.model}` : live.code] as const;
    })));
    const first = { schema: COPILOT_SETTINGS_SCHEMA, default: runtime, overrides: { WEB: claude } };
    expect(await settings(operator, { action: 'save', expectedVersion: v0, document: first }, { env: both })).toMatchObject({ status: 200 });
    expect(await resolved()).toEqual({ WEB: 'ANTHROPIC:claude-sonnet-5-5', TELEGRAM: 'OPENAI:gpt-5-mini', WHATSAPP: 'OPENAI:gpt-5-mini' });
    const second = { ...first, overrides: { WEB: claude, TELEGRAM: { ...claude, model: 'claude-haiku-5-5', reasoningEffort: 'low' } } };
    expect(await settings(operator, { action: 'save', expectedVersion: v0 + 1, document: second }, { env: both })).toMatchObject({ status: 200 });
    expect(await resolved()).toEqual({ WEB: 'ANTHROPIC:claude-sonnet-5-5', TELEGRAM: 'ANTHROPIC:claude-haiku-5-5', WHATSAPP: 'OPENAI:gpt-5-mini' });
    const third = { ...second, overrides: { ...second.overrides, WEB: { ...runtime, model: 'gpt-5-nano' } } };
    expect(await settings(operator, { action: 'save', expectedVersion: v0 + 2, document: third }, { env: both })).toMatchObject({ status: 200 });
    expect(await resolved()).toEqual({ WEB: 'OPENAI:gpt-5-nano', TELEGRAM: 'ANTHROPIC:claude-haiku-5-5', WHATSAPP: 'OPENAI:gpt-5-mini' });
    // Back to what was active before this test (an earlier version, or the environment bootstrap when there was none).
    expect(await settings(operator, v0 > 0 ? { action: 'rollback', expectedVersion: v0 + 3, toVersion: v0 } : { action: 'reset', expectedVersion: v0 + 3 }, { env: both }))
      .toMatchObject({ status: 200 });
    expect(Object.values(await resolved()).every(value => !value.startsWith('ANTHROPIC'))).toBe(true);
  });

  it('routes a live channel request to the provider its runtime settings name, with no redeploy', async () => {
    const operator = await adminSession('OPERATOR');
    const mixed = { schema: COPILOT_SETTINGS_SCHEMA, default: runtime, overrides: { WEB: claude } };
    expect(await settings(operator, { action: 'save', expectedVersion: v0, document: mixed }, { env: both })).toMatchObject({ status: 200 });
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seen.push(`${url} ${(JSON.parse(String(init.body)) as { model: string }).model}`);
      return url === 'https://api.anthropic.com/v1/messages' ? anthropicReply() : new Response(okBody('gpt-5-mini'), { status: 200 });
    });
    const { resolveCopilotLive, hostSettingsReader } = await import('../server/copilot-runtime.ts');
    const { createProviderTransport } = await import('../server/copilot-providers.ts');
    const { interpretCopilotV2 } = await import('../server/copilot-service.ts');
    const reader = hostSettingsReader({ db: t.db, tenantId: 'default' });
    for (const scope of ['WEB', 'TELEGRAM'] as const) {
      const resolved = await resolveCopilotLive(both, scope, reader);
      if (!resolved.ok) throw new Error(resolved.code);
      const result = await interpretCopilotV2(request, { transport: createProviderTransport(resolved.provider, resolved.apiKey), settings: resolved.settings, mode: 'live' });
      expect(result).toMatchObject({ ok: true, intent: { kind: 'ACTION' } });
    }
    expect(seen).toEqual(['https://api.anthropic.com/v1/messages claude-sonnet-5-5', 'https://api.openai.com/v1/responses gpt-5-mini']);
  });
});
