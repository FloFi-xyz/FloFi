// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EditorStepper } from './editor-stepper';
import { LocaleProvider } from '../i18n/locale';

/** The stepper's buttons from one real render, so each button's own handler can be invoked. */
function buttons(props: Parameters<typeof EditorStepper>[0]) {
  let tree: ReactNode = null;
  function Capture() { tree = EditorStepper(props); return null; }
  renderToStaticMarkup(createElement(Capture));
  const found: ReactElement<{ children: ReactNode; onClick(): void; disabled?: boolean; 'aria-disabled'?: boolean; 'aria-current'?: string }>[] = [];
  const walk = (node: ReactNode): void => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!isValidElement<{ children?: ReactNode }>(node)) return;
    if (node.type === 'button') found.push(node as (typeof found)[number]);
    walk(node.props.children);
  };
  walk(tree);
  return found;
}

// BUILD-FLOFI-BUILDER-UX-002: Create → Simulate → Execute inside the Editor; it replaces the footer's "View simulation" / "View execution".
describe('Editor stepper', () => {
  it('names the three Editor sections in order with numbered steps and marks the current one', () => {
    const html = renderToStaticMarkup(createElement(EditorStepper, { tab: 'Build', setTab: vi.fn(), disabled: false }));
    expect(html).toContain('<nav class="editor-stepper" aria-label="Editor steps"><ol>');
    expect([...html.matchAll(/editor-stepper-label">([^<]+)</g)].map(match => match[1])).toEqual(['Create', 'Simulate', 'Execute']);
    expect([...html.matchAll(/editor-stepper-number" aria-hidden="true">(\d)</g)].map(match => match[1])).toEqual(['1', '2', '3']);
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="step"><span class="editor-stepper-number" aria-hidden="true">1/);
  });

  it('opens the same sections the footer opened, and nothing else', () => {
    const setTab = vi.fn();
    const [create, simulate, execute] = buttons({ tab: 'Build', setTab, disabled: false });
    create!.props.onClick(); expect(setTab).not.toHaveBeenCalled();
    simulate!.props.onClick(); expect(setTab).toHaveBeenLastCalledWith('Simulate');
    execute!.props.onClick(); expect(setTab).toHaveBeenLastCalledWith('Execute');
    const [back] = buttons({ tab: 'Execute', setTab, disabled: false });
    back!.props.onClick(); expect(setTab).toHaveBeenLastCalledWith('Build');
    expect(setTab).toHaveBeenCalledTimes(3);
  });

  it('keeps Simulate and Execute closed while the shell refuses them, and says why only for an unapplied amount', () => {
    const incomplete = renderToStaticMarkup(createElement(EditorStepper, { tab: 'Build', setTab: vi.fn(), disabled: true, incomplete: true }));
    // Closed steps stay focusable (aria-disabled) so the reason is reachable from the keyboard; they never open their section.
    expect(incomplete.match(/<button type="button" aria-disabled="true" title="Configure the action amount on the Canvas first">/g)).toHaveLength(2);
    const gated = renderToStaticMarkup(createElement(EditorStepper, { tab: 'Build', setTab: vi.fn(), disabled: true }));
    expect(gated.match(/<button type="button" aria-disabled="true">/g)).toHaveLength(2);
    expect(gated).not.toContain('title=');
    // Create always stays available.
    expect(buttons({ tab: 'Simulate', setTab: vi.fn(), disabled: true })[0]!.props['aria-disabled']).toBeUndefined();
    // A closed step's click never opens its section.
    const refused = vi.fn(), closed = buttons({ tab: 'Build', setTab: refused, disabled: true });
    closed[1]!.props.onClick(); closed[2]!.props.onClick(); expect(refused).not.toHaveBeenCalled();
  });

  it('speaks Portuguese', () => {
    const html = renderToStaticMarkup(createElement(LocaleProvider, { initialLanguage: 'PT', children: createElement(EditorStepper, { tab: 'Simulate', setTab: vi.fn(), disabled: false }) }));
    expect([...html.matchAll(/editor-stepper-label">([^<]+)</g)].map(match => match[1])).toEqual(['Criar', 'Simular', 'Executar']);
    expect(html).toContain('aria-label="Etapas do editor"');
  });
});
