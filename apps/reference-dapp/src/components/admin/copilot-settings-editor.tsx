// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-ADMIN-001: the AI Settings editor. Edits a whole settings document (default + per-channel overrides), shows the model capability
 * hints the server will enforce, and calls the CSRF-protected settings API (save, probe, reset, rollback). The server re-validates
 * everything; this component never sees the API key and cannot change the Copilot's mode, instructions or output schema.
 */
import { useMemo, useState } from 'react';
import { adminPost } from './admin-client';

type Effort = 'minimal' | 'low' | 'medium' | 'high';
export type EditorSettings = { model: string; temperature: number | null; reasoningEffort: Effort | null; maxOutputTokens: number; timeoutMs: number;
  acknowledgedUnverified: boolean };
type Scope = 'WEB' | 'TELEGRAM' | 'WHATSAPP';
export type EditorDocument = { schema: string; default: EditorSettings; overrides: Partial<Record<Scope, EditorSettings>> };
type Family = { id: string; label: string; pattern: string; temperature: boolean; reasoning: readonly string[] | null };
type History = { version: number; createdAt: string; createdBy: string; reason: string | null; restoredFrom: number | null; valid: boolean; code: string | null;
  model: string | null; isNull: boolean };
type Probe = { ok: boolean; code: string | null; intentKind: string | null; durationMs?: number; inputTokens?: number | null; outputTokens?: number | null;
  reasoningTokens?: number | null; responseModel?: string | null; upstream: { code: string | null; param: string | null } | null };

const SCOPES: readonly { id: Scope; label: string }[] = [{ id: 'WEB', label: 'FloFi chat (web)' }, { id: 'TELEGRAM', label: 'Telegram' }, { id: 'WHATSAPP', label: 'WhatsApp' }];
const SUGGESTED = ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'o4-mini', 'o3', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini'];
const MESSAGES: Record<string, string> = {
  ADMIN_SETTINGS_VERSION_CONFLICT: 'Another administrator changed the settings first. Reload to see the latest version.',
  ADMIN_SETTINGS_UNCHANGED: 'Nothing changed compared with the active version.',
  COPILOT_SETTINGS_MODEL_UNVERIFIED: 'This model is not in FloFi’s capability catalog. Confirm the unverified model (and preferably run a live test) to save it.',
  COPILOT_SETTINGS_TEMPERATURE_UNSUPPORTED: 'This model family does not accept a temperature. Turn “Send temperature” off.',
  COPILOT_SETTINGS_REASONING_UNSUPPORTED: 'This model family does not accept that reasoning effort.',
  COPILOT_SETTINGS_OUT_OF_RANGE: 'A value is outside its allowed range.',
  COPILOT_SETTINGS_MODEL_INVALID: 'Enter a model identifier (letters, digits, . _ : -).',
  COPILOT_NOT_LIVE: 'The Copilot is not in live mode with an API key on this deployment, so no live test can run.',
  ADMIN_PROBE_RATE_LIMITED: 'At most 10 live tests run per 10 minutes. Try again later.',
  ADMIN_ROLE_INSUFFICIENT: 'Your role is read-only.',
  ADMIN_CSRF_INVALID: 'Your session token is stale. Reload the page.',
  ADMIN_SESSION_REQUIRED: 'Your admin session ended. Sign in again.',
};
const describe = (code: string, field?: string | null) => `${MESSAGES[code] ?? `Refused (${code}).`}${field ? ` Field: ${field}.` : ''}`;

function familyOf(families: readonly Family[], model: string): Family | null {
  return families.find(family => new RegExp(family.pattern).test(model.trim())) ?? null;
}

function SettingsFields({ value, onChange, families, disabled, idPrefix }: { value: EditorSettings; onChange: (next: EditorSettings) => void; families: readonly Family[];
  disabled: boolean; idPrefix: string }) {
  const family = familyOf(families, value.model);
  const set = <K extends keyof EditorSettings>(key: K, next: EditorSettings[K]) => onChange({ ...value, [key]: next });
  const temperatureBlocked = family !== null && !family.temperature, efforts = family ? family.reasoning : ['minimal', 'low', 'medium', 'high'];
  return <div className="admin-form">
    <div className="admin-form-row">
      <label className="admin-field" htmlFor={`${idPrefix}-model`}>Model
        <input id={`${idPrefix}-model`} type="text" list="admin-copilot-models" value={value.model} disabled={disabled} autoComplete="off" spellCheck={false}
          onChange={event => set('model', event.target.value)}/>
      </label>
      <label className="admin-field" htmlFor={`${idPrefix}-effort`}>Reasoning effort
        <select id={`${idPrefix}-effort`} value={value.reasoningEffort ?? ''} disabled={disabled || efforts === null}
          onChange={event => set('reasoningEffort', event.target.value === '' ? null : event.target.value as Effort)}>
          <option value="">Not sent</option>
          {(efforts ?? []).map(effort => <option key={effort} value={effort}>{effort}</option>)}
        </select>
      </label>
      <label className="admin-field" htmlFor={`${idPrefix}-tokens`}>Max output tokens (256–16,384)
        <input id={`${idPrefix}-tokens`} type="number" min={256} max={16384} step={1} value={value.maxOutputTokens} disabled={disabled}
          onChange={event => set('maxOutputTokens', Number(event.target.value))}/>
      </label>
      <label className="admin-field" htmlFor={`${idPrefix}-timeout`}>Request timeout, ms (5,000–60,000)
        <input id={`${idPrefix}-timeout`} type="number" min={5000} max={60000} step={500} value={value.timeoutMs} disabled={disabled}
          onChange={event => set('timeoutMs', Number(event.target.value))}/>
      </label>
    </div>
    <div className="admin-form-row">
      <label className="admin-field" htmlFor={`${idPrefix}-send-temperature`}>
        <span><input id={`${idPrefix}-send-temperature`} type="checkbox" checked={value.temperature !== null} disabled={disabled || (temperatureBlocked && value.temperature === null)}
          onChange={event => set('temperature', event.target.checked ? 0 : null)}/> Send temperature</span>
        <input type="number" aria-label="Temperature (0–1)" min={0} max={1} step={0.01} value={value.temperature ?? ''} disabled={disabled || value.temperature === null}
          onChange={event => set('temperature', Number(event.target.value))}/>
      </label>
      <div className="admin-field">Capability
        {family ? <span className="admin-badge" data-tone="ok">Known: {family.label}</span> : value.model.trim()
          ? <span className="admin-badge" data-tone="warn">Unverified model</span> : <span className="admin-badge">No model</span>}
        <span className="admin-diff">{family ? `Temperature ${family.temperature ? 'accepted' : 'not accepted (must be off)'} · reasoning ${family.reasoning ? family.reasoning.join('/') : 'not accepted'}`
          : 'Parameters are sent exactly as configured; FloFi does not adjust them.'}</span>
      </div>
      {!family && value.model.trim() ? <label className="admin-field" htmlFor={`${idPrefix}-ack`}>
        <span><input id={`${idPrefix}-ack`} type="checkbox" checked={value.acknowledgedUnverified} disabled={disabled}
          onChange={event => set('acknowledgedUnverified', event.target.checked)}/> I accept this unverified model</span>
        <span className="admin-diff">It must support strict JSON-schema output in the Responses API.</span>
      </label> : null}
    </div>
  </div>;
}

export function CopilotSettingsEditor({ csrf, canWrite, activeVersion, initial, families, history, liveAvailable, starting }: { csrf: string; canWrite: boolean;
  activeVersion: number; initial: EditorDocument; families: readonly Family[]; history: readonly History[]; liveAvailable: boolean; starting: EditorSettings }) {
  const [document, setDocument] = useState<EditorDocument>(initial);
  const [reason, setReason] = useState(''), [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null), [probe, setProbe] = useState<Probe | null>(null);
  const changed = useMemo(() => JSON.stringify(document) !== JSON.stringify(initial), [document, initial]);
  const disabled = !canWrite || busy;
  const normalized = (settings: EditorSettings): EditorSettings => {
    const known = familyOf(families, settings.model) !== null;
    return { ...settings, model: settings.model.trim(), acknowledgedUnverified: known ? false : settings.acknowledgedUnverified };
  };
  const payloadDocument = (): EditorDocument => ({ schema: document.schema, default: normalized(document.default),
    overrides: Object.fromEntries(Object.entries(document.overrides).filter(([, value]) => value).map(([scope, value]) => [scope, normalized(value!)])) });
  async function send(body: Record<string, unknown>, success: string) {
    setBusy(true); setMessage(null);
    const result = await adminPost<{ version?: number; probe?: Probe }>('/admin/api/settings/copilot', body, csrf);
    if (!result.ok) {
      setMessage({ tone: 'bad', text: describe(result.code, (result as unknown as { field?: string | null }).field) }); setBusy(false); return null;
    }
    setMessage({ tone: 'ok', text: success.replace('{version}', String(result.version ?? '')) });
    setBusy(false);
    return result;
  }
  async function save() {
    const result = await send({ action: 'save', expectedVersion: activeVersion, document: payloadDocument(), reason }, 'Saved as version {version}. It applies to the next Copilot request on every instance.');
    if (result) window.location.reload();
  }
  async function reset() {
    const result = await send({ action: 'reset', expectedVersion: activeVersion, reason }, 'Version {version}: back to the environment bootstrap.');
    if (result) window.location.reload();
  }
  async function rollback(version: number) {
    const result = await send({ action: 'rollback', expectedVersion: activeVersion, toVersion: version, reason }, `Version {version} restores version ${version}.`);
    if (result) window.location.reload();
  }
  async function test(settings: EditorSettings) {
    setProbe(null);
    const result = await send({ action: 'probe', settings: normalized(settings) }, 'Live test finished.');
    if (result?.probe) setProbe(result.probe);
  }
  return <div className="admin-form">
    <datalist id="admin-copilot-models">{SUGGESTED.map(model => <option key={model} value={model}/>)}</datalist>
    <section className="admin-card" aria-labelledby="admin-default-heading">
      <header><h2 id="admin-default-heading">Default settings</h2><p>Used by every channel without its own settings.</p></header>
      <SettingsFields value={document.default} families={families} disabled={disabled} idPrefix="default"
        onChange={next => setDocument(current => ({ ...current, default: next }))}/>
      <div className="admin-actions" style={{ marginTop: 12 }}>
        <button type="button" className="admin-button" disabled={disabled || !liveAvailable} onClick={() => void test(document.default)}
          title={liveAvailable ? 'One live request with the strict FloFi schema' : 'The Copilot is not live on this deployment'}>Test default with a live request</button>
      </div>
    </section>
    <section className="admin-card" aria-labelledby="admin-overrides-heading">
      <header><h2 id="admin-overrides-heading">Per-channel overrides</h2><p>An override replaces the default as a whole for that channel.</p></header>
      <div className="admin-form">
        {SCOPES.map(scope => { const value = document.overrides[scope.id];
          return <div key={scope.id} className="admin-form">
            <label><input type="checkbox" checked={Boolean(value)} disabled={disabled}
              onChange={event => setDocument(current => { const overrides = { ...current.overrides };
                if (event.target.checked) overrides[scope.id] = { ...current.default }; else delete overrides[scope.id];
                return { ...current, overrides }; })}/> Custom settings for {scope.label}</label>
            {value ? <SettingsFields value={value} families={families} disabled={disabled} idPrefix={`override-${scope.id}`}
              onChange={next => setDocument(current => ({ ...current, overrides: { ...current.overrides, [scope.id]: next } }))}/> : null}
            {value ? <div className="admin-actions"><button type="button" className="admin-button" disabled={disabled || !liveAvailable}
              onClick={() => void test(value)}>Test {scope.label} settings</button></div> : null}
          </div>; })}
      </div>
    </section>
    <section className="admin-card" aria-labelledby="admin-apply-heading">
      <header><h2 id="admin-apply-heading">Apply</h2><p>Active version: {activeVersion || 'none (environment bootstrap)'}</p></header>
      <label className="admin-field" htmlFor="admin-settings-reason">Reason (optional, stored in the version history)
        <input id="admin-settings-reason" type="text" maxLength={200} value={reason} disabled={disabled} onChange={event => setReason(event.target.value)}/>
      </label>
      <div className="admin-actions" style={{ marginTop: 12 }}>
        <button type="button" className="admin-button" data-variant="primary" disabled={disabled || !changed} onClick={() => void save()}>Save as version {activeVersion + 1}</button>
        <button type="button" className="admin-button" disabled={disabled || !changed} onClick={() => { setDocument(initial); setMessage(null); }}>Discard changes</button>
        <button type="button" className="admin-button" data-variant="danger" disabled={disabled || activeVersion === 0} onClick={() => void reset()}>Return to environment bootstrap</button>
        {!canWrite ? <span className="admin-diff">Read-only: your role is VIEWER.</span> : null}
      </div>
      {message ? <p className="admin-alert" data-tone={message.tone} role={message.tone === 'bad' ? 'alert' : 'status'} style={{ marginTop: 12 }}>{message.text}</p> : null}
      {probe ? <div className="admin-note" style={{ marginTop: 12 }} role="status" aria-label="Live test result">
        <strong>{probe.ok ? `Accepted: the model returned a valid ${probe.intentKind ?? ''} intent.` : `Failed: ${probe.code}`}</strong>
        {probe.upstream?.param || probe.upstream?.code ? <p>Provider rejected {probe.upstream.param ? <code>{probe.upstream.param}</code> : 'the request'}
          {probe.upstream.code ? <> (<code>{probe.upstream.code}</code>)</> : null}.</p> : null}
        <p className="admin-diff">{typeof probe.durationMs === 'number' ? `${probe.durationMs} ms` : ''}{probe.inputTokens != null ? ` · ${probe.inputTokens} in / ${probe.outputTokens ?? '—'} out` : ''}
          {probe.reasoningTokens ? ` (${probe.reasoningTokens} reasoning)` : ''}{probe.responseModel ? ` · served by ${probe.responseModel}` : ''}</p>
      </div> : null}
      <p className="admin-diff" style={{ marginTop: 8 }}>New settings start from {starting.model ? <code>{starting.model}</code> : 'the defaults'} when none are active.</p>
    </section>
    <section className="admin-card" aria-labelledby="admin-history-heading">
      <header><h2 id="admin-history-heading">Version history</h2><p>Append-only. A rollback appends a new version.</p></header>
      {history.length === 0 ? <p className="admin-empty">No runtime version yet: the environment bootstrap applies.</p>
        : <div className="admin-table-wrap"><table className="admin-table">
          <thead><tr><th>Version</th><th>When (UTC)</th><th>By</th><th>Default model</th><th>Reason</th><th>Validity</th><th></th></tr></thead>
          <tbody>{history.map(row => <tr key={row.version}>
            <td>v{row.version}{row.version === activeVersion ? <> <span className="admin-badge" data-tone="info">active</span></> : null}
              {row.restoredFrom ? <span className="admin-diff"> ← v{row.restoredFrom}</span> : null}</td>
            <td className="admin-mono">{row.createdAt.replace('T', ' ').slice(0, 16)}</td><td><code>{row.createdBy}</code></td>
            <td>{row.isNull ? <em>environment bootstrap</em> : row.model ? <code>{row.model}</code> : '—'}</td><td>{row.reason ?? '—'}</td>
            <td>{row.valid ? <span className="admin-badge" data-tone="ok">valid</span> : <span className="admin-badge" data-tone="bad" title={row.code ?? ''}>invalid today</span>}</td>
            <td>{row.version !== activeVersion ? <button type="button" className="admin-button" disabled={disabled || !row.valid}
              onClick={() => void rollback(row.version)}>Restore</button> : null}</td>
          </tr>)}</tbody>
        </table></div>}
    </section>
  </div>;
}
