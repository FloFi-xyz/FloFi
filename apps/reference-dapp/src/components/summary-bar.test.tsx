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
    expect(html).toContain('0 actions');
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
// BUILD-FLOFI-CHAT-EDITOR-UX-001: Simulate and Execute are no longer top-level tabs; the Editor's footer opens those sections instead.
describe('Editor sections in the footer', () => {
  it('opens the simulation and execution sections from the Canvas without any lifecycle action', () => {
    const setTab = vi.fn();
    const props = { tab: 'Build' as const, setTab, canvasOwnsAction: true, sections: { disabled: false } };
    const html = renderToStaticMarkup(createElement(SummaryBar, props));
    expect(html).toContain('<div class="summary-sections" role="group" aria-label="Editor sections"><button type="button">View simulation</button><button type="button">View execution</button></div>');
    expect(html).not.toMatch(/class="primary"|Review|Authorize|Back to/);
    expect(setTab).not.toHaveBeenCalled();
    const [simulation, execution] = footerButtons(props);
    expect(simulation?.props.children).toBe('View simulation'); simulation!.props.onClick();
    expect(setTab).toHaveBeenLastCalledWith('Simulate');
    expect(execution?.props.children).toBe('View execution'); execution!.props.onClick();
    expect(setTab).toHaveBeenLastCalledWith('Execute');
    expect(setTab).toHaveBeenCalledTimes(2);
    expect(createPortal).not.toHaveBeenCalled();
  });

  it('offers only the execution section from the simulation section, beside no Review action of its own', () => {
    const setTab = vi.fn();
    const props = { tab: 'Simulate' as const, setTab, canvasOwnsAction: true, sections: { disabled: false } };
    const html = renderToStaticMarkup(createElement(SummaryBar, props));
    expect(html).toContain('<div class="summary-sections" role="group" aria-label="Editor sections"><button type="button">View execution</button></div>');
    expect(html).not.toMatch(/View simulation|Review swap|class="primary"/);
    const buttons = footerButtons(props);
    expect(buttons.map(button => button.props.children)).toEqual(['View execution']);
    buttons[0]!.props.onClick();
    expect(setTab).toHaveBeenCalledExactlyOnceWith('Execute');
  });

  it('keeps both sections closed while a Canvas amount is unapplied, as the former tabs were, and says why', () => {
    const html = renderToStaticMarkup(createElement(SummaryBar, { tab: 'Build', setTab: vi.fn(), canvasOwnsAction: true, sections: { disabled: true, incomplete: true } }));
    expect(html.match(/<button type="button" disabled="" title="Configure the action amount on the Canvas first">View (simulation|execution)<\/button>/g)).toHaveLength(2);
  });

  it('keeps both sections closed while an /approve proposal gates them, without the amount reason', () => {
    const html = renderToStaticMarkup(createElement(SummaryBar, { tab: 'Build', setTab: vi.fn(), canvasOwnsAction: true, sections: { disabled: true } }));
    expect(html.match(/<button type="button" disabled="">View (simulation|execution)<\/button>/g)).toHaveLength(2);
    expect(html).not.toContain('title=');
  });

  it('adds no section action where the shell does not ask for one', () => {
    expect(renderToStaticMarkup(createElement(SummaryBar, { tab: 'Build', setTab: vi.fn(), canvasOwnsAction: true }))).not.toMatch(/summary-sections|<button/);
  });
});
