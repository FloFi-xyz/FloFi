// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-SITE-001: the owner-approved site (Claude Artifact "FloFi — site aprovado", version 1793715580-4561) at /how-it-works, /developers,
 * /docs and /docs/<slug>, and BUILD-FLOFI-LAUNCH-001: the team-approved launch landing at / and /faq (Claude Artifact "FloFi — opção hero digitando",
 * version 1793885744-1380), English by default: navigation, responsiveness and English/Portuguese. Read-only and closed: any request outside the app's
 * own origin fails.
 */
import { test as base, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DOCS } from '../src/components/site/docs-content';
import { answeredPrivacyNotice } from './app-origin';
import { DEVELOPER_ENDPOINTS } from '../src/components/site/site-copy';

// The site's tests start as a new visitor (no saved language: English); the pages whose checks read in Portuguese save it first.
const test = base.extend<{ guard: string[] }>({
  storageState: async ({ baseURL }, use) => { await use(answeredPrivacyNotice(baseURL!)); },
  guard: [async ({ context, baseURL, page }, use) => {
    const unexpected: string[] = [], errors: string[] = [];
    await context.route('**/*', async route => {
      let origin = '';
      try { origin = new URL(route.request().url()).origin; } catch { /* an invalid URL is refused */ }
      if (origin === new URL(baseURL!).origin) await route.continue(); else { unexpected.push(route.request().url()); await route.abort('blockedbyclient'); }
    });
    page.on('pageerror', error => errors.push(error.message));
    await use(unexpected);
    expect(unexpected).toEqual([]);
    expect(errors).toEqual([]);
  }, { auto: true }],
});

// The site clips sideways overflow (overflow-x: clip), so this measures with the clip lifted: anything wider than the viewport fails.
async function noOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const site = document.querySelector<HTMLElement>('[data-site-page]');
    const before = site?.style.overflowX ?? '';
    if (site) site.style.overflowX = 'visible';
    const fits = document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('[data-site-page] *')].every(node => node.getBoundingClientRect().right <= innerWidth + 1 || getComputedStyle(node).position === 'fixed' || node.closest('pre, table, [aria-hidden="true"]') !== null);
    if (site) site.style.overflowX = before;
    return fits;
  })).toBe(true);
}
// The artwork loads lazily (next/image); the check asks every image to load now, then requires each to have decoded.
async function imagesLoaded(page: Page) {
  await page.locator('img').evaluateAll(images => images.forEach(img => { (img as HTMLImageElement).loading = 'eager'; }));
  await expect.poll(() => page.locator('img').evaluateAll(images => images
    .filter(img => !(img as HTMLImageElement).complete || (img as HTMLImageElement).naturalWidth === 0).map(img => img.getAttribute('src')))).toEqual([]);
}
async function chooseLanguage(page: Page, current: 'Preferências' | 'Preferences', language: 'English' | 'Português') {
  await page.getByRole('navigation', { name: current === 'Preferências' ? 'Navegação principal' : 'Main navigation' }).getByRole('button', { name: current }).click();
  await page.getByRole('radio', { name: language }).check();
  await page.keyboard.press('Escape');
}

const HERO_EN = 'Tell FloFi: I want to swap, bridge, deposit, add liquidity or transfer.';
const HERO_PT = 'Diga à FloFi: quero trocar, mudar de rede, depositar, adicionar liquidez ou transferir.';
/** A visitor who saved Portuguese (the cookie Preferences writes), for the pages whose checks read in Portuguese. */
async function savePortuguese(page: Page, baseURL: string) {
  await page.context().addCookies([{ name: 'flofi_language', value: 'PT', url: new URL('/', baseURL).href }]);
}

// BUILD-FLOFI-LAUNCH-001: the team-approved launch landing, in English by default.
for (const width of [320, 390, 768, 1024, 1440, 1920]) test(`Home in English by default: the approved landing's sections, real entries, keyboard and layout at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  // The typed hero is decorative; the heading is named by the whole sentence.
  await expect(page.getByRole('heading', { level: 1, name: HERO_EN, exact: true })).toBeVisible();
  await expect(page.locator('.app-shell')).toHaveCount(0);
  expect(await page.locator('main section[id]').evaluateAll(items => items.map(item => item.id))).toEqual(['top', 'dor', 'como-funciona', 'hoje', 'seguranca', 'perguntas', 'entrar']);
  // The public product page names no test network, mock or sandbox, and every artwork loads from FloFi itself.
  await expect(page.locator('main')).not.toContainText(/devnet|testnet|sepolia|mock|sandbox|synthetic|simulated.only|test.funds/i);
  await expect(page.locator('#top')).toContainText('Public beta on mainnet. Start small.');
  await imagesLoaded(page);
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(nav.getByRole('link', { name: 'How it works' })).toHaveAttribute('href', '/how-it-works');
  await expect(nav.getByRole('link', { name: 'Docs', exact: true })).toHaveAttribute('href', '/docs');
  await expect(nav.getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/login');
  // Both "Try it" boxes open the real sign-in entry (sign in, create an account, connect a wallet or explore without an account).
  const tryIt = page.getByRole('link', { name: 'Try it in the app', exact: true });
  await expect(tryIt).toHaveCount(2);
  for (const link of await tryIt.all()) await expect(link).toHaveAttribute('href', '/login');
  await expect(page.locator('main a[href="/login"]')).toHaveCount(2);
  // The five requests served today lead to the closing "Try it"; the "coming soon" one is not a control.
  const asks = page.locator('#hoje a[href="#entrar"]');
  await expect(asks).toHaveText(['Swap', 'Change networks', 'Deposit on Aave', 'Add liquidity', 'Transfer']);
  for (const [index, ask] of (await asks.all()).entries()) await expect(ask).toHaveAttribute('aria-label', `Try it: ${['Swap', 'Change networks', 'Deposit on Aave', 'Add liquidity', 'Transfer'][index]}`);
  await expect(page.locator('#hoje')).toContainText('Buy every FridayComing soon');
  await expect(page.locator('#hoje').getByRole('link', { name: /Buy every Friday/ })).toHaveCount(0);
  // BUILD-FLOFI-UX-005: the five networks are their logos, each a link to the network's official homepage (opened in a new tab).
  const networks = page.getByRole('list', { name: 'On 5 networks' }).getByRole('link');
  await expect(networks).toHaveCount(5);
  const homepages = [['Ethereum', 'https://ethereum.org/'], ['Base', 'https://base.org/'], ['Arbitrum', 'https://arbitrum.io/'],
    ['Robinhood Chain', 'https://robinhood.com/us/en/chain/'], ['Solana', 'https://solana.com/']] as const;
  for (const [index, [name, href]] of homepages.entries()) {
    const link = networks.nth(index);
    await expect(link).toHaveAccessibleName(name); await expect(link).toHaveAttribute('href', href);
    await expect(link).toHaveAttribute('target', '_blank'); await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(await link.locator('img').evaluate(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)).toBe(true);
  }
  await expect(page.locator('#hoje')).not.toContainText('Ethereum · Base');
  // The tangle's network tags show the networks' logos instead of their names.
  await expect(page.locator('#dor [data-kind="network"] img')).toHaveCount(3);
  await expect(page.locator('#hoje').getByRole('link', { name: /API and SDK/ })).toHaveAttribute('href', '/developers');
  // The chaos and the wallet prompt are illustrations: hidden from assistive technology, with no control inside.
  for (const illustration of ['#dor [aria-hidden="true"]', '#seguranca [aria-hidden="true"]']) await expect(page.locator(illustration).first().locator('a, button')).toHaveCount(0);
  // Four approved answers, closed until asked; "See all" opens the FAQ.
  const preview = page.locator('#perguntas details');
  await expect(preview.locator('summary')).toHaveText(['Do I need a wallet?+', 'How much does it cost?+', 'Has FloFi had a security audit?+', 'What if something gets stuck halfway?+']);
  for (const item of await preview.all()) expect(await item.evaluate(node => (node as HTMLDetailsElement).open)).toBe(false);
  await expect(page.getByRole('link', { name: 'See all', exact: true })).toHaveAttribute('href', '/faq');
  const footer = page.getByRole('navigation', { name: 'Footer navigation' });
  await expect(footer.getByRole('link')).toHaveText(['How it works', 'Docs', 'For developers', 'FAQ']);
  await expect(footer.getByRole('link', { name: 'FAQ' })).toHaveAttribute('href', '/faq');
  await expect(page.locator('footer')).toContainText('Your path through DeFi, with clarity and control.');
  await expect(page.locator('footer')).toContainText('DeFi involves risk. Simulation does not guarantee price or outcome. Review before you sign.');
  for (const [name, href] of [['FloFi on X', 'https://x.com/FloFi_xyz'], ['FloFi on Discord', 'https://discord.gg/36rEhdUa'], ['FloFi on LinkedIn', 'https://www.linkedin.com/company/flofixyz/home/'], ['FloFi on Telegram', 'https://t.me/FloFiAppBot']] as const)
    await expect(page.getByRole('link', { name, exact: true })).toHaveAttribute('href', href);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#conteudo')).toBeFocused();
  for (const target of await page.locator('a, button, summary').all()) {
    if (!(await target.isVisible())) continue;
    const box = (await target.boundingBox())!;
    expect(box.x + box.width, await target.textContent() ?? '').toBeLessThanOrEqual(width + 1);
  }
  await noOverflow(page);
  // A question opens in place with its approved answer.
  await preview.locator('summary').nth(2).click();
  await expect(preview.nth(2)).toContainText('Not yet. FloFi is in public beta on mainnet, with real funds. Start with small amounts.');
  await page.getByRole('link', { name: 'Sign in your wallet' }).click();
  await expect(page.locator('#entrar')).toBeInViewport();
  // The hero types the approved requests (they move: the box reads one of them, or nothing between two).
  await expect.poll(() => page.locator('#top a[href="/login"] > [aria-hidden="true"]').textContent(), { timeout: 10_000 }).toMatch(/^I want to /);
});

test('the typed requests stand still for a visitor who prefers reduced motion', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL: baseURL!, reducedMotion: 'reduce', storageState: answeredPrivacyNotice(baseURL!) });
  const page = await context.newPage();
  await page.goto('/');
  const box = page.locator('#top a[href="/login"] > [aria-hidden="true"]');
  await expect(box).toHaveText('I want to swap 50 USDC for ETH on Base.');
  await expect(page.locator('#top h1 [data-typed]')).toHaveText('Tell FloFi:I want to swap');
  await page.waitForTimeout(1_500);
  await expect(box).toHaveText('I want to swap 50 USDC for ETH on Base.');
  await context.close();
});

for (const width of [320, 390, 768, 1440]) test(`FAQ at ${width}px: the approved questions in both languages, from the landing`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/');
  await page.getByRole('link', { name: 'See all', exact: true }).click();
  await expect(page).toHaveURL('/faq');
  await expect(page).toHaveTitle('Frequently asked questions · FloFi');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Frequently asked questions.');
  await expect(page.locator('main h2')).toHaveText(['About FloFi', 'Security', 'Using FloFi', 'For developers']);
  const items = page.locator('main details');
  await expect(items).toHaveCount(14);
  // The first answer is open, as on the approved board; the rest open on request, with the keyboard too.
  expect(await items.evaluateAll(nodes => nodes.map(node => (node as HTMLDetailsElement).open))).toEqual([true, ...Array(13).fill(false)]);
  await items.nth(3).locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(items.nth(3)).toContainText('No. Your keys and your funds stay in your wallet. Every transaction goes through it.');
  await expect(page.locator('main')).toContainText('Ethereum, Base, Arbitrum, Robinhood Chain and Solana.');
  await expect(page.getByRole('link', { name: 'Open Discord' })).toHaveAttribute('href', 'https://discord.gg/36rEhdUa');
  await expect(page.getByRole('navigation', { name: 'Footer navigation' }).getByRole('link', { name: 'FAQ' })).toHaveAttribute('aria-current', 'page');
  await imagesLoaded(page); await noOverflow(page);
  await chooseLanguage(page, 'Preferences', 'Português');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Perguntas frequentes.');
  await expect(page.locator('main h2')).toHaveText(['Sobre a FloFi', 'Segurança', 'Como usar', 'Para desenvolvedores']);
  await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
  await expect(page.getByRole('link', { name: 'Abrir o Discord' })).toBeVisible();
  await noOverflow(page);
});

test('the language preference is the product’s own: Portuguese everywhere, then back to English', async ({ page }) => {
  await page.goto('/');
  await chooseLanguage(page, 'Preferences', 'Português');
  await expect(page.getByRole('heading', { level: 1, name: HERO_PT, exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: HERO_PT, exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Experimentar no app', exact: true })).toHaveCount(2);
  await expect(page.locator('#hoje a[href="#entrar"]')).toHaveText(['Trocar', 'Mudar de rede', 'Depositar na Aave', 'Adicionar liquidez', 'Transferir']);
  await expect(page.getByRole('navigation', { name: 'Navegação do rodapé' }).getByRole('link')).toHaveText(['Como funciona', 'Docs', 'Para desenvolvedores', 'Perguntas frequentes']);
  await page.getByRole('navigation', { name: 'Navegação principal' }).getByRole('link', { name: 'Entrar' }).click();
  await expect(page).toHaveURL('/login');
  await expect(page.getByRole('link', { name: 'Explorar o construtor sem conta', exact: true })).toBeVisible();
  await page.goto('/how-it-works');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Como o FloFi funciona.');
  // Portuguese presents bridging as "Levar para outra rede".
  await expect(page.getByRole('columnheader', { name: 'Levar para outra rede' })).toBeVisible();
  await chooseLanguage(page, 'Preferências', 'English');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('How FloFi works.');
  await expect(page.getByRole('columnheader', { name: 'Move to another network' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  // Escape closed the preferences and returned focus to their button.
  await expect(page.getByRole('radio', { name: 'English' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Preferences' })).toBeFocused();
  // With the keyboard: the menu opens on the checked language, an arrow switches it and the menu stays open with focus on the new choice.
  await page.keyboard.press('Enter');
  await expect(page.getByRole('radio', { name: 'English' })).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Como o FloFi funciona.');
  await expect(page.getByRole('radio', { name: 'Português' })).toBeChecked();
  await expect(page.getByRole('radio', { name: 'Português' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Preferências' })).toBeFocused();
});

test('a new visitor gets English on the site, sign-in and /app; saved Portuguese is kept; nothing is saved for them', async ({ page, context, baseURL }) => {
  const h1 = (name: string) => page.getByRole('heading', { level: 1, name, exact: true });
  await page.goto('/');
  await expect(h1(HERO_EN)).toBeVisible();
  await page.goto('/login');
  await expect(page.getByRole('link', { name: 'Explore the builder without an account', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.goto('/app');
  await expect(page.getByRole('button', { name: 'Prefer the editor? Build manually', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  // The default is not written as anyone's preference.
  expect((await context.cookies()).filter(cookie => cookie.name === 'flofi_language')).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem('flofi.language'))).toBeNull();
  // An existing visitor's saved Portuguese is kept everywhere, from the first paint.
  await context.addCookies([{ name: 'flofi_language', value: 'PT', url: new URL('/', baseURL).href }]);
  for (const [path, locator] of [['/', h1(HERO_PT)], ['/login', page.getByRole('link', { name: 'Explorar o construtor sem conta', exact: true })],
    ['/app', page.getByRole('button', { name: 'Prefere o editor? Montar manualmente', exact: true })]] as const) {
    const response = await page.goto(path);
    expect(await response!.text(), path).toMatch(/<html lang="pt-BR"/);
    await expect(locator).toBeVisible();
  }
  // Portuguese kept only in storage (its cookie expired) is followed too, on the site and in /app.
  await context.clearCookies({ name: 'flofi_language' });
  await page.evaluate(() => localStorage.setItem('flofi.language', 'PT'));
  await page.goto('/');
  await expect(h1(HERO_PT)).toBeVisible();
  await page.goto('/app');
  await expect(page.getByRole('button', { name: 'Prefere o editor? Montar manualmente', exact: true })).toBeVisible();
  // A saved English preference is kept as well.
  await context.addCookies([{ name: 'flofi_language', value: 'EN', url: new URL('/', baseURL).href }]);
  await page.evaluate(() => localStorage.setItem('flofi.language', 'EN'));
  await page.goto('/login');
  await expect(page.getByRole('link', { name: 'Explore the builder without an account', exact: true })).toBeVisible();
});

test('the document language is right from the first byte; the embedded MCP surface keeps English', async ({ page }) => {
  // A new visitor's documents: English on the landing, the FAQ, the rest of the site, sign-in and the product, and on the MCP surface a chat host embeds.
  for (const path of ['/', '/faq', '/docs/simulation', '/how-it-works', '/developers', '/login', '/app', '/approve', '/mcp/approve']) {
    const response = await page.request.get(path);
    expect(response.status(), path).toBe(200);
    expect(await response.text(), path).toContain('<html lang="en"');
  }
});

test('confirming the English shown by default saves it, so sign-in follows', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: HERO_EN, exact: true })).toBeVisible();
  // The radio is already checked, so this is a click on it, not a change.
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Preferences' }).click();
  await page.getByRole('radio', { name: 'English' }).click();
  await expect.poll(async () => (await page.context().cookies()).find(cookie => cookie.name === 'flofi_language')?.value).toBe('EN');
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Open' }).click();
  await expect(page).toHaveURL('/login');
  await expect(page.getByRole('link', { name: 'Explore the builder without an account', exact: true })).toBeVisible();
});

for (const width of [320, 390, 1440]) test(`How it works and For developers at ${width}px: real routes and real API paths`, async ({ page, baseURL }) => {
  await page.setViewportSize({ width, height: 900 });
  await savePortuguese(page, baseURL!);
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Navegação principal' }).getByRole('link', { name: 'Como funciona' }).click();
  await expect(page).toHaveURL('/how-it-works');
  await expect(page.getByRole('navigation', { name: 'Navegação principal' }).getByRole('link', { name: 'Como funciona' })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('main ol li')).toHaveCount(5);
  await expect(page.getByRole('table')).toContainText('Orca (SOL/USDC)');
  await expect(page.locator('#entrar').getByRole('link', { name: 'Entrar' })).toHaveAttribute('href', '/login');
  await imagesLoaded(page); await noOverflow(page);
  await page.getByRole('navigation', { name: 'Navegação do rodapé' }).getByRole('link', { name: 'Para desenvolvedores' }).click();
  await expect(page).toHaveURL('/developers');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Coloque DeFi no seu produto.');
  await expect(page.getByText('Hoje só chaves de teste')).toBeVisible();
  // Only paths the Developer API v1 really serves (docs/developer/openapi.json).
  const openapi = JSON.parse(await readFile(new URL('../../../docs/developer/openapi.json', import.meta.url), 'utf8')) as { paths: Record<string, unknown> };
  for (const path of ['/capabilities', '/strategies', '/strategies/{id}/simulate', '/approvals']) expect(Object.keys(openapi.paths)).toContain(path);
  for (const [, path] of DEVELOPER_ENDPOINTS) await expect(page.locator('main')).toContainText(path);
  // Today's keys only discover capabilities; the page says so instead of promising strategies.
  await expect(page.locator('main')).toContainText('Criar e simular estratégias exige as chaves de produção');
  await expect(page.getByRole('link', { name: 'Ler a documentação' })).toHaveAttribute('href', '/docs');
  await noOverflow(page);
});

test('Docs: every guide in both languages, the sidebar search, the reading order and the links all resolve', async ({ page, request, baseURL }) => {
  test.slow(); // 26 guides, every internal link and the search, on the slowest CI worker too.
  await savePortuguese(page, baseURL!);
  await page.goto('/docs');
  // "Skip to content" lands on the article, past the sidebar.
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(page.locator('#artigo')).toBeFocused();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Documentação');
  await expect(page.getByRole('link', { name: 'Documentação', exact: true })).toHaveAttribute('aria-current', 'page');
  const search = page.getByRole('searchbox', { name: 'Buscar na documentação' });
  // Titles, leads and section titles are searched: "Depois, a carteira decide" is a section of the Strategy Manifest.
  await search.fill('carteira');
  await expect(page.locator('aside nav a')).toHaveText(['Strategy Manifest', 'Autorização na carteira']);
  // Accents are ignored, and every word must match.
  await search.fill('autorizacao carteira');
  await expect(page.locator('aside nav a')).toHaveText(['Strategy Manifest', 'Autorização na carteira']);
  await search.fill('assinatura');
  await expect(page.locator('aside nav a')).toHaveText(['Autorização na carteira']);
  await search.fill('xyzzy');
  await expect(page.getByRole('status')).toHaveText('Nenhuma página encontrada.');
  await search.fill('');
  await expect(page.locator('aside nav a')).toHaveCount(13);
  for (const language of ['PT', 'EN'] as const) {
    await page.context().clearCookies({ name: 'flofi_language' });
    await page.context().addCookies([{ name: 'flofi_language', value: language, url: new URL('/', baseURL).href }]);
    for (const [index, doc] of DOCS[language].pages.entries()) {
      const response = await page.goto(`/docs/${doc.slug}`);
      expect(response?.status()).toBe(200);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(doc.title);
      await expect(page.locator('aside').getByRole('link', { name: doc.title, exact: true })).toHaveAttribute('aria-current', 'page');
      await expect(page.locator('main h2')).toHaveCount(doc.sections.length);
      if (index) await expect(page.getByRole('link', { name: new RegExp(DOCS[language].pages[index - 1]!.title) }).last()).toHaveAttribute('href', `/docs/${DOCS[language].pages[index - 1]!.slug}`);
    }
  }
  // Every internal link a guide holds answers 200.
  // Same-origin paths only (a protocol-relative "//host" never matches), and every anchor names a section of its guide.
  const hrefs = DOCS.PT.pages.concat(DOCS.EN.pages).flatMap(doc => doc.sections.flatMap(section => section.blocks.flatMap(block => [...JSON.stringify(block).matchAll(/"href":"(\/(?!\/)[^"]*)"/g)].map(match => match[1]!))));
  for (const path of new Set(hrefs.map(href => href.split('#')[0]!))) {
    expect(new URL(path, baseURL).origin).toBe(new URL(baseURL!).origin);
    expect((await request.get(path)).status(), path).toBe(200);
  }
  for (const href of hrefs.filter(href => href.includes('#'))) {
    const [path, id] = href.split('#') as [string, string];
    expect(DOCS.EN.pages.find(doc => `/docs/${doc.slug}` === path)?.sections.map(section => section.id), href).toContain(id);
  }
  expect((await request.get('/docs/not-a-guide')).status()).toBe(404);
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const path of ['/docs', '/docs/developer-api', '/docs/mcp-integrations']) { await page.goto(path); await noOverflow(page); }
  }
});

test('the artwork is served byte for byte from the approved artifact', async ({ request }) => {
  const record = await readFile(new URL('../public/brand/site/source.md', import.meta.url), 'utf8');
  const rows = [...record.matchAll(/\| `([a-z-]+\.svg)` \| `[^`]+` \| `([0-9a-f]{64})` \|/g)];
  expect(rows).toHaveLength(9);
  for (const [, file, digest] of rows) {
    const body = await (await request.get(`/brand/site/${file}`)).body();
    expect(createHash('sha256').update(body).digest('hex'), file).toBe(digest);
    expect(body.toString('utf8')).not.toMatch(/<script|foreignObject|href=/i);
  }
});
