// SPDX-License-Identifier: AGPL-3.0-only
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { YourWorkflows } from './saved-workflows';
import { LocaleProvider } from '../i18n/locale';
import { NavigationDrawer } from './navigation-drawer';
import { SecondaryProductWorkspace } from './secondary-product-workspace';
import { secondaryWorkspaceRoute } from '../domain/secondary-workspaces';
import type { OwnerWorkflow, WorkflowList } from '../domain/saved-workflow';
import { DashboardView } from './dashboard/dashboard-view';
import { projectDashboardRun } from '../lib/dashboard/run-mapping';
import type { DashboardRun } from '../lib/dashboard/types';
const row: OwnerWorkflow = { workflowId: 'canonical-saved-id', name: 'My saved name', saved: true, version: 1, updatedAt: '2026-10-08T12:00:00Z', runCount: 0, lastRunId: null, lastStatus: null, hasEvidence: false };
const render = (list: WorkflowList) => renderToStaticMarkup(<YourWorkflows list={list} busy={false} error={null} open={vi.fn()} refresh={vi.fn()}/>);
describe('Your workflows secondary workspace presentation', () => {
  it('shows a saved workflow by its user name without run details or identifiers', () => {
    const html = render({ items: [row], hasMore: false }); expect(html).toContain('Your workflows'); expect(html).toContain('My saved name');
    for (const value of ['Never executed', 'canonical-saved-id', 'View run', 'Connect Wallet']) expect(html).not.toContain(value);
  });
  // BUILD-FLOFI-CHAT-E2E-DASHBOARD-UX-001: Saved holds only what was saved and never executed (the library's own `saved` and `runCount`);
  // an executed workflow is listed once, as executed (P0 approved UX: in the one list), where it can still be reopened.
  it('keeps a saved workflow that already ran out of Saved, without run details', () => {
    const html = render({ items: [{ ...row, runCount: 3, lastRunId: 'latest-run', lastStatus: 'RECONCILED', hasEvidence: true }], hasMore: false });
    expect(html).toContain('Saved<span class="ux-chip-count">0</span>');
    // It stays reopenable (and can be archived) as an executed workflow of the library, once.
    expect(html).toContain('data-tone="success">Executed</span>'); expect(html.match(/<span>My saved name<\/span>/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Open workflow: My saved name"');
    for (const value of ['RECONCILED', 'latest-run', 'View run', 'Evidence available', '>Saved</span>']) expect(html).not.toContain(value);
  });
  it('keeps an executed-only identity out of Saved without inventing a saved name', () => {
    const html = render({ items: [{ ...row, name: null, saved: false, version: null, runCount: 1, lastRunId: 'historical-run', lastStatus: 'RECONCILED' }], hasMore: false });
    expect(html).toContain('Saved<span class="ux-chip-count">0</span>'); expect(html).not.toContain('historical-run'); expect(html).not.toContain('My saved name');
    expect(html.match(/<span>Workflow<\/span>/g)).toHaveLength(1); expect(html).toContain('data-tone="success">Executed</span>');
  });
  it('renders ONE list: records that need attention first, then saved, then executed, with accurate counts and no per-block paragraphs (board 11)', () => {
    const owner = '0x' + '1'.repeat(40);
    const run: DashboardRun = { runId: 'executed-run', workflowId: 'ran-id', flow: 'base-sepolia-swap', status: 'RECONCILED', ownerAccount: owner, provenance: 'PUBLIC_TESTNET',
      hasEvidence: false, errorCode: null, needsObservation: false, attentionRequired: false, createdAt: null, updatedAt: null };
    const runs = [projectDashboardRun({ ...run, runId: 'attention-run', workflowId: 'other', status: 'UNKNOWN' }), projectDashboardRun(run)];
    const library = { items: [row, { ...row, workflowId: 'ran-id', name: 'Ran once', runCount: 1 }, { ...row, workflowId: 'archived-runs', name: 'Runs not listed', runCount: 2 }], hasMore: false };
    const records = <DashboardView mode="records" account={owner} connection="CONNECTED" runs={runs} hasMore={false} loading={false} build={vi.fn()} openRun={vi.fn()} verify={vi.fn()}
      verifying={false} verificationIssue={null} refresh={vi.fn()} openWorkflow={{ names: new Map([['ran-id', 'Ran once']]), open: vi.fn() }}/>;
    const html = renderToStaticMarkup(<YourWorkflows list={library} records={records} open={vi.fn()} refresh={vi.fn()} changeHistory={vi.fn()} create={vi.fn()}/>);
    expect(html.match(/class="ux-workflow-list"/g)).toHaveLength(1); expect(html.match(/<ul class="ux-panel ux-list ux-workflow-rows"/g)).toHaveLength(1);
    for (const [chip, count] of [['All', 4], ['Needs attention', 1], ['Saved', 1], ['Executed', 2]] as const) expect(html).toContain(`${chip}<span class="ux-chip-count">${count}</span>`);
    expect(html).toContain('aria-pressed="true">All');
    const order = ['/app/dashboard/runs/attention-run', '<span>My saved name</span>', '/app/dashboard/runs/executed-run', '<span>Runs not listed</span>'].map(value => html.indexOf(value));
    expect(order.every(index => index >= 0)).toBe(true); expect([...order].sort((a, b) => a - b)).toEqual(order);
    // A library workflow whose run is listed is reached through that run (named, reopenable, its own Archive in the run's details), never twice.
    expect(html).not.toContain('<span>Ran once</span>'); expect(html).toContain('Open workflow: Ran once'); expect(html).toContain('aria-label="More workflow actions"');
    // One page primary; no explanatory paragraph per block, no disabled control.
    expect(html.match(/ux-button-primary/g)).toHaveLength(1); expect(html).toContain('Create workflow');
    for (const removed of ['Saved and not executed yet', 'Workflows you executed and the results recorded for them.', 'Unresolved, interrupted or incomplete records', 'disabled=""'])
      expect(html).not.toContain(removed);
  });
  it.each([['EN', 'Your workflows'], ['PT', 'Seus fluxos']] as const)('has only a navigation entry in %s and renders the library in its workspace', (language, label) => {
    const html = renderToStaticMarkup(<LocaleProvider initialLanguage={language}><NavigationDrawer pathname="/app/workflows" onBuild={vi.fn()} onDisconnect={vi.fn()} disconnectDisabled/></LocaleProvider>);
    expect(html).toContain('href="/app/workflows"'); expect(html).toContain(`aria-current="page"`); expect(html).toContain(`<span>${label}</span>`);
    for (const value of ['navigation-workflows', 'My saved name', 'Refresh', 'Loading', 'temporarily unavailable', 'No workflows yet']) expect(html).not.toContain(value);
    const workspace = renderToStaticMarkup(<LocaleProvider initialLanguage={language}><SecondaryProductWorkspace workspace="workflows" workflows={{ list: { items: [{ ...row, name: 'Save workflow' }], hasMore: false }, busy: false, error: null, open: vi.fn(), refresh: vi.fn() }}/></LocaleProvider>);
    expect(workspace).toContain(`<h1>${label}</h1>`); expect(workspace).toContain('<span>Save workflow</span>'); expect(workspace).not.toContain('navigation-drawer');
    expect(secondaryWorkspaceRoute('/app/workflows/')?.id).toBe('workflows');
  });
  it('offers a shared refresh control and keeps saved ownership actions in a collapsed menu', () => {
    const html = renderToStaticMarkup(<YourWorkflows list={{ items: [row], hasMore: false }} open={vi.fn()} refresh={vi.fn()} changeHistory={vi.fn()}/>);
    expect(html).toContain('aria-label="Refresh workflows"');
    // Open is the visible row action; Archive (and Delete, with its confirmation) stay in the ··· menu.
    expect(html).toContain('>Open</button>'); expect(html).toContain('aria-label="More workflow actions"');
    expect(html).toMatch(/role="group"[^>]*hidden=""/);
    expect(html).toContain('aria-label="Archive workflow"'); expect(html).toContain('aria-label="Delete workflow"');
    expect(html).toContain('Delete permanently?');
    const unavailable = renderToStaticMarkup(<YourWorkflows list={{ items: [row], hasMore: false }} error="WALLET_SESSION_REQUIRED"/>);
    expect(unavailable).not.toContain('My saved name');
  });
  it('puts loading, retry and empty states in the workspace', () => {
    expect(render({ items: [], hasMore: false })).toContain('Build a workflow and save it from the Canvas; it will appear here.');
    expect(renderToStaticMarkup(<YourWorkflows loading/>)).toContain('Loading your workflows…');
    const error = renderToStaticMarkup(<YourWorkflows error="WORKFLOW_UNAVAILABLE" refresh={vi.fn()}/>);
    expect(error).toContain('Your workflows are temporarily unavailable.'); expect(error).toContain('Retry');
    expect(renderToStaticMarkup(<YourWorkflows connected={false}/>)).toContain('Connect a wallet from the header');
  });
});
