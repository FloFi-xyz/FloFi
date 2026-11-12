// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { createBaseSepoliaReviewContext } from '@defi-workflow-engine/reference-linter';
import { initialEditor, editorReducer } from '../domain/editor';
import { canvasAddCommand } from '../domain/canvas-authoring';
import { SummaryBar } from './summary-bar';

const fixture = vi.hoisted(() => ({ state: null as unknown as ReturnType<typeof initialEditor>, supply: { record: null as unknown, retired: false },
  modeA: { info: null as { available: boolean } | null, prepared: null as unknown, retired: false, verifyError: null as string | null, verified: {} as Record<string, boolean> } }));
vi.mock('react-dom', () => ({ createPortal: vi.fn(() => null) }));
vi.mock('../state/workflow-store', () => ({ useWorkflow: () => ({ state: fixture.state }) }));
vi.mock('../state/mode-a-store', () => ({ useModeA: () => fixture.modeA }));
vi.mock('../state/mode-b-store', () => ({ useModeB: () => ({ info: null }) }));
vi.mock('../state/public-testnet-store', () => ({ usePublicTestnet: () => ({ run: null }) }));
vi.mock('../state/supply-store', () => ({ useSupply: () => fixture.supply }));
vi.mock('../state/lending-store', () => ({ useLending: () => ({ record: null }) }));
vi.mock('../state/robinhood-transfer-store', () => ({ useRobinhoodTransfer: () => ({ record: null }) }));
vi.mock('../state/jupiter-store', () => ({ useJupiter: () => ({ record: null }) }));
vi.mock('../state/solana-liquidity-store', () => ({ useSolanaLiquidity: () => ({ record: null }) }));

beforeEach(() => {
  vi.clearAllMocks();
  fixture.state = initialEditor(); fixture.supply = { record: null, retired: false };
  fixture.modeA = { info: null, prepared: null, retired: false, verifyError: null, verified: {} };
});
describe('footer after Build CTA relocation', () => {
  it('retains workflow revision/count without a duplicate Build button', () => {
    const setTab = vi.fn();
    const html = renderToStaticMarkup(createElement(SummaryBar, { tab: 'Build', setTab }));
    expect(html).toContain('data-workflow-revision="0"');
    expect(html).toContain('0 steps'); // P0 approved UX (board 04): "WORKFLOW · n steps"
    expect(html).not.toMatch(/<button|Simular Fees|Continue to Simulate/);
    expect(setTab).not.toHaveBeenCalled();
  });

  it.each([false, true])('preserves the Supply review gate when a simulation record exists=%s', ready => {
    fixture.state = editorReducer(initialEditor(), canvasAddCommand('supply', 0, '0x1111111111111111111111111111111111111111', '1'), createBaseSepoliaReviewContext());
    fixture.supply.record = ready ? { review: {} } : null;
    const setTab = vi.fn();
    const html = renderToStaticMarkup(createElement(SummaryBar, { tab: 'Simulate', setTab }));
    expect(html).toContain('Review Supply');
    expect(html.includes('disabled=""')).toBe(!ready);
    expect(setTab).not.toHaveBeenCalled();
  });

  it.each(['unavailable', 'unprepared', 'retired', 'verification error', 'unverified approval', 'unverified swap', 'ready'])('preserves swap review eligibility in the canvas: %s', condition => {
    fixture.modeA = { info: { available: true }, prepared: {}, retired: false, verifyError: null, verified: { 'step-approve': true, 'step-swap': true } };
    if (condition === 'unavailable') fixture.modeA.info = null;
    if (condition === 'unprepared') fixture.modeA.prepared = null;
    if (condition === 'retired') fixture.modeA.retired = true;
    if (condition === 'verification error') fixture.modeA.verifyError = 'Payload verification failed';
    if (condition === 'unverified approval') fixture.modeA.verified['step-approve'] = false;
    if (condition === 'unverified swap') fixture.modeA.verified['step-swap'] = false;
    const simulationActionHost = {} as HTMLDivElement, setTab = vi.fn(), focusReview = vi.fn();
    const html = renderToStaticMarkup(createElement(SummaryBar, { tab: 'Simulate', setTab, simulationActionHost, focusReview }));
    expect(html).not.toContain('Review swap');
    expect(createPortal).toHaveBeenCalledTimes(1);
    const [action, host] = vi.mocked(createPortal).mock.calls[0]!;
    expect(host).toBe(simulationActionHost);
    const button = action as ReactElement<{ children: string; disabled: boolean; onClick: () => void }>;
    expect(button.props.children).toBe('Review swap');
    expect(button.props.disabled).toBe(condition !== 'ready');
    expect(setTab).not.toHaveBeenCalled();
    if (condition === 'ready') {
      button.props.onClick();
      expect(focusReview).toHaveBeenCalledOnce(); expect(setTab).not.toHaveBeenCalled();
    }
  });

  it('focuses embedded Review without navigating or executing', () => {
    const setTab = vi.fn(), focusReview = vi.fn(), simulationActionHost = {} as HTMLDivElement;
    renderToStaticMarkup(createElement(SummaryBar, { tab: 'Simulate', setTab, simulationActionHost, focusReview, reviewAvailable: true }));
    const [action] = vi.mocked(createPortal).mock.calls[0]!;
    const button = action as ReactElement<{ onClick(): void; children: string }>;
    expect(button.props.children).toBe('Review authorization'); button.props.onClick();
    expect(focusReview).toHaveBeenCalledOnce(); expect(setTab).not.toHaveBeenCalled();
  });

  it('does not present an unavailable Review CTA or navigate to Execute before simulation', () => {
    const setTab = vi.fn(), focusReview = vi.fn(), simulationActionHost = {} as HTMLDivElement;
    renderToStaticMarkup(createElement(SummaryBar, { tab: 'Simulate', setTab, focusReview, simulationActionHost, reviewAvailable: false }));
    expect(vi.mocked(createPortal).mock.calls[0]?.[0]).toBeNull();
    expect(setTab).not.toHaveBeenCalled(); expect(focusReview).not.toHaveBeenCalled();
  });
  it('retains footer actions when no simulation canvas is mounted and on Execute', () => {
    const setTab = vi.fn();
    expect(renderToStaticMarkup(createElement(SummaryBar, { tab: 'Simulate', setTab }))).toMatch(/disabled="">Review swap/);
    expect(renderToStaticMarkup(createElement(SummaryBar, { tab: 'Execute', setTab, simulationActionHost: {} as HTMLDivElement }))).toContain('Back to the Canvas');
    expect(createPortal).not.toHaveBeenCalled();
    expect(setTab).not.toHaveBeenCalled();
  });
});

/** The footer's element tree from one real render (hooks run inside `Capture`), so a button's own handler can be invoked. */
function footerButtons(props: Parameters<typeof SummaryBar>[0]) {
  let tree: ReactNode = null;
  function Capture() { tree = SummaryBar(props); return null; }
  renderToStaticMarkup(createElement(Capture));
  const buttons: ReactElement<{ children: ReactNode; onClick(): void; disabled?: boolean }>[] = [];
  const walk = (node: ReactNode): void => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!isValidElement<{ children?: ReactNode }>(node)) return;
    if (node.type === 'button') buttons.push(node as (typeof buttons)[number]);
    walk(node.props.children);
  };
  walk(tree);
  return buttons;
}
// BUILD-FLOFI-BUILDER-UX-002 (owner-approved Editor brief): the Editor's Create → Simulate → Execute stepper now opens the sections (editor-stepper.test.tsx);
// the footer states the count and the workflow's real notices and hosts the existing Canvas lifecycle control, once.
const step = (nodeId: string, n: number, kind: 'draft' | 'configured' | 'attention', detail = '') =>
  ({ nodeId, step: n, action: 'Swap', flow: 'USDC → WETH', status: { kind, label: kind === 'attention' ? 'Needs attention' : kind === 'draft' ? 'Draft' : 'Configured', detail } });
const overview = (fields: Partial<Parameters<typeof SummaryBar>[0]['overview'] & object> = {}) =>
  ({ count: 1, steps: [step('a', 1, 'configured')], networks: ['Base'], state: 'configured' as const, attention: [], drafts: 0, invalid: false, ...fields });
describe('Editor footer', () => {
  it('no longer repeats the stepper: no section buttons on the Canvas or the simulation section', () => {
    for (const tab of ['Build', 'Simulate'] as const) expect(renderToStaticMarkup(createElement(SummaryBar, { tab, setTab: vi.fn(), canvasOwnsAction: true }))).not.toMatch(/summary-sections|View simulation|View execution/);
  });

  // P0 approved UX (boards 06–08): the footer hosts the ONE lifecycle control on Create and on Simulate (it left the canvas corner).
  it('hosts the existing Canvas lifecycle control once, on Create and Simulate (and on Execute only when the shell hands it one), keeping its wrapper class', () => {
    const control = createElement('button', { type: 'button', className: 'primary', 'data-lifecycle-action': 'simulate' }, 'Simulate workflow');
    const html = renderToStaticMarkup(createElement(SummaryBar, { tab: 'Build', setTab: vi.fn(), canvasOwnsAction: true, primaryAction: control, overview: overview() }));
    expect(html.match(/data-lifecycle-action="simulate"/g)).toHaveLength(1);
    expect(html).toContain('<div class="canvas-primary-action summary-primary-action"><button type="button" class="primary" data-lifecycle-action="simulate">Simulate workflow</button></div>');
    expect(html).toContain('class="summary-bar editor-bar"');
    const simulate = renderToStaticMarkup(createElement(SummaryBar, { tab: 'Simulate', setTab: vi.fn(), canvasOwnsAction: true, primaryAction: control }));
    expect(simulate.match(/data-lifecycle-action="simulate"/g)).toHaveLength(1);
    // Board 06: the shell renders the footer on Execute only while the whole-workflow Review waits for authorization, and hands it that ONE action.
    expect(renderToStaticMarkup(createElement(SummaryBar, { tab: 'Execute', setTab: vi.fn(), canvasOwnsAction: true, primaryAction: control })).match(/data-lifecycle-action="simulate"/g)).toHaveLength(1);
    expect(renderToStaticMarkup(createElement(SummaryBar, { tab: 'Execute', setTab: vi.fn(), canvasOwnsAction: true }))).not.toContain('summary-primary-action');
  });

  it('states only real notices: steps that need attention, unapplied changes, or none', () => {
    const showStep = vi.fn();
    const props = { tab: 'Build' as const, setTab: vi.fn(), canvasOwnsAction: true, showStep,
      overview: overview({ state: 'attention', steps: [step('a', 1, 'configured'), step('b', 2, 'attention', 'Slippage is elevated.')], attention: [step('b', 2, 'attention', 'Slippage is elevated.')] }) };
    const html = renderToStaticMarkup(createElement(SummaryBar, props));
    expect(html).toContain('1 step needs attention'); expect(html).toContain('Step 2: Slippage is elevated.');
    const [show] = footerButtons(props);
    expect(show?.props.children).toBe('Show step'); show!.props.onClick();
    expect(showStep).toHaveBeenCalledExactlyOnceWith('b');
    expect(renderToStaticMarkup(createElement(SummaryBar, { ...props, overview: overview({ state: 'draft', drafts: 2 }) }))).toContain('2 changes not applied yet');
    expect(renderToStaticMarkup(createElement(SummaryBar, { ...props, overview: overview() }))).toContain('No warnings');
    // Simulate closed for a reason its control states: the footer claims nothing about warnings.
    expect(renderToStaticMarkup(createElement(SummaryBar, { ...props, overview: overview(), simulationBlocked: true }))).not.toContain('summary-notice');
    // One live region: attention is announced, an unapplied change is read on demand.
    expect(html).toContain('<p class="summary-notice" data-notice="attention" role="status">');
    expect(renderToStaticMarkup(createElement(SummaryBar, { ...props, overview: overview({ state: 'draft', drafts: 1 }) }))).not.toContain('role="status"');
    expect(renderToStaticMarkup(createElement(SummaryBar, { ...props, overview: overview({ state: 'empty', count: 0, steps: [] }) }))).not.toContain('summary-notice');
    // A notice never claims a simulation, an approval or an executable transaction.
    expect(html).not.toMatch(/Simulated|Approved|Ready to execute/);
  });
});

/** P0 approved UX (boards 06–07): the Simulate footer states the validity countdown or the blocker, as a status line. */
describe('Simulate footer status', () => {
  const sim = { busy: false, status: 'ready' as const, label: 'Ready', expiresAt: Date.now() + 52_000, executionStarted: false };
  it('counts the simulation validity down in a status line', () => {
    const html = renderToStaticMarkup(createElement(SummaryBar, { tab: 'Simulate', setTab: vi.fn(), canvasOwnsAction: true, simulation: sim }));
    expect(html).toMatch(/<p class="summary-status-line" data-tone="ready">[\s\S]*Simulation valid for 0:5[12]/);
    // The ticking m:ss is not a live region; the status speaks only when the meaning changes.
    expect(html).toMatch(/<span class="summary-status-text" aria-hidden="true">Simulation valid for/);
    expect(html).toMatch(/<span class="sr-only" role="status">Simulation valid for 0:5[12]<\/span>/);
  });
  it('names a blocker and says nothing was sent only before any execution', () => {
    const blocked = renderToStaticMarkup(createElement(SummaryBar, { tab: 'Simulate', setTab: vi.fn(), canvasOwnsAction: true, simulation: { ...sim, status: 'blocked', label: 'Insufficient balance', expiresAt: null } }));
    expect(blocked).toContain('Insufficient balance'); expect(blocked).toContain('Nothing was sent');
    const started = renderToStaticMarkup(createElement(SummaryBar, { tab: 'Simulate', setTab: vi.fn(), canvasOwnsAction: true, simulation: { ...sim, status: 'blocked', label: 'Insufficient balance', expiresAt: null, executionStarted: true } }));
    expect(started).not.toContain('Nothing was sent');
  });
  it('on Create, a pending network question is the one notice', () => {
    const html = renderToStaticMarkup(createElement(SummaryBar, { tab: 'Build', setTab: vi.fn(), overview: overview(), networkQuestion: true }));
    expect(html).toContain('Choose the network in the chat to simulate'); expect(html).not.toContain('No warnings');
  });
});
