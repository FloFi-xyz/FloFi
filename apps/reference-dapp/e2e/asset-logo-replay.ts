// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-BASE-001: closed replay for provider logos. Catalog assets may show their provider's logo (`trustedAssetLogo`), which the browser would
 * load from the issuer's image host. In tests that host is never reached: a page route — which Playwright prefers over the network guard's
 * context route — answers every request under a provider logo rule with one small local PNG, or with 404 for the URLs a test marks broken.
 * Any other non-loopback request still reaches the guard and fails the test.
 */
import type { Page } from '@playwright/test';
import { ASSET_LOGO_RULES } from '@defi-workflow-engine/action-registry';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGOoqGjAihiGlgQA8NVcAQ7KRV0AAAAASUVORK5CYII=', 'base64');
const PREFIXES = ASSET_LOGO_RULES.flatMap(rule => rule.kind === 'ADDRESS_DERIVED' ? [rule.prefix] : rule.prefixes);
export const isProviderLogo = (url: string) => PREFIXES.some(prefix => url.startsWith(prefix));

/** Installs the replay before navigation; returns the logo URLs the page asked for, in order. */
export async function replayProviderLogos(page: Page, options: { readonly broken?: readonly string[] } = {}): Promise<string[]> {
  const requested: string[] = [];
  await page.route(url => isProviderLogo(url.href), async route => {
    const url = route.request().url();
    requested.push(url);
    await (options.broken?.includes(url) ? route.fulfill({ status: 404, body: '' }) : route.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
  });
  return requested;
}
/** Every image on the page is FloFi's own (`/brand/…`, data URIs) or a provider logo answered by the replay. */
export async function expectReviewedImagesOnly(page: Page): Promise<void> {
  const sources = await page.locator('img').evaluateAll(images => images.map(image => image.getAttribute('src') ?? ''));
  const foreign = sources.filter(src => src && !src.startsWith('/') && !src.startsWith('data:') && !isProviderLogo(src));
  if (foreign.length) throw new Error(`Unreviewed image sources: ${foreign.join(', ')}`);
}
