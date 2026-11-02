// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DashboardView } from './dashboard-view';
import { RunDetailView } from './run-detail-view';
import { projectDashboardRun } from '../../lib/dashboard/run-mapping';
import { dashboardRoute } from '../../lib/dashboard/routes';
import type { DashboardRun, DashboardStatus } from '../../lib/dashboard/types';
import { projectDashboardRecord } from '../../lib/dashboard/record-projection';
import { reviewFixture } from '../../test-utils/review-fixture';

const noop = () => undefined;
const owner = '0x' + '1'.repeat(40);
const row: DashboardRun = { runId: 'real-owned-id', workflowId: 'workflow-id', flow: 'aave-supply', status: 'RECONCILED', ownerAccount: owner,
  provenance: 'PUBLIC_TESTNET', hasEvidence: true, errorCode: null, needsObservation: false, attentionRequired: false, createdAt: null, updatedAt: null };
function index(props: Partial<Parameters<typeof DashboardView>[0]> = {}) {
  return renderToStaticMarkup(<DashboardView account={owner} connection="CONNECTED" runs={[]} hasMore={false} loading={false} build={noop} openRun={noop} verify={noop} verifying={false} verificationIssue={null} refresh={noop} {...props}/>);
}
/** BUILD-FLOFI-CHAT-E2E-DASHBOARD-UX-001: the execution history (executed records and records that need attention) now renders in Your workflows. */
const records = (props: Partial<Parameters<typeof DashboardView>[0]> = {}) => index({ mode: 'records', ...props });
describe('Dashboard foundation inside the canonical shell', () => {
  it('contains no duplicate header, wallet connection, environment selector or theme controller', () => {
    const html = index();
    expect(html).not.toContain('<header'); expect(html).not.toContain('Wallet connection'); expect(html).not.toContain('<select');
    expect(html).not.toContain('Settings'); expect(html).not.toContain('Light Theme');
  });
  it('shows a connected empty state with a Build action and no invented portfolio, prices or history', () => {
    const html = records();
    expect(html).toContain('No workflows executed yet'); expect(html).toContain('Build workflow');
    expect(html).not.toContain('real-owned-id'); expect(html).not.toMatch(/\$|APY|PnL|0 ETH|0 USDC/);
    const overview = index();
    expect(overview).toContain('Workflow records'); expect(overview).toContain('Build workflow'); expect(overview).not.toMatch(/\$|APY|PnL|0 ETH|0 USDC/);
  });
  it('keeps the Dashboard an overview: portfolio slot, current execution and a records summary, never the history list', () => {
    const html = index({ runs: [projectDashboardRun(row)], portfolio: <section aria-label="Wallet portfolio">portfolio slot</section>, openRecords: noop });
    expect(html).toContain('portfolio slot'); expect(html).toContain('Open Your workflows');
    expect(html).toContain('<strong>0</strong> records need attention'); expect(html).toContain('<strong>1</strong> executed record');
    expect(html).not.toContain(`/app/dashboard/runs/${row.runId}`); expect(html).not.toContain('dashboard-run-list');
    expect(html.indexOf('portfolio slot')).toBeLessThan(html.indexOf('aria-labelledby="dashboard-records"'));
  });
  it('shows disconnected truth instead of run data', () => {
    const html = index({ account: null, runs: [projectDashboardRun(row)] });
    expect(html).toContain('Connect your wallet to view your execution history'); expect(html).not.toContain(row.runId);
  });
  it('does not present an unavailable source as a verified empty account', () => {
    for (const connection of ['UNAVAILABLE', 'NOT_CONFIGURED', 'SIGN_IN_REQUIRED'] as const) {
      const html = records({ connection }); expect(html).not.toContain('No workflows executed yet');
      expect(index({ connection })).not.toContain('executed record');
    }
  });
  it('shows a loading announcement without invented runs or a verified empty state', () => {
    const html = records({ connection: null, loading: true });
    expect(html).toContain('Loading execution history'); expect(html).toContain('Checking available records');
    expect(html).not.toContain('No workflows executed yet'); expect(html).not.toContain('No available runs need attention');
    expect(html).not.toContain('dashboard-run-card');
  });
  it('separates the current execution from saved history without displaying it twice', () => {
    const current = projectDashboardRun({ ...row, runId: 'current-owned-run', status: 'UNKNOWN' }, null, 'Current workflow', true);
    const overview = index({ runs: [current, projectDashboardRun(row)] });
    expect(overview).toContain('Current execution'); expect(overview).toContain('View current run');
    expect(overview.match(/href="\/app\/dashboard\/runs\/current-owned-run"/g)).toHaveLength(1);
    expect(overview).toContain('<strong>1</strong> record needs attention'); expect(overview).not.toContain(`/app/dashboard/runs/${row.runId}`);
    // In Your workflows each run is in exactly one section: the unresolved current run needs attention, the completed one is history.
    const html = records({ runs: [current, projectDashboardRun(row)] });
    expect(html.match(/href="\/app\/dashboard\/runs\/current-owned-run"/g)).toHaveLength(1);
    expect(html.match(new RegExp(`href="/app/dashboard/runs/${row.runId}"`, 'g'))).toHaveLength(1);
    expect(html).toContain('Execution status unresolved'); expect(html).toContain('1 available run needs attention');
    expect(html).not.toContain('No workflows executed yet');
  });
  it('keeps a current run visible while saved history is unavailable', () => {
    const current = projectDashboardRun({ ...row, status: 'UNKNOWN' }, null, 'Current workflow', true);
    for (const connection of ['UNAVAILABLE', 'NOT_CONFIGURED', 'SIGN_IN_REQUIRED'] as const) {
      const html = index({ connection, runs: [current] });
      expect(html).toContain('Current execution'); expect(html).toContain('Unresolved');
      expect(html).not.toContain('No workflows executed yet'); expect(html).not.toContain('executed record');
      expect(records({ connection, runs: [current] })).toContain('Executed workflows will appear here when their records are available.');
    }
    expect(records({ runs: [current] })).toContain('Records that need attention are listed below.');
  });
  it('orders Your workflows as the owner specified (executed history, then records that need attention) and keeps the current execution first on the Dashboard', () => {
    const current = projectDashboardRun({ ...row, runId: 'current-owned-run', status: 'UNKNOWN' }, null, 'Current workflow', true);
    const overview = index({ runs: [current, projectDashboardRun(row)] });
    expect(overview.indexOf('aria-labelledby="dashboard-current"')).toBeLessThan(overview.indexOf('aria-labelledby="dashboard-records"'));
    expect(overview).toContain('dashboard-attention-required');
    const html = records({ runs: [current, projectDashboardRun(row)] });
    expect(html.indexOf('aria-labelledby="workflows-history"')).toBeLessThan(html.indexOf('aria-labelledby="dashboard-attention"'));
    expect(html).toContain('dashboard-attention-required');
    expect(records({ runs: [projectDashboardRun(row)] })).not.toContain('dashboard-attention-required');
  });
  it('offers the workflow behind a run only when it is in the owner\'s library', () => {
    const open = { names: new Map([['workflow-id', 'My saved name'], ['unnamed-id', null]]), open: noop };
    expect(records({ runs: [projectDashboardRun(row)], openWorkflow: open })).toContain('Open workflow: My saved name');
    expect(records({ runs: [projectDashboardRun({ ...row, workflowId: 'unnamed-id' })], openWorkflow: open })).toContain('>Open workflow</button>');
    expect(records({ runs: [projectDashboardRun({ ...row, workflowId: 'another' })], openWorkflow: open })).not.toContain('Open workflow');
  });
  it.each<[DashboardStatus, string]>([
    ['Completed', 'complete'], ['Completed with attention', 'attention'], ['In progress', 'progress'],
    ['Needs attention', 'attention'], ['Partially completed', 'attention'], ['Failed', 'failed'],
    ['Unresolved', 'attention'], ['Transaction not submitted', 'neutral'], ['Not started', 'neutral'],
  ])('keeps the exact %s label with its presentation tone', (status, tone) => {
    const html = records({ runs: [{ ...projectDashboardRun(row), status }] });
    expect(html).toContain(`dashboard-status-${tone}`); expect(html).toContain(status);
  });
  it('keeps verification progress and errors separate from execution results', () => {
    const html = index({ connection: 'SIGN_IN_REQUIRED', verifying: true, verificationIssue: 'Wallet verification was not completed.' });
    expect(html).toContain('Waiting for wallet'); expect(html).toContain('disabled');
    expect(html).toContain('role="alert"'); expect(html).toContain('Wallet verification was not completed');
    expect(html).not.toContain('No workflows executed yet'); expect(html).not.toContain('Execution failed');
  });
  it('uses the actual run ID for detail navigation, real evidence availability, and no fabricated time/count', () => {
    const html = records({ runs: [projectDashboardRun(row)] });
    expect(html).toContain(`/app/dashboard/runs/${row.runId}`); expect(html).toContain('Completed'); expect(html).toContain('Evidence available');
    expect(html).not.toContain('steps confirmed'); expect(html).not.toContain('<time');
    expect(records({ runs: [projectDashboardRun({ ...row, hasEvidence: false })] })).not.toContain('Evidence available');
  });
  it.each(['UNKNOWN', 'PARTIALLY_COMPLETED'])('keeps %s truthful in run cards and details', status => {
    const view = projectDashboardRun({ ...row, status });
    const html = renderToStaticMarkup(<RunDetailView view={view} detail={null} connection="CONNECTED" loading={false} back={noop} build={noop} execute={noop}/>);
    expect(html).toContain(status === 'UNKNOWN' ? 'Unresolved' : 'Partially completed');
    expect(html).not.toContain('Execution completed'); expect(html).not.toContain('Retry');
    expect(html).toContain('<details'); expect(html).toContain('View technical details'); expect(html).not.toContain('<details open');
    expect(html).not.toContain('Build another workflow');
  });
  it('resolves canonical paths including encoded IDs and handles malformed encoding without throwing', () => {
    expect(dashboardRoute('/app/dashboard')).toEqual({ runId: null });
    expect(dashboardRoute('/app/dashboard/runs/real-owned-id')).toEqual({ runId: 'real-owned-id' });
    expect(dashboardRoute('/app/dashboard/runs/run%2D123')).toEqual({ runId: 'run-123' });
    expect(dashboardRoute('/app/dashboard/runs/%ZZ')).toEqual({ runId: '%ZZ' });
    expect(dashboardRoute('/')).toBeNull(); expect(dashboardRoute('/app/dashboard/runs/one/two')).toBeNull();
  });
  it('projects saved evidence through the existing timeline without calling the historical run current', () => {
    const fixture = reviewFixture(), base = 'run' in fixture.source.state ? fixture.source.state.run : null;
    const saved = { ...row, flow: 'base-sepolia-swap', ownerAccount: fixture.wallet.account!, hasEvidence: true };
    const hash = '0x' + 'a'.repeat(64);
    const detail = { run: saved, attempts: [], evidence: [], recordUnavailable: false, evidenceUnavailable: false,
      record: { ...base, quote: { ...base?.quote, executionId: saved.runId }, attempts: [{ step: 'swap', account: saved.ownerAccount, state: 'CONFIRMED', txHash: hash }], outcome: null } };
    const progress = projectDashboardRecord(detail, fixture.context);
    expect(progress).not.toBeNull();
    const html = renderToStaticMarkup(<RunDetailView view={projectDashboardRun(saved, progress)} detail={detail} connection="CONNECTED" loading={false} back={noop} build={noop} execute={noop}/>);
    expect(html).toContain('Execution completed'); expect(html).toContain('SAVED RUN RESULT'); expect(html).toContain('Saved run');
    expect(html).not.toContain('Current run'); expect(html).not.toContain('Open current execution');
    expect(html).toContain('Action transaction'); expect(html).toContain(hash);
    expect(html).not.toContain('Actual received'); expect(html).not.toContain('0 ETH'); expect(html).not.toContain('Retry');
  });
});
