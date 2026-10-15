// SPDX-License-Identifier: AGPL-3.0-only
import { adminPermits } from '../../../admin/guard';
import { copilotSettingsView } from '../../../admin/copilot-view';
import { adminPage } from '../../../admin/page-context';
import { AdminShell, AdminUnavailable } from '../../../components/admin/admin-shell';
import { CopilotSettingsEditor, type EditorDocument, type EditorSettings } from '../../../components/admin/copilot-settings-editor';
import { COPILOT_SCOPE_LABELS, COPILOT_SETTINGS_SCHEMA, DEFAULT_EDITOR_SETTINGS } from '../../../server/copilot-settings';

const MODE: Record<string, { label: string; tone: string }> = { live: { label: 'Live', tone: 'ok' }, replay: { label: 'Replay (recorded answers)', tone: 'info' },
  off: { label: 'Off', tone: '' }, unavailable: { label: 'Unavailable (misconfigured)', tone: 'bad' } };
const fmt = (s: { temperature: number | null; reasoningEffort: string | null; maxOutputTokens: number; timeoutMs: number }) =>
  `temperature ${s.temperature === null ? 'not sent' : s.temperature} · reasoning ${s.reasoningEffort ?? 'not sent'} · ${s.maxOutputTokens.toLocaleString('en-US')} tokens · ${s.timeoutMs / 1000} s`;

/** BUILD-ADMIN-001: versioned Copilot model settings. Viewers read; operators change them without a rebuild or redeploy. */
export default async function AdminAiSettingsPage() {
  const page = await adminPage();
  if (!page.ok) return <AdminUnavailable code={page.code}/>;
  const view = await copilotSettingsView(process.env, page.host), mode = MODE[view.mode] ?? MODE.off!;
  const starting: EditorSettings = view.environment ? { ...view.environment } as EditorSettings : { model: '', ...DEFAULT_EDITOR_SETTINGS } as EditorSettings;
  const initial: EditorDocument = view.activeDocument ? JSON.parse(JSON.stringify(view.activeDocument)) as EditorDocument
    : { schema: COPILOT_SETTINGS_SCHEMA, default: starting, overrides: {} };
  return <AdminShell active="ai-settings" context={page.context} title="AI Settings"
    description="Which model interprets Copilot requests, and how. The model stays an untrusted interpreter: strict schema validation and deterministic grounding are unchanged.">
    <section className="admin-card" aria-labelledby="admin-copilot-status">
      <header><h2 id="admin-copilot-status">Copilot status</h2></header>
      <div className="admin-table-wrap"><table className="admin-table"><tbody>
        <tr><th scope="row">Mode (FLOFI_COPILOT, environment)</th><td><span className="admin-badge" data-tone={mode.tone}>{mode.label}</span></td></tr>
        <tr><th scope="row">Provider API key (environment)</th><td>{view.apiKeyConfigured ? 'Configured (never shown)' : 'Not configured'}</td></tr>
        <tr><th scope="row">Runtime settings</th><td>{view.runtimeEnabled ? 'Applied from the database on every request'
          : view.runtimeDisabledReason === 'BREAK_GLASS' ? 'Disabled by FLOFI_COPILOT_RUNTIME_CONFIG=disabled (environment bootstrap only)'
          : 'Unavailable: this deployment has no platform-state database'}</td></tr>
        <tr><th scope="row">Active source</th><td>{view.activeCode ? <span className="admin-badge" data-tone="bad">Stored version is invalid ({view.activeCode}): live requests fail closed</span>
          : view.activeSource === 'RUNTIME' ? `Runtime version v${view.activeVersion}` : `Environment bootstrap${view.activeVersion ? ` (reset in v${view.activeVersion})` : ''}`}</td></tr>
        <tr><th scope="row">Environment bootstrap</th><td>{view.environment ? <><code>{view.environment.model}</code> · {fmt(view.environment)}</>
          : <span className="admin-diff">{view.environmentCode}</span>}</td></tr>
      </tbody></table></div>
      {view.storeError ? <p className="admin-alert" data-tone="bad">The settings history could not be read ({view.storeError}).</p> : null}
    </section>
    <section className="admin-card" aria-labelledby="admin-copilot-effective">
      <header><h2 id="admin-copilot-effective">Effective settings by channel</h2><p>What the next request on each channel uses</p></header>
      <div className="admin-table-wrap"><table className="admin-table">
        <thead><tr><th>Channel</th><th>Source</th><th>Model</th><th>Parameters</th></tr></thead>
        <tbody>{view.effective.map(row => <tr key={row.scope}>
          <td>{COPILOT_SCOPE_LABELS[row.scope]}</td>
          <td>{row.source === 'RUNTIME' ? `Runtime v${view.activeVersion}` : 'Environment'}{view.activeDocument?.overrides[row.scope] ? ' · override' : ''}</td>
          <td>{row.settings ? <code>{row.settings.model}</code> : <span className="admin-badge" data-tone="bad">{row.code ?? 'Not configured'}</span>}</td>
          <td>{row.settings ? fmt(row.settings) : '—'}</td>
        </tr>)}</tbody>
      </table></div>
    </section>
    {view.storeError ? null : <CopilotSettingsEditor csrf={page.context.csrf} canWrite={adminPermits(page.context, 'write') && view.runtimeEnabled}
      activeVersion={view.activeVersion} initial={initial} starting={starting} families={view.families} liveAvailable={view.mode === 'live'}
      history={view.history.map(row => ({ version: row.version, createdAt: row.createdAt, createdBy: row.createdBy, reason: row.reason, restoredFrom: row.restoredFrom,
        valid: row.valid, code: row.code, model: row.model, isNull: row.document === null }))}/>}
  </AdminShell>;
}
