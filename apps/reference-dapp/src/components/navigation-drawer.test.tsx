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
  it('starts closed and inert with a labelled trigger linked to the drawer', () => {
    const html = render();
    const controlledId = html.match(/aria-controls="([^"]+)"/)?.[1];
    expect(controlledId).toBeTruthy();
    expect(html).toContain('aria-label="Open navigation" aria-expanded="false"');
    expect(html).toContain(`id="${controlledId}" class="navigation-drawer"`);
    expect(html).toContain('data-open="false" aria-hidden="true" inert=""');
    expect(html).toContain('M4 6h16M4 12h16M4 18h16');
  });

  // BUILD-FLOFI-CHAT-EDITOR-UX-001: "Build Workflow" is now "Editor", current on each Editor section like the top bar (Simulate here).
  // P0 approved UX (board 03b): the only navigation — New workflow (where the Chat entry exists), Editor, Dashboard; Library: Your workflows,
  // Automations; Access: Credentials, Agents, Passkeys; then Log out; Terms · Privacy on one line. Agents carries "In testing", never a dead control.
  it('orders the drawer as approved, with grouped Library and Access and a separate bottom Log out action', () => {
    const html = render({ section: 'Simulate' });
    expect(html.match(/class="navigation-row"/g)).toHaveLength(8);
    expect(html).toContain('<p class="navigation-legal"><a href="/terms">Terms</a>');
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('href="/app/dashboard"');
    expect(html).toContain('href="/app"');
    const labels = [...html.matchAll(/<span>(New workflow|Dashboard|Chat|Editor|Your workflows|Automations|Credentials|Agents|Passkeys|Log out)<\/span>/g)].map(match => match[1]);
    expect(labels).toEqual(['Editor', 'Dashboard', 'Your workflows', 'Automations', 'Credentials', 'Agents', 'Passkeys', 'Log out']);
    expect([...html.matchAll(/class="navigation-section-label"[^>]*>([^<]+)</g)].map(match => match[1])).toEqual(['Library', 'Access']);
    expect(html).not.toContain('Build Workflow');
    expect(html).toMatch(/class="navigation-footer"><button type="button" class="navigation-row" disabled="">(?:(?!<\/button>)[\s\S])*<span>Log out<\/span>/);
    for (const item of SECONDARY_WORKSPACES) {
      expect(html).toContain(`href="${item.href}"`);
      expect(html).toContain(`<span>${item.label}</span>`);
    }
    // "In testing" is a status next to Agents (not clickable on its own); no disabled control pretends to work.
    expect(html).toMatch(/<span>Agents<\/span><span class="navigation-status" data-status="testing">In testing<\/span>/);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="page" href="\/app">(?:(?!<\/a>)[\s\S])*<span>Editor<\/span>/);
    expect(html).not.toMatch(/aria-pressed=|role="dialog"|aria-modal=/);
  });

  it.each(SECONDARY_WORKSPACES)('marks only the $label route as current', item => {
    const html = render({ pathname: item.href });
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toContain(`class="navigation-row" aria-current="page" href="${item.href}"`);
    expect(secondaryWorkspaceRoute(`${item.href}/`)).toEqual(item);
  });

  it.each([
    { pathname: '/app/dashboard', section: 'Dashboard' as const, href: '/app/dashboard' },
    { pathname: '/app/dashboard/runs/owner-run', section: 'Dashboard' as const, href: '/app/dashboard' },
    { pathname: '/app', section: 'Build' as const, href: '/app' },
  ])('selects only the existing $section workspace for $pathname', ({ pathname, section, href }) => {
    const html = render({ pathname, section });
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toContain(`class="navigation-row" aria-current="page" href="${href}"`);
  });

  it.each(['Build', 'Simulate', 'Execute'] as const)('selects only the Editor in its %s section, as the top bar does', section => {
    const html = render({ pathname: '/app', section });
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="page" href="\/app">(?:(?!<\/a>)[\s\S])*<span>Editor<\/span>/);
  });

  it('offers New workflow (the Chat entry) only where the shell has it, current on the entry, with the shell click targets', () => {
    const calls: string[] = [];
    const without = render({ pathname: '/app', section: 'Chat' });
    expect(without).not.toContain('<span>New workflow</span>');
    expect(without).not.toContain('aria-current="page"');
    const html = render({ pathname: '/app', section: 'Chat', onChat: () => calls.push('chat'), onBuild: () => calls.push('build') });
    const labels = [...html.matchAll(/<span>(New workflow|Dashboard|Editor|Your workflows)<\/span>/g)].map(match => match[1]);
    expect(labels).toEqual(['New workflow', 'Editor', 'Dashboard', 'Your workflows']);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="page" href="\/app">(?:(?!<\/a>)[\s\S])*<span>New workflow<\/span>/);
    expect(render({ pathname: '/app', section: 'Execute', onChat: () => undefined })).toMatch(/aria-current="page" href="\/app">(?:(?!<\/a>)[\s\S])*<span>Editor<\/span>/);
    expect(calls).toEqual([]);
  });

  it('enables Log out only when the existing disconnect availability permits it', () => {
    expect(render({ disconnectDisabled: false })).toMatch(/class="navigation-footer"><button type="button" class="navigation-row">(?:(?!<\/button>)[\s\S])*<span>Log out<\/span>/);
  });

  it.each(['/app', '/app/dashboard', '/app/credentials/unknown', null, undefined])('does not select a secondary workspace for %s', pathname => {
    expect(secondaryWorkspaceRoute(pathname)).toBeNull();
  });
});
