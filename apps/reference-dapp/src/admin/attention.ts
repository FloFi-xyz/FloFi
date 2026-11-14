// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ADMIN-AI-PROVIDERS-001 (Admin UX): "Is everything operating normally, and what requires my attention?" — derived only from what the
 * console already measures (the health report and the Copilot settings view). Nothing is inferred beyond those probes: an unreadable probe
 * is reported as unknown, never as healthy. Each item links to the page where it is handled.
 */
import type { AttentionItem, Tone } from '../components/admin/admin-ui';
import type { CopilotSettingsView } from './copilot-view.ts';
import type { HealthReport } from './health.ts';

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

export function healthAttention(report: HealthReport): AttentionItem[] {
  const items: AttentionItem[] = [], health = '/admin/health';
  const { database, api, queue, runs, scheduler } = report;
  if (!database.ok) items.push({ key: 'db', tone: 'bad', title: 'The database cannot be read', detail: `Check ${database.code}`, href: health, action: 'View health' });
  else if (database.value.appliedMigrations !== database.value.shippedMigrations)
    items.push({ key: 'schema', tone: 'bad', title: 'The database schema does not match this build',
      detail: `${database.value.appliedMigrations} of ${database.value.shippedMigrations} migrations applied`, href: health, action: 'View health' });
  if (api.readiness && !api.readiness.ok) items.push({ key: 'api', tone: 'bad', title: 'The Railway API is not ready', detail: api.readiness.code, href: health, action: 'View health' });
  if (!queue.ok) items.push({ key: 'queue', tone: 'warn', title: 'The work queue could not be checked', detail: queue.code, href: health, action: 'View health' });
  else {
    if (queue.value.dead24h) items.push({ key: 'dead', tone: 'warn', title: `${plural(queue.value.dead24h, 'work item')} stopped in the last 24 hours`,
      detail: 'They exhausted their observation budget and were not resubmitted.', href: health, action: 'See incidents' });
    if (queue.value.overdue) items.push({ key: 'overdue', tone: 'warn', title: `${plural(queue.value.overdue, 'work item')} waiting longer than 5 minutes`,
      detail: 'The worker may be stopped or overloaded.', href: health, action: 'View queue' });
    if (queue.value.expiredLeases) items.push({ key: 'leases', tone: 'warn', title: `${plural(queue.value.expiredLeases, 'expired lease')} in the work queue`, href: health, action: 'View queue' });
  }
  if (!runs.ok) items.push({ key: 'runs', tone: 'warn', title: 'Executions under observation could not be checked', detail: runs.code, href: health, action: 'View health' });
  else if (runs.value.attention) items.push({ key: 'attention', tone: 'warn', title: `${plural(runs.value.attention, 'execution')} flagged for attention`,
    detail: 'Uncertain or flagged by the worker; review them before anything else.', href: '/admin/workflows', action: 'Review executions' });
  if (!scheduler.ok) items.push({ key: 'scheduler', tone: 'warn', title: 'The automation scheduler could not be checked', detail: scheduler.code, href: health, action: 'View health' });
  else if (scheduler.value.installed && scheduler.value.overdueRules) items.push({ key: 'rules', tone: 'warn',
    title: `${plural(scheduler.value.overdueRules, 'active automation rule')} not evaluated on time`, detail: 'No scheduler is evaluating them (the worker needs FLOFI_AUTOMATIONS=enabled).',
    href: '/admin/automations', action: 'Open Automations' });
  return items;
}

/** The Copilot's own state in one line, plus anything an operator must act on. */
export function copilotStatus(view: CopilotSettingsView): { readonly tone: Tone; readonly value: string; readonly detail: string; readonly items: AttentionItem[] } {
  const items: AttentionItem[] = [], href = '/admin/ai-settings';
  const used = [...new Set(view.effective.flatMap(row => row.settings ? [row.settings.provider] : []))];
  const missing = view.providers.filter(provider => provider.usedBy.length && !provider.keyConfigured);
  if (view.mode === 'live') {
    if (view.activeCode) items.push({ key: 'copilot-invalid', tone: 'bad', title: 'The active AI configuration is invalid', detail: 'The Copilot is unavailable for safety until an operator saves or restores a valid version.', href, action: 'Fix AI Settings' });
    for (const provider of missing) items.push({ key: `copilot-key-${provider.id}`, tone: 'bad', title: `${provider.label} is selected but not connected`,
      detail: `${provider.usedBy.length} channel(s) use ${provider.label}, but ${provider.keyEnv} is not installed on this deployment; those channels are unavailable for safety.`, href, action: 'Open AI Settings' });
    if (view.effective.some(row => !row.settings)) items.push({ key: 'copilot-unconfigured', tone: 'warn', title: 'Some channels have no AI model configured', href, action: 'Open AI Settings' });
  } else if (view.mode === 'unavailable') items.push({ key: 'copilot-unavailable', tone: 'bad', title: 'The Copilot is set to live but no AI provider is connected', href, action: 'Open AI Settings' });
  if (view.storeError) items.push({ key: 'copilot-store', tone: 'warn', title: 'AI settings history could not be read', href, action: 'Open AI Settings' });
  const tone: Tone = items.some(item => item.tone === 'bad') ? 'bad' : items.length ? 'warn' : view.mode === 'live' ? 'ok' : 'neutral';
  const value = view.mode === 'live' ? used.length ? `Live · ${used.map(p => p === 'ANTHROPIC' ? 'Anthropic' : 'OpenAI').join(' + ')}` : 'Live'
    : view.mode === 'replay' ? 'Replay (recorded answers)' : view.mode === 'off' ? 'Off' : 'Unavailable';
  const detail = view.activeSource === 'RUNTIME' ? `Active configuration v${view.activeVersion}` : 'Default system settings';
  return { tone, value, detail, items };
}

export function healthStatus(report: HealthReport): { readonly tone: Tone; readonly value: string; readonly detail: string } {
  const items = healthAttention(report);
  if (items.some(item => item.tone === 'bad')) return { tone: 'bad', value: 'Action needed', detail: `${plural(items.length, 'issue')} found` };
  if (items.length) return { tone: 'warn', value: 'Needs a look', detail: `${plural(items.length, 'item')} to review` };
  return { tone: 'ok', value: 'Operating normally', detail: 'Database, queue and scheduler checks passed' };
}
