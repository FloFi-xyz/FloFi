// SPDX-License-Identifier: AGPL-3.0-only
/**
 * HOTFIX-P1-UI-OVERFLOW-AND-ATTRIBUTION-001 (production report 2026-11-16): a workflow Review in the FloFi Assistant overflowed the chat panel
 * (long addresses and descriptions past its edge, the card clipped, a horizontal scrollbar in the chat). The real `CopilotPanel` and Review card
 * are mounted with the product's own stylesheets, in the Simulate/Execute stage's side panel, with long Solana and EVM addresses, a long
 * route, nested steps and open Technical details, at desktop, tablet and phone widths. Display fixture only: nothing is simulated, quoted,
 * signed or sent; server actions are not part of this bundle (they would refuse), and no value comes from a network.
 */
import { test, expect } from './fixtures';
import { build, type Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openBuilder } from './build-entry-navigation';
import { CHAT_REVIEW_FIXTURE } from '../src/test-utils/chat-review-fixture';

/** A Server Action module ('use server') becomes refusing stubs in this browser-only bundle: the panel renders, nothing reaches a server. */
const serverActions: Plugin = { name: 'acceptance-server-action-stubs', enforce: 'pre', load(id) {
  if (!/\.(ts|tsx)$/.test(id) || id.includes('node_modules')) return null;
  const source = readFileSync(id, 'utf8');
  if (!/^(?:\s*\/\/[^\n]*\n|\s*\/\*[\s\S]*?\*\/)*\s*['"]use server['"]/.test(source)) return null;
  const names = [...source.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map(match => match[1]);
  return names.map(name => `export async function ${name}() { throw new Error('SERVER_ACTION_NOT_AVAILABLE_IN_ACCEPTANCE'); }`).join('\n') || 'export {};';
} };
const compiled = (path: string) => fileURLToPath(new URL(`../node_modules/next/dist/compiled/${path}`, import.meta.url));
let bundle: string;
test.beforeAll(async () => {
  const result = await build({ root: fileURLToPath(new URL('../../../', import.meta.url)), configFile: false, logLevel: 'error', plugins: [serverActions],
    // `next/image` (CommonJS, resolved by Next itself) renders as an ordinary img here (src/test-utils/next-image-stub.ts).
    resolve: { alias: { 'next/image': fileURLToPath(new URL('../src/test-utils/next-image-stub.ts', import.meta.url)), 'node:crypto': compiled('crypto-browserify/index.js'), buffer: compiled('buffer/index.js'), 'node:buffer': compiled('buffer/index.js'),
      stream: compiled('stream-browserify/index.js'), events: compiled('events/events.js'), string_decoder: compiled('string_decoder/string_decoder.js'),
      util: compiled('util/util.js'), vm: compiled('vm-browserify/index.js'), process: compiled('process/browser.js') } },
    define: { 'process.env.NODE_ENV': '"production"', __dirname: '"/"', global: 'globalThis' },
    build: { write: false, minify: false, rolldownOptions: { transform: { inject: { Buffer: ['buffer', 'Buffer'], process: 'process' } } },
      lib: { entry: fileURLToPath(new URL('../src/test-utils/chat-review-acceptance-harness.tsx', import.meta.url)), name: 'FloFiChatReviewAcceptance', formats: ['iife'] } } });
  const outputs = Array.isArray(result) ? result : [result];
  const entry = outputs.flatMap(output => 'output' in output ? output.output : []).find(output => output.type === 'chunk' && output.isEntry);
  if (!entry || entry.type !== 'chunk') throw new Error('Acceptance component bundle missing');
  bundle = entry.code;
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 800 }, { width: 390, height: 844 }, { width: 320, height: 640 }]) {
  test(`the Assistant's Review stays inside its panel at ${viewport.width}px, with every address and value in full`, async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize(viewport);
    await openBuilder(page);
    const styles = await page.locator('head link[rel="stylesheet"]').evaluateAll(links => links.map(link => link.outerHTML).join(''));
    await page.route('**/__chat-review-acceptance.js', route => route.fulfill({ contentType: 'application/javascript; charset=utf-8', body: bundle }));
    // The Simulate / Execute stage beside the Assistant (app-shell wrapStage: the panel is the grid's direct child, so the product's own
    // `.stage-with-chat>.copilot` width, margins and height apply), in a fresh document.
    await page.route('**/__chat-review-acceptance', route => route.fulfill({ contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${styles}</head><body><main class="main"><div class="stage-with-chat" id="acceptance-root"></div></main><script src="/__chat-review-acceptance.js"></script></body></html>` }));
    await page.goto('/__chat-review-acceptance');
    await page.evaluate(() => (window as unknown as { FloFiChatReviewAcceptance: { mount(element: HTMLElement): void } }).FloFiChatReviewAcceptance.mount(document.getElementById('acceptance-root')!));
    const panel = page.getByRole('complementary', { name: 'FloFi Assistant' }), card = panel.getByRole('region', { name: 'Workflow review' });
    await expect(card).toBeVisible();
    await card.locator('summary', { hasText: 'Technical details' }).click();
    await expect(card.getByRole('term').filter({ hasText: /^Quote binding$/ })).toBeVisible();
    const layout = await panel.evaluate(element => {
      const log = element.querySelector('.chat-messages')!, review = log.querySelector('.conversation-review')!, bubble = review.closest('.message')!;
      const right = (node: Element) => node.getBoundingClientRect().right, edge = right(log);
      const outside = [...log.querySelectorAll('*')].filter(node => right(node) > edge + 0.5).map(node => `${node.tagName}.${node.className}`);
      // A value cut inside its own box (an ellipsis or a hidden overflow) is hidden data even when nothing leaves the panel.
      const cut = [...review.querySelectorAll('*')].filter(node => node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).overflowX !== 'visible')
        .map(node => `${node.tagName}:${node.textContent?.slice(0, 40)}`);
      return { logScroll: log.scrollWidth, logClient: log.clientWidth, documentScroll: document.documentElement.scrollWidth, viewport: innerWidth,
        reviewInBubble: right(review) <= right(bubble) + 0.5, bubbleInLog: right(bubble) <= edge + 0.5, outside, cut,
        verticalScroll: getComputedStyle(log).overflowY, text: review.textContent ?? '' };
    });
    expect(layout.outside, JSON.stringify(layout.outside)).toEqual([]);
    expect(layout.cut, JSON.stringify(layout.cut)).toEqual([]);
    expect(layout.logScroll).toBeLessThanOrEqual(layout.logClient);
    expect(layout.documentScroll).toBeLessThanOrEqual(layout.viewport);
    expect(layout.reviewInBubble).toBe(true); expect(layout.bubbleInLog).toBe(true);
    // The exact values are all there, unshortened: the destination, the spender and the technical value.
    for (const value of [CHAT_REVIEW_FIXTURE.solana, CHAT_REVIEW_FIXTURE.evm, CHAT_REVIEW_FIXTURE.technical]) expect(layout.text).toContain(value);
    // Vertical scrolling, warnings and the confirmation answers stay as they were.
    expect(['auto', 'scroll']).toContain(layout.verticalScroll);
    await expect(card.getByRole('list', { name: 'Risks and warnings' })).toContainText(CHAT_REVIEW_FIXTURE.solana);
    await expect(panel.getByRole('button', { name: 'Yes, I confirm', exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'No', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });
}
