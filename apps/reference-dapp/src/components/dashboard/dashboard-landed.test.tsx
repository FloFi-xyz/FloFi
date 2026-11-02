// SPDX-License-Identifier: AGPL-3.0-only
/** Issue #149: the Dashboard card and run summary show what landed onchain, never "nothing was sent" after a confirmed approval. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DashboardView } from './dashboard-view';
import { RunDetailView } from './run-detail-view';
import { projectDashboardRun } from '../../lib/dashboard/run-mapping';
import type { DashboardRun } from '../../lib/dashboard/types';

const noop = () => undefined, owner = '0x' + '1'.repeat(40);
const run: DashboardRun = { runId: 'bas-0123456789abcdef01234567', workflowId: 'w', flow: 'base-swap', status: 'CONFIRMED', provenance: 'PUBLIC_MAINNET', ownerAccount: owner,
  errorCode: null, needsObservation: false, attentionRequired: false, hasEvidence: false, createdAt: null, updatedAt: null,
  attempts: [{ attemptId: 'bas-0123456789abcdef01234567.approval.1', step: 'APPROVAL', state: 'CONFIRMED', transactionHash: '0x' + 'e'.repeat(64), reconciled: false }] };

describe('Issue #149: landed-attempt indicator in the Dashboard', () => {
  it('the run card shows the landed approval and the incomplete main action, never "Not started"', () => {
    const html = renderToStaticMarkup(<DashboardView account={owner} connection="CONNECTED" runs={[projectDashboardRun(run)]} hasMore={false} loading={false} build={noop}
      openRun={noop} verify={noop} verifying={false} verificationIssue={null} refresh={noop}/>);
    expect(html).toContain('Approval confirmed · main action not sent');
    expect(html).toContain('Partially completed');
    expect(html).not.toContain('Not started');
    expect(html).not.toContain('nothing was sent');
  });
  it('the saved run summary names what landed onchain', () => {
    const html = renderToStaticMarkup(<RunDetailView view={projectDashboardRun(run)} detail={null} connection="CONNECTED" loading={false} back={noop} build={noop} execute={noop}/>);
    expect(html).toContain('Landed onchain');
    expect(html).toContain('Approval confirmed · main action not sent');
    expect(renderToStaticMarkup(<RunDetailView view={projectDashboardRun({ ...run, status: 'SIMULATED', attempts: [] })} detail={null} connection="CONNECTED" loading={false}
      back={noop} build={noop} execute={noop}/>)).not.toContain('Landed onchain');
  });
});
