// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-ADMIN-001: the AI Settings editor. Edits a whole settings document (default + per-channel overrides), shows the model capability
 * hints the server will enforce, and calls the CSRF-protected settings API (save, probe, reset, rollback). The server re-validates
 * everything; this component never sees an API key and cannot change the Copilot's mode, instructions or output schema.
 *
 * BUILD-ADMIN-AI-PROVIDERS-001: provider-aware. Each settings set picks OpenAI or Anthropic, then a model of that provider (Anthropic's from
 * the organization's own model list, with friendly names and exact ids), then only the parameters that model accepts. Incompatible or
 * unverified choices are explained before saving; saving shows exactly which channels change; destructive actions ask for confirmation.
 */
import { useMemo, useState } from 'react';
import { adminPost } from './admin-client';

type Provider = 'OPENAI' | 'ANTHROPIC';
type Effort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type EditorSettings = { provider: Provider; model: string; temperature: number | null; reasoningEffort: Effort | null; maxOutputTokens: number; timeoutMs: number;
  acknowledgedUnverified: boolean };
type Scope = 'WEB' | 'TELEGRAM' | 'WHATSAPP';
export type EditorDocument = { schema: string; default: EditorSettings; overrides: Partial<Record<Scope, EditorSettings>> };
export type EditorFamily = { id: string; provider: Provider; label: string; pattern: string; temperature: boolean; reasoning: readonly string[] | null; incompatible: string | null };
export type EditorProvider = { id: Provider; label: string; keyEnv: string; keyConfigured: boolean; efforts: readonly string[]; usedBy: readonly Scope[] };
export type EditorModel = { id: string; displayName: string; createdAt: string | null; maxInputTokens: number | null; maxOutputTokens: number | null;
  structuredOutputs: boolean | null; efforts: readonly string[] | null };
export type EditorDiscovery = { ok: true; models: readonly EditorModel[]; fetchedAt: string } | { ok: false; code: string; fetchedAt: string } | null;
export type EditorHistory = { version: number; createdAt: string; createdBy: string; reason: string | null; restoredFrom: number | null; valid: boolean; code: string | null;
  model: string | null; providers: readonly Provider[]; isNull: boolean };
type Probe = { ok: boolean; code: string | null; intentKind: string | null; durationMs?: number; inputTokens?: number | null; outputTokens?: number | null;
  reasoningTokens?: number | null; responseModel?: string | null; provider?: Provider; model?: string; estimatedCostUsd?: number | null;
  upstream: { code: string | null; param: string | null; status?: number } | null };

const SCOPES: readonly { id: Scope; label: string }[] = [{ id: 'WEB', label: 'FloFi chat (web)' }, { id: 'TELEGRAM', label: 'Telegram' }, { id: 'WHATSAPP', label: 'WhatsApp' }];
const PROVIDER_LABEL: Record<Provider, string> = { OPENAI: 'OpenAI', ANTHROPIC: 'Anthropic' };
const OPENAI_SUGGESTED = ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'o4-mini', 'o3', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini'];
/** Shown when the organization's model list cannot be read; availability is then unconfirmed. */
const ANTHROPIC_CATALOG: readonly { id: string; name: string }[] = [{ id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' }, { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' }, { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' }, { id: 'claude-opus-5', name: 'Claude Opus 5' },
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8' }, { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' }, { id: 'claude-fable-5-2', name: 'Claude Fable 5.2' }];
const EFFORT_LABEL: Record<string, string> = { minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Maximum' };
const CUSTOM = '__custom__';
const MESSAGES: Record<string, string> = {
  ADMIN_SETTINGS_VERSION_CONFLICT: 'Another administrator changed the settings first. Reload to see the latest version.',
  ADMIN_SETTINGS_UNCHANGED: 'Nothing changed compared with the active version.',
  COPILOT_SETTINGS_MODEL_UNVERIFIED: 'This model is not in FloFi’s capability catalog. Confirm the unverified model (and preferably test it) to save it.',
  COPILOT_SETTINGS_MODEL_INCOMPATIBLE: 'This model does not support the strict structured output FloFi requires. Choose another model.',
  COPILOT_SETTINGS_PROVIDER_MISMATCH: 'This model belongs to the other provider. Choose a model of the selected provider.',
  COPILOT_SETTINGS_PROVIDER_INVALID: 'Choose OpenAI or Anthropic.',
  COPILOT_SETTINGS_TEMPERATURE_UNSUPPORTED: 'This model does not accept a temperature. Turn “Send temperature” off.',
  COPILOT_SETTINGS_REASONING_UNSUPPORTED: 'This model does not accept that reasoning effort.',
  COPILOT_SETTINGS_OUT_OF_RANGE: 'A value is outside its allowed range.',
  COPILOT_SETTINGS_MODEL_INVALID: 'Enter a model identifier (letters, digits, . _ : -).',
  COPILOT_PROVIDER_NOT_CONFIGURED: 'That provider is not connected on this deployment (its API key is not installed), so it cannot be tested or activated.',
  COPILOT_NOT_LIVE: 'The Copilot is not in live mode on this deployment, so no live test can run.',
  ADMIN_PROBE_RATE_LIMITED: 'At most 10 tests (or model list refreshes) run per 10 minutes. Try again later.',
  ADMIN_ROLE_INSUFFICIENT: 'Your role is read-only.',
  ADMIN_CSRF_INVALID: 'Your session token is stale. Reload the page.',
  ADMIN_SESSION_REQUIRED: 'Your admin session ended. Sign in again.',
};
/** What a failed test means, in plain words; the exact code stays in the technical details. */
const PROBE_FAILURES: Record<string, string> = {
  COPILOT_UPSTREAM_UNAUTHORIZED: 'The provider rejected this deployment’s API key. Check the key in the provider console.',
  COPILOT_UPSTREAM_BILLING: 'The provider refused the request for billing reasons (for example, no remaining credit). Check the provider’s billing page.',
  COPILOT_UPSTREAM_MODEL_UNAVAILABLE: 'This model is not available to the connected organization.',
  COPILOT_UPSTREAM_REJECTED: 'The provider rejected a setting of this request.',
  COPILOT_UPSTREAM_RATE_LIMITED: 'The provider is rate limiting requests. Try again shortly.',
  COPILOT_UPSTREAM_UNAVAILABLE: 'The provider is unavailable right now.',
  COPILOT_TIMEOUT: 'The model did not answer within the request timeout.',
  COPILOT_REFUSED: 'The model declined to interpret the test request.',
  COPILOT_RESPONSE_INCOMPLETE: 'The answer was cut off. Raise the maximum output tokens or lower the reasoning effort.',
  COPILOT_INTENT_INVALID: 'The model answered, but its answer failed FloFi’s validation, so it would be discarded in production.',
  COPILOT_RESPONSE_INVALID: 'The model’s answer could not be read as FloFi’s structured format.',
};
const describe = (code: string, field?: string | null) => `${MESSAGES[code] ?? `Refused (${code}).`}${field ? ` Field: ${field}.` : ''}`;
const familyOf = (families: readonly EditorFamily[], provider: Provider, model: string) =>
  families.find(family => family.provider === provider && new RegExp(family.pattern).test(model.trim())) ?? null;
const usd = (value: number) => value < 0.0001 ? '< $0.0001' : `$${value.toFixed(4)}`;

type Issue = { tone: 'bad' | 'warn'; text: string };
/** The same rules the server enforces, explained before anything is sent. */
function issuesOf(settings: EditorSettings, families: readonly EditorFamily[], providers: readonly EditorProvider[], models: readonly EditorModel[]): Issue[] {
  const issues: Issue[] = [], model = settings.model.trim(), family = familyOf(families, settings.provider, model);
  const provider = providers.find(entry => entry.id === settings.provider);
  if (provider && !provider.keyConfigured) issues.push({ tone: 'bad', text: `${provider.label} is not connected on this deployment (${provider.keyEnv} is not installed). It cannot be tested, and a live Copilot refuses to activate it.` });
  if (!model) { issues.push({ tone: 'bad', text: 'Choose a model.' }); return issues; }
  if ((settings.provider === 'ANTHROPIC') !== /^claude-/.test(model)) issues.push({ tone: 'bad', text: MESSAGES.COPILOT_SETTINGS_PROVIDER_MISMATCH! });
  if (family?.incompatible) issues.push({ tone: 'bad', text: family.incompatible });
  const discovered = models.find(entry => entry.id === model);
  if (settings.provider === 'ANTHROPIC' && discovered?.structuredOutputs === false) issues.push({ tone: 'bad', text: 'The provider reports that this model does not support structured outputs.' });
  if (!family && !settings.acknowledgedUnverified) issues.push({ tone: 'warn', text: 'This model is not verified by FloFi. Confirm it below (and test it) before saving.' });
  if (settings.temperature !== null && (settings.provider === 'ANTHROPIC' || (family && !family.temperature))) issues.push({ tone: 'bad', text: MESSAGES.COPILOT_SETTINGS_TEMPERATURE_UNSUPPORTED! });
  return issues;
}
function effortsOf(settings: EditorSettings, families: readonly EditorFamily[], providers: readonly EditorProvider[], models: readonly EditorModel[]): readonly string[] {
  const family = familyOf(families, settings.provider, settings.model), discovered = models.find(entry => entry.id === settings.model.trim());
  const base = family ? family.reasoning ?? [] : providers.find(entry => entry.id === settings.provider)?.efforts ?? [];
  return discovered?.efforts ? base.filter(effort => discovered.efforts!.includes(effort)) : base;
}
const summary = (settings: EditorSettings | undefined) => settings ? `${PROVIDER_LABEL[settings.provider]} · ${settings.model.trim() || 'no model'}` : '—';

function SettingsFields({ value, onChange, families, providers, models, disabled, idPrefix, starting }: { value: EditorSettings; onChange: (next: EditorSettings) => void;
  families: readonly EditorFamily[]; providers: readonly EditorProvider[]; models: readonly EditorModel[]; disabled: boolean; idPrefix: string; starting: EditorSettings }) {
  const family = familyOf(families, value.provider, value.model);
  const set = <K extends keyof EditorSettings>(key: K, next: EditorSettings[K]) => onChange({ ...value, [key]: next });
  const efforts = effortsOf(value, families, providers, models), issues = issuesOf(value, families, providers, models);
  const anthropicChoices = models.length ? models.map(model => ({ id: model.id, name: model.displayName })) : ANTHROPIC_CATALOG;
  const inList = anthropicChoices.some(choice => choice.id === value.model.trim());
  const [custom, setCustom] = useState(value.provider === 'ANTHROPIC' && value.model.trim() !== '' && !inList);
  function switchProvider(provider: Provider) {
    if (provider === value.provider) return;
    setCustom(false);
    const preferred = provider === 'ANTHROPIC' ? (anthropicChoices.find(choice => choice.id === 'claude-sonnet-5-5') ?? anthropicChoices.find(choice =>
      familyOf(families, 'ANTHROPIC', choice.id)?.incompatible === null))?.id ?? '' : starting.provider === 'OPENAI' ? starting.model : '';
    onChange({ ...value, provider, model: preferred, temperature: null, reasoningEffort: null, acknowledgedUnverified: false });
  }
  return <div className="admin-form">
    <fieldset className="admin-field" style={{ border: 0, padding: 0, margin: 0 }} disabled={disabled}>
      <legend style={{ marginBottom: 6 }}>Provider</legend>
      <div className="admin-segmented" role="radiogroup" aria-label="Provider">
        {providers.map(provider => <label key={provider.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', cursor: 'pointer',
          background: value.provider === provider.id ? 'var(--a-blue-soft)' : undefined, color: value.provider === provider.id ? 'var(--a-blue)' : undefined, fontWeight: value.provider === provider.id ? 600 : 400 }}>
          <input type="radio" name={`${idPrefix}-provider`} value={provider.id} checked={value.provider === provider.id} onChange={() => switchProvider(provider.id)}/>
          {provider.label}<span className="admin-hint">{provider.keyConfigured ? '· connected' : '· not connected'}</span>
        </label>)}
      </div>
    </fieldset>
    <div className="admin-form-row">
      {value.provider === 'ANTHROPIC' ? <label className="admin-field" htmlFor={`${idPrefix}-model`}>Model
        <select id={`${idPrefix}-model`} value={custom ? CUSTOM : inList ? value.model.trim() : ''} disabled={disabled}
          onChange={event => { if (event.target.value === CUSTOM) { setCustom(true); set('model', ''); } else { setCustom(false); onChange({ ...value, model: event.target.value, reasoningEffort: null, acknowledgedUnverified: false }); } }}>
          <option value="" disabled>Choose a model…</option>
          {anthropicChoices.map(choice => { const known = familyOf(families, 'ANTHROPIC', choice.id);
            return <option key={choice.id} value={choice.id} disabled={Boolean(known?.incompatible)}>
              {choice.name}{choice.name !== choice.id ? ` — ${choice.id}` : ''}{known?.incompatible ? ' (not compatible)' : known ? '' : ' (not verified by FloFi)'}</option>; })}
          <option value={CUSTOM}>Other model ID…</option>
        </select>
        <span className="admin-hint">{models.length ? 'Models available to the connected Anthropic organization.' : 'From FloFi’s catalog; availability to your organization is not confirmed.'}</span>
      </label> : <label className="admin-field" htmlFor={`${idPrefix}-model`}>Model
        <input id={`${idPrefix}-model`} type="text" list="admin-copilot-models" value={value.model} disabled={disabled} autoComplete="off" spellCheck={false}
          onChange={event => set('model', event.target.value)}/>
        <span className="admin-hint">The exact OpenAI model ID.</span>
      </label>}
      {value.provider === 'ANTHROPIC' && custom ? <label className="admin-field" htmlFor={`${idPrefix}-custom`}>Custom model ID
        <input id={`${idPrefix}-custom`} type="text" value={value.model} disabled={disabled} autoComplete="off" spellCheck={false} placeholder="claude-…"
          onChange={event => set('model', event.target.value)}/>
        <span className="admin-hint">Use only an exact Anthropic model ID you have confirmed.</span>
      </label> : null}
      <label className="admin-field" htmlFor={`${idPrefix}-effort`}>Reasoning effort
        <select id={`${idPrefix}-effort`} value={value.reasoningEffort ?? ''} disabled={disabled || efforts.length === 0}
          onChange={event => set('reasoningEffort', event.target.value === '' ? null : event.target.value as Effort)}>
          <option value="">{value.provider === 'ANTHROPIC' ? 'Model default' : 'Not sent'}</option>
          {efforts.map(effort => <option key={effort} value={effort}>{EFFORT_LABEL[effort] ?? effort}</option>)}
        </select>
        <span className="admin-hint">{efforts.length ? 'Higher effort: more careful, slower and more tokens.' : 'This model does not accept a reasoning effort.'}</span>
      </label>
      {value.provider === 'OPENAI' ? <label className="admin-field" htmlFor={`${idPrefix}-send-temperature`}>
        <span><input id={`${idPrefix}-send-temperature`} type="checkbox" checked={value.temperature !== null}
          disabled={disabled || (family !== null && !family.temperature && value.temperature === null)} onChange={event => set('temperature', event.target.checked ? 0 : null)}/> Send temperature</span>
        <input type="number" aria-label="Temperature (0–1)" min={0} max={1} step={0.01} value={value.temperature ?? ''} disabled={disabled || value.temperature === null}
          onChange={event => set('temperature', Number(event.target.value))}/>
      </label> : null}
    </div>
    <div className="admin-summary-line" aria-label="Compatibility">
      {family && !family.incompatible ? <span>Compatibility: <strong>verified — {family.label}</strong></span>
        : family ? <span>Compatibility: <strong>not compatible</strong></span> : value.model.trim() ? <span>Compatibility: <strong>not verified by FloFi</strong></span> : null}
      {value.provider === 'ANTHROPIC' ? <span>Temperature is not used with Anthropic models.</span> : null}
    </div>
    {issues.length ? <ul className="admin-attention" aria-label="Before you save">{issues.map(issue => <li key={issue.text} data-tone={issue.tone}>
      <span className="admin-attention-glyph" aria-hidden="true">{issue.tone === 'bad' ? '✕' : '!'}</span><div><span style={{ color: 'inherit' }}>{issue.text}</span></div></li>)}</ul> : null}
    {!family && value.model.trim() ? <label className="admin-field" htmlFor={`${idPrefix}-ack`}>
      <span><input id={`${idPrefix}-ack`} type="checkbox" checked={value.acknowledgedUnverified} disabled={disabled}
        onChange={event => set('acknowledgedUnverified', event.target.checked)}/> I accept this unverified model</span>
      <span className="admin-hint">{value.provider === 'ANTHROPIC' ? 'It must support strict JSON-schema structured outputs in the Messages API.'
        : 'It must support strict JSON-schema output in the Responses API.'} Its parameters are sent exactly as configured.</span>
    </label> : null}
    <details className="admin-details">
      <summary>Advanced: output limit and timeout</summary>
      <div className="admin-details-body"><div className="admin-form-row">
        <label className="admin-field" htmlFor={`${idPrefix}-tokens`}>Max output tokens (256–16,384)
          <input id={`${idPrefix}-tokens`} type="number" min={256} max={16384} step={1} value={value.maxOutputTokens} disabled={disabled}
            onChange={event => set('maxOutputTokens', Number(event.target.value))}/>
          <span className="admin-hint">Includes the model’s reasoning tokens.</span>
        </label>
        <label className="admin-field" htmlFor={`${idPrefix}-timeout`}>Request timeout, ms (5,000–60,000)
          <input id={`${idPrefix}-timeout`} type="number" min={5000} max={60000} step={500} value={value.timeoutMs} disabled={disabled}
            onChange={event => set('timeoutMs', Number(event.target.value))}/>
        </label>
      </div></div>
    </details>
  </div>;
}

function ProbeResult({ probe }: { probe: Probe }) {
  const tokens = probe.inputTokens != null ? `${probe.inputTokens.toLocaleString('en-US')} in / ${(probe.outputTokens ?? 0).toLocaleString('en-US')} out` : '—';
  return <div className="admin-result" data-tone={probe.ok ? 'ok' : 'bad'} role="status" aria-label="Live test result">
    <strong>{probe.ok ? `Works: ${probe.provider ? PROVIDER_LABEL[probe.provider] : 'the provider'} answered and FloFi validated the result (${probe.intentKind ?? 'intent'}).`
      : `Did not pass: ${PROBE_FAILURES[probe.code ?? ''] ?? 'the test failed.'}`}</strong>
    <dl className="admin-dl">
      <dt>Response time</dt><dd>{typeof probe.durationMs === 'number' ? `${probe.durationMs.toLocaleString('en-US')} ms` : '—'}</dd>
      <dt>Tokens</dt><dd>{tokens}{probe.reasoningTokens ? ` (${probe.reasoningTokens} reasoning)` : ''}</dd>
      <dt>Estimated cost</dt><dd>{probe.estimatedCostUsd != null ? `${usd(probe.estimatedCostUsd)} (list price; not billing data)` : 'no listed price'}</dd>
    </dl>
    <p className="admin-diff">The test interprets one fixed, harmless request (“Swap 1 USDC to WETH…”). No workflow is changed and nothing is signed, submitted or executed.</p>
    <details className="admin-details"><summary>Technical details</summary><div className="admin-details-body">
      <dl className="admin-dl">
        <dt>Provider / model</dt><dd>{probe.provider ?? '—'} · <code>{probe.model ?? '—'}</code></dd>
        <dt>Served by</dt><dd>{probe.responseModel ? <code>{probe.responseModel}</code> : '—'}</dd>
        <dt>Result code</dt><dd>{probe.code ? <code>{probe.code}</code> : 'OK'}</dd>
        {probe.upstream ? <><dt>Provider error</dt><dd>{probe.upstream.status ? `HTTP ${probe.upstream.status} · ` : ''}{probe.upstream.code ? <code>{probe.upstream.code}</code> : 'unspecified'}
          {probe.upstream.param ? <> · parameter <code>{probe.upstream.param}</code></> : null}</dd></> : null}
      </dl>
    </div></details>
  </div>;
}

export function CopilotSettingsEditor({ csrf, canWrite, activeVersion, initial, families, history, liveAvailable, starting, providers, discovery }: { csrf: string; canWrite: boolean;
  activeVersion: number; initial: EditorDocument; families: readonly EditorFamily[]; history: readonly EditorHistory[]; liveAvailable: boolean; starting: EditorSettings;
  providers: readonly EditorProvider[]; discovery: EditorDiscovery }) {
  const [document, setDocument] = useState<EditorDocument>(initial);
  const [reason, setReason] = useState(''), [busy, setBusy] = useState(false), [models, setModels] = useState<EditorDiscovery>(discovery);
  const [message, setMessage] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null), [probe, setProbe] = useState<Probe | null>(null);
  const [confirming, setConfirming] = useState<null | { kind: 'reset' } | { kind: 'rollback'; version: number }>(null);
  const changed = useMemo(() => JSON.stringify(document) !== JSON.stringify(initial), [document, initial]);
  const disabled = !canWrite || busy, list = models?.ok ? models.models : [];
  const normalized = (settings: EditorSettings): EditorSettings => {
    const known = familyOf(families, settings.provider, settings.model) !== null;
    return { ...settings, model: settings.model.trim(), acknowledgedUnverified: known ? false : settings.acknowledgedUnverified };
  };
  const payloadDocument = (): EditorDocument => ({ schema: document.schema, default: normalized(document.default),
    overrides: Object.fromEntries(Object.entries(document.overrides).filter(([, value]) => value).map(([scope, value]) => [scope, normalized(value!)])) });
  const blocking = [document.default, ...Object.values(document.overrides).filter((value): value is EditorSettings => Boolean(value))]
    .some(settings => issuesOf(settings, families, providers, list).some(issue => issue.tone === 'bad' && !/not connected/.test(issue.text)));
  // What saving changes, channel by channel (an override replaces the default as a whole).
  const changes = SCOPES.flatMap(scope => { const before = summary(initial.overrides[scope.id] ?? initial.default), after = summary(document.overrides[scope.id] ?? document.default);
    return before === after ? [] : [`${scope.label}: ${before} → ${after}`]; });
  async function send(body: Record<string, unknown>, success: string) {
    setBusy(true); setMessage(null);
    const result = await adminPost<{ version?: number; probe?: Probe; discovery?: EditorDiscovery }>('/admin/api/settings/copilot', body, csrf);
    if (!result.ok) {
      setMessage({ tone: 'bad', text: describe(result.code, (result as unknown as { field?: string | null }).field) }); setBusy(false); return null;
    }
    setMessage({ tone: 'ok', text: success.replace('{version}', String(result.version ?? '')) });
    setBusy(false);
    return result;
  }
  async function save() {
    const result = await send({ action: 'save', expectedVersion: activeVersion, document: payloadDocument(), reason }, 'Saved and activated as version {version}. It applies to the next Copilot request on every instance.');
    if (result) window.location.reload();
  }
  async function reset() {
    setConfirming(null);
    const result = await send({ action: 'reset', expectedVersion: activeVersion, reason }, 'Version {version}: back to the default system settings.');
    if (result) window.location.reload();
  }
  async function rollback(version: number) {
    setConfirming(null);
    const result = await send({ action: 'rollback', expectedVersion: activeVersion, toVersion: version, reason }, `Version {version} restores version ${version}.`);
    if (result) window.location.reload();
  }
  async function test(settings: EditorSettings) {
    setProbe(null);
    const result = await send({ action: 'probe', settings: normalized(settings) }, 'Test finished.');
    if (result?.probe) setProbe(result.probe);
  }
  async function refreshModels() {
    const result = await send({ action: 'models', provider: 'ANTHROPIC' }, 'Model list refreshed.');
    if (result?.discovery) setModels(result.discovery);
  }
  const testable = (settings: EditorSettings) => liveAvailable && providers.find(provider => provider.id === settings.provider)?.keyConfigured === true && settings.model.trim() !== '';
  const testTitle = (settings: EditorSettings) => !liveAvailable ? 'The Copilot is not live on this deployment'
    : providers.find(provider => provider.id === settings.provider)?.keyConfigured ? 'One real request to the provider with FloFi’s strict format' : 'This provider is not connected';
  const anthropic = providers.find(provider => provider.id === 'ANTHROPIC');
  return <div className="admin-form">
    <datalist id="admin-copilot-models">{OPENAI_SUGGESTED.map(model => <option key={model} value={model}/>)}</datalist>
    <ol className="admin-steps" aria-label="How to change the AI configuration"><li>Choose provider and model</li><li>Test connection and model</li><li>Save and activate</li></ol>
    <section className="admin-card" aria-labelledby="admin-default-heading">
      <header><div><h2 id="admin-default-heading">Default settings</h2><p>Used by every channel without custom settings.</p></div>
        {anthropic?.keyConfigured && canWrite ? <div className="admin-actions"><button type="button" className="admin-button" data-size="sm" disabled={busy} onClick={() => void refreshModels()}>
          Refresh Anthropic models</button></div> : null}</header>
      {models && !models.ok ? <p className="admin-alert" data-tone="warn" style={{ marginBottom: 12 }}>Anthropic’s model list could not be read ({models.code}); FloFi’s catalog is shown instead.</p> : null}
      <SettingsFields value={document.default} families={families} providers={providers} models={list} disabled={disabled} idPrefix="default" starting={starting}
        onChange={next => setDocument(current => ({ ...current, default: next }))}/>
      <div className="admin-actions" style={{ marginTop: 12 }}>
        <button type="button" className="admin-button" disabled={disabled || !testable(document.default)} onClick={() => void test(document.default)}
          title={testTitle(document.default)}>Test connection and model</button>
      </div>
    </section>
    <section className="admin-card" aria-labelledby="admin-overrides-heading">
      <header><div><h2 id="admin-overrides-heading">Custom settings by channel</h2><p>A channel with custom settings uses them instead of the default, as a whole — for example a different provider for WhatsApp.</p></div></header>
      <div className="admin-form">
        {SCOPES.map(scope => { const value = document.overrides[scope.id];
          return <div key={scope.id} className="admin-scope">
            <header><h3>{scope.label}</h3><span className="admin-hint">{value ? `Custom: ${summary(value)}` : `Uses the default: ${summary(document.default)}`}</span></header>
            <label><input type="checkbox" checked={Boolean(value)} disabled={disabled}
              onChange={event => setDocument(current => { const overrides = { ...current.overrides };
                if (event.target.checked) overrides[scope.id] = { ...current.default }; else delete overrides[scope.id];
                return { ...current, overrides }; })}/> Custom settings for {scope.label}</label>
            {value ? <SettingsFields value={value} families={families} providers={providers} models={list} disabled={disabled} idPrefix={`override-${scope.id}`} starting={starting}
              onChange={next => setDocument(current => ({ ...current, overrides: { ...current.overrides, [scope.id]: next } }))}/> : null}
            {value ? <div className="admin-actions"><button type="button" className="admin-button" disabled={disabled || !testable(value)} title={testTitle(value)}
              onClick={() => void test(value)}>Test {scope.label} settings</button></div> : null}
          </div>; })}
      </div>
    </section>
    {probe ? <ProbeResult probe={probe}/> : null}
    <section className="admin-card" aria-labelledby="admin-apply-heading">
      <header><div><h2 id="admin-apply-heading">Save and activate</h2>
        <p>Active version: {activeVersion ? `v${activeVersion}` : 'none (default system settings)'}. Saving applies to the next request on every channel — no redeploy.</p></div></header>
      {changed ? changes.length ? <div className="admin-note" role="note"><strong>Saving will change:</strong><ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{changes.map(change => <li key={change}>{change}</li>)}</ul></div>
        : <p className="admin-note" role="note">Saving changes parameters only; every channel keeps its provider and model.</p> : null}
      {changed && [document.default, ...Object.values(document.overrides)].some(settings => settings?.provider === 'ANTHROPIC')
        ? <p className="admin-diff" style={{ marginTop: 8 }}>Note: a version that uses Anthropic is not readable by builds released before Anthropic support. If such an older build is
          rolled back to or still serving during a deploy, its Copilot is unavailable on every channel (it never misreads the settings) until an OpenAI-only version is restored.</p> : null}
      <label className="admin-field" htmlFor="admin-settings-reason" style={{ marginTop: 12 }}>Reason (optional, stored in the version history)
        <input id="admin-settings-reason" type="text" maxLength={200} value={reason} disabled={disabled} onChange={event => setReason(event.target.value)}/>
      </label>
      <div className="admin-actions" style={{ marginTop: 12 }}>
        <button type="button" className="admin-button" data-variant="primary" disabled={disabled || !changed || blocking} onClick={() => void save()}
          title={blocking ? 'Resolve the problems shown above first' : undefined}>Save and activate version {activeVersion + 1}</button>
        <button type="button" className="admin-button" disabled={disabled || !changed} onClick={() => { setDocument(initial); setMessage(null); }}>Discard changes</button>
        {confirming?.kind === 'reset' ? <>
          <button type="button" className="admin-button" data-variant="danger" disabled={disabled} onClick={() => void reset()}>Confirm: use default system settings</button>
          <button type="button" className="admin-button" disabled={busy} onClick={() => setConfirming(null)}>Cancel</button>
        </> : <button type="button" className="admin-button" data-variant="danger" disabled={disabled || activeVersion === 0} onClick={() => setConfirming({ kind: 'reset' })}>
          Return to default system settings</button>}
        {!canWrite ? <span className="admin-diff">Read-only: your role cannot change settings.</span> : null}
      </div>
      {confirming?.kind === 'reset' ? <p className="admin-alert" data-tone="warn" style={{ marginTop: 12 }}>{starting.model && providers.find(p => p.id === 'OPENAI')?.keyConfigured
        ? <>Every channel will use the deployment’s default system settings (OpenAI <code>{starting.model}</code>, from <code>OPENAI_COPILOT_*</code>) on its next request.
          Channels on Anthropic switch to OpenAI.</>
        : <>This deployment has no usable default system settings (OpenAI model or key missing): after the reset every channel is unavailable until settings are saved again.</>}</p> : null}
      {message ? <p className="admin-alert" data-tone={message.tone} role={message.tone === 'bad' ? 'alert' : 'status'} style={{ marginTop: 12 }}>{message.text}</p> : null}
      <p className="admin-diff" style={{ marginTop: 8 }}>New settings start from {starting.model ? <code>{starting.model}</code> : 'the defaults'} when none are active.</p>
    </section>
    <section className="admin-card" aria-labelledby="admin-history-heading">
      <header><div><h2 id="admin-history-heading">Version history</h2><p>Append-only. Restoring a version adds a new version; nothing is overwritten.</p></div></header>
      {confirming?.kind === 'rollback' ? <div className="admin-alert" data-tone="warn" role="alert" style={{ marginBottom: 12 }}>
        Restore version {confirming.version}? It becomes the new active version on every channel’s next request.{' '}
        <button type="button" className="admin-button" data-size="sm" data-variant="primary" disabled={disabled} onClick={() => void rollback(confirming.version)}>Confirm restore</button>{' '}
        <button type="button" className="admin-button" data-size="sm" disabled={busy} onClick={() => setConfirming(null)}>Cancel</button>
      </div> : null}
      {history.length === 0 ? <p className="admin-empty">No saved version yet: the default system settings apply.</p>
        : <div className="admin-table-wrap"><table className="admin-table">
          <thead><tr><th>Version</th><th>When (UTC)</th><th>By</th><th>Providers</th><th>Default model</th><th>Reason</th><th>Validity</th><th></th></tr></thead>
          <tbody>{history.map(row => <tr key={row.version}>
            <td>v{row.version}{row.version === activeVersion ? <> <span className="admin-badge" data-tone="info">active</span></> : null}
              {row.restoredFrom ? <span className="admin-diff"> ← v{row.restoredFrom}</span> : null}</td>
            <td className="admin-mono">{row.createdAt.replace('T', ' ').slice(0, 16)}</td><td><code>{row.createdBy}</code></td>
            <td>{row.isNull ? '—' : row.providers.map(provider => PROVIDER_LABEL[provider]).join(', ') || '—'}</td>
            <td>{row.isNull ? <em>default system settings</em> : row.model ? <code>{row.model}</code> : '—'}</td><td>{row.reason ?? '—'}</td>
            <td>{row.valid ? <span className="admin-badge" data-tone="ok">✓ valid</span> : <span className="admin-badge" data-tone="bad" title={row.code ?? ''}>✕ invalid today</span>}</td>
            <td>{row.version !== activeVersion ? <button type="button" className="admin-button" data-size="sm" disabled={disabled || !row.valid}
              onClick={() => setConfirming({ kind: 'rollback', version: row.version })}>Restore</button> : null}</td>
          </tr>)}</tbody>
        </table></div>}
    </section>
  </div>;
}
