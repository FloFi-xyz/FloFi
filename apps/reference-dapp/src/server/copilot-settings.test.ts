// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ADMIN-001: Copilot runtime settings are validated as a whole, with the environment's bounds, and known-incompatible model/parameter
 * combinations are refused rather than adjusted. Unknown models need an explicit acknowledgment.
 */
import { describe, expect, it } from 'vitest';
import { COPILOT_SETTINGS_SCHEMA, CopilotSettingsError, documentProviders, effectiveSettings, modelFamily, providerOfModel, storedDocument, validateRuntimeSettings,
  validateSettingsDocument,
  type StoredRuntimeSettings } from './copilot-settings.ts';

const base: StoredRuntimeSettings = { model: 'gpt-4.1-mini', temperature: 0, reasoningEffort: null, maxOutputTokens: 4096, timeoutMs: 20_000, acknowledgedUnverified: false };
const refused = (input: unknown, field = 'default') => { try { validateRuntimeSettings(input, field); return null; }
  catch (error) { return error instanceof CopilotSettingsError ? [error.code, error.field] : ['UNEXPECTED', String(error)]; } };

describe('BUILD-ADMIN-001 Copilot settings validation', () => {
  it('accepts complete settings within the environment bounds', () => {
    expect(validateRuntimeSettings(base)).toEqual({ ...base, provider: 'OPENAI' });
    expect(validateRuntimeSettings({ ...base, temperature: 0.35, maxOutputTokens: 256, timeoutMs: 5_000 })).toMatchObject({ temperature: 0.35 });
    expect(validateRuntimeSettings({ ...base, temperature: 1, maxOutputTokens: 16_384, timeoutMs: 60_000 })).toMatchObject({ temperature: 1 });
    expect(validateRuntimeSettings({ ...base, temperature: null })).toMatchObject({ temperature: null });
    expect(validateRuntimeSettings({ ...base, model: '  gpt-4o ' })).toMatchObject({ model: 'gpt-4o' });
  });
  it('refuses missing or extra fields and out-of-range values', () => {
    expect(refused({ ...base, extra: 1 })).toEqual(['COPILOT_SETTINGS_SHAPE_INVALID', 'default']);
    expect(refused(Object.fromEntries(Object.entries(base).filter(([name]) => name !== 'timeoutMs')))).toEqual(['COPILOT_SETTINGS_SHAPE_INVALID', 'default']);
    expect(refused([base])).toEqual(['COPILOT_SETTINGS_SHAPE_INVALID', 'default']);
    expect(refused({ ...base, model: '' })).toEqual(['COPILOT_SETTINGS_MODEL_INVALID', 'default.model']);
    expect(refused({ ...base, model: 'gpt 4o' })).toEqual(['COPILOT_SETTINGS_MODEL_INVALID', 'default.model']);
    expect(refused({ ...base, model: 'x'.repeat(101) })).toEqual(['COPILOT_SETTINGS_MODEL_INVALID', 'default.model']);
    for (const temperature of [-0.1, 1.01, 0.123, 2, '0.5', Number.NaN])
      expect(refused({ ...base, temperature })).toEqual(['COPILOT_SETTINGS_OUT_OF_RANGE', 'default.temperature']);
    for (const maxOutputTokens of [255, 16_385, 1000.5, '4096'])
      expect(refused({ ...base, maxOutputTokens })).toEqual(['COPILOT_SETTINGS_OUT_OF_RANGE', 'default.maxOutputTokens']);
    for (const timeoutMs of [4_999, 60_001]) expect(refused({ ...base, timeoutMs })).toEqual(['COPILOT_SETTINGS_OUT_OF_RANGE', 'default.timeoutMs']);
    expect(refused({ ...base, model: 'gpt-5', temperature: null, reasoningEffort: 'extreme' })).toEqual(['COPILOT_SETTINGS_OUT_OF_RANGE', 'default.reasoningEffort']);
    expect(refused({ ...base, acknowledgedUnverified: 'yes' })).toEqual(['COPILOT_SETTINGS_SHAPE_INVALID', 'default.acknowledgedUnverified']);
  });
  it('refuses known-incompatible model and parameter combinations instead of changing them', () => {
    expect(refused({ ...base, model: 'gpt-5-mini', temperature: 0 })).toEqual(['COPILOT_SETTINGS_TEMPERATURE_UNSUPPORTED', 'default.temperature']);
    expect(refused({ ...base, model: 'o4-mini', temperature: 0.2 })).toEqual(['COPILOT_SETTINGS_TEMPERATURE_UNSUPPORTED', 'default.temperature']);
    expect(refused({ ...base, model: 'gpt-4o', reasoningEffort: 'low' })).toEqual(['COPILOT_SETTINGS_REASONING_UNSUPPORTED', 'default.reasoningEffort']);
    expect(refused({ ...base, model: 'o3', temperature: null, reasoningEffort: 'minimal' })).toEqual(['COPILOT_SETTINGS_REASONING_UNSUPPORTED', 'default.reasoningEffort']);
    expect(validateRuntimeSettings({ ...base, model: 'gpt-5', temperature: null, reasoningEffort: 'minimal' })).toMatchObject({ reasoningEffort: 'minimal' });
    expect(validateRuntimeSettings({ ...base, model: 'o4-mini-2025-04-16', temperature: null, reasoningEffort: 'high' })).toMatchObject({ model: 'o4-mini-2025-04-16' });
  });
  it('needs an explicit acknowledgment for a model outside the catalog, and then sends its parameters unchanged', () => {
    for (const model of ['gpt-5.1', 'gpt-5-chat-latest', 'o1-mini', 'ft:gpt-4o-mini:acme::abc', 'my-proxy-model']) {
      expect(modelFamily(model)).toBeNull();
      expect(refused({ ...base, model })).toEqual(['COPILOT_SETTINGS_MODEL_UNVERIFIED', 'default.model']);
      expect(validateRuntimeSettings({ ...base, model, temperature: 0.7, reasoningEffort: 'high', acknowledgedUnverified: true }))
        .toMatchObject({ model, temperature: 0.7, reasoningEffort: 'high' });
    }
    expect(modelFamily('gpt-4o-mini-2024-07-18')?.id).toBe('gpt-4o');
    expect(modelFamily('gpt-4.1-nano')?.id).toBe('gpt-4.1');
  });
  it('validates whole documents: schema, scopes, overrides replace the default as a whole', () => {
    const telegram = { ...base, model: 'gpt-4o-mini', maxOutputTokens: 2048 };
    const document = validateSettingsDocument({ schema: COPILOT_SETTINGS_SCHEMA, default: base, overrides: { TELEGRAM: telegram } });
    expect(effectiveSettings(document, 'WEB')).toEqual({ ...base, provider: 'OPENAI' });
    expect(effectiveSettings(document, 'WHATSAPP')).toEqual({ ...base, provider: 'OPENAI' });
    expect(effectiveSettings(document, 'TELEGRAM')).toEqual({ ...telegram, provider: 'OPENAI' });
    expect(Object.isFrozen(document)).toBe(true);
    const invalid = (input: unknown) => { try { validateSettingsDocument(input); return null; } catch (error) { return (error as CopilotSettingsError).code; } };
    expect(invalid({ schema: 'other', default: base, overrides: {} })).toBe('COPILOT_SETTINGS_SHAPE_INVALID');
    expect(invalid({ schema: COPILOT_SETTINGS_SCHEMA, default: base })).toBe('COPILOT_SETTINGS_SHAPE_INVALID');
    expect(invalid({ schema: COPILOT_SETTINGS_SCHEMA, default: base, overrides: { DISCORD: base } })).toBe('COPILOT_SETTINGS_SCOPE_INVALID');
    expect(invalid({ schema: COPILOT_SETTINGS_SCHEMA, default: base, overrides: { WEB: { ...base, model: 'gpt-5' } } })).toBe('COPILOT_SETTINGS_TEMPERATURE_UNSUPPORTED');
    expect(invalid({ schema: COPILOT_SETTINGS_SCHEMA, default: base, overrides: {}, apiKey: 'sk-x' })).toBe('COPILOT_SETTINGS_SHAPE_INVALID');
  });
});

describe('BUILD-ADMIN-AI-PROVIDERS-001 provider identity', () => {
  const claude = { ...base, provider: 'ANTHROPIC', model: 'claude-sonnet-5-5', temperature: null, reasoningEffort: 'high' } as const;
  it('accepts Anthropic settings for known Claude families, with Anthropic efforts and no temperature', () => {
    expect(validateRuntimeSettings(claude)).toEqual(claude);
    for (const model of ['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-5-5', 'claude-opus-4-8', 'claude-fable-5-2'])
      expect(modelFamily(model, 'ANTHROPIC')?.incompatible, model).toBeUndefined();
    expect(validateRuntimeSettings({ ...claude, reasoningEffort: 'max' })).toMatchObject({ reasoningEffort: 'max' });
    expect(validateRuntimeSettings({ ...claude, model: 'claude-haiku-4-5', reasoningEffort: null })).toMatchObject({ model: 'claude-haiku-4-5' });
    expect(validateRuntimeSettings({ ...claude, model: 'claude-haiku-4-5-20251001', reasoningEffort: null })).toMatchObject({ model: 'claude-haiku-4-5-20251001' });
  });
  it('never mixes a provider with the other provider\'s models or parameters', () => {
    expect(refused({ ...claude, model: 'gpt-5' })).toEqual(['COPILOT_SETTINGS_PROVIDER_MISMATCH', 'default.model']);
    expect(refused({ ...base, model: 'claude-sonnet-5-5', acknowledgedUnverified: true })).toEqual(['COPILOT_SETTINGS_PROVIDER_MISMATCH', 'default.model']);
    expect(refused({ ...claude, provider: 'GEMINI' })).toEqual(['COPILOT_SETTINGS_PROVIDER_INVALID', 'default.provider']);
    expect(refused({ ...claude, temperature: 0 })).toEqual(['COPILOT_SETTINGS_TEMPERATURE_UNSUPPORTED', 'default.temperature']);
    expect(refused({ ...claude, model: 'claude-new-model', temperature: 0.3, acknowledgedUnverified: true })).toEqual(['COPILOT_SETTINGS_TEMPERATURE_UNSUPPORTED', 'default.temperature']);
    expect(refused({ ...claude, reasoningEffort: 'minimal' })).toEqual(['COPILOT_SETTINGS_REASONING_UNSUPPORTED', 'default.reasoningEffort']);
    expect(refused({ ...base, model: 'gpt-5', temperature: null, reasoningEffort: 'xhigh' })).toEqual(['COPILOT_SETTINGS_REASONING_UNSUPPORTED', 'default.reasoningEffort']);
    expect(refused({ ...base, model: 'my-model', acknowledgedUnverified: true, reasoningEffort: 'max' })).toEqual(['COPILOT_SETTINGS_REASONING_UNSUPPORTED', 'default.reasoningEffort']);
    expect(refused({ ...claude, model: 'claude-haiku-4-5', reasoningEffort: 'low' })).toEqual(['COPILOT_SETTINGS_REASONING_UNSUPPORTED', 'default.reasoningEffort']);
  });
  it('refuses Claude models known to lack strict structured output, and needs acknowledgment for unknown Claude ids', () => {
    for (const model of ['claude-opus-4-6', 'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-3-5-haiku-20241022'])
      expect(refused({ ...claude, model, reasoningEffort: null, acknowledgedUnverified: true }), model).toEqual(['COPILOT_SETTINGS_MODEL_INCOMPATIBLE', 'default.model']);
    expect(refused({ ...claude, model: 'claude-sonnet-6' })).toEqual(['COPILOT_SETTINGS_MODEL_UNVERIFIED', 'default.model']);
    expect(validateRuntimeSettings({ ...claude, model: 'claude-sonnet-6', acknowledgedUnverified: true })).toMatchObject({ model: 'claude-sonnet-6' });
  });
  it('stores OpenAI sets in the pre-provider form and Anthropic sets with their provider', () => {
    const document = validateSettingsDocument({ schema: COPILOT_SETTINGS_SCHEMA, default: base, overrides: { WEB: claude, TELEGRAM: { ...base, provider: 'OPENAI' } } });
    expect(documentProviders(document)).toEqual(['OPENAI', 'ANTHROPIC']);
    const stored = storedDocument(document);
    expect(stored).toEqual({ schema: COPILOT_SETTINGS_SCHEMA, default: base, overrides: { WEB: claude, TELEGRAM: base } });
    // The stored form validates back to the same document.
    expect(validateSettingsDocument(JSON.parse(JSON.stringify(stored)))).toEqual(document);
    // An OpenAI-only document is byte-identical to what the previous build writes (and reads).
    expect(JSON.stringify(storedDocument(validateSettingsDocument({ schema: COPILOT_SETTINGS_SCHEMA, default: base, overrides: {} }))))
      .toBe(JSON.stringify({ schema: COPILOT_SETTINGS_SCHEMA, default: base, overrides: {} }));
    expect([providerOfModel('claude-opus-5-5'), providerOfModel('gpt-5'), providerOfModel('')]).toEqual(['ANTHROPIC', 'OPENAI', 'OPENAI']);
  });
});
