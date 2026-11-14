// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ADMIN-001: which model settings a live Copilot request uses, resolved per request on the Next.js server (the only place the
 * Copilot runs: the chat server action and Channel Core). Precedence:
 *
 *   1. `FLOFI_COPILOT`, `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` stay environment-only: off/replay/live and the keys are never runtime
 *      settings. The settings name a provider; the request uses that provider's key, and only that key.
 *   2. With PostgreSQL platform state and `FLOFI_COPILOT_RUNTIME_CONFIG` not `disabled`, the latest `admin_settings_versions` row for
 *      `copilot` is read on every request (one primary-key lookup, no process cache: a change applies to the next request on every
 *      instance). Its document is validated again here; the scope's override, else the default, is used.
 *   3. No row, a NULL document (an administrator reset), no platform state, or the break-glass `FLOFI_COPILOT_RUNTIME_CONFIG=disabled`:
 *      the environment bootstrap (`OPENAI_COPILOT_*`, unchanged semantics: no default model, invalid tuning → not configured).
 *
 * BUILD-ADMIN-AI-PROVIDERS-001: a provider whose key is not installed fails closed (`COPILOT_PROVIDER_NOT_CONFIGURED`) — the request is never
 * sent to the other provider, so an Anthropic outage or a missing key never turns into OpenAI traffic (or charges), and the reverse. An
 * Anthropic-only deployment needs no OpenAI key: the runtime settings select Anthropic; the environment bootstrap stays OpenAI-only.
 *
 * A stored document that fails validation, or a database that cannot be read, fails closed (the exact grammar keeps working); it never
 * falls back to the environment, because that would silently swap the model an administrator chose. A read that failed only because its
 * pooled connection dropped (a restarting or scaled-to-zero server) is repeated once at once, on a fresh connection: the same read, the
 * same answer, never a cached or different one.
 */
import { copilotConfig, copilotTuning } from './copilot-service.ts';
import { anyProviderKey, providerApiKey } from './copilot-providers.ts';
import { effectiveSettings, environmentSettings, validateSettingsDocument, type CopilotProvider, type CopilotRuntimeSettings, type CopilotScope } from './copilot-settings.ts';
import { readActiveSettings, type SettingsVersion } from './runtime-settings-store.ts';

type Env = Readonly<Record<string, string | undefined>>;
export type CopilotSettingsSource = 'ENVIRONMENT' | 'RUNTIME';
export type ResolvedCopilot = { readonly ok: true; readonly provider: CopilotProvider; readonly apiKey: string; readonly settings: CopilotRuntimeSettings;
  readonly source: CopilotSettingsSource; readonly version: number | null }
  | { readonly ok: false; readonly code: 'COPILOT_NOT_CONFIGURED' | 'COPILOT_PROVIDER_NOT_CONFIGURED' | 'COPILOT_CONFIG_UNAVAILABLE' | 'COPILOT_CONFIG_INVALID' };
/** Reads the active settings version (null when none was ever written). */
export type CopilotSettingsReader = () => Promise<SettingsVersion | null>;
export type CopilotHost = { readonly db: Parameters<typeof readActiveSettings>[0]; readonly tenantId: string };

/** The OpenAI key of a live Copilot (the environment bootstrap's provider), or null. See `providerApiKey` for either provider. */
export function copilotApiKey(env: Env): string | null {
  if (env.FLOFI_COPILOT !== 'live') return null;
  const key = env.OPENAI_API_KEY?.trim() ?? '';
  return key && !/\s/.test(key) ? key : null;
}
/** Runtime settings apply only where durable platform state exists and the operator has not disabled them. */
export function runtimeSettingsEnabled(env: Env): boolean {
  return env.FLOFI_COPILOT_RUNTIME_CONFIG !== 'disabled' && (Boolean(env.DATABASE_URL) || env.FLOFI_RUNTIME === 'embedded');
}
export const hostSettingsReader = (host: CopilotHost): CopilotSettingsReader => () => readActiveSettings(host.db, host.tenantId, 'copilot');
export function environmentCopilot(env: Env): ResolvedCopilot {
  const config = copilotConfig(env), tuning = copilotTuning(env);
  if (config.mode !== 'live' || !tuning) return { ok: false, code: 'COPILOT_NOT_CONFIGURED' };
  return { ok: true, provider: 'OPENAI', apiKey: config.apiKey, source: 'ENVIRONMENT', version: null, settings: environmentSettings({ model: config.model, temperature: config.temperature,
    maxOutputTokens: tuning.maxOutputTokens, reasoningEffort: tuning.reasoningEffort, timeoutMs: tuning.timeoutMs }) };
}

/** A failure of the connection itself (dropped, reset, server restarting), not of the query: worth exactly one immediate second read. */
export function connectionDropped(error: unknown): boolean {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  if (typeof code === 'string') return /^08[0-9A-Z]{3}$/.test(code) || /^57P0[1-3]$/.test(code) || code === 'ECONNRESET' || code === 'EPIPE';
  return error instanceof Error && /^(?:Connection terminated(?: unexpectedly)?|Client has encountered a connection error and is not queryable)$/.test(error.message);
}

/** The settings for one live request in `scope`. Call it per request; it holds no state. */
export async function resolveCopilotLive(env: Env, scope: CopilotScope, reader: CopilotSettingsReader | null): Promise<ResolvedCopilot> {
  // No provider key at all: nothing could answer, so the database is not read.
  if (!anyProviderKey(env)) return { ok: false, code: 'COPILOT_NOT_CONFIGURED' };
  if (!reader || env.FLOFI_COPILOT_RUNTIME_CONFIG === 'disabled') return environmentCopilot(env);
  let active: SettingsVersion | null;
  try { active = await reader(); }
  catch (error) {
    if (!connectionDropped(error)) return { ok: false, code: 'COPILOT_CONFIG_UNAVAILABLE' };
    try { active = await reader(); } catch { return { ok: false, code: 'COPILOT_CONFIG_UNAVAILABLE' }; }
  }
  if (!active || active.document === null) {
    const bootstrap = environmentCopilot(env);
    return bootstrap.ok ? { ...bootstrap, version: active?.version ?? null } : bootstrap;
  }
  let settings: CopilotRuntimeSettings;
  try { settings = effectiveSettings(validateSettingsDocument(active.document), scope); } catch { return { ok: false, code: 'COPILOT_CONFIG_INVALID' }; }
  const apiKey = providerApiKey(env, settings.provider);
  if (!apiKey) return { ok: false, code: 'COPILOT_PROVIDER_NOT_CONFIGURED' };
  return { ok: true, provider: settings.provider, apiKey, source: 'RUNTIME', version: active.version, settings };
}

/** The browser-facing code: users keep seeing the existing messages; the precise reason goes to the server log. */
export function publicCopilotCode(code: Extract<ResolvedCopilot, { ok: false }>['code']): 'COPILOT_NOT_CONFIGURED' | 'COPILOT_UNAVAILABLE' {
  return code === 'COPILOT_CONFIG_UNAVAILABLE' ? 'COPILOT_UNAVAILABLE' : 'COPILOT_NOT_CONFIGURED';
}
/** One content-free line when runtime settings cannot be applied (`FLOFI_COPILOT_TELEMETRY=off` silences it). */
export function logCopilotSettingsFailure(env: Env, code: string, scope: CopilotScope, log: (line: string) => void = line => console.warn(line)): void {
  if (env.FLOFI_COPILOT_TELEMETRY?.trim() === 'off') return;
  log(JSON.stringify({ event: 'flofi.copilot.settings', outcome: code, scope }));
}

/** A channel turn's live settings for `scope`, read from the channel host's database (Channel Core receives it through its wiring). */
export function channelLiveCopilot(env: Env, scope: CopilotScope, host: CopilotHost) {
  const reader = runtimeSettingsEnabled(env) ? hostSettingsReader(host) : null;
  return async () => {
    const resolved = await resolveCopilotLive(env, scope, reader);
    if (resolved.ok) return resolved;
    logCopilotSettingsFailure(env, resolved.code, scope);
    return { ok: false as const, code: publicCopilotCode(resolved.code) };
  };
}
