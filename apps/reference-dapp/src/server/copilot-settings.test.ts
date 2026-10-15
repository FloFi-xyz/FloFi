// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ADMIN-001: Copilot runtime settings are validated as a whole, with the environment's bounds, and known-incompatible model/parameter
 * combinations are refused rather than adjusted. Unknown models need an explicit acknowledgment.
 */
import { describe, expect, it } from 'vitest';
import { COPILOT_SETTINGS_SCHEMA, CopilotSettingsError, effectiveSettings, modelFamily, validateRuntimeSettings, validateSettingsDocument,
  type CopilotRuntimeSettings } from './copilot-settings.ts';

const base: CopilotRuntimeSettings = { model: 'gpt-4.1-mini', temperature: 0, reasoningEffort: null, maxOutputTokens: 4096, timeoutMs: 20_000, acknowledgedUnverified: false };
const refused = (input: unknown, field = 'default') => { try { validateRuntimeSettings(input, field); return null; }
  catch (error) { return error instanceof CopilotSettingsError ? [error.code, error.field] : ['UNEXPECTED', String(error)]; } };

describe('BUILD-ADMIN-001 Copilot settings validation', () => {
  it('accepts complete settings within the environment bounds', () => {
    expect(validateRuntimeSettings(base)).toEqual(base);
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
    expect(effectiveSettings(document, 'WEB')).toEqual(base);
    expect(effectiveSettings(document, 'WHATSAPP')).toEqual(base);
    expect(effectiveSettings(document, 'TELEGRAM')).toEqual(telegram);
    expect(Object.isFrozen(document)).toBe(true);
    const invalid = (input: unknown) => { try { validateSettingsDocument(input); return null; } catch (error) { return (error as CopilotSettingsError).code; } };
    expect(invalid({ schema: 'other', default: base, overrides: {} })).toBe('COPILOT_SETTINGS_SHAPE_INVALID');
    expect(invalid({ schema: COPILOT_SETTINGS_SCHEMA, default: base })).toBe('COPILOT_SETTINGS_SHAPE_INVALID');
    expect(invalid({ schema: COPILOT_SETTINGS_SCHEMA, default: base, overrides: { DISCORD: base } })).toBe('COPILOT_SETTINGS_SCOPE_INVALID');
    expect(invalid({ schema: COPILOT_SETTINGS_SCHEMA, default: base, overrides: { WEB: { ...base, model: 'gpt-5' } } })).toBe('COPILOT_SETTINGS_TEMPERATURE_UNSUPPORTED');
    expect(invalid({ schema: COPILOT_SETTINGS_SCHEMA, default: base, overrides: {}, apiKey: 'sk-x' })).toBe('COPILOT_SETTINGS_SHAPE_INVALID');
  });
});
