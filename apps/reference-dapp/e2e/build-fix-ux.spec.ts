// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FIX-UX-001 (default product profile): Canvas connections are easy to make yet remain exactly the workflow's CONNECT rules; a USD
 * equivalent appears only for a verified estimate (MOCKED here, and labelled so) and never for valueless test tokens; an amount applies on
 * Enter at desktop and mobile widths. A passive wallet refuses every request; nothing leaves the loopback app.
 */
import { test, expect, installPassiveWallet, assertPassiveWallet, readWorkflowIr } from './fixtures';
import type { Page, Route } from '@playwright/test';
import { hashArtifactBytes } from '@defi-workflow-engine/workflow-contracts';

test.afterEach(async ({ page }) => { await assertPassiveWallet(page); });
type Ir = { revision: number; nodes: { nodeId: string; actionType: string; dependencies: string[]; chainId: string }[] };
const ir = async (page: Page) => JSON.parse(await readWorkflowIr(page)) as Ir;
const dependencies = async (page: Page, id: string) => (await ir(page)).nodes.find(node => node.nodeId === id)!.dependencies;
const node = (page: Page, id: string) => page.locator(`.build-flow-surface .react-flow__node[data-id="${id}"]`);
const output = (page: Page, id: string) => node(page, id).locator('.react-flow__handle.source');
const input = (page: Page, id: string) => node(page, id).locator('.react-flow__handle.target');
const feedback = (page: Page) => page.locator('.canvas-feedback');

async function settledViewport(page: Page) {
  let last: string | null = null, stable = 0;
  await expect.poll(async () => {
    const current = await page.locator('.build-flow-surface .react-flow__viewport').getAttribute('style');
    stable = current === last ? stable + 1 : 0; last = current;
    return stable;
  }, { intervals: [100] }).toBeGreaterThanOrEqual(3);
}
/** A swap card whose amount applies on Enter (no Review/Apply step). */
async function addSwap(page: Page, amount: string) {
  const before = await page.locator('.build-flow-surface .react-flow__node').count();
  await page.getByRole('button', { name: 'Add swap', exact: true }).click();
  const card = page.locator('.build-flow-surface .composer-card').last();
  const field = card.getByRole('textbox', { name: 'Source amount (USDC)', exact: true });
  await field.fill(amount); await field.press('Enter');
  await expect(page.locator('.build-flow-surface .react-flow__node')).toHaveCount(before + 1);
  await expect(page.locator('.build-flow-surface .composer-amount-hint')).toHaveCount(0);
  await settledViewport(page);
}
/** Two connectable swaps, the first moved left so both handles are clear of each other. */
async function twoSwaps(page: Page) {
  await installPassiveWallet(page); await page.goto('/app');
  await addSwap(page, '1'); await addSwap(page, '2');
  const title = (await node(page, 'node-002').locator('.composer-action-title').boundingBox())!;
  await page.mouse.move(title.x + 10, title.y + 10); await page.mouse.down();
  await page.mouse.move(title.x - 80, title.y + 60, { steps: 20 }); await page.mouse.up();
  await settledViewport(page);
}
const center = async (locator: ReturnType<Page['locator']>) => { const box = (await locator.boundingBox())!; return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; };
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, via?: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  if (via) await page.mouse.move(via.x, via.y, { steps: 12 });
  await page.mouse.move(to.x, to.y, { steps: 12 }); await page.mouse.up();
}
const underPointer = (page: Page, point: { x: number; y: number }) => page.evaluate(({ x, y }) => {
  const element = document.elementFromPoint(x, y)?.closest('.react-flow__handle');
  return element ? `${element.closest('.react-flow__node')?.getAttribute('data-id')}:${element.classList.contains('source') ? 'output' : 'input'}` : null;
}, point);

test('a connection starts from near the output, is released anywhere on the next card, and invalid links are explained', async ({ page, networkGuard }) => {
  await twoSwaps(page);
  const start = await ir(page), from = await center(output(page, 'node-002'));
  // The visible dot is small; the area around it (outside the dot) still starts a connection, and hovering shows it.
  const near = { x: from.x + 9, y: from.y + 7 };
  expect(await underPointer(page, near)).toBe('node-002:output');
  await page.mouse.move(near.x, near.y);
  await expect.poll(() => output(page, 'node-002').evaluate(element => getComputedStyle(element).scale)).not.toBe('none');
  // An ordinary click on a handle never connects anything.
  await page.mouse.click(near.x, near.y);
  await expect(page.locator('.build-flow-surface .react-flow__edge')).toHaveCount(0);
  expect(await ir(page)).toEqual(start);
  // While dragging, the compatible input is marked valid; releasing on the card body (not the small input) connects.
  await page.mouse.move(near.x, near.y); await page.mouse.down();
  await page.mouse.move(near.x + 30, near.y + 10, { steps: 6 });
  await page.mouse.move((await center(input(page, 'node-003'))).x, (await center(input(page, 'node-003'))).y, { steps: 10 });
  await expect(input(page, 'node-003')).toHaveClass(/(?:^|\s)valid(?:\s|$)/);
  await page.mouse.move((await center(node(page, 'node-003').locator('.composer-action-title'))).x, (await center(node(page, 'node-003').locator('.composer-action-title'))).y, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('.build-flow-surface .react-flow__edge[data-id="node-002-node-003"]')).toBeVisible();
  await expect.poll(() => dependencies(page, 'node-003')).toEqual(['node-002']);
  expect((await ir(page)).revision).toBe(start.revision + 1);
  await expect(feedback(page)).toHaveCount(0);
  const linked = await readWorkflowIr(page);
  // A cycle is refused with a reason and nothing changes; the same link again never duplicates the edge.
  await drag(page, await center(output(page, 'node-003')), await center(node(page, 'node-002').locator('.composer-action-title')));
  await expect(feedback(page)).toHaveText('This connection would create a loop.');
  expect(await readWorkflowIr(page)).toBe(linked);
  await drag(page, await center(output(page, 'node-002')), await center(input(page, 'node-003')));
  await expect(page.locator('.build-flow-surface .react-flow__edge')).toHaveCount(1);
  expect(await dependencies(page, 'node-003')).toEqual(['node-002']);
  // Released on the empty canvas: nothing happens.
  const pane = (await page.locator('.build-flow-surface').boundingBox())!;
  await drag(page, await center(output(page, 'node-003')), { x: pane.x + 20, y: pane.y + pane.height - 20 });
  expect(await readWorkflowIr(page)).toBe(linked);
  // Selecting and dragging a card still work and never connect anything.
  await node(page, 'node-003').locator('.composer-action-title').click();
  await expect(node(page, 'node-003').locator('.composer-card')).toHaveClass(/active/);
  const before = (await node(page, 'node-003').boundingBox())!, title = await center(node(page, 'node-003').locator('.composer-action-title'));
  await drag(page, title, { x: title.x + 40, y: title.y + 50 });
  expect((await node(page, 'node-003').boundingBox())!.y).toBeGreaterThan(before.y + 20);
  expect(await readWorkflowIr(page)).toBe(linked);
  networkGuard.assertClean();
});

test('handles stay easy to target when the Canvas is zoomed out', async ({ page, networkGuard }) => {
  await twoSwaps(page);
  await page.getByRole('slider', { name: 'Canvas zoom', exact: true }).fill('0.5');
  await settledViewport(page);
  const flow = page.locator('.build-flow-surface .react-flow');
  await expect.poll(() => flow.evaluate(element => Number(getComputedStyle(element).getPropertyValue('--canvas-handle-scale')))).toBeGreaterThan(1);
  const from = await center(output(page, 'node-002'));
  // At this zoom the visible dot is a few pixels wide; the compensated area still answers 8 px away.
  expect(await underPointer(page, { x: from.x + 8, y: from.y })).toBe('node-002:output');
  await drag(page, { x: from.x + 8, y: from.y }, await center(node(page, 'node-003').locator('.composer-action-title')), { x: from.x + 30, y: from.y });
  await expect.poll(() => dependencies(page, 'node-003')).toEqual(['node-002']);
  networkGuard.assertClean();
});

/** A MOCKED estimate for exactly the requested snapshot, as the live-quote endpoint would answer with a verified price source. */
function mockedEstimate(usd: { input: string | null; output: string | null }) {
  return async (route: Route) => {
    const body = route.request().postDataJSON() as { workflow: { nodes: { nodeId: string; chainId: string }[] }; nodeId: string };
    const swap = body.workflow.nodes.find(item => item.nodeId === body.nodeId)!;
    await route.fulfill({ json: { ok: true, estimate: {
      workflowHash: hashArtifactBytes('semantic-workflow', new TextEncoder().encode(JSON.stringify(body.workflow))), nodeId: body.nodeId, chain: swap.chainId,
      provider: 'Uniswap V3', expected: '0.000794', minimum: '0.000786', symbol: 'WETH', slippageBps: 100, expiresAt: new Date(Date.now() + 60_000).toISOString(),
      usd: { ...usd, source: 'FIXTURE', evidence: 'MOCKED', observedAt: new Date().toISOString() } } } });
  };
}

test('a verified USD estimate is shown as an approximation (MOCKED here, labelled so), with USD first only where a value exists', async ({ page, networkGuard }) => {
  await installPassiveWallet(page, '0x2105');
  await page.route('**/api/build-estimate', mockedEstimate({ input: null, output: '2.49' }));
  await page.goto('/app');
  await page.getByRole('button', { name: 'Add swap', exact: true }).click();
  const card = page.locator('.build-flow-surface .composer-card'), source = card.locator('.composer-amount'), destination = card.locator('.composer-destination-box');
  await expect(card.locator('.composer-chain')).toHaveText('Base');
  await card.getByRole('textbox', { name: 'Source amount (USDC)', exact: true }).fill('2.5');
  await expect(destination.locator('.composer-amount-value')).toHaveText('0.000794');
  // USDC has no verified feed (no number); the WETH estimate carries its approximate USD value and provenance.
  await expect(source.locator('.composer-fiat-value')).toHaveText('USD price unavailable');
  const usd = destination.getByRole('button', { name: 'Show USD value first', exact: true });
  await expect(usd).toHaveText('≈ $2.49 · test price');
  await expect(usd).toHaveAttribute('title', /Estimated from the verified test \(MOCKED\) USD price.*Not a quote\./);
  await expect(card.locator('.composer-quote-note')).toContainText('Approximate · Uniswap V3 · Simulate before review');
  await usd.click();
  await expect(destination.locator('.composer-primary-fiat')).toHaveText('≈ $2.49 · test price');
  await expect(destination.locator('.composer-token-subline')).toHaveText('0.000794 WETH');
  // The source has no USD value, so it stays token-first; display never changes the amount or applies anything.
  await expect(source.locator('.composer-primary-fiat')).toHaveCount(0);
  await expect(card.getByRole('textbox', { name: 'Source amount (USDC)', exact: true })).toHaveValue('2.5');
  await expect(page.locator('.summary-bar')).toHaveAttribute('data-workflow-revision', '0');
  await destination.getByRole('button', { name: 'Show token amount first', exact: true }).click();
  await expect(destination.locator('.composer-amount-value')).toHaveText('0.000794');
  networkGuard.assertClean();
});

test('valueless test tokens never show a USD number, even when an estimate carries one', async ({ page, networkGuard }) => {
  await installPassiveWallet(page, '0x14a34');
  await page.route('**/api/build-estimate', mockedEstimate({ input: '2.50', output: '2.49' }));
  await page.goto('/app');
  await page.getByRole('button', { name: 'Add swap', exact: true }).click();
  const card = page.locator('.build-flow-surface .composer-card');
  await expect(card.locator('.composer-chain')).toHaveText('Base Sepolia');
  await card.getByRole('textbox', { name: 'Source amount (USDC)', exact: true }).fill('5');
  await expect(card.locator('.composer-fiat-value')).toHaveText(['Test token · no USD value', 'Test token · no USD value']);
  await expect(card).not.toContainText('$');
  await expect(card.getByRole('button', { name: 'Show USD value first', exact: true })).toHaveCount(0);
  networkGuard.assertClean();
});

for (const width of [1440, 390]) test(`an amount applies on Enter at ${width}px, once, and an invalid one is refused inline`, async ({ page, networkGuard }) => {
  await page.setViewportSize({ width, height: 900 });
  await installPassiveWallet(page); await page.goto('/app');
  await addSwap(page, '5');
  const card = page.locator('.build-flow-surface .composer-card'), field = card.getByRole('textbox', { name: 'Source amount (USDC)', exact: true });
  const revision = (await ir(page)).revision;
  await field.fill('10'); await expect(card.locator('.composer-amount-hint')).toBeVisible();
  expect((await ir(page)).revision).toBe(revision);
  await field.press('Enter'); await field.press('Enter');
  await expect.poll(async () => (await ir(page)).revision).toBe(revision + 1);
  await expect(card.getByRole('button', { name: /^(Review|Apply) amount$/ })).toHaveCount(0);
  await field.fill('0'); await field.press('Enter');
  await expect(card.getByRole('alert')).toContainText('greater than 0'); await expect(card.getByRole('alert')).toBeVisible();
  expect((await ir(page)).revision).toBe(revision + 1);
  await field.press('Escape'); await expect(field).toHaveValue('10');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  networkGuard.assertClean();
});
