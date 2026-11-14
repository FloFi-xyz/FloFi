// SPDX-License-Identifier: AGPL-3.0-only
import { copilotStatus } from '../../../admin/attention';
import { adminPermits } from '../../../admin/guard';
import { copilotSettingsView } from '../../../admin/copilot-view';
import { adminPage } from '../../../admin/page-context';
import { AdminShell, AdminUnavailable } from '../../../components/admin/admin-shell';
import { AttentionList, Section, Status, TechnicalDetails } from '../../../components/admin/admin-ui';
import { CopilotSettingsEditor, type EditorDocument, type EditorSettings } from '../../../components/admin/copilot-settings-editor';
import { COPILOT_PROVIDER_LABELS, COPILOT_SCOPE_LABELS, COPILOT_SETTINGS_SCHEMA, DEFAULT_EDITOR_SETTINGS } from '../../../server/copilot-settings';

const MODE: Record<string, { label: string; tone: 'ok' | 'info' | 'neutral' | 'bad' }> = { live: { label: 'Live', tone: 'ok' }, replay: { label: 'Replay (recorded answers)', tone: 'info' },
  off: { label: 'Off', tone: 'neutral' }, unavailable: { label: 'Unavailable (no provider connected)', tone: 'bad' } };
const EFFORT: Record<string, string> = { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'extra high', max: 'maximum' };
const params = (s: { provider: string; temperature: number | null; reasoningEffort: string | null; maxOutputTokens: number; timeoutMs: number }) =>
  [s.reasoningEffort ? `effort ${EFFORT[s.reasoningEffort] ?? s.reasoningEffort}` : null, s.provider === 'OPENAI' && s.temperature !== null ? `temperature ${s.temperature}` : null,
    `up to ${s.maxOutputTokens.toLocaleString('en-US')} tokens`, `${s.timeoutMs / 1000} s timeout`].filter(Boolean).join(' · ');

/**
 * BUILD-ADMIN-001: versioned Copilot model settings. Viewers read; operators change them without a rebuild or redeploy.
 * BUILD-ADMIN-AI-PROVIDERS-001: provider connections, per-channel provider and model, live tests, history and rollback in one place.
 */
export default async function AdminAiSettingsPage() {
  const page = await adminPage();
  if (!page.ok) return <AdminUnavailable code={page.code}/>;
  const view = await copilotSettingsView(process.env, page.host, { discover: true }), mode = MODE[view.mode] ?? MODE.off!;
  const status = copilotStatus(view);
  const starting: EditorSettings = view.environment ? { ...view.environment } as EditorSettings : { provider: 'OPENAI', model: '', ...DEFAULT_EDITOR_SETTINGS } as EditorSettings;
  const initial: EditorDocument = view.activeDocument ? JSON.parse(JSON.stringify(view.activeDocument)) as EditorDocument
    : { schema: COPILOT_SETTINGS_SCHEMA, default: starting, overrides: {} };
  const canWrite = adminPermits(page.context, 'write') && view.runtimeEnabled;
  return <AdminShell active="ai-settings" context={page.context} title="AI Settings"
    description="Choose which AI provider and model interpret Copilot requests on each channel, test them, and switch without redeploying. The AI only proposes: FloFi validates every answer and only the wallet owner can approve or sign.">
    <Section id="admin-copilot-status" title="Copilot status" description="Is the Copilot working, and is anything blocking it?">
      <div className="admin-summary-line" style={{ marginBottom: 12 }}>
        <span>Mode: <Status tone={mode.tone}>{mode.label}</Status></span>
        <span>Configuration: <strong>{view.activeCode ? 'invalid — unavailable for safety' : view.activeSource === 'RUNTIME' ? `active configuration v${view.activeVersion}`
          : `default system settings${view.activeVersion ? ` (reset in v${view.activeVersion})` : ''}`}</strong></span>
        <span>Changes apply: <strong>{view.runtimeEnabled ? 'on the next request, no redeploy' : 'only by redeploying (settings are disabled here)'}</strong></span>
      </div>
      <AttentionList items={status.items} allClear={view.mode === 'live' ? 'Every channel has a connected provider and a valid model.' : 'Nothing is blocking the Copilot configuration.'}/>
      {view.storeError ? <p className="admin-alert" data-tone="bad" style={{ marginTop: 12 }}>The settings history could not be read ({view.storeError}).</p> : null}
      {!view.runtimeEnabled ? <p className="admin-alert" data-tone="warn" style={{ marginTop: 12 }}>{view.runtimeDisabledReason === 'BREAK_GLASS'
        ? 'Stored settings are switched off on this deployment (break-glass), so only the default system settings apply.'
        : 'This deployment has no platform-state database, so settings cannot be stored; only the default system settings apply.'}</p> : null}
      <h3 style={{ marginTop: 18 }}>Provider connections</h3>
      <div className="admin-providers">
        {view.providers.map(provider => <div key={provider.id} className="admin-provider">
          <header><strong>{provider.label}</strong>
            <Status tone={provider.keyConfigured ? 'ok' : provider.usedBy.length ? 'bad' : 'neutral'}>{provider.keyConfigured ? 'Connected' : 'Not connected'}</Status></header>
          <span className="admin-hint">{provider.usedBy.length ? `Used by ${provider.usedBy.map(scope => COPILOT_SCOPE_LABELS[scope]).join(', ')}` : 'Not used by any channel'}</span>
          {provider.id === 'ANTHROPIC' ? <span className="admin-hint">{view.anthropicModels?.ok ? `${view.anthropicModels.models.length} models available to this organization`
            : view.anthropicModels ? `Model list unavailable (${view.anthropicModels.code})` : provider.keyConfigured ? '' : 'Install the key to list the organization’s models.'}</span> : null}
          <TechnicalDetails summary="How to connect">
            <p>Set the server-side environment variable <code>{provider.keyEnv}</code> on the web deployment (Vercel), then redeploy once. The key is never shown here,
              never stored in settings and never sent to the browser. After that, switching models or providers needs no redeploy.</p>
            {provider.id === 'ANTHROPIC' ? <p><a href={view.console.keys} target="_blank" rel="noreferrer noopener">API keys</a> ·{' '}
              <a href={view.console.billing} target="_blank" rel="noreferrer noopener">Billing and credits</a> ·{' '}
              <a href={view.console.usage} target="_blank" rel="noreferrer noopener">Usage</a> (Anthropic console)</p> : null}
          </TechnicalDetails>
        </div>)}
      </div>
    </Section>
    <Section id="admin-copilot-effective" title="Active configuration by channel" description="What the next request on each channel uses.">
      <div className="admin-table-wrap"><table className="admin-table">
        <thead><tr><th>Channel</th><th>Provider</th><th>Model</th><th>Settings</th><th>Source</th></tr></thead>
        <tbody>{view.effective.map(row => <tr key={row.scope}>
          <td>{COPILOT_SCOPE_LABELS[row.scope]}</td>
          <td>{row.settings ? <>{COPILOT_PROVIDER_LABELS[row.settings.provider]}{view.providers.find(p => p.id === row.settings!.provider)?.keyConfigured ? null
            : <> <Status tone="bad">not connected</Status></>}</> : '—'}</td>
          <td>{row.settings ? <code>{row.settings.model}</code> : <Status tone="bad">{row.code ? 'Unavailable for safety' : 'Not configured'}</Status>}</td>
          <td>{row.settings ? params(row.settings) : row.code ? <code className="admin-hint">{row.code}</code> : '—'}</td>
          <td>{row.source === 'RUNTIME' ? `Active configuration v${view.activeVersion}` : 'Default system settings'}{view.activeDocument?.overrides[row.scope] ? ' · custom' : ''}</td>
        </tr>)}</tbody>
      </table></div>
      <TechnicalDetails summary="Default system settings (environment)">
        <p>{view.environment ? <><code>{view.environment.model}</code> (OpenAI) · {params(view.environment)}</> : <span className="admin-diff">Not available: <code>{view.environmentCode}</code></span>}</p>
        <p className="admin-diff">From <code>OPENAI_COPILOT_*</code> on the deployment. They apply when no version is active, after a reset, or when stored settings are switched off
          (<code>FLOFI_COPILOT_RUNTIME_CONFIG=disabled</code>). The Copilot mode (<code>FLOFI_COPILOT</code>) and the provider keys are always environment-only.</p>
      </TechnicalDetails>
    </Section>
    {view.storeError ? null : <CopilotSettingsEditor csrf={page.context.csrf} canWrite={canWrite}
      activeVersion={view.activeVersion} initial={initial} starting={starting} families={view.families} liveAvailable={view.mode === 'live'}
      providers={view.providers} discovery={view.anthropicModels}
      history={view.history.map(row => ({ version: row.version, createdAt: row.createdAt, createdBy: row.createdBy, reason: row.reason, restoredFrom: row.restoredFrom,
        valid: row.valid, code: row.code, model: row.model, providers: row.providers, isNull: row.document === null }))}/>}
    <Section id="admin-copilot-catalog" title="Model catalog and prices" description="What FloFi knows about each model family, and the list prices used for cost estimates.">
      <TechnicalDetails summary={`Known model families (${view.families.length})`}>
        <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Provider</th><th>Family</th><th>Temperature</th><th>Reasoning effort</th><th>Status</th></tr></thead>
          <tbody>{view.families.map(family => <tr key={family.id}><td>{COPILOT_PROVIDER_LABELS[family.provider]}</td><td>{family.label}</td>
            <td>{family.temperature ? 'accepted' : 'not sent'}</td><td>{family.reasoning ? family.reasoning.map(e => EFFORT[e] ?? e).join(', ') : 'not accepted'}</td>
            <td>{family.incompatible ? <Status tone="bad">not compatible</Status> : <Status tone="ok">verified</Status>}</td></tr>)}</tbody></table></div>
      </TechnicalDetails>
      <TechnicalDetails summary={`List prices used for estimates (checked ${view.pricesChecked})`}>
        <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Model</th><th className="num">Input / 1M tokens</th><th className="num">Output / 1M tokens</th></tr></thead>
          <tbody>{view.prices.map(price => <tr key={price.pattern}><td>{price.label}</td><td className="num">${price.inputPerMTok.toFixed(2)}</td><td className="num">${price.outputPerMTok.toFixed(2)}</td></tr>)}</tbody></table></div>
        <p className="admin-diff">Estimates only: credits, discounts and billing are in the <a href={view.console.billing} target="_blank" rel="noreferrer noopener">provider console</a>.
          No OpenAI price is listed in this build.</p>
      </TechnicalDetails>
    </Section>
  </AdminShell>;
}
