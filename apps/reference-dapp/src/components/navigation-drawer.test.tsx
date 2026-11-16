// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NavigationDrawer } from './navigation-drawer';
import { SECONDARY_WORKSPACES, secondaryWorkspaceRoute } from '../domain/secondary-workspaces';

const render = (props: Partial<ComponentProps<typeof NavigationDrawer>> = {}) => renderToStaticMarkup(createElement(NavigationDrawer, {
  onBuild: () => undefined, onDisconnect: () => undefined, disconnectDisabled: true, ...props,
}));

describe('navigation drawer shell', () => {
  // BUILD UX POLISH 004 (UX-01, intentional change): the server renders the desktop rail — collapsed, never inert — with the chevron that shows the
  // names; the ☰ trigger stays in the markup for the mobile drawer (CSS shows exactly one of them, and keeps the drawer closed on a narrow screen
  // until the client applies `inert`/`aria-hidden`). Both controls name the same navigation.
  it('renders the collapsed desktop rail with its chevron, keeping the mobile ☰ trigger, both linked to the navigation', () => {
    const html = render();
    const controlledId = html.match(/aria-controls="([^"]+)"/)?.[1];
    expect(controlledId).toBeTruthy();
    expect(html.match(new RegExp(`aria-controls="${controlledId}"`, 'g'))).toHaveLength(2);
    expect(html).toContain('class="navigation-trigger navigation-menu-trigger" aria-label="Open navigation" aria-expanded="false"');
    expect(html).toContain('M4 6h16M4 12h16M4 18h16');
    expect(html).toContain('class="navigation-trigger navigation-rail-toggle" aria-label="Expand navigation" title="Expand navigation" aria-expanded="false"');
    expect(html).toContain('<path d="m9 6 6 6-6 6"></path>');
    expect(html).toContain(`id="${controlledId}" class="navigation-drawer"`);
    expect(html).toContain('class="navigation-layer" data-open="false" data-expanded="false">');
    expect(html).not.toMatch(/navigation-layer"[^>]*(aria-hidden|inert)/);
    // No tooltip until an item is hovered or focused.
    expect(html).not.toContain('navigation-rail-tooltip');
  });

  it('names every item, Log out, Terms and Privacy for the collapsed rail (tooltip and accessible name), status tags included', () => {
    const html = render({ onChat: () => undefined });
    const tips = [...html.matchAll(/data-navigation-tip="([^"]+)"/g)].map(match => match[1]);
    expect(tips).toEqual(['New workflow', 'Editor', 'Dashboard', 'Your workflows', 'Automations', 'Credentials', 'Agents · In testing', 'Passkeys', 'Log out', 'Terms', 'Privacy']);
    // Each name stays in the item itself (visually hidden only while collapsed), so assistive technology never depends on the tooltip.
    for (const label of ['New workflow', 'Editor', 'Dashboard', 'Your workflows', 'Automations', 'Credentials', 'Agents', 'Passkeys', 'Log out'])
      expect(html).toContain(`<span class="navigation-row-label">${label}</span>`);
    expect(html.match(/class="navigation-legal-icon"/g)).toHaveLength(2);
    expect(html).toMatch(/<a href="\/terms" data-navigation-tip="Terms"><svg class="navigation-legal-icon"[^>]*aria-hidden="true">(?:(?!<\/a>)[\s\S])*<span class="navigation-legal-label">Terms<\/span><\/a>/);
    expect(html).toMatch(/<a href="\/privacy" data-navigation-tip="Privacy"><svg class="navigation-legal-icon"[^>]*aria-hidden="true">(?:(?!<\/a>)[\s\S])*<span class="navigation-legal-label">Privacy<\/span><\/a>/);
  });

  // BUILD-FLOFI-CHAT-EDITOR-UX-001: "Build Workflow" is now "Editor", current on each Editor section like the top bar (Simulate here).
  // P0 approved UX (board 03b): the only navigation — New workflow (where the Chat entry exists), Editor, Dashboard; Library: Your workflows,
  // Automations; Access: Credentials, Agents, Passkeys; then Log out; Terms · Privacy on one line. Agents carries "In testing", never a dead control.
  it('orders the drawer as approved, with grouped Library and Access and a separate bottom Log out action', () => {
    const html = render({ section: 'Simulate' });
    expect(html.match(/class="navigation-row"/g)).toHaveLength(8);
    expect(html).toMatch(/<p class="navigation-legal"><a href="\/terms"[^>]*>(?:(?!<\/a>)[\s\S])*Terms<\/span><\/a><span class="navigation-legal-separator" aria-hidden="true"> · <\/span>/);
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('href="/app/dashboard"');
    expect(html).toContain('href="/app"');
    const labels = [...html.matchAll(/<span class="navigation-row-label">(New workflow|Dashboard|Chat|Editor|Your workflows|Automations|Credentials|Agents|Passkeys|Log out)<\/span>/g)].map(match => match[1]);
    expect(labels).toEqual(['Editor', 'Dashboard', 'Your workflows', 'Automations', 'Credentials', 'Agents', 'Passkeys', 'Log out']);
    expect([...html.matchAll(/class="navigation-section-label"[^>]*>([^<]+)</g)].map(match => match[1])).toEqual(['Library', 'Access']);
    expect(html).not.toContain('Build Workflow');
    expect(html).toMatch(/class="navigation-footer"><button type="button" class="navigation-row" disabled="" data-navigation-tip="Log out">(?:(?!<\/button>)[\s\S])*<span class="navigation-row-label">Log out<\/span>/);
    for (const item of SECONDARY_WORKSPACES) {
      expect(html).toContain(`href="${item.href}"`);
      expect(html).toContain(`<span class="navigation-row-label">${item.label}</span>`);
    }
    // "In testing" is a status next to Agents (not clickable on its own); no disabled control pretends to work.
    expect(html).toMatch(/<span class="navigation-row-label">Agents<\/span><span class="navigation-status" data-status="testing">In testing<\/span>/);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="page" data-navigation-tip="Editor" href="\/app">(?:(?!<\/a>)[\s\S])*<span class="navigation-row-label">Editor<\/span>/);
    expect(html).not.toMatch(/aria-pressed=|role="dialog"|aria-modal=/);
  });

  it.each(SECONDARY_WORKSPACES)('marks only the $label route as current', item => {
    const html = render({ pathname: item.href });
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(new RegExp(`class="navigation-row" aria-current="page" data-navigation-tip="[^"]+" href="${item.href}"`));
    expect(secondaryWorkspaceRoute(`${item.href}/`)).toEqual(item);
  });

  it.each([
    { pathname: '/app/dashboard', section: 'Dashboard' as const, href: '/app/dashboard' },
    { pathname: '/app/dashboard/runs/owner-run', section: 'Dashboard' as const, href: '/app/dashboard' },
    { pathname: '/app', section: 'Build' as const, href: '/app' },
  ])('selects only the existing $section workspace for $pathname', ({ pathname, section, href }) => {
    const html = render({ pathname, section });
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(new RegExp(`class="navigation-row" aria-current="page" data-navigation-tip="[^"]+" href="${href}"`));
  });

  it.each(['Build', 'Simulate', 'Execute'] as const)('selects only the Editor in its %s section, as the top bar does', section => {
    const html = render({ pathname: '/app', section });
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="page" data-navigation-tip="Editor" href="\/app">(?:(?!<\/a>)[\s\S])*<span class="navigation-row-label">Editor<\/span>/);
  });

  it('offers New workflow (the Chat entry) only where the shell has it, current on the entry, with the shell click targets', () => {
    const calls: string[] = [];
    const without = render({ pathname: '/app', section: 'Chat' });
    expect(without).not.toContain('<span class="navigation-row-label">New workflow</span>');
    expect(without).not.toContain('aria-current="page"');
    const html = render({ pathname: '/app', section: 'Chat', onChat: () => calls.push('chat'), onBuild: () => calls.push('build') });
    const labels = [...html.matchAll(/<span class="navigation-row-label">(New workflow|Dashboard|Editor|Your workflows)<\/span>/g)].map(match => match[1]);
    expect(labels).toEqual(['New workflow', 'Editor', 'Dashboard', 'Your workflows']);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="page" data-navigation-tip="New workflow" href="\/app">(?:(?!<\/a>)[\s\S])*<span class="navigation-row-label">New workflow<\/span>/);
    expect(render({ pathname: '/app', section: 'Execute', onChat: () => undefined })).toMatch(/aria-current="page" data-navigation-tip="Editor" href="\/app">(?:(?!<\/a>)[\s\S])*<span class="navigation-row-label">Editor<\/span>/);
    expect(calls).toEqual([]);
  });

  it('enables Log out only when the existing disconnect availability permits it', () => {
    expect(render({ disconnectDisabled: false })).toMatch(/class="navigation-footer"><button type="button" class="navigation-row" data-navigation-tip="Log out">(?:(?!<\/button>)[\s\S])*<span class="navigation-row-label">Log out<\/span>/);
  });

  it.each(['/app', '/app/dashboard', '/app/credentials/unknown', null, undefined])('does not select a secondary workspace for %s', pathname => {
    expect(secondaryWorkspaceRoute(pathname)).toBeNull();
  });
});
