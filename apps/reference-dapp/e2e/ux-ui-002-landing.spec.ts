// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UX-UI-002: community links, the "How it works" story, the assistant onboarding and the restored mascot journey on the real
 * landing. Read-only: every request outside the app origin is refused, nothing connects a wallet and nothing is sent.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { DEMO_CUES, DEMO_END } from '../src/components/marketing/demo-timeline';
import { landingText } from '../src/components/marketing/landing-copy';

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

const CUE_ORDER = ['idle', ...Object.keys(DEMO_CUES)];
const CLOCK_START = new Date('2026-10-16T12:00:00Z').getTime();
type DemoSnapshot = { at: number; cue: string; state: string; stage: string; typed: number; supply: string; borrow: string; connector: string;
  supplyLine: string; borrowLine: string; simulateLine: string; thinking: string; mascot: string };

/** Records every distinct frame of the How it works stage, so a test can show that one ordered timeline drove the chat and the Canvas. */
async function recordDemo(page: Page) {
  await page.evaluate(() => {
    const store = window as unknown as { __demo: Record<string, unknown>[] };
    const stage = document.querySelector<HTMLElement>('#demo [data-demo-cue]')!;
    const attr = (selector: string, name: string) => stage.querySelector(selector)?.getAttribute(name) ?? '';
    store.__demo = [];
    const take = () => {
      const composing = attr('[data-demo-composer]', 'data-composing') === 'true';
      const dock = document.querySelector<HTMLElement>('[data-mascot-dock="demo"]');
      const character = innerWidth <= 760 ? dock?.querySelector<HTMLElement>('[data-mascot-character]') : document.querySelector<HTMLElement>('[data-mascot-traveler] [data-mascot-character]');
      const frame: Record<string, unknown> = { cue: stage.dataset.demoCue, state: stage.dataset.demoState, stage: stage.dataset.demoStage,
        typed: composing ? stage.querySelector('[data-demo-composer]')!.textContent!.length : -1,
        supply: attr('[data-demo-card="supply"]', 'data-state'), borrow: attr('[data-demo-card="borrow"]', 'data-state'), connector: attr('[data-demo-connector]', 'data-shown'),
        supplyLine: attr('[data-demo-line="supply"]', 'data-status'), borrowLine: attr('[data-demo-line="borrow"]', 'data-status'),
        simulateLine: attr('[data-demo-line="simulate"]', 'data-status'), thinking: attr('[data-demo-thinking]', 'data-shown'),
        mascot: dock?.dataset.active === 'true' ? character?.dataset.state ?? '' : 'inactive' };
      const last = store.__demo.at(-1);
      if (!last || Object.entries(frame).some(([key, value]) => last[key] !== value)) store.__demo.push({ at: performance.now(), ...frame });
    };
    take();
    new MutationObserver(take).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['data-demo-cue', 'data-demo-state', 'data-state', 'data-status', 'data-shown', 'data-composing', 'data-active'] });
  });
}
const recorded = (page: Page) => page.evaluate(() => (window as unknown as { __demo: unknown[] }).__demo) as Promise<DemoSnapshot[]>;

function expectOneSynchronizedStory(frames: DemoSnapshot[], promptLength: number) {
  const played = frames.filter(frame => frame.state !== 'static');
  // Every cue once, in the owner order: one timeline, never two overlapping or restarting ones.
  expect(played.map(frame => frame.cue).filter((cue, i, all) => cue !== all[i - 1])).toEqual(CUE_ORDER);
  // The request is typed character by character into the composer.
  const typed = played.map(frame => frame.typed).filter(length => length >= 0);
  expect(typed[0]).toBeLessThanOrEqual(2);
  expect(typed.at(-1)).toBe(promptLength);
  expect(typed.every((length, i) => i === 0 || length >= typed[i - 1]!)).toBe(true);
  expect(new Set(typed).size).toBeGreaterThan(25);
  expect(played.some(frame => frame.thinking === 'true')).toBe(true);
  for (const frame of played) {
    // Each chat update and its Canvas change are one frame.
    expect(frame.supplyLine !== 'pending', JSON.stringify(frame)).toBe(frame.supply !== 'hidden');
    expect(frame.borrowLine !== 'pending', JSON.stringify(frame)).toBe(frame.borrow !== 'hidden');
    expect(frame.simulateLine === 'active', JSON.stringify(frame)).toBe(frame.stage === 'simulate');
    if (frame.connector === 'true') expect(frame.borrow, JSON.stringify(frame)).toBe('shown');
  }
}

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
    test(`How it works plays one synchronized story in real time: typed request, FloFi thinks and answers while the Canvas builds, simulates and reaches Execute at ${width}px`, async ({ page, baseURL }) => {
      test.setTimeout(75_000);
      const seen = await guard(page, baseURL);
      await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });
      await page.goto('/'); await page.evaluate(() => document.fonts.ready);
      const demo = page.locator('#demo'), stage = demo.locator('[data-demo-cue]');
      // Until it is seen, it waits on an empty chat and an empty Canvas.
      await expect(stage).toHaveAttribute('data-demo-cue', 'idle');
      await expect(stage).toHaveAttribute('data-demo-state', 'waiting');
      await expect(demo.locator('[data-demo-card][data-state="hidden"]')).toHaveCount(2);
      await recordDemo(page);
      const dock = demo.locator('[data-mascot-dock="demo"]');
      await dock.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
      await expect(stage).toHaveAttribute('data-demo-state', 'playing');
      await expect(dock).toHaveAttribute('data-active', 'true');
      await expect(stage).toHaveAttribute('data-demo-cue', 'done', { timeout: DEMO_END + 10_000 });
      const frames = await recorded(page);
      expectOneSynchronizedStory(frames, landingText.en.demoPrompt.length);
      // Natural, readable timing: the full story takes its scripted time, not a flash.
      const played = frames.filter(frame => frame.state === 'playing' || frame.state === 'done');
      expect(played.at(-1)!.at - played[0]!.at).toBeGreaterThanOrEqual(DEMO_END - 100);
      expect(played.at(-1)!.at - played[0]!.at).toBeLessThan(DEMO_END + 5_000);
      // The existing mascot controller reacted to the story: the jump is requested only when the workflow is ready.
      expect(frames.slice(frames.findIndex(frame => frame.cue === 'ready')).some(frame => frame.mascot === 'jump')).toBe(true);
      // The final state stays; it never loops.
      await page.waitForTimeout(1_500);
      await expect(stage).toHaveAttribute('data-demo-cue', 'done');
      await expect(stage).toHaveAttribute('data-demo-state', 'done');
      const execute = demo.locator('[data-panel="execute"]');
      await expect(execute).toBeVisible();
      for (const step of ['Strategy review', 'Wallet authorization', 'Execution', 'Status and reconciliation']) await expect(execute).toContainText(step);
      await expect(execute.locator('li[data-status="active"]')).toHaveCount(0);
      await expect(demo.locator('[data-demo-card][data-state="shown"]')).toHaveCount(2);
      const cta = demo.getByRole('link', { name: /Try it in FloFi/ });
      await expect(cta).toBeVisible(); await expect(cta).toHaveAttribute('href', '/app');
      await expect(demo.getByRole('button', { name: 'Replay the illustration' })).toBeVisible();
      await expect(demo).toContainText('No wallet is connected and nothing is sent.');
      await expect(demo.locator('[data-demo-card="borrow"]')).toContainText('Borrowing limit checked in simulation');
      // Truthful: no input, no request or server action, no storage, no invented number, hash or outcome.
      const text = await stage.innerText();
      expect(text).not.toMatch(/0x[0-9a-f]{6,}|\bAPY\b|%|confirmed|success|\bexecuted\b|\bcompleted?\b|receipt|\bhash\b|balance|health factor|\$\s?\d|\d{1,2}:\d{2}/i);
      expect(new Set(text.match(/\d+/g))).toEqual(new Set(['1', '2', '3', '4', '500']));
      await expect(demo.locator('input, textarea, form, select, iframe')).toHaveCount(0);
      expect(seen.actions).toEqual([]); expect(await writes(page)).toEqual([]);
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
    for (const scene of ['hero', 'networks', 'demo', 'assistants', 'infrastructure', 'cta']) {
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

test.describe('motion allowed, stepped by a fake clock', () => {
  test.use({ reducedMotion: 'no-preference' });

  test('How it works follows the visitor: keyboard pause and play, holds off screen and in a hidden tab, keeps its place across languages, replays', async ({ page, baseURL }) => {
    const seen = await guard(page, baseURL);
    await page.clock.install({ time: CLOCK_START });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/'); await page.evaluate(() => document.fonts.ready);
    await page.clock.pauseAt(CLOCK_START + 60_000);
    const demo = page.locator('#demo'), stage = demo.locator('[data-demo-cue]');
    const advance = async (ms: number, cue: string) => { await page.clock.runFor(ms); await expect(stage).toHaveAttribute('data-demo-cue', cue); };
    const setHidden = (hidden: boolean) => page.evaluate(value => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => value });
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);
    // Time passing before the section is seen starts nothing.
    await page.clock.runFor(10_000);
    await expect(stage).toHaveAttribute('data-demo-cue', 'idle');
    await stage.scrollIntoViewIfNeeded();
    await expect(stage).toHaveAttribute('data-demo-state', 'playing');
    await advance(DEMO_CUES.reply + 30, 'reply');
    // The visitor pauses it from the keyboard: nothing advances while paused.
    await demo.getByRole('button', { name: 'Pause the illustration' }).focus();
    await page.keyboard.press('Enter');
    await expect(stage).toHaveAttribute('data-demo-state', 'paused');
    await expect(demo.getByRole('button', { name: 'Play the illustration' })).toBeFocused();
    await page.clock.runFor(20_000);
    await expect(stage).toHaveAttribute('data-demo-cue', 'reply');
    await page.keyboard.press('Space');
    await expect(stage).toHaveAttribute('data-demo-state', 'playing');
    await advance(DEMO_CUES.supplyGhost - DEMO_CUES.reply + 30, 'supplyGhost');
    // Scrolled away it holds; seen again, it resumes where it was.
    await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
    await expect(stage).toHaveAttribute('data-demo-state', 'waiting');
    await page.clock.runFor(20_000);
    await expect(stage).toHaveAttribute('data-demo-cue', 'supplyGhost');
    await stage.scrollIntoViewIfNeeded();
    await expect(stage).toHaveAttribute('data-demo-state', 'playing');
    await advance(DEMO_CUES.supplyCard - DEMO_CUES.supplyGhost + 30, 'supplyCard');
    // A hidden tab holds it too.
    await setHidden(true);
    await expect(stage).toHaveAttribute('data-demo-state', 'waiting');
    await page.clock.runFor(20_000);
    await expect(stage).toHaveAttribute('data-demo-cue', 'supplyCard');
    await setHidden(false);
    await expect(stage).toHaveAttribute('data-demo-state', 'playing');
    // Changing the language translates the story in place; it does not restart. (The header switch scrolls away; the story holds.)
    await page.getByRole('button', { name: 'PT', exact: true }).click();
    await stage.scrollIntoViewIfNeeded();
    await expect(stage).toHaveAttribute('data-demo-state', 'playing');
    await expect(stage).toHaveAttribute('data-demo-cue', 'supplyCard');
    await expect(demo.locator('[data-demo-line="supply"]')).toHaveText('Adicionando a etapa de depósito…');
    await expect(demo.locator('[data-demo-card="supply"]')).toContainText('1. Depositar');
    await expect(demo.getByRole('button', { name: 'Pausar a ilustração' })).toBeVisible();
    await page.getByRole('button', { name: 'EN', exact: true }).click();
    await stage.scrollIntoViewIfNeeded();
    await expect(stage).toHaveAttribute('data-demo-state', 'playing');
    await page.clock.runFor(DEMO_END);
    await expect(stage).toHaveAttribute('data-demo-cue', 'done');
    await expect(stage).toHaveAttribute('data-demo-state', 'done');
    await page.clock.runFor(120_000);
    await expect(stage).toHaveAttribute('data-demo-cue', 'done');
    // Keyboard order at the end: the control, then the closing link.
    const replay = demo.getByRole('button', { name: 'Replay the illustration' }), cta = demo.getByRole('link', { name: /Try it in FloFi/ });
    // The closing link is focusable as soon as it appears.
    expect(await cta.evaluate(element => getComputedStyle(element).visibility)).toBe('visible');
    await replay.focus(); await page.keyboard.press('Tab');
    await expect(cta).toBeFocused();
    // Replay restarts the same single timeline from an empty chat and Canvas.
    await replay.click();
    await expect(stage).toHaveAttribute('data-demo-cue', 'idle');
    await expect(stage).toHaveAttribute('data-demo-state', 'playing');
    await expect(demo.locator('[data-demo-card][data-state="hidden"]')).toHaveCount(2);
    await advance(DEMO_CUES.sent + 30, 'sent');
    await page.clock.runFor(DEMO_END);
    await expect(stage).toHaveAttribute('data-demo-cue', 'done');
    expect(seen.actions).toEqual([]); expect(new Set(await writes(page))).toEqual(new Set(['flofi-landing-language']));
    expect(seen.external).toEqual([]); expect(seen.errors).toEqual([]);
  });

  /** Key states of the story; times are on the demo timeline. */
  const KEY_STATES = [
    ['typing', DEMO_CUES.typing + 1_200], ['thinking', DEMO_CUES.thinking + 400], ['supply-created', DEMO_CUES.supplyCard + 600],
    ['borrow-connected', DEMO_CUES.connector + 900], ['simulate', DEMO_CUES.collateral + 400], ['execute', DEMO_CUES.wallet + 400], ['final', DEMO_END],
  ] as const;

  for (const width of [320, 375, 390, 768, 1024, 1440, 1920]) {
    test(`How it works stays readable at every stage at ${width}px (EN/PT): reading order, nothing clipped or overflowing, usable controls`, async ({ page, baseURL }) => {
      test.setTimeout(90_000);
      const seen = await guard(page, baseURL);
      await page.clock.install({ time: CLOCK_START });
      await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });
      await page.goto('/'); await page.evaluate(() => document.fonts.ready);
      await page.clock.pauseAt(CLOCK_START + 60_000);
      const demo = page.locator('#demo'), stage = demo.locator('[data-demo-cue]');
      for (const locale of ['en', 'pt'] as const) {
        await page.getByRole('button', { name: locale.toUpperCase(), exact: true }).click();
        await demo.locator('[data-demo-chat]').evaluate(element => element.scrollIntoView({ block: 'start', behavior: 'instant' }));
        // The second language replays the same story from the start.
        if (locale === 'pt') await demo.getByRole('button', { name: 'Repetir a ilustração' }).click();
        await expect(stage).toHaveAttribute('data-demo-state', 'playing');
        let reached = 0;
        for (const [name, at] of KEY_STATES) {
          await page.clock.runFor(at - reached); reached = at;
          if (name === 'final') await expect(stage).toHaveAttribute('data-demo-state', 'done');
          // CSS transitions run on real time.
          await page.waitForTimeout(700);
          const layout = await stage.evaluate(element => {
            const chat = element.querySelector('[data-demo-chat]')!.getBoundingClientRect(), canvas = element.querySelector('[data-demo-canvas]')!.getBoundingClientRect();
            const shown = [...element.querySelectorAll<HTMLElement>('p, li, strong, small, b, a, button, [data-demo-composer]')].filter(item => {
              const style = getComputedStyle(item), box = item.getBoundingClientRect();
              return box.width > 0 && style.visibility !== 'hidden' && item.closest('[data-shown="false"]') === null;
            });
            const outside = shown.filter(item => {
              const root = item.closest('[data-demo-chat]') ? chat : canvas, box = item.getBoundingClientRect();
              return box.left < root.left - 1 || box.right > root.right + 1 || box.top < root.top - 1 || box.bottom > root.bottom + 1;
            }).map(item => item.textContent!.slice(0, 48));
            const clipped = shown.filter(item => item.scrollWidth > item.clientWidth + 1 && getComputedStyle(item).overflowX !== 'visible').map(item => item.textContent!.slice(0, 48));
            return { outside, clipped, stacked: chat.bottom <= canvas.top, sideBySide: chat.right <= canvas.left && Math.abs(chat.top - canvas.top) < 2,
              overflow: document.documentElement.scrollWidth > innerWidth };
          });
          expect(layout.outside, `${locale} ${name}`).toEqual([]);
          expect(layout.clipped, `${locale} ${name}`).toEqual([]);
          expect(layout.overflow, `${locale} ${name}`).toBe(false);
          // Conversation first, then the Canvas: side by side on desktop, stacked below 1024px.
          expect(width >= 1024 ? layout.sideBySide : layout.stacked, `${locale} ${name}`).toBe(true);
          if (evidence && locale === 'en' && [390, 1440].includes(width)) await demo.screenshot({ path: `${evidence}/howitworks-${name}-${width}.png` });
          if (evidence && locale === 'pt' && name === 'final' && [390, 1440].includes(width)) await demo.screenshot({ path: `${evidence}/howitworks-final-pt-${width}.png` });
        }
        for (const control of [demo.getByRole('button', { name: locale === 'en' ? 'Replay the illustration' : 'Repetir a ilustração' }), demo.getByRole('link', { name: locale === 'en' ? /Try it in FloFi/ : /Experimente no FloFi/ })]) {
          await control.scrollIntoViewIfNeeded();
          expect(await control.evaluate(element => {
            const box = element.getBoundingClientRect();
            return box.width >= 44 && box.height >= 44 && element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
          })).toBe(true);
        }
      }
      expect(seen.actions).toEqual([]); expect(seen.external).toEqual([]); expect(seen.errors).toEqual([]);
    });
  }
});

test('reduced motion shows the complete How it works story and the onboarding at once, with the still mascot and no running animation', async ({ page, baseURL }) => {
  const seen = await guard(page, baseURL);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('[data-mascot-motion]')).toHaveAttribute('data-alive', 'still');
  const demo = page.locator('#demo'), stage = demo.locator('[data-demo-cue]');
  for (const [selector, attribute, value] of [['#demo [data-demo-cue]', 'data-demo-cue', 'done'], ['#assistants [data-assistant-step]', 'data-assistant-step', '5']] as const) {
    await expect(page.locator(selector)).toHaveAttribute(attribute, value);
    await page.locator(selector).scrollIntoViewIfNeeded();
    await expect(page.locator(selector)).toHaveAttribute(attribute, value);
  }
  await expect(stage).toHaveAttribute('data-demo-state', 'static');
  // A readable static version: both cards, Simulate and Execute together, the closing link; no control when nothing moves.
  await expect(demo.locator('[data-demo-card][data-state="shown"]')).toHaveCount(2);
  await expect(demo.locator('[data-panel="simulate"]')).toBeVisible();
  await expect(demo.locator('[data-panel="execute"]')).toBeVisible();
  await expect(demo.locator('[data-panel="build"]')).toBeHidden();
  await expect(demo.getByRole('button')).toHaveCount(0);
  await expect(demo.getByRole('link', { name: /Try it in FloFi/ })).toBeVisible();
  // Assistive technology reads one equivalent summary; the moving picture is decorative and holds nothing focusable.
  await expect(demo.locator('p[class*="srOnly"]')).toHaveText(landingText.en.demoSummary.replace('{0}', landingText.en.demoPrompt));
  expect(await demo.locator('[aria-hidden="true"]').count()).toBeGreaterThanOrEqual(4);
  await expect(demo.locator('[aria-hidden="true"] :is(a, button, input, [tabindex])')).toHaveCount(0);
  expect(await page.locator('main').evaluate(element => [...element.querySelectorAll('*')].flatMap(item => item.getAnimations()).length)).toBe(0);
  expect(seen.external).toEqual([]); expect(seen.errors).toEqual([]);
});
