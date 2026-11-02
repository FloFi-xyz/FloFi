// SPDX-License-Identifier: AGPL-3.0-only
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { YourWorkflows } from './saved-workflows';
import { LocaleProvider } from '../i18n/locale';
import { NavigationDrawer } from './navigation-drawer';
import { SecondaryProductWorkspace } from './secondary-product-workspace';
import { secondaryWorkspaceRoute } from '../domain/secondary-workspaces';
import type { OwnerWorkflow, WorkflowList } from '../domain/saved-workflow';
const row: OwnerWorkflow = { workflowId: 'canonical-saved-id', name: 'My saved name', saved: true, version: 1, updatedAt: '2026-10-08T12:00:00Z', runCount: 0, lastRunId: null, lastStatus: null, hasEvidence: false };
const render = (list: WorkflowList) => renderToStaticMarkup(<YourWorkflows list={list} busy={false} error={null} open={vi.fn()} refresh={vi.fn()}/>);
describe('Your workflows secondary workspace presentation', () => {
  it('shows a saved workflow by its user name without run details or identifiers', () => {
    const html = render({ items: [row], hasMore: false }); expect(html).toContain('Your workflows'); expect(html).toContain('My saved name');
    for (const value of ['Never executed', 'canonical-saved-id', 'View run', 'Connect Wallet']) expect(html).not.toContain(value);
  });
  // BUILD-FLOFI-CHAT-E2E-DASHBOARD-UX-001: Saved workflows hold only what was saved and never executed (the library's own `saved` and `runCount`);
  // an executed workflow is listed once, with its execution records (the `records` section), where it can still be reopened.
  it('keeps a saved workflow that already ran out of Saved workflows, without run details', () => {
    const html = render({ items: [{ ...row, runCount: 3, lastRunId: 'latest-run', lastStatus: 'RECONCILED', hasEvidence: true }], hasMore: false });
    const savedSection = html.slice(html.indexOf('workflows-saved'), html.indexOf('</details>'));
    expect(savedSection).not.toContain('My saved name'); expect(html).toContain('Workflows you executed are listed with their records below.');
    // It stays reopenable (and can be archived) from the executed workflows of the library, once.
    expect(html).toContain('Executed workflows in your library'); expect(html.match(/My saved name/g)).toHaveLength(1);
    for (const value of ['RECONCILED', 'latest-run', 'View run', 'Evidence available']) expect(html).not.toContain(value);
  });
  it('keeps an executed-only identity out of Saved workflows without inventing a saved name', () => {
    const html = render({ items: [{ ...row, name: null, saved: false, version: null, runCount: 1, lastRunId: 'historical-run', lastStatus: 'RECONCILED' }], hasMore: false });
    const savedSection = html.slice(html.indexOf('workflows-saved'), html.indexOf('</details>'));
    expect(savedSection).not.toContain('<span>Workflow</span>'); expect(html).not.toContain('historical-run'); expect(html).not.toContain('My saved name');
    expect(html).toContain('<span>Workflow</span>');
  });
  it('orders the hub: saved workflows (an open, expandable area) first, then the execution records', () => {
    const html = renderToStaticMarkup(<YourWorkflows list={{ items: [row], hasMore: false }} records={<div>execution records</div>} open={vi.fn()} refresh={vi.fn()}/>);
    expect(html).toContain('<details class="panel workflows-section workflows-saved" open="">'); expect(html).toContain('<h2>Saved workflows</h2>');
    expect(html.indexOf('My saved name')).toBeLessThan(html.indexOf('execution records'));
    expect(html).toContain('aria-label="1 saved workflow"');
  });
  it.each([['EN', 'Your workflows'], ['PT', 'Seus workflows']] as const)('has only a navigation entry in %s and renders the library in its workspace', (language, label) => {
    const html = renderToStaticMarkup(<LocaleProvider initialLanguage={language}><NavigationDrawer pathname="/app/workflows" onBuild={vi.fn()} onDisconnect={vi.fn()} disconnectDisabled/></LocaleProvider>);
    expect(html).toContain('href="/app/workflows"'); expect(html).toContain(`aria-current="page"`); expect(html).toContain(`<span>${label}</span>`);
    for (const value of ['navigation-workflows', 'My saved name', 'Refresh', 'Loading', 'temporarily unavailable', 'No workflows yet']) expect(html).not.toContain(value);
    const workspace = renderToStaticMarkup(<LocaleProvider initialLanguage={language}><SecondaryProductWorkspace workspace="workflows" workflows={{ list: { items: [{ ...row, name: 'Save workflow' }], hasMore: false }, busy: false, error: null, open: vi.fn(), refresh: vi.fn() }}/></LocaleProvider>);
    expect(workspace).toContain(`<h1>${label}</h1>`); expect(workspace).toContain('<span>Save workflow</span>'); expect(workspace).not.toContain('navigation-drawer');
    expect(secondaryWorkspaceRoute('/app/workflows/')?.id).toBe('workflows');
  });
  it('puts loading, retry and empty states in the workspace', () => {
    expect(render({ items: [], hasMore: false })).toContain('Build a workflow and save it from the Canvas; it will appear here.');
    expect(renderToStaticMarkup(<YourWorkflows loading/>)).toContain('Loading your workflows…');
    const error = renderToStaticMarkup(<YourWorkflows error="WORKFLOW_UNAVAILABLE" refresh={vi.fn()}/>);
    expect(error).toContain('Your workflows are temporarily unavailable.'); expect(error).toContain('Retry');
    expect(renderToStaticMarkup(<YourWorkflows connected={false}/>)).toContain('Connect a wallet from the header');
  });
});
