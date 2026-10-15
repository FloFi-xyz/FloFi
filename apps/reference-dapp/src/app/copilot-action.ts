// SPDX-License-Identifier: AGPL-3.0-only
'use server';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { COPILOT_REPLAY_FORMAT_V2, copilotConfig, copilotTelemetrySink, createCopilotLimiter, createOpenAITransport, createReplayTransport, interpretCopilot,
  interpretCopilotV2, parseCopilotReplay, COPILOT_SERVER_LIMITS, COPILOT_TUNING_DEFAULTS, type CopilotLimiter, type CopilotMode, type CopilotResult, type CopilotResultV2 } from '../server/copilot-service';
import { logCopilotSettingsFailure, publicCopilotCode, resolveCopilotLive, runtimeSettingsEnabled } from '../server/copilot-runtime';
import { webCopilotSettingsReader } from '../server/copilot-settings-source';
import { parseInterpretOptions, requestGlossary } from '../learning/web-actions';
import { webLearningService, pickPrincipal } from '../server/learning-web';
import { currentWalletPrincipals } from '../server/session-principal';

/**
 * BUILD-COPILOT-001: Flofi Copilot interpretation. The browser sends only its short clarification thread and receives
 * an untrusted structured intent or a failure code — never the key, the model name, the prompt or upstream errors.
 * The intent becomes a proposal only through the exact grammar, and the workflow changes only on the user's Apply.
 *
 * BUILD-COPILOT-002: a request with `version: '2'` carries a bounded transcript and receives a CopilotIntentV2. The
 * browser resolves it against its own state; nothing here sees, stores or trusts a workflow. Requests without a version
 * keep the V1 protocol and replay file.
 *
 * BUILD-ADMIN-001: live model settings are resolved per request (`copilot-runtime.ts`): an administrator's versioned settings when
 * this deployment has platform state, otherwise the unchanged `OPENAI_COPILOT_*` bootstrap. Mode and key stay environment-only. The read
 * survives a rolling deployment's schema window (`copilot-settings-source.ts`).
 *
 * BUILD-CHAT-LEARNING-001: with learning enabled, a V2 request carries a bounded glossary of the meanings matched in its open request (the
 * verified wallet's own, then FloFi's reviewed global glossary; `options` may name which proven wallet and this conversation's own aliases),
 * and one content-free INTERPRETED event is recorded. Without learning, or when it is unavailable, the request is exactly as before.
 */
const REPLAY_FILE = join('e2e', 'copilot', 'replay.json');
const REPLAY_FILE_V2 = join('e2e', 'copilot', 'replay-v2.json');
/** Held on globalThis so development module reloads cannot reset the per-process admission limits. */
function limiter(): CopilotLimiter {
  const key = Symbol.for('flofi.copilot.limiter');
  const holder = globalThis as unknown as Record<symbol, CopilotLimiter | undefined>;
  holder[key] ??= createCopilotLimiter();
  return holder[key];
}
/** Live settings for this request; invalid tuning or unreadable runtime settings make the Copilot unavailable, never silently different. */
async function live() {
  // The platform-state pool opens only when a live request needs it (the same pool MCP, Developer and Channels use).
  const reader = runtimeSettingsEnabled(process.env) ? webCopilotSettingsReader(process.env) : null;
  const resolved = await resolveCopilotLive(process.env, 'WEB', reader);
  if (!resolved.ok) logCopilotSettingsFailure(process.env, resolved.code, 'WEB');
  return resolved;
}
async function mode(): Promise<CopilotMode> {
  const config = copilotConfig(process.env);
  if (config.mode === 'off' || config.mode === 'replay' || process.env.FLOFI_COPILOT !== 'live') return config.mode;
  return (await live()).ok ? 'live' : 'unavailable';
}
export async function copilotStatus(): Promise<{ mode: CopilotMode }> {
  return { mode: await mode() };
}
const isV2 = (input: unknown) => !!input && typeof input === 'object' && (input as { version?: unknown }).version === '2';
/** The learning part of a V2 request: its glossary and how to record its outcome; null when learning is off or unavailable (fail-soft). */
async function learningFor(input: unknown, options: unknown) {
  const service = await webLearningService(process.env);
  if (typeof service === 'string') return null;
  try {
    const parsed = parseInterpretOptions(options), principal = pickPrincipal(await currentWalletPrincipals().catch(() => []), parsed.identity);
    const session = await service.session(principal);
    const messages = (input as { messages?: unknown }).messages;
    const { glossary, entries } = requestGlossary(session, Array.isArray(messages) ? messages.filter((m): m is { role: string; text: string } =>
      !!m && typeof m === 'object' && typeof (m as { role?: unknown }).role === 'string' && typeof (m as { text?: unknown }).text === 'string') : [], parsed.aliases,
      parsed.adapted);
    const record = (result: CopilotResultV2) => service.record('WEB', [{ kind: 'INTERPRETED', outcome: result.ok ? 'OK' : result.code,
      language: result.ok ? result.intent.language : null, privateEntries: entries.filter(e => e.source !== 'GLOBAL').length,
      globalEntries: entries.filter(e => e.source === 'GLOBAL').length, knowledgeVersion: session.learning.globalVersion }], session.subject?.subjectId ?? null);
    return { glossary, record };
  } catch { return null; }
}
export async function copilotInterpret(input: unknown, options?: unknown): Promise<CopilotResult | CopilotResultV2> {
  const config = copilotConfig(process.env);
  if (config.mode === 'off') return { ok: false, code: 'COPILOT_OFF' };
  if (process.env.FLOFI_COPILOT === 'live') {
    const resolved = await live();
    if (!resolved.ok) return { ok: false, code: publicCopilotCode(resolved.code) };
    const { apiKey, settings } = resolved;
    if (isV2(input)) {
      const learning = await learningFor(input, options);
      const result = await interpretCopilotV2(input, { transport: createOpenAITransport(apiKey, fetch, { timeoutMs: settings.timeoutMs, maxResponseBytes: COPILOT_SERVER_LIMITS.maxResponseBytes }),
        settings: { model: settings.model, temperature: settings.temperature, maxOutputTokens: settings.maxOutputTokens, reasoningEffort: settings.reasoningEffort },
        mode: 'live', limiter: limiter(), telemetry: copilotTelemetrySink(process.env, 'live'), glossary: learning?.glossary ?? null });
      await learning?.record(result);
      return result;
    }
    return interpretCopilot(input, { transport: createOpenAITransport(apiKey), model: settings.model, temperature: settings.temperature, limiter: limiter() });
  }
  if (config.mode === 'unavailable') return { ok: false, code: 'COPILOT_NOT_CONFIGURED' };
  if (isV2(input)) {
    let replay;
    try { replay = parseCopilotReplay(JSON.parse(await readFile(REPLAY_FILE_V2, 'utf8')), COPILOT_REPLAY_FORMAT_V2); } catch { return { ok: false, code: 'COPILOT_REPLAY_INVALID' }; }
    const learning = await learningFor(input, options);
    const result = await interpretCopilotV2(input, { transport: createReplayTransport(replay, 'segment'), settings: { model: 'replay', temperature: 0,
      maxOutputTokens: COPILOT_TUNING_DEFAULTS.maxOutputTokens, reasoningEffort: null }, mode: 'replay', limiter: limiter(), telemetry: copilotTelemetrySink(process.env, 'replay'),
      glossary: learning?.glossary ?? null });
    await learning?.record(result);
    return result;
  }
  try {
    const replay = parseCopilotReplay(JSON.parse(await readFile(REPLAY_FILE, 'utf8')));
    return interpretCopilot(input, { transport: createReplayTransport(replay), model: 'replay', temperature: 0, limiter: limiter() });
  } catch { return { ok: false, code: 'COPILOT_REPLAY_INVALID' }; }
}
