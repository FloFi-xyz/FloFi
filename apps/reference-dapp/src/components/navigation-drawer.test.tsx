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
  it('contains seven ordered workspace links and a separate bottom Logout action', () => {
    const html = render({ section: 'Simulate' });
    expect(html.match(/class="navigation-row"/g)).toHaveLength(8);
    expect(html).toContain('href="/app/dashboard"');
    expect(html).toContain('href="/app"');
    const labels = [...html.matchAll(/<span>(Dashboard|Chat|Editor|Your workflows|Automations|Credentials|Agents|Passkeys|Logout)<\/span>/g)].map(match => match[1]);
    expect(labels).toEqual(['Dashboard', 'Editor', 'Your workflows', 'Automations', 'Credentials', 'Agents', 'Passkeys', 'Logout']);
    expect(html).not.toContain('Build Workflow');
    expect(html).toMatch(/class="navigation-footer"><button[^>]*aria-label="Logout"[^>]*disabled=""/);
    for (const item of SECONDARY_WORKSPACES) {
      expect(html).toContain(`href="${item.href}"`);
      expect(html).toContain(`<span>${item.label}</span>`);
    }
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="page" href="\/app">(?:(?!<\/a>)[\s\S])*<span>Editor<\/span>/);
    expect(html).not.toMatch(/aria-pressed=|coming soon|role="dialog"|aria-modal=/);
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

  it('offers Chat only where the top bar does, current on the intent entry, with the top bar click targets', () => {
    const calls: string[] = [];
    const without = render({ pathname: '/app', section: 'Chat' });
    expect(without).not.toContain('<span>Chat</span>');
    expect(without).not.toContain('aria-current="page"');
    const html = render({ pathname: '/app', section: 'Chat', onChat: () => calls.push('chat'), onBuild: () => calls.push('build') });
    const labels = [...html.matchAll(/<span>(Dashboard|Chat|Editor|Your workflows)<\/span>/g)].map(match => match[1]);
    expect(labels).toEqual(['Dashboard', 'Chat', 'Editor', 'Your workflows']);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="page" href="\/app">(?:(?!<\/a>)[\s\S])*<span>Chat<\/span>/);
    expect(render({ pathname: '/app', section: 'Execute', onChat: () => undefined })).toMatch(/aria-current="page" href="\/app">(?:(?!<\/a>)[\s\S])*<span>Editor<\/span>/);
    expect(calls).toEqual([]);
  });

  it('enables Logout only when the existing disconnect availability permits it', () => {
    expect(render({ disconnectDisabled: false })).toMatch(/aria-label="Logout"(?! disabled)/);
  });

  it.each(['/app', '/app/dashboard', '/app/credentials/unknown', null, undefined])('does not select a secondary workspace for %s', pathname => {
    expect(secondaryWorkspaceRoute(pathname)).toBeNull();
  });
});
