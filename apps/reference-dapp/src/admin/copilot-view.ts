// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ADMIN-001: what the AI Settings page shows. Server-only data assembly: the Copilot mode, whether a key is configured (never the
 * key), whether runtime settings apply here, the active version and its source, the effective settings per scope, and the history with
 * each version's validity under today's catalog. Nothing in the result is a secret.
 *
 * BUILD-ADMIN-AI-PROVIDERS-001: also which providers have a key installed (never the key) and which channels use each, the Anthropic models
 * this organization can use (Models API, cached), the capability catalog per provider and the list prices used for estimates.
 */
import { copilotConfig, copilotTuning } from '../server/copilot-service.ts';
import { runtimeSettingsEnabled } from '../server/copilot-runtime.ts';
import { ANTHROPIC_CONSOLE, anyProviderKey, discoverAnthropicModels, MODEL_PRICES, MODEL_PRICES_CHECKED, PROVIDER_KEY_ENV, providerReadiness,
  type ModelDiscovery } from '../server/copilot-providers.ts';
import { COPILOT_PROVIDER_LABELS, COPILOT_PROVIDERS, COPILOT_SCOPES, effectiveSettings, environmentSettings, MODEL_FAMILIES, MODEL_ID, PROVIDER_EFFORTS,
  validateSettingsDocument, CopilotSettingsError, type CopilotProvider, type CopilotRuntimeSettings, type CopilotScope, type CopilotSettingsDocument } from '../server/copilot-settings.ts';
import { readActiveSettings, settingsHistory, type SettingsVersion } from '../server/runtime-settings-store.ts';
import type { AdminHost } from './host.ts';

type Env = Readonly<Record<string, string | undefined>>;
export type EffectiveView = { readonly scope: CopilotScope; readonly source: 'RUNTIME' | 'ENVIRONMENT'; readonly settings: CopilotRuntimeSettings | null;
  readonly code: string | null };
export type HistoryView = SettingsVersion & { readonly valid: boolean; readonly code: string | null; readonly model: string | null;
  readonly providers: readonly CopilotProvider[] };
export type ProviderView = { readonly id: CopilotProvider; readonly label: string; readonly keyEnv: string; readonly keyConfigured: boolean;
  readonly efforts: readonly string[]; readonly usedBy: readonly CopilotScope[] };
export type CopilotSettingsView = {
  readonly mode: 'off' | 'replay' | 'live' | 'unavailable'; readonly apiKeyConfigured: boolean; readonly runtimeEnabled: boolean;
  readonly runtimeDisabledReason: 'BREAK_GLASS' | 'NO_PLATFORM_STATE' | null; readonly storeError: string | null;
  readonly activeVersion: number; readonly activeSource: 'RUNTIME' | 'ENVIRONMENT'; readonly activeDocument: CopilotSettingsDocument | null; readonly activeCode: string | null;
  readonly environment: CopilotRuntimeSettings | null; readonly environmentCode: string | null;
  readonly effective: readonly EffectiveView[]; readonly history: readonly HistoryView[];
  readonly families: readonly { readonly id: string; readonly provider: CopilotProvider; readonly label: string; readonly pattern: string; readonly temperature: boolean;
    readonly reasoning: readonly string[] | null; readonly incompatible: string | null }[];
  readonly providers: readonly ProviderView[]; readonly anthropicModels: ModelDiscovery | null;
  readonly prices: readonly { readonly provider: CopilotProvider; readonly label: string; readonly pattern: string; readonly inputPerMTok: number; readonly outputPerMTok: number }[];
  readonly pricesChecked: string; readonly console: typeof ANTHROPIC_CONSOLE;
};

/** The `OPENAI_COPILOT_*` bootstrap as settings, independent of the mode (so it can be shown while the Copilot is off). */
export function environmentBootstrap(env: Env): { readonly settings: CopilotRuntimeSettings | null; readonly code: string | null } {
  const model = env.OPENAI_COPILOT_MODEL?.trim() ?? '';
  if (!MODEL_ID.test(model)) return { settings: null, code: 'OPENAI_COPILOT_MODEL_MISSING' };
  const config = copilotConfig({ FLOFI_COPILOT: 'live', OPENAI_API_KEY: 'present', OPENAI_COPILOT_MODEL: model, OPENAI_COPILOT_TEMPERATURE: env.OPENAI_COPILOT_TEMPERATURE });
  const tuning = copilotTuning(env);
  if (config.mode !== 'live' || !tuning) return { settings: null, code: 'OPENAI_COPILOT_TUNING_INVALID' };
  return { settings: environmentSettings({ model, temperature: config.temperature, maxOutputTokens: tuning.maxOutputTokens, reasoningEffort: tuning.reasoningEffort,
    timeoutMs: tuning.timeoutMs }), code: null };
}
const validity = (document: unknown): { document: CopilotSettingsDocument | null; code: string | null } => {
  if (document === null) return { document: null, code: null };
  try { return { document: validateSettingsDocument(document), code: null }; }
  catch (error) { return { document: null, code: error instanceof CopilotSettingsError ? error.code : 'COPILOT_SETTINGS_INVALID' }; }
};

export async function copilotSettingsView(env: Env, host: AdminHost, options: { readonly discover?: boolean; readonly fetch?: typeof fetch } = {}): Promise<CopilotSettingsView> {
  const config = copilotConfig(env), runtimeEnabled = runtimeSettingsEnabled(env), bootstrap = environmentBootstrap(env), keys = providerReadiness(env);
  const mode = env.FLOFI_COPILOT === 'live' ? (anyProviderKey(env) ? 'live' : 'unavailable') : config.mode;
  // The models this Anthropic organization can use (cached per process); never fetched without a key or when the caller does not need it.
  // Only a live Copilot ever contacts a provider (an off/replay deployment stays closed even when a key is present).
  const anthropicModels = options.discover && keys.ANTHROPIC && env.FLOFI_COPILOT === 'live' ? await discoverAnthropicModels(env.ANTHROPIC_API_KEY!.trim(), options.fetch ? { fetch: options.fetch } : {}) : null;
  let active: SettingsVersion | null = null, history: SettingsVersion[] = [], storeError: string | null = null;
  try { [active, history] = await Promise.all([readActiveSettings(host.db, host.tenantId, 'copilot'), settingsHistory(host.db, host.tenantId, 'copilot', 30)]); }
  catch { storeError = 'ADMIN_STORE_UNAVAILABLE'; }
  const current = validity(active?.document ?? null), runtime = runtimeEnabled && current.document !== null;
  const effective = COPILOT_SCOPES.map((scope): EffectiveView => runtime ? { scope, source: 'RUNTIME', settings: effectiveSettings(current.document!, scope), code: null }
    : runtimeEnabled && current.code ? { scope, source: 'RUNTIME', settings: null, code: current.code }
    : { scope, source: 'ENVIRONMENT', settings: bootstrap.settings, code: bootstrap.code });
  const providers = COPILOT_PROVIDERS.map((id): ProviderView => ({ id, label: COPILOT_PROVIDER_LABELS[id], keyEnv: PROVIDER_KEY_ENV[id], keyConfigured: keys[id],
    efforts: PROVIDER_EFFORTS[id], usedBy: effective.filter(row => row.settings?.provider === id).map(row => row.scope) }));
  return {
    mode, apiKeyConfigured: keys.OPENAI, runtimeEnabled,
    runtimeDisabledReason: runtimeEnabled ? null : env.FLOFI_COPILOT_RUNTIME_CONFIG === 'disabled' ? 'BREAK_GLASS' : 'NO_PLATFORM_STATE', storeError,
    activeVersion: active?.version ?? 0, activeSource: current.document ? 'RUNTIME' : 'ENVIRONMENT', activeDocument: current.document,
    // With stored settings switched off (break-glass) the runtime never reads the stored version, so its validity is not an outage.
    activeCode: runtimeEnabled ? current.code : null,
    environment: bootstrap.settings, environmentCode: bootstrap.code, effective,
    history: history.map(version => { const v = validity(version.document);
      return { ...version, valid: v.code === null, code: v.code, model: v.document?.default.model ?? null,
        providers: v.document ? COPILOT_PROVIDERS.filter(p => v.document!.default.provider === p || Object.values(v.document!.overrides).some(o => o?.provider === p)) : [] }; }),
    families: MODEL_FAMILIES.map(family => ({ id: family.id, provider: family.provider, label: family.label, pattern: family.match.source, temperature: family.temperature,
      reasoning: family.reasoning, incompatible: family.incompatible ?? null })),
    providers, anthropicModels,
    prices: MODEL_PRICES.map(price => ({ provider: price.provider, label: price.label, pattern: price.match.source, inputPerMTok: price.inputPerMTok, outputPerMTok: price.outputPerMTok })),
    pricesChecked: MODEL_PRICES_CHECKED, console: ANTHROPIC_CONSOLE,
  };
}
