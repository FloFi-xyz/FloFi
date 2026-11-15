// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-RECONCILIATION-PRIVACY-UX-001 (P2): the Admin login has no white strip above it. The console background must paint the viewport
 * from its topmost pixel — light and dark, desktop and mobile, short viewports, before and after hydration — with no horizontal overflow and no
 * layout shift. Visual only: sign-in itself (wallet choice, signature, session) is exercised unchanged by `admin-console.spec.ts`.
 *
 * Runs in the guarded admin group (`FLOFI_ADMIN_E2E=LOOPBACK_ONLY`, disposable loopback database). No wallet signs anything here.
 */
import { expect, test } from './fixtures';

const PAGE: Record<'light' | 'dark', readonly [number, number, number]> = { light: [0xf8, 0xfa, 0xfd], dark: [0x0b, 0x0d, 0x12] }; // admin.css --a-page
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
  { name: 'short', width: 1280, height: 560 },
] as const;

/** The colour that actually paints each sampled top-row point: the first non-transparent background from the hit element up to the canvas. */
async function topRowPaint(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const rgb = (value: string) => (value.match(/\d+(\.\d+)?/g) ?? []).map(Number);
    const paint = (start: Element | null) => {
      for (let el: Element | null = start; el; el = el.parentElement) {
        const [r, g, b, a = 1] = rgb(getComputedStyle(el).backgroundColor);
        if (a > 0) return { tag: el.tagName.toLowerCase(), cls: el.className.toString().slice(0, 40), color: [r!, g!, b!] };
      }
      return { tag: 'canvas', cls: '', color: [255, 255, 255] }; // nothing painted: the browser default canvas
    };
    const w = window.innerWidth;
    return [2, Math.floor(w / 2), w - 3].map(x => paint(document.elementFromPoint(x, 0)));
  });
}
/** Pixel truth from a real screenshot of the top rows, decoded in the page (no image dependency). */
async function topRowPixels(page: import('@playwright/test').Page, width: number) {
  const png = await page.screenshot({ clip: { x: 0, y: 0, width, height: 4 } });
  return page.evaluate(async bytes => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data, out: number[][] = [];
    for (const x of [1, Math.floor(bitmap.width / 2), bitmap.width - 2]) for (const y of [0, bitmap.height - 1]) { const i = (y * bitmap.width + x) * 4; out.push([data[i]!, data[i + 1]!, data[i + 2]!]); }
    return out;
  }, [...png]);
}
const near = (actual: readonly number[], expected: readonly number[]) => actual.every((v, i) => Math.abs(v - expected[i]!) <= 2);

for (const scheme of ['light', 'dark'] as const) {
  for (const viewport of VIEWPORTS) {
    test(`admin login paints the console background from the top pixel — ${scheme}, ${viewport.name} ${viewport.width}×${viewport.height}`, async ({ page, networkGuard }, info) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.emulateMedia({ colorScheme: scheme });
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      // Before hydration: the server-rendered document with its stylesheet, scripts not yet run.
      await page.goto('/admin/login', { waitUntil: 'domcontentloaded' });
      const brand = page.locator('.admin-sign-in .admin-brand');
      await expect(brand).toBeVisible();
      const early = await page.locator('.admin-sign-in').boundingBox();
      for (const point of await topRowPaint(page)) expect(point.color, `pre-hydration ${JSON.stringify(point)}`).toEqual([...PAGE[scheme]]);

      // After hydration: the sign-in card (client component) is interactive.
      await page.waitForLoadState('load');
      await expect(page.getByRole('heading', { name: 'Sign in with an administrator wallet' })).toBeVisible();
      // Rendered by the client component after its effect ran: the page is hydrated (no wallet is injected in this spec).
      await expect(page.getByText(/No browser wallet was detected/)).toBeVisible();
      for (const point of await topRowPaint(page)) expect(point.color, `hydrated ${JSON.stringify(point)}`).toEqual([...PAGE[scheme]]);
      for (const pixel of await topRowPixels(page, viewport.width)) expect(near(pixel, PAGE[scheme]), `screenshot pixel ${pixel} vs ${PAGE[scheme]}`).toBe(true);

      const geometry = await page.evaluate(() => {
        const root = document.querySelector('.admin-root')!.getBoundingClientRect(), html = document.documentElement;
        return { rootTop: root.top, rootHeight: root.height, scrollWidth: html.scrollWidth, clientWidth: html.clientWidth, innerHeight: window.innerHeight,
          bodyBackground: getComputedStyle(document.body).backgroundColor };
      });
      expect(geometry.rootTop).toBe(0);                                       // nothing above the console
      expect(geometry.rootHeight).toBeGreaterThanOrEqual(geometry.innerHeight); // it covers the viewport
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);   // no horizontal overflow
      expect(geometry.bodyBackground).toBe(`rgb(${PAGE[scheme].join(', ')})`); // overscroll / gaps match too
      // No layout shift between first paint and hydration; brand above the card, horizontally aligned.
      const late = await page.locator('.admin-sign-in').boundingBox();
      expect(late).toEqual(early);
      const [brandBox, cardBox] = [await brand.boundingBox(), await page.locator('.admin-sign-in .admin-card').first().boundingBox()];
      expect(brandBox!.y + brandBox!.height).toBeLessThanOrEqual(cardBox!.y);
      expect(Math.abs(brandBox!.x - cardBox!.x)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: info.outputPath(`admin-login-${scheme}-${viewport.name}.png`) });
      expect(errors).toEqual([]);
      networkGuard.assertClean();
    });
  }
}
