// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ADMIN-001: the Copilot's runtime model settings — the document an administrator versions in PostgreSQL, its validation, and the
 * model capability catalog that refuses known-incompatible parameter combinations instead of silently changing them.
 *
 * Only interpretation tuning lives here: provider, model id, temperature (or omitted), reasoning effort, maximum output tokens and the
 * request timeout, as a default plus optional per-channel overrides. The Copilot's mode (`FLOFI_COPILOT`), the provider API keys, its
 * instructions, the strict output schema and every grounding rule stay in code and environment: a settings document can never change what
 * the model is allowed to do, only which model interprets and how. Bounds are those of the environment variables (`copilot-service.ts`).
 *
 * BUILD-ADMIN-AI-PROVIDERS-001: every settings set names its provider (OpenAI or Anthropic). The document schema is unchanged
 * (`flofi.copilot-settings.v1`) and evolves additively, without a database migration:
 *
 *   - a stored settings set WITHOUT `provider` is OpenAI — every document written before this build stays valid with its meaning unchanged;
 *   - documents are stored in their canonical form (`storedDocument`): OpenAI sets omit `provider`, so a document that only uses OpenAI is
 *     byte-for-byte what the previous build writes and still reads during a rolling deployment;
 *   - an Anthropic set carries `provider: "ANTHROPIC"`, which the previous build refuses (`COPILOT_SETTINGS_SHAPE_INVALID` → its Copilot
 *     fails closed). It can never misread it as an OpenAI model.
 *
 * A provider and its models never mix: an Anthropic model id (`claude-…`) is refused for OpenAI and anything else is refused for Anthropic,
 * so a Claude model id is never sent to the OpenAI Responses API and the reverse.
 */
import { COPILOT_TUNING_DEFAULTS, type CopilotModelSettings, type CopilotReasoningEffort } from './copilot-service.ts';

export const COPILOT_SETTINGS_SCHEMA = 'flofi.copilot-settings.v1';
export const COPILOT_SCOPES = ['WEB', 'TELEGRAM', 'WHATSAPP'] as const;
export type CopilotScope = (typeof COPILOT_SCOPES)[number];
export const COPILOT_SCOPE_LABELS: Readonly<Record<CopilotScope, string>> = { WEB: 'FloFi chat (web)', TELEGRAM: 'Telegram', WHATSAPP: 'WhatsApp' };
export const COPILOT_PROVIDERS = ['OPENAI', 'ANTHROPIC'] as const;
export type CopilotProvider = (typeof COPILOT_PROVIDERS)[number];
export const COPILOT_PROVIDER_LABELS: Readonly<Record<CopilotProvider, string>> = { OPENAI: 'OpenAI', ANTHROPIC: 'Anthropic' };
/** The efforts each provider's API accepts at all; a model family can narrow them further. */
export const PROVIDER_EFFORTS: Readonly<Record<CopilotProvider, readonly CopilotReasoningEffort[]>> = Object.freeze({
  OPENAI: Object.freeze(['minimal', 'low', 'medium', 'high'] as const), ANTHROPIC: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max'] as const) });
export const REASONING_EFFORTS: readonly CopilotReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const COPILOT_BOUNDS = Object.freeze({ timeoutMs: [5_000, 60_000], maxOutputTokens: [256, 16_384] } as const);
/** Anthropic model ids all start with `claude-`; no OpenAI model id does. */
export const ANTHROPIC_MODEL_ID = /^claude-[a-z0-9][a-z0-9.-]{0,90}$/;

/** One complete set of settings (a scope never inherits single fields: an override replaces the default as a whole). */
export type CopilotRuntimeSettings = CopilotModelSettings & { readonly provider: CopilotProvider; readonly timeoutMs: number;
  /** The administrator accepted a model the catalog does not know; its parameters are sent exactly as configured. */
  readonly acknowledgedUnverified: boolean };
/** A settings set as stored: `provider` is absent for OpenAI (the form every pre-provider document has). */
export type StoredRuntimeSettings = Omit<CopilotRuntimeSettings, 'provider'> & { readonly provider?: CopilotProvider };
export type CopilotSettingsDocument = { readonly schema: typeof COPILOT_SETTINGS_SCHEMA; readonly default: CopilotRuntimeSettings;
  readonly overrides: Readonly<Partial<Record<CopilotScope, CopilotRuntimeSettings>>> };

/**
 * What FloFi knows about a model family's API parameters. Only families whose constraints are established are listed; any other model id
 * of the provider is UNVERIFIED and needs an explicit acknowledgment (and, preferably, a probe) — never a silent adjustment. A family with
 * `incompatible` set is known NOT to work with FloFi's strict structured output and is refused outright.
 */
export type ModelFamily = { readonly id: string; readonly provider: CopilotProvider; readonly label: string; readonly match: RegExp; readonly temperature: boolean;
  readonly reasoning: readonly CopilotReasoningEffort[] | null; readonly incompatible?: string };
const DATED = '(?:-\\d{4}-\\d{2}-\\d{2})?', ANTHROPIC_DATED = '(?:-\\d{8})?';
const ALL_ANTHROPIC: readonly CopilotReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
export const MODEL_FAMILIES: readonly ModelFamily[] = Object.freeze(([
  { id: 'gpt-5', provider: 'OPENAI', label: 'GPT-5 (gpt-5, -mini, -nano)', match: new RegExp(`^gpt-5(?:-mini|-nano)?${DATED}$`), temperature: false, reasoning: ['minimal', 'low', 'medium', 'high'] },
  { id: 'o-series', provider: 'OPENAI', label: 'o-series reasoning (o1, o3, o3-mini, o4-mini)', match: new RegExp(`^(?:o1|o3|o3-mini|o4-mini)${DATED}$`), temperature: false,
    reasoning: ['low', 'medium', 'high'] },
  { id: 'gpt-4.1', provider: 'OPENAI', label: 'GPT-4.1 (gpt-4.1, -mini, -nano)', match: new RegExp(`^gpt-4\\.1(?:-mini|-nano)?${DATED}$`), temperature: true, reasoning: null },
  { id: 'gpt-4o', provider: 'OPENAI', label: 'GPT-4o (gpt-4o, gpt-4o-mini)', match: new RegExp(`^gpt-4o(?:-mini)?${DATED}$`), temperature: true, reasoning: null },
  // Anthropic Messages API (anthropic-version 2026-10-21): sampling parameters are not accepted, so temperature is never sent. Effort is
  // `output_config.effort`. Every compatible family supports strict JSON-schema structured outputs (`output_config.format`).
  { id: 'claude-opus-5', provider: 'ANTHROPIC', label: 'Claude Opus 5 / 5.5', match: new RegExp(`^claude-opus-5(?:-5)?${ANTHROPIC_DATED}$`), temperature: false, reasoning: ALL_ANTHROPIC },
  { id: 'claude-sonnet-5', provider: 'ANTHROPIC', label: 'Claude Sonnet 5 / 5.5', match: new RegExp(`^claude-sonnet-5(?:-5)?${ANTHROPIC_DATED}$`), temperature: false, reasoning: ALL_ANTHROPIC },
  { id: 'claude-haiku-5', provider: 'ANTHROPIC', label: 'Claude Haiku 5.5', match: new RegExp(`^claude-haiku-5-5${ANTHROPIC_DATED}$`), temperature: false, reasoning: ALL_ANTHROPIC },
  { id: 'claude-opus-4-8', provider: 'ANTHROPIC', label: 'Claude Opus 4.8', match: new RegExp(`^claude-opus-4-8${ANTHROPIC_DATED}$`), temperature: false, reasoning: ALL_ANTHROPIC },
  { id: 'claude-haiku-4-5', provider: 'ANTHROPIC', label: 'Claude Haiku 4.5', match: new RegExp(`^claude-haiku-4-5${ANTHROPIC_DATED}$`), temperature: false, reasoning: null },
  { id: 'claude-fable-5', provider: 'ANTHROPIC', label: 'Claude Fable 5 / 5.1 / 5.2', match: new RegExp(`^claude-fable-5(?:-[12])?${ANTHROPIC_DATED}$`), temperature: false, reasoning: ALL_ANTHROPIC },
  { id: 'claude-no-structured-output', provider: 'ANTHROPIC', label: 'Claude Opus 4.6 / 4.7, Sonnet 4.5 / 4.6, Claude 3',
    match: new RegExp(`^claude-(?:opus-4-[67]|sonnet-4-[56]|3-|(?:opus|sonnet|haiku)-3)[a-z0-9.-]*$`), temperature: false, reasoning: null,
    incompatible: 'These models do not support the strict JSON-schema structured output FloFi requires.' },
] as ModelFamily[]).map(family => Object.freeze(family)));
export const modelFamily = (model: string, provider: CopilotProvider = 'OPENAI'): ModelFamily | null =>
  MODEL_FAMILIES.find(family => family.provider === provider && family.match.test(model)) ?? null;
/** The provider a model id belongs to (for records that keep only the model id, such as the daily metrics). */
export const providerOfModel = (model: string): CopilotProvider => ANTHROPIC_MODEL_ID.test(model) ? 'ANTHROPIC' : 'OPENAI';

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
const KEYS = ['acknowledgedUnverified', 'maxOutputTokens', 'model', 'reasoningEffort', 'temperature', 'timeoutMs'].join();
const KEYS_WITH_PROVIDER = ['acknowledgedUnverified', 'maxOutputTokens', 'model', 'provider', 'reasoningEffort', 'temperature', 'timeoutMs'].join();

/** Validates one complete settings set, including the provider and model capability checks. Throws `CopilotSettingsError`. */
export function validateRuntimeSettings(input: unknown, field = 'default'): CopilotRuntimeSettings {
  const keys = plain(input) ? Object.keys(input).sort().join() : '';
  if (!plain(input) || (keys !== KEYS && keys !== KEYS_WITH_PROVIDER)) return fail('COPILOT_SETTINGS_SHAPE_INVALID', field);
  // A set written before providers existed has no `provider` and always meant OpenAI.
  const provider = input.provider === undefined ? 'OPENAI' : input.provider;
  if (!(COPILOT_PROVIDERS as readonly unknown[]).includes(provider)) return fail('COPILOT_SETTINGS_PROVIDER_INVALID', `${field}.provider`);
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  if (!MODEL_ID.test(model)) return fail('COPILOT_SETTINGS_MODEL_INVALID', `${field}.model`);
  if ((provider === 'ANTHROPIC') !== ANTHROPIC_MODEL_ID.test(model)) return fail('COPILOT_SETTINGS_PROVIDER_MISMATCH', `${field}.model`);
  let temperature: number | null;
  if (input.temperature === null) temperature = null;
  else if (typeof input.temperature === 'number' && Number.isFinite(input.temperature) && TEMPERATURE.test(String(input.temperature))) temperature = input.temperature;
  else return fail('COPILOT_SETTINGS_OUT_OF_RANGE', `${field}.temperature`);
  const effort = input.reasoningEffort;
  if (effort !== null && !REASONING_EFFORTS.includes(effort as CopilotReasoningEffort)) return fail('COPILOT_SETTINGS_OUT_OF_RANGE', `${field}.reasoningEffort`);
  if (effort !== null && !PROVIDER_EFFORTS[provider as CopilotProvider].includes(effort as CopilotReasoningEffort))
    return fail('COPILOT_SETTINGS_REASONING_UNSUPPORTED', `${field}.reasoningEffort`);
  if (typeof input.acknowledgedUnverified !== 'boolean') return fail('COPILOT_SETTINGS_SHAPE_INVALID', `${field}.acknowledgedUnverified`);
  const settings: CopilotRuntimeSettings = { provider: provider as CopilotProvider, model, temperature, reasoningEffort: effort as CopilotReasoningEffort | null,
    maxOutputTokens: integer(input.maxOutputTokens, COPILOT_BOUNDS.maxOutputTokens, `${field}.maxOutputTokens`),
    timeoutMs: integer(input.timeoutMs, COPILOT_BOUNDS.timeoutMs, `${field}.timeoutMs`), acknowledgedUnverified: input.acknowledgedUnverified };
  // The Anthropic Messages API version FloFi sends accepts no sampling parameter on any model.
  if (settings.provider === 'ANTHROPIC' && settings.temperature !== null) return fail('COPILOT_SETTINGS_TEMPERATURE_UNSUPPORTED', `${field}.temperature`);
  const family = modelFamily(model, settings.provider);
  if (!family) {
    if (!settings.acknowledgedUnverified) return fail('COPILOT_SETTINGS_MODEL_UNVERIFIED', `${field}.model`);
  } else {
    if (family.incompatible) return fail('COPILOT_SETTINGS_MODEL_INCOMPATIBLE', `${field}.model`);
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
/** The providers a document uses (default and every override). */
export const documentProviders = (document: CopilotSettingsDocument): CopilotProvider[] =>
  COPILOT_PROVIDERS.filter(provider => document.default.provider === provider || Object.values(document.overrides).some(settings => settings?.provider === provider));

/**
 * The canonical stored form of a validated document: OpenAI sets omit `provider` (exactly the pre-provider form, which the previous build
 * reads), Anthropic sets keep it (which the previous build refuses rather than misreads).
 */
export function storedDocument(document: CopilotSettingsDocument): Record<string, unknown> {
  const stored = (settings: CopilotRuntimeSettings) => { const { provider, ...rest } = settings; return provider === 'OPENAI' ? { ...rest } : { ...rest, provider }; };
  return { schema: document.schema, default: stored(document.default),
    overrides: Object.fromEntries(Object.entries(document.overrides).filter(([, value]) => value).map(([scope, value]) => [scope, stored(value!)])) };
}

/** The environment bootstrap expressed as settings, for display and as the editor's starting point. It is always OpenAI. */
export function environmentSettings(input: { readonly model: string; readonly temperature: number | null; readonly maxOutputTokens: number;
  readonly reasoningEffort: CopilotReasoningEffort | null; readonly timeoutMs: number }): CopilotRuntimeSettings {
  return { provider: 'OPENAI', ...input, acknowledgedUnverified: modelFamily(input.model, 'OPENAI') === null };
}
export const DEFAULT_EDITOR_SETTINGS: Omit<CopilotRuntimeSettings, 'model' | 'provider'> = Object.freeze({ temperature: 0, reasoningEffort: null,
  maxOutputTokens: COPILOT_TUNING_DEFAULTS.maxOutputTokens, timeoutMs: COPILOT_TUNING_DEFAULTS.timeoutMs, acknowledgedUnverified: false });
