// SPDX-License-Identifier: AGPL-3.0-only
// Isolated browser entry; never imported by a product route. No wallet, RPC or broadcast.
import { createRoot } from 'react-dom/client';
import { ReactFlow, ReactFlowProvider, Background } from '@xyflow/react';
import { LocaleProvider } from '../i18n/locale';
import { SimulationSummary } from '../components/simulation-summary';
import { ReviewTokenPermissions } from '../components/review-workspace';
import { projectReview } from '../domain/review-presentation';
import { CanvasNavigator, CANVAS_GESTURES } from '../components/canvas-navigator';
import { DashboardView } from '../components/dashboard/dashboard-view';
import { RunDetailView } from '../components/dashboard/run-detail-view';
import { reviewFixture, reviewSpender } from './review-fixture';
import { runDetailFixture } from './run-detail-fixture';

export function mount(element: HTMLElement, area: string, language: 'EN' | 'PT' = 'EN') {
  const fixture = reviewFixture(), saved = runDetailFixture(area === 'bridge' ? 'bridge-pending' : 'completed');
  if (area.startsWith('simulation-unavailable-')) fixture.source = { kind: 'unavailable', state: { busy: false, error: area.endsWith('rate') ? 'ROUTER_RPC_RATE_LIMITED' : area.endsWith('storage') ? 'SUPPLY_STORAGE_NOT_CONFIGURED' : 'ROUTER_RPC_UNAVAILABLE' } };
  fixture.authorization.approvals = [{ token: 'address' in fixture.context.assets.USDC.asset ? fixture.context.assets.USDC.asset.address : '', chain: fixture.wallet.chain!, spender: reviewSpender, amount: '100000000', kind: 'exact' }];
  if (area === 'technical' && fixture.source.kind === 'public' && fixture.source.state.run) Object.assign(fixture.source.state.run.quote, { ownerReview: { feeBudgetWei: '123456000000000', step: 'approval' } });
  const review = projectReview(fixture.workflow, fixture.context, fixture.source, fixture.authorization, fixture.wallet);
  createRoot(element).render(<LocaleProvider initialLanguage={language}><main className="caio-fixture" style={{ maxWidth: 1200, padding: 16, margin: 'auto' }}>
    <p>Engineering fixture · isolated browser · no funds moved</p>
    {area.startsWith('simulation') || area === 'technical' ? <aside className="simulation-summary panel" style={{ maxWidth: 720, margin: 'auto', padding: 22 }}><SimulationSummary {...fixture}/><ReviewTokenPermissions review={review}/></aside>
      : area === 'history' ? <DashboardView account={fixture.wallet.account} connection="CONNECTED" runs={[saved.view!]} hasMore={false} loading={false} build={() => {}} openRun={() => {}} verify={() => {}} verifying={false} verificationIssue={null} refresh={() => {}}/>
      : area.startsWith('canvas') ? <ReactFlowProvider><div className="flow-surface" style={{ height: 520 }}><ReactFlow nodes={[{ id: 'one', position: { x: 100, y: 120 }, data: { label: area === 'canvas-form' ? <label>Amount<input aria-label="Navigation form field" defaultValue="1"/></label> : 'Recorded workflow action' } }]} edges={[]} minZoom={.35} maxZoom={1.4} panOnDrag={[1, 2]} {...CANVAS_GESTURES}><Background/><CanvasNavigator/></ReactFlow></div><div style={{ height: 1200 }}>Page scroll remains available</div></ReactFlowProvider>
      : <RunDetailView {...saved} connection="CONNECTED" loading={false} back={() => {}} build={() => {}} execute={() => {}}/>}
  </main></LocaleProvider>);
}
