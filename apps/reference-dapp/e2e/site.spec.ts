// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-SITE-001: the owner-approved site (Claude Artifact "FloFi — site aprovado", version 1793715580-4561) at /, /how-it-works, /developers,
 * /docs and /docs/<slug>: navigation, responsiveness and Portuguese/English. Read-only and closed: any request outside the app's own origin fails.
 */
import { test as base, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DOCS } from '../src/components/site/docs-content';
import { DEVELOPER_ENDPOINTS } from '../src/components/site/site-copy';

const test = base.extend<{ guard: string[] }>({
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

for (const width of [320, 390, 768, 1024, 1440, 1920]) test(`Home in Portuguese by default: sections, real entries, keyboard and layout at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('DeFi do jeito que você fala.');
  await expect(page.locator('.app-shell')).toHaveCount(0);
  expect(await page.locator('main section[id]').evaluateAll(items => items.map(item => item.id))).toEqual(['top', 'exemplos', 'como-funciona', 'seguranca', 'canais', 'entrar']);
  // The public product page names no test network, mock or sandbox, and every artwork loads from FloFi itself.
  await expect(page.locator('main')).not.toContainText(/devnet|testnet|sepolia|mock|sandbox|synthetic|simulated.only|test.funds/i);
  await imagesLoaded(page);
  const nav = page.getByRole('navigation', { name: 'Navegação principal' });
  await expect(nav.getByRole('link', { name: 'Como funciona' })).toHaveAttribute('href', '/how-it-works');
  await expect(nav.getByRole('link', { name: 'Docs', exact: true })).toHaveAttribute('href', '/docs');
  await expect(nav.getByRole('link', { name: 'Entrar' })).toHaveAttribute('href', '/login');
  await expect(page.locator('main a[href="/login"]')).toHaveCount(2);
  // Five examples lead to the start section, named by their own prompt (they carry nothing into sign-in); the "coming soon" one is not a control.
  const examples = page.locator('#exemplos a:has(img)');
  await expect(examples).toHaveCount(5);
  for (const link of await examples.all()) { await expect(link).toHaveAttribute('href', '#entrar'); await expect(link).not.toHaveAttribute('aria-label', /.*/); }
  await expect(page.locator('#exemplos')).toContainText('Em breve');
  await expect(page.locator('#seguranca')).toContainText('Ethereum · Base · Arbitrum · Robinhood Chain · Solana');
  await expect(page.locator('#canais').getByRole('link', { name: /API e SDK/ })).toHaveAttribute('href', '/developers');
  const footer = page.getByRole('navigation', { name: 'Navegação do rodapé' });
  await expect(footer.getByRole('link')).toHaveText(['Como funciona', 'Docs', 'Para desenvolvedores']);
  for (const [name, href] of [['FloFi no X', 'https://x.com/FloFi_xyz'], ['FloFi no Discord', 'https://discord.gg/36rEhdUa'], ['FloFi no LinkedIn', 'https://www.linkedin.com/company/flofixyz/home/'], ['FloFi no Telegram', 'https://t.me/FloFiAppBot']] as const)
    await expect(page.getByRole('link', { name, exact: true })).toHaveAttribute('href', href);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Ir para o conteúdo' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#conteudo')).toBeFocused();
  for (const target of await page.locator('a, button').all()) {
    if (!(await target.isVisible())) continue;
    const box = (await target.boundingBox())!;
    expect(box.x + box.width, await target.textContent() ?? '').toBeLessThanOrEqual(width + 1);
  }
  await noOverflow(page);
  await page.getByRole('link', { name: 'Ver exemplos' }).click();
  await expect(page.locator('#exemplos')).toBeInViewport();
});

test('the language preference is the product’s own: English everywhere, then back to Portuguese', async ({ page }) => {
  await page.goto('/');
  await chooseLanguage(page, 'Preferências', 'English');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('DeFi the way you talk.');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('DeFi the way you talk.');
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Open' }).click();
  await expect(page).toHaveURL('/login');
  await expect(page.getByRole('link', { name: 'Explore the builder without an account', exact: true })).toBeVisible();
  await page.goto('/how-it-works');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('How FloFi works.');
  await expect(page.getByRole('columnheader', { name: 'Move to another network' })).toBeVisible();
  await chooseLanguage(page, 'Preferences', 'Português');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Como o FloFi funciona.');
  // Portuguese presents bridging as "Levar para outra rede".
  await expect(page.getByRole('columnheader', { name: 'Levar para outra rede' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
  // Escape closed the preferences and returned focus to their button.
  await expect(page.getByRole('radio', { name: 'English' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Preferências' })).toBeFocused();
  // With the keyboard: the menu opens on the checked language, an arrow switches it and the menu stays open with focus on the new choice.
  await page.keyboard.press('Enter');
  await expect(page.getByRole('radio', { name: 'Português' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('How FloFi works.');
  await expect(page.getByRole('radio', { name: 'English' })).toBeChecked();
  await expect(page.getByRole('radio', { name: 'English' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Preferences' })).toBeFocused();
});

test('confirming the Portuguese shown by default saves it, so sign-in follows', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('DeFi do jeito que você fala.');
  // The radio is already checked, so this is a click on it, not a change.
  await page.getByRole('navigation', { name: 'Navegação principal' }).getByRole('button', { name: 'Preferências' }).click();
  await page.getByRole('radio', { name: 'Português' }).click();
  await expect.poll(async () => (await page.context().cookies()).find(cookie => cookie.name === 'flofi_language')?.value).toBe('PT');
  await page.getByRole('navigation', { name: 'Navegação principal' }).getByRole('link', { name: 'Entrar' }).click();
  await expect(page).toHaveURL('/login');
  await expect(page.getByRole('link', { name: 'Explorar o construtor sem conta', exact: true })).toBeVisible();
});

for (const width of [320, 390, 1440]) test(`How it works and For developers at ${width}px: real routes and real API paths`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
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
