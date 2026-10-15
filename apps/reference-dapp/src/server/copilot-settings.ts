// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ADMIN-001: the Copilot's runtime model settings — the document an administrator versions in PostgreSQL, its validation, and the
 * model capability catalog that refuses known-incompatible parameter combinations instead of silently changing them.
 *
 * Only interpretation tuning lives here: model id, temperature (or omitted), reasoning effort, maximum output tokens and the request
 * timeout, as a default plus optional per-channel overrides. The Copilot's mode (`FLOFI_COPILOT`), its API key, its instructions, the
 * strict output schema and every grounding rule stay in code and environment: a settings document can never change what the model is
 * allowed to do, only which model interprets and how. Bounds are those of the environment variables (`copilot-service.ts`).
 */
import { COPILOT_TUNING_DEFAULTS, type CopilotModelSettings, type CopilotReasoningEffort } from './copilot-service.ts';

export const COPILOT_SETTINGS_SCHEMA = 'flofi.copilot-settings.v1';
export const COPILOT_SCOPES = ['WEB', 'TELEGRAM', 'WHATSAPP'] as const;
export type CopilotScope = (typeof COPILOT_SCOPES)[number];
export const COPILOT_SCOPE_LABELS: Readonly<Record<CopilotScope, string>> = { WEB: 'FloFi chat (web)', TELEGRAM: 'Telegram', WHATSAPP: 'WhatsApp' };
export const REASONING_EFFORTS: readonly CopilotReasoningEffort[] = ['minimal', 'low', 'medium', 'high'];
export const COPILOT_BOUNDS = Object.freeze({ timeoutMs: [5_000, 60_000], maxOutputTokens: [256, 16_384] } as const);

/** One complete set of settings (a scope never inherits single fields: an override replaces the default as a whole). */
export type CopilotRuntimeSettings = CopilotModelSettings & { readonly timeoutMs: number;
  /** The administrator accepted a model the catalog does not know; its parameters are sent exactly as configured. */
  readonly acknowledgedUnverified: boolean };
export type CopilotSettingsDocument = { readonly schema: typeof COPILOT_SETTINGS_SCHEMA; readonly default: CopilotRuntimeSettings;
  readonly overrides: Readonly<Partial<Record<CopilotScope, CopilotRuntimeSettings>>> };

/**
 * What FloFi knows about a model family's Responses API parameters. Only families whose constraints are established are listed; any
 * other model id is UNVERIFIED and needs an explicit acknowledgment (and, preferably, a probe) — never a silent adjustment.
 */
export type ModelFamily = { readonly id: string; readonly label: string; readonly match: RegExp; readonly temperature: boolean;
  readonly reasoning: readonly CopilotReasoningEffort[] | null };
export const MODEL_FAMILIES: readonly ModelFamily[] = Object.freeze(([
  { id: 'gpt-5', label: 'GPT-5 (gpt-5, -mini, -nano)', match: /^gpt-5(?:-mini|-nano)?(?:-\d{4}-\d{2}-\d{2})?$/, temperature: false, reasoning: ['minimal', 'low', 'medium', 'high'] },
  { id: 'o-series', label: 'o-series reasoning (o1, o3, o3-mini, o4-mini)', match: /^(?:o1|o3|o3-mini|o4-mini)(?:-\d{4}-\d{2}-\d{2})?$/, temperature: false,
    reasoning: ['low', 'medium', 'high'] },
  { id: 'gpt-4.1', label: 'GPT-4.1 (gpt-4.1, -mini, -nano)', match: /^gpt-4\.1(?:-mini|-nano)?(?:-\d{4}-\d{2}-\d{2})?$/, temperature: true, reasoning: null },
  { id: 'gpt-4o', label: 'GPT-4o (gpt-4o, gpt-4o-mini)', match: /^gpt-4o(?:-mini)?(?:-\d{4}-\d{2}-\d{2})?$/, temperature: true, reasoning: null },
] as ModelFamily[]).map(family => Object.freeze(family)));
export const modelFamily = (model: string): ModelFamily | null => MODEL_FAMILIES.find(family => family.match.test(model)) ?? null;

export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const TEMPERATURE = /^(?:0(?:\.\d{1,2})?|1(?:\.0{1,2})?)$/;
export class CopilotSettingsError extends Error {
  constructor(readonly code: string, readonly field: string | null = null) { super(code); }
}
const fail = (code: string, field: string | null = null): never => { throw new CopilotSettingsError(code, field); };
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const integer = (value: unknown, [min, max]: readonly [number, number], field: string) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : fail('COPILOT_SETTINGS_OUT_OF_RANGE', field);

/** Validates one complete settings set, including the model capability check. Throws `CopilotSettingsError`. */
export function validateRuntimeSettings(input: unknown, field = 'default'): CopilotRuntimeSettings {
  const keys = ['model', 'temperature', 'reasoningEffort', 'maxOutputTokens', 'timeoutMs', 'acknowledgedUnverified'];
  if (!plain(input) || Object.keys(input).sort().join() !== [...keys].sort().join()) return fail('COPILOT_SETTINGS_SHAPE_INVALID', field);
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  if (!MODEL_ID.test(model)) return fail('COPILOT_SETTINGS_MODEL_INVALID', `${field}.model`);
  let temperature: number | null;
  if (input.temperature === null) temperature = null;
  else if (typeof input.temperature === 'number' && Number.isFinite(input.temperature) && TEMPERATURE.test(String(input.temperature))) temperature = input.temperature;
  else return fail('COPILOT_SETTINGS_OUT_OF_RANGE', `${field}.temperature`);
  const effort = input.reasoningEffort;
  if (effort !== null && !REASONING_EFFORTS.includes(effort as CopilotReasoningEffort)) return fail('COPILOT_SETTINGS_OUT_OF_RANGE', `${field}.reasoningEffort`);
  if (typeof input.acknowledgedUnverified !== 'boolean') return fail('COPILOT_SETTINGS_SHAPE_INVALID', `${field}.acknowledgedUnverified`);
  const settings: CopilotRuntimeSettings = { model, temperature, reasoningEffort: effort as CopilotReasoningEffort | null,
    maxOutputTokens: integer(input.maxOutputTokens, COPILOT_BOUNDS.maxOutputTokens, `${field}.maxOutputTokens`),
    timeoutMs: integer(input.timeoutMs, COPILOT_BOUNDS.timeoutMs, `${field}.timeoutMs`), acknowledgedUnverified: input.acknowledgedUnverified };
  const family = modelFamily(model);
  if (!family) {
    if (!settings.acknowledgedUnverified) return fail('COPILOT_SETTINGS_MODEL_UNVERIFIED', `${field}.model`);
  } else {
    if (settings.temperature !== null && !family.temperature) return fail('COPILOT_SETTINGS_TEMPERATURE_UNSUPPORTED', `${field}.temperature`);
    if (settings.reasoningEffort !== null && !family.reasoning) return fail('COPILOT_SETTINGS_REASONING_UNSUPPORTED', `${field}.reasoningEffort`);
    if (settings.reasoningEffort !== null && family.reasoning && !family.reasoning.includes(settings.reasoningEffort))
      return fail('COPILOT_SETTINGS_REASONING_UNSUPPORTED', `${field}.reasoningEffort`);
  }
  return Object.freeze(settings);
}

/** Validates a whole document (also used when reading one back, so a tampered row fails closed). */
export function validateSettingsDocument(input: unknown): CopilotSettingsDocument {
  if (!plain(input) || Object.keys(input).sort().join() !== 'default,overrides,schema' || input.schema !== COPILOT_SETTINGS_SCHEMA || !plain(input.overrides))
    return fail('COPILOT_SETTINGS_SHAPE_INVALID');
  const overrides: Partial<Record<CopilotScope, CopilotRuntimeSettings>> = {};
  for (const [scope, value] of Object.entries(input.overrides)) {
    if (!(COPILOT_SCOPES as readonly string[]).includes(scope)) return fail('COPILOT_SETTINGS_SCOPE_INVALID', `overrides.${scope}`);
    overrides[scope as CopilotScope] = validateRuntimeSettings(value, `overrides.${scope}`);
  }
  return Object.freeze({ schema: COPILOT_SETTINGS_SCHEMA, default: validateRuntimeSettings(input.default), overrides: Object.freeze(overrides) });
}
export const effectiveSettings = (document: CopilotSettingsDocument, scope: CopilotScope): CopilotRuntimeSettings => document.overrides[scope] ?? document.default;

/** The environment bootstrap expressed as settings, for display and as the editor's starting point. */
export function environmentSettings(input: { readonly model: string; readonly temperature: number | null; readonly maxOutputTokens: number;
  readonly reasoningEffort: CopilotReasoningEffort | null; readonly timeoutMs: number }): CopilotRuntimeSettings {
  return { ...input, acknowledgedUnverified: modelFamily(input.model) === null };
}
export const DEFAULT_EDITOR_SETTINGS: Omit<CopilotRuntimeSettings, 'model'> = Object.freeze({ temperature: 0, reasoningEffort: null,
  maxOutputTokens: COPILOT_TUNING_DEFAULTS.maxOutputTokens, timeoutMs: COPILOT_TUNING_DEFAULTS.timeoutMs, acknowledgedUnverified: false });
