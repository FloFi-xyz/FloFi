// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ADMIN-001: which settings a live Copilot request uses. The environment keeps the mode and the key; an administrator's latest valid
 * version wins where platform state exists; no version, a reset or the break-glass flag means the unchanged environment bootstrap; an
 * unreadable store or an invalid stored document fails closed and never falls back to another model.
 */
import { describe, expect, it } from 'vitest';
import { channelLiveCopilot, environmentCopilot, publicCopilotCode, resolveCopilotLive, runtimeSettingsEnabled, type CopilotSettingsReader } from './copilot-runtime.ts';
import { COPILOT_SETTINGS_SCHEMA, type CopilotRuntimeSettings } from './copilot-settings.ts';

const env = { FLOFI_COPILOT: 'live', OPENAI_API_KEY: 'sk-test-key', OPENAI_COPILOT_MODEL: 'gpt-4.1-mini', DATABASE_URL: 'postgres://127.0.0.1:1/x' };
const runtime: CopilotRuntimeSettings = { model: 'gpt-5-mini', temperature: null, reasoningEffort: 'low', maxOutputTokens: 6000, timeoutMs: 30_000, acknowledgedUnverified: false };
const document = { schema: COPILOT_SETTINGS_SCHEMA, default: runtime, overrides: { TELEGRAM: { ...runtime, model: 'gpt-4o-mini', temperature: 0.2, reasoningEffort: null } } };
const version = (v: number, doc: unknown) => async () => ({ version: v, document: doc, restoredFrom: null, createdBy: 'cli', reason: null, createdAt: '2026-10-14T12:00:00.000Z' });

describe('BUILD-ADMIN-001 Copilot settings resolution', () => {
  it('keeps mode and key in the environment', async () => {
    const reader = version(1, document);
    expect(await resolveCopilotLive({ ...env, FLOFI_COPILOT: 'replay' }, 'WEB', reader)).toEqual({ ok: false, code: 'COPILOT_NOT_CONFIGURED' });
    expect(await resolveCopilotLive({ ...env, OPENAI_API_KEY: '' }, 'WEB', reader)).toEqual({ ok: false, code: 'COPILOT_NOT_CONFIGURED' });
    expect(await resolveCopilotLive({ ...env, OPENAI_API_KEY: 'sk bad' }, 'WEB', reader)).toEqual({ ok: false, code: 'COPILOT_NOT_CONFIGURED' });
  });
  it('uses the latest valid runtime version, per scope, even without an environment model', async () => {
    const noModel = { ...env, OPENAI_COPILOT_MODEL: undefined };
    expect(await resolveCopilotLive(noModel, 'WEB', version(3, document))).toEqual({ ok: true, apiKey: 'sk-test-key', source: 'RUNTIME', version: 3, settings: runtime });
    expect(await resolveCopilotLive(noModel, 'TELEGRAM', version(3, document))).toMatchObject({ ok: true, source: 'RUNTIME', settings: { model: 'gpt-4o-mini', temperature: 0.2 } });
    expect(await resolveCopilotLive(noModel, 'WHATSAPP', version(3, document))).toMatchObject({ settings: { model: 'gpt-5-mini' } });
  });
  it('falls back to the unchanged environment bootstrap only when no runtime document applies', async () => {
    const bootstrap = { ok: true, apiKey: 'sk-test-key', source: 'ENVIRONMENT', version: null,
      settings: { model: 'gpt-4.1-mini', temperature: 0, reasoningEffort: null, maxOutputTokens: 4096, timeoutMs: 20_000, acknowledgedUnverified: false } };
    expect(await resolveCopilotLive(env, 'WEB', async () => null)).toEqual(bootstrap);
    expect(await resolveCopilotLive(env, 'WEB', version(4, null))).toEqual({ ...bootstrap, version: 4 });
    expect(await resolveCopilotLive(env, 'WEB', null)).toEqual(bootstrap);
    expect(await resolveCopilotLive({ ...env, FLOFI_COPILOT_RUNTIME_CONFIG: 'disabled' }, 'WEB', version(3, document))).toEqual(bootstrap);
    expect(await resolveCopilotLive({ ...env, OPENAI_COPILOT_TIMEOUT_MS: '99' }, 'WEB', async () => null)).toEqual({ ok: false, code: 'COPILOT_NOT_CONFIGURED' });
    expect(environmentCopilot({ ...env, OPENAI_COPILOT_TEMPERATURE: 'omit', OPENAI_COPILOT_REASONING_EFFORT: 'high' }))
      .toMatchObject({ ok: true, settings: { temperature: null, reasoningEffort: 'high' } });
  });
  it('fails closed on an unreadable store or an invalid stored document, never swapping in the environment model', async () => {
    const broken: CopilotSettingsReader = async () => { throw new Error('ECONNREFUSED'); };
    expect(await resolveCopilotLive(env, 'WEB', broken)).toEqual({ ok: false, code: 'COPILOT_CONFIG_UNAVAILABLE' });
    expect(await resolveCopilotLive(env, 'WEB', version(5, { ...document, default: { ...runtime, temperature: 0.5 } }))).toEqual({ ok: false, code: 'COPILOT_CONFIG_INVALID' });
    expect(await resolveCopilotLive(env, 'WEB', version(5, { schema: 'x' }))).toEqual({ ok: false, code: 'COPILOT_CONFIG_INVALID' });
    expect(publicCopilotCode('COPILOT_CONFIG_UNAVAILABLE')).toBe('COPILOT_UNAVAILABLE');
    expect(publicCopilotCode('COPILOT_CONFIG_INVALID')).toBe('COPILOT_NOT_CONFIGURED');
  });
  it('applies runtime settings only where platform state exists and the operator has not disabled them', () => {
    expect(runtimeSettingsEnabled(env)).toBe(true);
    expect(runtimeSettingsEnabled({ FLOFI_RUNTIME: 'embedded' })).toBe(true);
    expect(runtimeSettingsEnabled({})).toBe(false);
    expect(runtimeSettingsEnabled({ ...env, FLOFI_COPILOT_RUNTIME_CONFIG: 'disabled' })).toBe(false);
  });
  it('gives channels the browser-safe code and logs the precise one', async () => {
    const lines: string[] = [], warn = console.warn;
    console.warn = (line: string) => { lines.push(line); };
    try {
      const host = { db: { query: async () => { throw new Error('down'); } }, tenantId: 'default' } as unknown as Parameters<typeof channelLiveCopilot>[2];
      expect(await channelLiveCopilot(env, 'TELEGRAM', host)()).toEqual({ ok: false, code: 'COPILOT_UNAVAILABLE' });
      expect(lines).toEqual([JSON.stringify({ event: 'flofi.copilot.settings', outcome: 'COPILOT_CONFIG_UNAVAILABLE', scope: 'TELEGRAM' })]);
      expect(await channelLiveCopilot({ ...env, FLOFI_COPILOT_RUNTIME_CONFIG: 'disabled' }, 'TELEGRAM', host)()).toMatchObject({ ok: true, source: 'ENVIRONMENT' });
    } finally { console.warn = warn; }
  });
});
