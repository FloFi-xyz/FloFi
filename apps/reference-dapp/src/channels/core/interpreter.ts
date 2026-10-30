// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHANNELS-001: the channel's untrusted interpreter — FloFi's existing Copilot V2 boundary (`copilot-service.ts`), unchanged:
 * bounded read-only tool calls, structured output, `store: false`, strict schema validation, closed failure
 * codes, and the same per-process admission limiter as FloFi's own chat (shared through the same global key). `replay` answers come
 * from committed recordings with no network. Nothing here sees a wallet, a workflow or a secret, and nothing it returns is authority:
 * the conversation engine grounds every value in the user's own words and authors only through the exact grammar.
 *
 * `FLOFI_CHANNEL_COPILOT=disabled` (or `FLOFI_COPILOT` off) means no interpreter at all: exact commands only, no model call.
 *
 * BUILD-ADMIN-001: the wiring may pass `live`, which resolves the model settings for each turn (an administrator's versioned settings for the
 * channel's scope, else the environment bootstrap — `server/copilot-runtime.ts`). Without it, the environment settings below apply unchanged.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { COPILOT_REPLAY_FORMAT_V2, COPILOT_SERVER_LIMITS, COPILOT_TUNING_DEFAULTS, copilotConfig, copilotTelemetrySink, copilotTuning, createCopilotLimiter,
  createOpenAITransport, createReplayTransport, interpretCopilotV2, parseCopilotReplay, type CopilotLimiter, type CopilotModelSettings,
  type CopilotTelemetry, type CopilotTransport } from '../../server/copilot-service.ts';
import type { ChannelInterpreter } from './conversation.ts';
import { copilotToolkitOf, copilotToolsEnabled, type CopilotToolkit } from '../../platform/copilot-tools.ts';
import { scopeOfEnv } from '../../domain/network-scope';
import { logCopilotTurn } from '../../server/copilot-service.ts';
import type { TurnMetrics } from '../../domain/intelligence/turn-metrics';

type Env = Readonly<Record<string, string | undefined>>;
/** One turn's live settings, or the browser-safe code to answer with. */
export type ChannelLiveCopilot = () => Promise<{ readonly ok: true; readonly apiKey: string; readonly settings: CopilotModelSettings & { readonly timeoutMs: number } }
  | { readonly ok: false; readonly code: string }>;
const REPLAY_FILE_V2 = join('e2e', 'copilot', 'replay-v2.json');
/** The process-wide admission limiter FloFi's chat uses (`copilot-action.ts` holds it under the same key). */
function sharedLimiter(): CopilotLimiter {
  const key = Symbol.for('flofi.copilot.limiter'), holder = globalThis as unknown as Record<symbol, CopilotLimiter | undefined>;
  holder[key] ??= createCopilotLimiter();
  return holder[key];
}

/** The interpreter this deployment allows for channels, or null (exact commands only). `transport` is a test seam for replayed answers. */
export function channelInterpreter(env: Env, options: { readonly enabled: boolean; readonly transport?: CopilotTransport; readonly live?: ChannelLiveCopilot;
  /** Awaited durable server telemetry, supplied only by the authenticated entry point. */ readonly metrics?: (record: CopilotTelemetry) => Promise<void>;
  /** BUILD-FLOFI-INTELLIGENCE-001: test seam for the read-only tools (default: this deployment's, `copilotToolkit`). */ readonly toolkit?: CopilotToolkit | null } =
  { enabled: true }): ChannelInterpreter | null {
  if (!options.enabled) return null;
  // Entry points inject the authenticated server's read-only provider toolkit. Core has no flow runtime or transaction authority.
  // A standalone interpreter without server wiring keeps registry-only tools. None with FLOFI_COPILOT_TOOLS=off.
  const toolkit = options.toolkit !== undefined ? options.toolkit : copilotToolsEnabled(env) ? copilotToolkitOf(scopeOfEnv(env), {}) : null;
  const interpret = async (request: Parameters<ChannelInterpreter>[0], deps: Parameters<typeof interpretCopilotV2>[1]) => {
    const records: CopilotTelemetry[] = [];
    const result = await interpretCopilotV2(request, { ...deps, telemetry: record => { deps.telemetry?.(record); records.push(record); } });
    for (const record of records) await options.metrics?.(record);
    return result;
  };
  if (options.transport) {
    const transport = options.transport;
    return (request, options) => interpret(request, { transport, mode: 'replay', limiter: sharedLimiter(), glossary: options?.glossary ?? null, toolkit, surface: 'CHANNEL',
      settings: { model: 'replay', temperature: 0, maxOutputTokens: COPILOT_TUNING_DEFAULTS.maxOutputTokens, reasoningEffort: null } });
  }
  const config = copilotConfig(env), tuning = copilotTuning(env), live = options.live;
  if (config.mode === 'off') return null;
  if (live && env.FLOFI_COPILOT === 'live') {
    return async (request, options) => {
      const resolved = await live();
      if (!resolved.ok) return { ok: false, code: resolved.code };
      const { apiKey, settings } = resolved;
      return interpret(request, { transport: createOpenAITransport(apiKey, fetch, { timeoutMs: settings.timeoutMs, maxResponseBytes: COPILOT_SERVER_LIMITS.maxResponseBytes }),
        mode: 'live', limiter: sharedLimiter(), telemetry: copilotTelemetrySink(env, 'live'), glossary: options?.glossary ?? null, toolkit, surface: 'CHANNEL',
        settings: { model: settings.model, temperature: settings.temperature, maxOutputTokens: settings.maxOutputTokens, reasoningEffort: settings.reasoningEffort } });
    };
  }
  if (config.mode === 'unavailable' || (config.mode === 'live' && !tuning)) return async () => ({ ok: false, code: 'COPILOT_NOT_CONFIGURED' });
  if (config.mode === 'live' && tuning) {
    const transport = createOpenAITransport(config.apiKey, fetch, { timeoutMs: tuning.timeoutMs, maxResponseBytes: COPILOT_SERVER_LIMITS.maxResponseBytes });
    return (request, options) => interpret(request, { transport, mode: 'live', limiter: sharedLimiter(), telemetry: copilotTelemetrySink(env, 'live'),
      glossary: options?.glossary ?? null, toolkit, surface: 'CHANNEL',
      settings: { model: config.model, temperature: config.temperature, maxOutputTokens: tuning.maxOutputTokens, reasoningEffort: tuning.reasoningEffort } });
  }
  return async (request, options) => {
    try {
      const replay = parseCopilotReplay(JSON.parse(await readFile(REPLAY_FILE_V2, 'utf8')), COPILOT_REPLAY_FORMAT_V2);
      return interpret(request, { transport: createReplayTransport(replay, 'segment'), mode: 'replay', limiter: sharedLimiter(), glossary: options?.glossary ?? null, toolkit, surface: 'CHANNEL',
        settings: { model: 'replay', temperature: 0, maxOutputTokens: COPILOT_TUNING_DEFAULTS.maxOutputTokens, reasoningEffort: null } });
    } catch { return { ok: false, code: 'COPILOT_REPLAY_INVALID' }; }
  };
}

/** BUILD-FLOFI-INTELLIGENCE-001: a channel turn's content-free record (`domain/intelligence/turn-metrics.ts`), under the Copilot's telemetry switch. */
export function logChannelTurn(env: Env, record: TurnMetrics): void {
  logCopilotTurn(env, env.FLOFI_COPILOT === 'live' ? 'live' : 'replay', record);
}
