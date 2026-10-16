// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import LandingPage from './page';
import { landingText } from './landing-copy';
import { SOCIAL_LINKS, SocialLinks } from './social-links';
import { ConversationDemo, DEMO_SCENARIOS } from './conversation-demo';
import { ASSISTANT_HOSTS, AssistantOnboarding, FLOFI_MCP_URL, ILLUSTRATED_TOOLS } from './assistant-onboarding';
import { APPROVAL_TOOL_NAMES, MCP_TOOL_NAMES } from '../../mcp/tools';
import { articles } from '../docs/content';

const read = (path: string) => readFileSync(new URL(path, import.meta.url));
const publicFile = (path: string) => read(`../../../public${path}`);
const between = (html: string, start: string, end: string) => html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)));

describe('BUILD-FLOFI-UX-UI-002 landing', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('community links use the owner-supplied accounts, safe external links and the registered official marks (EN/PT)', () => {
    expect(SOCIAL_LINKS.map(link => link.href)).toEqual(['https://x.com/FloFi_xyz', 'https://discord.gg/36rEhdUa',
      'https://www.linkedin.com/company/flofixyz/home/', 'https://t.me/FloFiAppBot']);
    const register = read('../../../public/brand/social/sources.md').toString() + read('../../../public/brand/channels/sources.md').toString();
    for (const link of SOCIAL_LINKS) {
      expect(register).toContain(createHash('sha256').update(publicFile(link.mark)).digest('hex'));
    }
    for (const locale of ['en', 'pt'] as const) {
      const t = landingText[locale];
      for (const variant of ['hero', 'footer'] as const) {
        const html = renderToStaticMarkup(createElement(SocialLinks, { t, variant }));
        expect(html.match(/<a /g)).toHaveLength(4);
        expect(html.match(/target="_blank" rel="noopener noreferrer"/g)).toHaveLength(4);
        for (const label of [t.socialX, t.socialDiscord, t.socialLinkedIn, t.socialTelegram]) expect(html).toContain(`aria-label="${label}"`);
        expect(html).toContain(t.socialLabel);
        // The list is named by its visible label; marks are decorative.
        expect(html).toMatch(/<p id="([^"]+)">[^<]+<\/p><ul aria-labelledby="\1">/);
        expect(html.match(/alt=""/g)).toHaveLength(4);
      }
    }
    expect(landingText.pt.socialX).toContain('abre em nova aba');
  });

  it('renders the restored mascot journey by default, the new sections in order, and community links near the hero CTAs and in the footer', () => {
    const html = renderToStaticMarkup(createElement(LandingPage));
    expect(html).toContain('data-mascot-motion="true"');
    expect(html).toContain('data-mascot-journey');
    for (const scene of ['hero', 'demo', 'assistants', 'networks', 'infrastructure', 'cta']) expect(html).toContain(`data-mascot-dock="${scene}"`);
    expect([...html.matchAll(/<section[^>]* id="([a-z]+)"/g)].map(match => match[1])).toEqual(['workflow', 'demo', 'assistants', 'networks', 'developers', 'about']);
    const hero = between(html, 'id="workflow"', '</section>');
    expect(hero.indexOf('href="/docs"')).toBeLessThan(hero.indexOf('data-social-links="hero"'));
    expect(between(html, '<footer', '</footer>')).toContain('data-social-links="footer"');
    // Nothing on the landing may look like test infrastructure (the CI landing rule).
    const main = between(html, '<main', '</main>').replace(/<[^>]+>/g, ' ');
    expect(main).not.toMatch(/devnet|testnet|sepolia|mock|sandbox|synthetic|simulated.only|test.funds/i);
  });

  it('the build-time off switch still removes the mascot experience', async () => {
    vi.stubEnv('NEXT_PUBLIC_FLOFI_MASCOT_MOTION', 'false');
    const { mascotMotionEnabled } = await import('./mascot-journey');
    expect(mascotMotionEnabled).toBe(false);
  });

  it('the conversation demo is a bounded illustration: fixed requests, no input, no fabricated results (EN/PT)', () => {
    for (const locale of ['en', 'pt'] as const) {
      const t = landingText[locale];
      const html = renderToStaticMarkup(createElement(ConversationDemo, { t, locale }));
      expect(html).not.toMatch(/<(input|textarea|form)\b/);
      expect(html.match(/<button /g)).toHaveLength(DEMO_SCENARIOS.length);
      expect(html).toContain(t.demoIllustration);
      expect(html).toContain(t.demoFinal);
      expect(html).toContain(t.demoNote);
      // Server HTML is the complete final state; motion only replays it.
      expect(html).toContain(`data-demo-step="5"`);
      const text = html.replace(/<[^>]+>/g, ' ');
      expect(text).not.toMatch(/0x[0-9a-f]{6,}|\bAPY\b|%|confirmed|confirmad|success|sucesso|\bexecuted\b|executad[oa] com|balance|saldo|\d{1,2}:\d{2}/i);
    }
    // Only the visitor's own example amounts appear.
    expect(DEMO_SCENARIOS.flatMap(s => s.cards.flatMap(c => c.amount ? [c.amount[0]] : []))).toEqual(['0.5', '0.5', '1', '500']);
  });

  it('the MCP onboarding names the deployed endpoint, real tools and the docs guide, without one-click or in-chat signing claims', () => {
    expect(FLOFI_MCP_URL).toBe('https://flofi.xyz/api/mcp');
    for (const tool of ILLUSTRATED_TOOLS) expect([...MCP_TOOL_NAMES, ...APPROVAL_TOOL_NAMES] as string[]).toContain(tool);
    expect(articles.some(article => article.slug === 'mcp-integrations')).toBe(true);
    expect(ASSISTANT_HOSTS.map(host => host.name)).toEqual(['Claude', 'ChatGPT']);
    for (const locale of ['en', 'pt'] as const) {
      const t = landingText[locale];
      const html = renderToStaticMarkup(createElement(AssistantOnboarding, { t }));
      expect(html).toContain('href="/docs/mcp-integrations"');
      expect(html).toContain(FLOFI_MCP_URL);
      expect(html).toContain('role="tablist"');
      expect(html.match(/role="tab"/g)).toHaveLength(2);
      expect(html).toContain(t.assistantsSafety);
      expect(html).toContain(t.assistantsNotOneClick);
      expect(html).not.toMatch(/one-click install(?!:)|sign (?:in|inside) (?:the )?chat/i);
    }
    // The connector paths are the operator guide's (docs/deploy/MCP.md §2).
    const guide = read('../../../../../docs/deploy/MCP.md').toString();
    expect(guide).toContain('Settings → Connectors → Add custom connector');
    expect(guide).toContain('Settings → Apps & Connectors → Advanced → Developer mode');
  });

  it('scrolling never hides an Earth layer: it only pauses the clocks of the original artwork passes', () => {
    const css = read('./landing.module.css').toString();
    expect(css).not.toMatch(/data-earth-active="false"[^{]*\{[^}]*visibility\s*:\s*hidden/);
    expect(css).toMatch(/\.horizon\[data-earth-active="true"\][^{]*\{[^}]*animation-play-state:\s*running/);
    expect(css).toContain('.earthSurface { animation: earthSurfaceRotation 60s linear infinite; animation-play-state: paused; }');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.earthSurface \{ animation: none; opacity: 0; \}/);
    const source = read('./earth-atmosphere.tsx').toString();
    expect(source).toContain('href="/flofi/closing-horizon-v2.png"');
    expect(source).toContain('data-earth-active="false"');
  });
});
