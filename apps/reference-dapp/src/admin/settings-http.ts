// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ADMIN-001: `POST /admin/api/settings/copilot` — the Copilot's versioned runtime settings (OPERATOR only, CSRF-checked, audited).
 *
 *   save      `{ action, expectedVersion, document, reason? }`   validates the whole document (bounds + model capability catalog) and
 *                                                                 appends it as version expectedVersion + 1
 *   rollback  `{ action, expectedVersion, toVersion, reason? }`  appends a version restoring an older one (re-validated today)
 *   reset     `{ action, expectedVersion, reason? }`             appends a NULL document: back to the environment bootstrap
 *   probe     `{ action, settings }`                             one live strict-schema request with candidate settings (rate-limited)
 *
 * Nothing here can set the API key, the Copilot mode, its instructions or its output schema. Every change takes effect on the next
 * Copilot request of every instance (no cache, see `copilot-runtime.ts`).
 */
import { COPILOT_SERVER_LIMITS, createOpenAITransport, interpretCopilotV2, type CopilotHttpResponse } from '../server/copilot-service.ts';
import { copilotApiKey } from '../server/copilot-runtime.ts';
import { CopilotSettingsError, validateRuntimeSettings, validateSettingsDocument, type CopilotSettingsDocument } from '../server/copilot-settings.ts';
import { appendSettingsVersion, readActiveSettings, readSettingsVersion, type SettingsVersion } from '../server/runtime-settings-store.ts';
import { adminMutation, codeOf, json, readJsonObject, type AdminHttpOptions } from './http.ts';

export type SettingsHttpOptions = AdminHttpOptions & { readonly fetch?: typeof fetch };
export const PROBE_WINDOW_MS = 600_000, PROBE_LIMIT = 10;
export const PROBE_TRANSCRIPT = Object.freeze({ version: '2', messages: [{ role: 'user', text: 'Swap 1 USDC to WETH on Base Sepolia with 0.5% slippage' }] });
const UPSTREAM_CODES = new Set(['unsupported_parameter', 'unsupported_value', 'model_not_found', 'invalid_value', 'invalid_type', 'invalid_json_schema']);
const UPSTREAM_PARAMS = new Set(['model', 'temperature', 'reasoning', 'reasoning.effort', 'max_output_tokens', 'text.format', 'text.format.schema', 'instructions']);

const settingsError = (error: unknown) => error instanceof CopilotSettingsError ? { code: error.code, field: error.field } : { code: codeOf(error, 'COPILOT_SETTINGS_INVALID'), field: null };
function reasonOf(value: unknown): string | null | false {
  if (value === undefined || value === null || value === '') return null;
  return typeof value === 'string' && /^[^\p{Cc}]{1,200}$/u.test(value.trim()) ? value.trim() : false;
}
/** Key-order independent equality (PostgreSQL `jsonb` does not keep the order the document was written in). */
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)])) : value;
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const versionOf = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Only allow-listed fields of an upstream 4xx error body are ever returned (never its free-text message). */
export function upstreamRejection(response: CopilotHttpResponse | null): { readonly code: string | null; readonly param: string | null } | null {
  if (!response || response.status < 400 || response.status >= 500) return null;
  try {
    const error = (JSON.parse(response.body) as { error?: { code?: unknown; param?: unknown } }).error;
    return { code: typeof error?.code === 'string' && UPSTREAM_CODES.has(error.code) ? error.code : null,
      param: typeof error?.param === 'string' && UPSTREAM_PARAMS.has(error.param) ? error.param : null };
  } catch { return { code: null, param: null }; }
}

export async function handleCopilotSettings(request: Request, options: SettingsHttpOptions = {}): Promise<Response> {
  const allowed = await adminMutation(request, options, 'write');
  if (allowed instanceof Response) return allowed;
  const { context, request: base } = allowed, actor = context.principal.principalId, { db, tenantId } = base.host;
  const body = await readJsonObject(request);
  if (!body || typeof body.action !== 'string') return json(400, { ok: false, code: 'ADMIN_REQUEST_INVALID' });
  const audit = (kind: string, outcome: 'OK' | 'REFUSED' | 'FAILED', code: string | null, detail: Record<string, string | number | boolean | null> | null) =>
    base.store.audit({ actor, kind, outcome, code, target: 'settings:copilot', detail }).catch(() => undefined);

  if (body.action === 'probe') {
    const apiKey = copilotApiKey(options.env ?? process.env);
    if (!apiKey) return json(409, { ok: false, code: 'COPILOT_NOT_LIVE' });
    let settings;
    try { settings = validateRuntimeSettings(body.settings, 'settings'); }
    catch (error) { return json(400, { ok: false, ...settingsError(error) }); }
    const recent = await base.store.countAudit('ADMIN_COPILOT_PROBE', new Date(base.now.getTime() - PROBE_WINDOW_MS)).catch(() => PROBE_LIMIT);
    if (recent >= PROBE_LIMIT) return json(429, { ok: false, code: 'ADMIN_PROBE_RATE_LIMITED' });
    let last: CopilotHttpResponse | null = null;
    const live = createOpenAITransport(apiKey, options.fetch ?? fetch, { timeoutMs: settings.timeoutMs, maxResponseBytes: COPILOT_SERVER_LIMITS.maxResponseBytes });
    let telemetry: { durationMs: number; inputTokens: number | null; outputTokens: number | null; reasoningTokens: number | null; responseModel: string | null } | null = null;
    const result = await interpretCopilotV2(PROBE_TRANSCRIPT, { transport: async input => (last = await live(input)), mode: 'live',
      settings: { model: settings.model, temperature: settings.temperature, maxOutputTokens: settings.maxOutputTokens, reasoningEffort: settings.reasoningEffort },
      telemetry: record => { telemetry = { durationMs: record.durationMs, inputTokens: record.inputTokens, outputTokens: record.outputTokens,
        reasoningTokens: record.reasoningTokens, responseModel: record.responseModel }; } });
    const rejection = result.ok ? null : upstreamRejection(last);
    const outcome = { ok: result.ok, code: result.ok ? null : result.code, intentKind: result.ok ? result.intent.kind : null, upstream: rejection, ...telemetry ?? {} };
    await audit('ADMIN_COPILOT_PROBE', result.ok ? 'OK' : 'FAILED', result.ok ? null : result.code, { model: settings.model, upstreamParam: rejection?.param ?? null });
    return json(200, { ok: true, probe: outcome });
  }

  const expected = versionOf(body.expectedVersion), reason = reasonOf(body.reason);
  if (expected === null) return json(400, { ok: false, code: 'ADMIN_SETTINGS_VERSION_REQUIRED' });
  if (reason === false) return json(400, { ok: false, code: 'ADMIN_SETTINGS_REASON_INVALID' });
  let active: SettingsVersion | null;
  try { active = await readActiveSettings(db, tenantId, 'copilot'); } catch { return json(503, { ok: false, code: 'ADMIN_STORE_UNAVAILABLE' }); }
  if ((active?.version ?? 0) !== expected) return json(409, { ok: false, code: 'ADMIN_SETTINGS_VERSION_CONFLICT', activeVersion: active?.version ?? 0 });

  let document: CopilotSettingsDocument | null, restoredFrom: number | null = null, kind: string;
  if (body.action === 'save') {
    kind = 'ADMIN_COPILOT_SETTINGS_SAVED';
    try { document = validateSettingsDocument(body.document); }
    catch (error) {
      const refused = settingsError(error);
      await audit(kind, 'REFUSED', refused.code, { field: refused.field });
      return json(400, { ok: false, ...refused });
    }
  } else if (body.action === 'rollback') {
    kind = 'ADMIN_COPILOT_SETTINGS_ROLLED_BACK';
    const target = versionOf(body.toVersion);
    const restored = target === null || target >= expected ? null : await readSettingsVersion(db, tenantId, 'copilot', target).catch(() => null);
    if (!restored) return json(400, { ok: false, code: 'ADMIN_SETTINGS_VERSION_UNKNOWN' });
    restoredFrom = restored.version;
    try { document = restored.document === null ? null : validateSettingsDocument(restored.document); }
    catch (error) {
      const refused = settingsError(error);
      await audit(kind, 'REFUSED', refused.code, { restoredFrom, field: refused.field });
      return json(400, { ok: false, ...refused });
    }
  } else if (body.action === 'reset') {
    kind = 'ADMIN_COPILOT_SETTINGS_RESET';
    document = null;
  } else return json(400, { ok: false, code: 'ADMIN_REQUEST_INVALID' });

  if (active && same(active.document, document)) return json(409, { ok: false, code: 'ADMIN_SETTINGS_UNCHANGED' });
  if (!active && document === null) return json(409, { ok: false, code: 'ADMIN_SETTINGS_UNCHANGED' });
  try {
    const written = await appendSettingsVersion(db, tenantId, { key: 'copilot', expectedVersion: expected, document, restoredFrom, createdBy: actor, reason });
    await audit(kind, 'OK', null, { version: written.version, restoredFrom, model: document?.default.model ?? null,
      overrides: document ? Object.keys(document.overrides).sort().join(',') || null : null });
    return json(200, { ok: true, version: written.version });
  } catch (error) {
    const code = codeOf(error, 'ADMIN_STORE_UNAVAILABLE');
    return json(code === 'ADMIN_SETTINGS_VERSION_CONFLICT' ? 409 : 503, { ok: false, code });
  }
}
