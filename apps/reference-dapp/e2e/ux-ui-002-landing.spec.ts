// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UX-UI-002: community links, the conversation demo, the assistant onboarding and the restored mascot journey on the real
 * landing. Read-only: every request outside the app origin is refused, nothing connects a wallet and nothing is sent.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const evidence = process.env.FLOFI_UX_EVIDENCE ? 'e2e/visual-evidence/flofi-ux-ui-002' : null;
if (evidence) mkdirSync(evidence, { recursive: true });
const SOCIAL = [
  ['x', 'https://x.com/FloFi_xyz', 'FloFi on X (opens in a new tab)', 'FloFi no X (abre em nova aba)'],
  ['discord', 'https://discord.gg/36rEhdUa', 'FloFi community on Discord (opens in a new tab)', 'Comunidade FloFi no Discord (abre em nova aba)'],
  ['linkedin', 'https://www.linkedin.com/company/flofixyz/home/', 'FloFi on LinkedIn (opens in a new tab)', 'FloFi no LinkedIn (abre em nova aba)'],
  ['telegram', 'https://t.me/FloFiAppBot', 'Chat with FloFi on Telegram (opens in a new tab)', 'Converse com a FloFi no Telegram (abre em nova aba)'],
] as const;

async function guard(page: Page, baseURL: string | undefined) {
  const external: string[] = [], actions: string[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', event => { if (event.type() === 'error' || /hydration|did not match/i.test(event.text())) errors.push(event.text()); });
  await page.context().route('**/*', route => {
    const request = route.request();
    if (new URL(request.url()).origin !== new URL(baseURL!).origin) { external.push(request.url()); return route.abort(); }
    // The landing makes no server-action or API call; record any so the demo can prove it sends nothing.
    if (request.method() !== 'GET' || request.headers()['next-action'] || new URL(request.url()).pathname.startsWith('/api/')) actions.push(`${request.method()} ${request.url()}`);
    return route.continue();
  });
  // Every storage write is recorded; the demo must add none.
  await page.addInitScript(() => {
    const writes: string[] = [];
    (window as unknown as { __storageWrites: string[] }).__storageWrites = writes;
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) { writes.push(key); return original.call(this, key, value); };
    sessionStorage.setItem('flofi-alive-intro-v1', 'seen');
  });
  return { external, actions, errors };
}
const writes = (page: Page) => page.evaluate(() => (window as unknown as { __storageWrites: string[] }).__storageWrites.filter(key => key !== 'flofi-alive-intro-v1'));

for (const width of [320, 375, 390, 768, 1024, 1440, 1920]) {
  test(`community links near the hero CTAs and in the footer are recognizable, safe and usable at ${width}px (EN/PT)`, async ({ page, baseURL }) => {
    const seen = await guard(page, baseURL);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/'); await page.evaluate(() => document.fonts.ready);
    for (const locale of ['en', 'pt'] as const) {
      await page.getByRole('button', { name: locale.toUpperCase(), exact: true }).click();
      for (const area of ['hero', 'footer'] as const) {
        const group = page.locator(`[data-social-links="${area}"]`);
        await group.scrollIntoViewIfNeeded();
        await expect(group.getByRole('list', { name: locale === 'en' ? 'Community' : 'Comunidade', exact: true })).toBeVisible();
        for (const [id, href, en, pt] of SOCIAL) {
          const link = group.getByRole('link', { name: locale === 'en' ? en : pt, exact: true });
          await expect(link).toHaveAttribute('href', href);
          await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
          await expect(link).toHaveAttribute('target', '_blank');
          await expect(link.locator('img')).toHaveJSProperty('complete', true);
          expect(await link.locator('img').evaluate(img => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
          expect(await link.evaluate(element => {
            const box = element.getBoundingClientRect();
            return box.width >= 44 && box.height >= 44 && box.left >= 0 && box.right <= innerWidth && element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
          }), `${area} ${id}`).toBe(true);
        }
        // Distinct from the product CTAs: no button styling, never inside the CTA row.
        expect(await group.evaluate(element => !element.closest('[class*="heroActions"]') && !element.querySelector('[class*="primaryButton"], [class*="secondaryButton"]'))).toBe(true);
      }
      // Keyboard order: the hero CTAs, then the community links.
      await page.locator('#workflow').getByRole('link', { name: locale === 'en' ? /Explore Docs/ : /Explorar Docs/ }).focus();
      await page.keyboard.press('Tab');
      await expect(page.locator('[data-social-links="hero"] a[data-social="x"]')).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (evidence && [390, 1440].includes(width)) {
        await page.locator('#workflow').screenshot({ path: `${evidence}/hero-social-${locale}-${width}.png`, animations: 'disabled' });
        await page.locator('footer').screenshot({ path: `${evidence}/footer-social-${locale}-${width}.png`, animations: 'disabled' });
      }
    }
    expect(seen.external).toEqual([]); expect(seen.errors).toEqual([]);
  });
}

test.describe('motion allowed', () => {
  test.use({ reducedMotion: 'no-preference' });

  for (const width of [390, 1440]) {
    test(`conversation demo plays a bounded illustration, reacts with the mascot and sends or stores nothing at ${width}px`, async ({ page, baseURL }) => {
      const seen = await guard(page, baseURL);
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/'); await page.evaluate(() => document.fonts.ready);
      const demo = page.locator('#demo'), stage = demo.locator('[data-demo-step]');
      // Before it is seen, the illustration waits at its start; once in view it finishes in under five seconds and stays.
      await expect(stage).toHaveAttribute('data-demo-step', '0');
      await stage.scrollIntoViewIfNeeded();
      const started = Date.now();
      await expect(stage).toHaveAttribute('data-demo-step', '5', { timeout: 6_000 });
      expect(Date.now() - started).toBeLessThan(5_500);
      await expect(demo).toContainText('Illustration');
      await expect(demo).toContainText('Nothing runs until you sign.');
      await expect(demo.locator('[data-demo-card]')).toHaveCount(1);
      // The mascot is the assistant's avatar here: its dock becomes the active scene (traveller on desktop, its own character on mobile).
      const dock = demo.locator('[data-mascot-dock="demo"]');
      await dock.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await expect(dock).toHaveAttribute('data-active', 'true');
      const character = width <= 760 ? dock.locator('[data-mascot-character]') : page.locator('[data-mascot-traveler] [data-mascot-character]');
      await expect(character).toBeVisible();
      if (evidence) await demo.screenshot({ path: `${evidence}/demo-swap-${width}.png` });
      // A visitor's choice replays the same honest sequence for another fixed request (keyboard operable).
      const lend = demo.getByRole('button', { name: 'Lend', exact: true });
      await lend.focus(); await page.keyboard.press('Enter');
      await expect(lend).toHaveAttribute('aria-pressed', 'true');
      await expect(stage).toHaveAttribute('data-demo', 'lend');
      await expect(stage).toHaveAttribute('data-demo-step', '5', { timeout: 6_000 });
      await expect(demo.locator('[data-demo-card]')).toHaveCount(2);
      await expect(demo).toContainText('Borrowing limit');
      await expect(demo).toContainText('Supply 1 ETH on Aave and borrow 500 USDC');
      await demo.getByRole('button', { name: 'Swap + bridge', exact: true }).click();
      await expect(stage).toHaveAttribute('data-demo-step', '5', { timeout: 6_000 });
      await expect(demo).toContainText('Base → Arbitrum');
      if (evidence) await demo.screenshot({ path: `${evidence}/demo-bridge-${width}.png` });
      await page.getByRole('button', { name: 'PT', exact: true }).click();
      await expect(demo).toContainText('Nada é executado até você assinar.');
      await expect(demo.getByRole('button', { name: 'Empréstimo', exact: true })).toBeVisible();
      expect(seen.actions).toEqual([]); expect(await writes(page)).toEqual(['flofi-landing-language']);
      await expect(demo.locator('input, textarea, form')).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(seen.external).toEqual([]); expect(seen.errors).toEqual([]);
    });

    test(`assistant onboarding shows the documented Claude and ChatGPT connection, then the illustrated tool sequence at ${width}px`, async ({ page, context, baseURL }) => {
      const seen = await guard(page, baseURL);
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL! });
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/'); await page.evaluate(() => document.fonts.ready);
      const section = page.locator('#assistants');
      await section.scrollIntoViewIfNeeded();
      const tabs = section.getByRole('tablist', { name: 'Choose your assistant' });
      const claude = tabs.getByRole('tab', { name: 'Claude' }), chatgpt = tabs.getByRole('tab', { name: 'ChatGPT' });
      await expect(claude).toHaveAttribute('aria-selected', 'true');
      const panel = section.getByRole('tabpanel');
      await expect(panel).toContainText('Settings → Connectors → Add custom connector');
      await expect(panel).toContainText('https://flofi.xyz/api/mcp');
      await expect(panel).toContainText('There is no one-click install');
      const chat = panel.locator('[data-assistant-step]');
      await chat.scrollIntoViewIfNeeded();
      await expect(chat).toHaveAttribute('data-assistant-step', '5', { timeout: 6_000 });
      for (const tool of ['compose_strategy', 'simulate_strategy', 'request_user_approval']) await expect(chat).toContainText(tool);
      await expect(chat).toContainText('connect your wallet, run a fresh simulation, review the Strategy Manifest and sign');
      if (evidence) await section.screenshot({ path: `${evidence}/assistants-claude-${width}.png` });
      // Arrow keys move between tabs (WAI-ARIA tabs); the sequence replays for the selected assistant.
      await claude.focus(); await page.keyboard.press('ArrowRight');
      await expect(chatgpt).toBeFocused(); await expect(chatgpt).toHaveAttribute('aria-selected', 'true');
      await expect(panel).toContainText('Developer mode');
      // On one column the chat sits below the steps: the replay waits until it is actually seen.
      await chat.scrollIntoViewIfNeeded();
      await expect(chat).toHaveAttribute('data-assistant-step', '5', { timeout: 6_000 });
      if (evidence) await section.screenshot({ path: `${evidence}/assistants-chatgpt-${width}.png` });
      await panel.getByRole('button', { name: 'Copy URL' }).click();
      await expect(panel.getByRole('button', { name: 'Copied' })).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('https://flofi.xyz/api/mcp');
      await expect(section).toContainText('Assistants never sign or move funds.');
      await page.getByRole('button', { name: 'PT', exact: true }).click();
      await expect(section.getByRole('tablist', { name: 'Escolha seu assistente' })).toBeVisible();
      await expect(section).toContainText('Não há instalação com um clique');
      expect(seen.actions).toEqual([]);
      const guide = section.getByRole('link', { name: /Ler o guia MCP/ });
      await expect(guide).toHaveAttribute('href', '/docs/mcp-integrations');
      await guide.click();
      await expect(page).toHaveURL(/\/docs\/mcp-integrations$/);
      await expect(page.getByRole('heading', { level: 1, name: 'MCP Integrations' })).toBeVisible();
      expect(seen.external).toEqual([]); expect(seen.errors).toEqual([]);
    });
  }

  test('the restored mascot journey runs by default: intro, travel through the new sections, no CTA interception', async ({ page, baseURL }) => {
    const seen = await guard(page, baseURL);
    await page.addInitScript(() => sessionStorage.removeItem('flofi-alive-intro-v1'));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    const root = page.locator('[data-mascot-motion="true"]');
    await expect(root).toHaveAttribute('data-alive', 'running');
    await expect(root).toHaveAttribute('data-intro', /playing|complete/);
    await page.getByRole('button', { name: 'Skip intro', exact: true }).click({ timeout: 5_000 }).catch(() => undefined);
    await expect(root).toHaveAttribute('data-intro', 'complete');
    for (const scene of ['hero', 'demo', 'assistants', 'networks', 'infrastructure', 'cta']) {
      const dock = page.locator(`[data-mascot-dock="${scene}"]`);
      await dock.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await expect(dock).toHaveAttribute('data-active', 'true');
      await expect(page.locator('[data-mascot-journey]')).toHaveAttribute('data-scene', scene);
    }
    // The traveller never takes pointer events: the closing CTA stays clickable under it.
    const cta = page.locator('#about').getByRole('link', { name: 'Launch FloFi', exact: true });
    expect(await cta.evaluate(element => { const box = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)); })).toBe(true);
    expect(await page.locator('[data-mascot-traveler]').evaluate(element => getComputedStyle(element).pointerEvents)).toBe('none');
    // Reloading in the same tab never replays the intro.
    await page.reload();
    await expect(page.locator('[data-mascot-motion="true"]')).toHaveAttribute('data-intro', 'skipped');
    expect(seen.external).toEqual([]); expect(seen.errors).toEqual([]);
  });
});

test('reduced motion shows the complete demo and onboarding at once, with the still mascot and no running animation', async ({ page, baseURL }) => {
  const seen = await guard(page, baseURL);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('[data-mascot-motion]')).toHaveAttribute('data-alive', 'still');
  for (const [selector, attribute] of [['#demo [data-demo-step]', 'data-demo-step'], ['#assistants [data-assistant-step]', 'data-assistant-step']] as const) {
    await expect(page.locator(selector)).toHaveAttribute(attribute, '5');
    await page.locator(selector).scrollIntoViewIfNeeded();
    await expect(page.locator(selector)).toHaveAttribute(attribute, '5');
  }
  await page.locator('#demo').getByRole('button', { name: 'Lend', exact: true }).click();
  await expect(page.locator('#demo [data-demo-step]')).toHaveAttribute('data-demo-step', '5');
  expect(await page.locator('main').evaluate(element => [...element.querySelectorAll('*')].flatMap(item => item.getAnimations()).length)).toBe(0);
  expect(seen.external).toEqual([]); expect(seen.errors).toEqual([]);
});
