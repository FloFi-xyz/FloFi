// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ADMIN-001: what the AI Settings page shows. Server-only data assembly: the Copilot mode, whether a key is configured (never the
 * key), whether runtime settings apply here, the active version and its source, the effective settings per scope, and the history with
 * each version's validity under today's catalog. Nothing in the result is a secret.
 */
import { copilotConfig, copilotTuning } from '../server/copilot-service.ts';
import { copilotApiKey, runtimeSettingsEnabled } from '../server/copilot-runtime.ts';
import { COPILOT_SCOPES, effectiveSettings, environmentSettings, MODEL_FAMILIES, MODEL_ID, validateSettingsDocument, CopilotSettingsError,
  type CopilotRuntimeSettings, type CopilotScope, type CopilotSettingsDocument } from '../server/copilot-settings.ts';
import { readActiveSettings, settingsHistory, type SettingsVersion } from '../server/runtime-settings-store.ts';
import type { AdminHost } from './host.ts';

type Env = Readonly<Record<string, string | undefined>>;
export type EffectiveView = { readonly scope: CopilotScope; readonly source: 'RUNTIME' | 'ENVIRONMENT'; readonly settings: CopilotRuntimeSettings | null;
  readonly code: string | null };
export type HistoryView = SettingsVersion & { readonly valid: boolean; readonly code: string | null; readonly model: string | null };
export type CopilotSettingsView = {
  readonly mode: 'off' | 'replay' | 'live' | 'unavailable'; readonly apiKeyConfigured: boolean; readonly runtimeEnabled: boolean;
  readonly runtimeDisabledReason: 'BREAK_GLASS' | 'NO_PLATFORM_STATE' | null; readonly storeError: string | null;
  readonly activeVersion: number; readonly activeSource: 'RUNTIME' | 'ENVIRONMENT'; readonly activeDocument: CopilotSettingsDocument | null; readonly activeCode: string | null;
  readonly environment: CopilotRuntimeSettings | null; readonly environmentCode: string | null;
  readonly effective: readonly EffectiveView[]; readonly history: readonly HistoryView[];
  readonly families: readonly { readonly id: string; readonly label: string; readonly pattern: string; readonly temperature: boolean; readonly reasoning: readonly string[] | null }[];
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

export async function copilotSettingsView(env: Env, host: AdminHost): Promise<CopilotSettingsView> {
  const config = copilotConfig(env), runtimeEnabled = runtimeSettingsEnabled(env), bootstrap = environmentBootstrap(env);
  const mode = env.FLOFI_COPILOT === 'live' ? (copilotApiKey(env) ? 'live' : 'unavailable') : config.mode;
  let active: SettingsVersion | null = null, history: SettingsVersion[] = [], storeError: string | null = null;
  try { [active, history] = await Promise.all([readActiveSettings(host.db, host.tenantId, 'copilot'), settingsHistory(host.db, host.tenantId, 'copilot', 30)]); }
  catch { storeError = 'ADMIN_STORE_UNAVAILABLE'; }
  const current = validity(active?.document ?? null), runtime = runtimeEnabled && current.document !== null;
  const effective = COPILOT_SCOPES.map((scope): EffectiveView => runtime ? { scope, source: 'RUNTIME', settings: effectiveSettings(current.document!, scope), code: null }
    : runtimeEnabled && current.code ? { scope, source: 'RUNTIME', settings: null, code: current.code }
    : { scope, source: 'ENVIRONMENT', settings: bootstrap.settings, code: bootstrap.code });
  return {
    mode, apiKeyConfigured: Boolean(env.OPENAI_API_KEY?.trim()), runtimeEnabled,
    runtimeDisabledReason: runtimeEnabled ? null : env.FLOFI_COPILOT_RUNTIME_CONFIG === 'disabled' ? 'BREAK_GLASS' : 'NO_PLATFORM_STATE', storeError,
    activeVersion: active?.version ?? 0, activeSource: current.document ? 'RUNTIME' : 'ENVIRONMENT', activeDocument: current.document, activeCode: current.code,
    environment: bootstrap.settings, environmentCode: bootstrap.code, effective,
    history: history.map(version => { const v = validity(version.document);
      return { ...version, valid: v.code === null, code: v.code, model: v.document?.default.model ?? null }; }),
    families: MODEL_FAMILIES.map(family => ({ id: family.id, label: family.label, pattern: family.match.source, temperature: family.temperature, reasoning: family.reasoning })),
  };
}
