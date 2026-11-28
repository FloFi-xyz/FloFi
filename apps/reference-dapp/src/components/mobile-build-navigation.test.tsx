// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (E11, P2-04, A10): the one-column Plan / Conversation switch — tabs that say which pane is shown,
 * a reply that arrived while the Plan was shown marked on the Conversation tab, a stage change that shows its Plan, and the stage's summary
 * shortcut kept on Simulate and Execute. The panes themselves stay mounted (the shell only hides one, CSS).
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { currentMobilePane, MobileBuildNavigation, mobilePaneUnread, type MobilePaneState } from './mobile-build-navigation';
import { LocaleProvider } from '../i18n/locale';

const render = (props: Parameters<typeof MobileBuildNavigation>[0], language: 'EN' | 'PT' = 'EN') =>
  renderToStaticMarkup(createElement(LocaleProvider, { initialLanguage: language, children: createElement(MobileBuildNavigation, props) }));

describe('the Plan / Conversation switch', () => {
  it('is a tablist whose selected tab is the shown pane (EN/PT); only the selected tab is in the tab order', () => {
    const plan = render({ stage: 'Build', pane: 'plan' });
    expect(plan).toContain('aria-label="Editor navigation"'); expect(plan).toContain('role="tablist"');
    expect(plan).toMatch(/role="tab" data-pane="plan" aria-selected="true" tabindex="0">Plan</);
    expect(plan).toMatch(/role="tab" data-pane="conversation" aria-selected="false" tabindex="-1">Conversation</);
    const conversation = render({ stage: 'Build', pane: 'conversation' }, 'PT');
    expect(conversation).toMatch(/data-pane="plan" aria-selected="false" tabindex="-1">Plano</);
    expect(conversation).toMatch(/data-pane="conversation" aria-selected="true" tabindex="0">Conversa</);
    // Build has no third shortcut: the Canvas and the chat are the two panes.
    expect(plan.match(/<button/g)).toHaveLength(2);
  });
  it('marks a new reply on the Conversation tab compactly (a dot and a screen-reader word), never on the shown pane', () => {
    const unread = render({ stage: 'Build', pane: 'plan', unread: true });
    expect(unread).toMatch(/data-pane="conversation"[^>]*data-unread="true">Conversation<span class="mobile-pane-unread" aria-hidden="true"><\/span><span class="sr-only">New reply<\/span>/);
    expect(render({ stage: 'Build', pane: 'plan', unread: true }, 'PT')).toContain('<span class="sr-only">Nova resposta</span>');
    expect(render({ stage: 'Build', pane: 'conversation', unread: true })).not.toMatch(/data-unread|New reply/);
  });
  it('keeps the stage summary shortcut on Simulate and Execute', () => {
    expect(render({ stage: 'Simulate', pane: 'plan' })).toMatch(/aria-label="Simulation workspace navigation".*<\/div><button type="button">Review<\/button><\/nav>/);
    expect(render({ stage: 'Execute', pane: 'conversation' })).toMatch(/aria-label="Execution workspace navigation".*<button type="button">Execution Summary<\/button><\/nav>/);
  });
});

describe('the pane state', () => {
  const at = (pane: MobilePaneState['pane'], seen: number, stage = 'Build'): MobilePaneState => ({ pane, stage, seen });
  it('a reply counted after the pane was chosen marks the Conversation tab only while the Plan is shown', () => {
    expect(mobilePaneUnread(at('plan', 2), 2)).toBe(false);
    expect(mobilePaneUnread(at('plan', 2), 3)).toBe(true);
    expect(mobilePaneUnread(at('conversation', 2), 3)).toBe(false);
  });
  it('a stage change shows its Plan and counts every reply so far as seen; a shorter conversation counts from its new length', () => {
    expect(currentMobilePane(at('conversation', 2), 'Execute', 5)).toEqual({ pane: 'plan', stage: 'Execute', seen: 5 });
    const same = at('plan', 2);
    expect(currentMobilePane(same, 'Build', 4)).toBe(same);
    expect(currentMobilePane(at('plan', 6), 'Build', 1)).toEqual(at('plan', 1));
  });
});
