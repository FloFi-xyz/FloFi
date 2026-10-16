// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AdminBrand } from './admin-brand';
import { AdminShell } from './admin-shell';
import type { AdminContext } from '../../admin/guard';

const file = (path: string) => readFileSync(new URL(path, import.meta.url));
const digest = (path: string) => createHash('sha256').update(file(path)).digest('hex');

describe('BUILD-FLOFI-UX-UI-002 admin identity', () => {
  it('uses the approved symbol and wordmark for both console themes, never the legacy Gryloo artwork', () => {
    const html = renderToStaticMarkup(createElement(AdminBrand));
    expect(html).not.toContain('/flofi-logo.png');
    for (const theme of ['light', 'dark'] as const) {
      const symbol = `/brand/flofi-symbol-${theme}.svg`, wordmark = `/brand/flofi-wordmark-${theme}.png`;
      expect(html).toContain(theme === 'dark' ? `srcSet="${symbol}"` : `src="${symbol}"`);
      expect(html).toContain(theme === 'dark' ? `srcSet="${wordmark}"` : `src="${wordmark}"`);
    }
    // Dark artwork follows the same media query as the console palette in admin.css.
    expect(html.match(/media="\(prefers-color-scheme: dark\)"/g)).toHaveLength(2);
    expect(file('../../app/admin/admin.css').toString()).toContain('@media (prefers-color-scheme:dark)');
    // Intrinsic sizes match the supplied artwork, so CSS scales them without distortion.
    expect(html).toContain('width="370" height="345"');
    expect(html).toContain('width="738" height="280"');
    // One accessible name: the wordmark reads "FloFi", the symbol is decorative.
    expect(html).toContain('alt="FloFi"');
    expect(html.match(/alt=""/g)).toHaveLength(1);
    expect(html).toContain('Admin');
    expect(html).toContain('Private console');
  });

  it('the console frame renders the same identity, and the legacy file is the former Gryloo artwork', () => {
    const context = { principal: { account: '0x' + 'a'.repeat(40), role: 'ADMIN' }, csrf: 'c'.repeat(32) } as unknown as AdminContext;
    const html = renderToStaticMarkup(createElement(AdminShell, { active: 'overview', context, title: 'Overview', children: null }));
    expect(html).toContain('/brand/flofi-symbol-light.svg');
    expect(html).not.toContain('/flofi-logo.png');
    expect(digest('../../../public/flofi-logo.png')).toBe(digest('../../../public/gryloo-logo.png'));
    for (const source of ['./admin-shell.tsx', '../../app/admin/login/page.tsx']) expect(file(source).toString()).not.toContain('/flofi-logo.png');
  });
});
