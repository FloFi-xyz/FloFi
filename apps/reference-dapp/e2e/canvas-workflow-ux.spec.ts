// SPDX-License-Identifier: AGPL-3.0-only
/** Phase 7B: normal product, real handles, canonical probe, passive wallet, all financial gates off. */
import type { Page } from '@playwright/test';
import { test, expect, installPassiveWallet, assertPassiveWallet, readWorkflowIr, applyPendingProposal } from './fixtures';
import { replayProviderLogos } from './asset-logo-replay';
import { workflowOrder, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
const cards = (page: Page) => page.locator('.build-flow-surface .react-flow__node');
const viewport = (page: Page) => page.locator('.build-flow-surface .react-flow__viewport');
const ir = async (page: Page) => JSON.parse(await readWorkflowIr(page)) as SemanticWorkflow;
async function open(page: Page) {
  await replayProviderLogos(page); await installPassiveWallet(page, '0xa4b1'); await page.goto('/app');
  await expect(page.getByRole('log', { name: 'Conversation' })).toContainText('Flofi Copilot ready in replay mode');
}
async function say(page: Page, text: string) {
  await page.locator('#mock-prompt').fill(text); await page.getByRole('button', { name: 'Send', exact: true }).click();
  await applyPendingProposal(page);
}
async function settledViewport(page: Page) {
  let last: string | null = null, stable = 0;
  await expect.poll(async () => {
    const current = await viewport(page).getAttribute('style');
    stable = current === last ? stable + 1 : 0; last = current;
    return stable;
  }, { intervals: [100] }).toBeGreaterThanOrEqual(3);
}
async function visibleCards(page: Page, count: number) {
  await expect(cards(page)).toHaveCount(count);
  await expect.poll(async () => {
    const pane = await page.locator('.build-flow-surface').boundingBox();
    const bounds = await cards(page).evaluateAll(nodes => nodes.map(n => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom }; }));
    return Boolean(pane && bounds.every(r => r.x >= pane.x && r.y >= pane.y && r.right <= pane.x + pane.width && r.bottom <= pane.y + pane.height));
  }).toBe(true);
  await settledViewport(page);
}
async function connect(page: Page, source: string, target: string) {
  const output = page.locator(`.build-flow-surface .react-flow__node[data-id="${source}"] .react-flow__handle.source`);
  const input = page.locator(`.build-flow-surface .react-flow__node[data-id="${target}"] .react-flow__handle.target`);
  const a = await output.boundingBox(), b = await input.boundingBox(); expect(a).not.toBeNull(); expect(b).not.toBeNull();
  await page.mouse.move(a!.x + a!.width / 2, a!.y + a!.height / 2); await page.mouse.down();
  await page.mouse.move(b!.x + b!.width / 2, b!.y + b!.height / 2, { steps: 16 }); await page.mouse.up();
  await expect(page.locator(`.build-flow-surface .react-flow__edge[data-id="${source}-${target}"]`)).toBeVisible();
  await expect.poll(async () => (await ir(page)).nodes.find(n => n.nodeId === target)?.dependencies).toContain(source);
}

for (const width of [1440, 1536, 1920]) test(`UX-008 all desktop toolbar controls fit at ${width}px`, async ({ page, networkGuard }) => {
  await page.setViewportSize({ width, height: 1080 }); await open(page);
  const toolbar = page.getByRole('toolbar', { name: 'Canvas tools' });
  const geometry = await toolbar.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return { left: bounds.left, right: bounds.right, scroll: element.scrollWidth - element.clientWidth,
      buttons: [...element.querySelectorAll('button')].map(b => { const r = b.getBoundingClientRect(), label = b.querySelector('span')?.getBoundingClientRect();
        return { hit: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('button') === b, text: b.textContent?.trim(), x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, labelWidth: label?.width }; }) };
  });
  const labels = ['Swap','Bridge','Pool / Liquidity','Supply','Lending','Borrow','Repay','Withdraw','Send','Stocks','Privacy','Duplicate','Undo','Redo','Delete'];
  expect(geometry.buttons.filter(b => labels.includes(b.text ?? '')).map(b => b.text)).toHaveLength(15);
  for (const [index, button] of geometry.buttons.entries()) {
    expect(button.hit).toBe(true);
    expect(button.x).toBeGreaterThanOrEqual(geometry.left - 1); expect(button.right).toBeLessThanOrEqual(geometry.right + 1);
    expect(button.y).toBeCloseTo(geometry.buttons[0]!.y, 0); expect(button.width).toBeGreaterThan(18);
    if (index) expect(button.x).toBeGreaterThanOrEqual(geometry.buttons[index - 1]!.right - 1);
    if (labels.includes(button.text ?? '')) expect(button.labelWidth).toBeGreaterThan(12);
  }
  expect(geometry.scroll).toBeLessThanOrEqual(1);
  expect(await toolbar.locator('.canvas-primary-tools').evaluate(e => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(1);
  // Privacy is the existing unavailable action; fit does not enable an unimplemented financial capability.
  await expect(toolbar.getByRole('button', { name: 'Privacy', exact: true })).toBeDisabled();
  await toolbar.getByRole('button', { name: 'Add swap', exact: true }).click(); await expect(cards(page)).toHaveCount(1);
  await toolbar.getByRole('button', { name: 'Delete', exact: true }).click(); await expect(cards(page)).toHaveCount(0);
  await assertPassiveWallet(page); networkGuard.assertClean();
});

test('UX-009 fits committed insertions 1–5; proposals and ordinary edits do not refit', async ({ page, networkGuard }) => {
  await page.setViewportSize({ width: 1536, height: 1080 }); await open(page);
  for (let count = 1; count <= 5; count++) {
    const before = await viewport(page).getAttribute('style'), canonical = await ir(page);
    await page.locator('#mock-prompt').fill('Swap 5 USDC for WETH on Base'); await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByRole('button', { name: /^Review proposed change:/ })).toBeVisible();
    expect(await viewport(page).getAttribute('style')).toBe(before); expect(await ir(page)).toEqual(canonical); await applyPendingProposal(page);
    await visibleCards(page, count);
  }
  const after = await viewport(page).getAttribute('style');
  await cards(page).first().locator('.composer-action-title').click();
  expect(await viewport(page).getAttribute('style')).toBe(after);
  const amount = cards(page).first().getByRole('textbox', { name: /Source amount/ }); await amount.fill('6');
  await expect(amount).toHaveValue('6');
  await expect(cards(page).first().locator('.composer-quote-note')).toHaveText('Quote unavailable');
  expect(await viewport(page).getAttribute('style')).toBe(after);
  await cards(page).first().getByRole('button', { name: 'Select source token', exact: true }).click();
  await page.getByRole('region', { name: 'Source token picker', exact: true }).locator('label:has(input[aria-label="WETH"])').click();
  await page.getByRole('button', { name: 'Hide token picker', exact: true }).click();
  expect(await viewport(page).getAttribute('style')).toBe(after);
  await expect(page.locator('.canvas-navigator-slider').first()).toHaveAttribute('max', '1.4');
  await assertPassiveWallet(page); networkGuard.assertClean();
});

test('UX-010 real handles author Bridge → Swap, preserve layout on reconnect, and remove canonical dependencies', async ({ page, networkGuard }) => {
  await page.setViewportSize({ width: 1536, height: 1080 }); await open(page);
  await say(page, 'Swap 5 USDC for WETH on Base');
  await say(page, 'bridge 5 USDC from Base to Arbitrum'); await visibleCards(page, 2);
  const draft = await ir(page), swap = draft.nodes.find(n => n.actionType === 'asset.swap.exact-input')!, bridge = draft.nodes.find(n => n.actionType === 'asset.bridge')!;
  const before = await viewport(page).getAttribute('style');
  await connect(page, bridge.nodeId, swap.nodeId);
  expect(workflowOrder(await ir(page)).filter(n => !n.actionType.startsWith('mock-')).map(n => n.nodeId)).toEqual([bridge.nodeId, swap.nodeId]);
  await expect(cards(page).filter({ hasText: 'Bridge' }).locator('.composer-action-title')).toContainText('1. Bridge');
  await expect(page.locator(`.react-flow__node[data-id="${swap.nodeId}"] .composer-action-title`)).toContainText('2. Swap');
  expect(await viewport(page).getAttribute('style')).toBe(before);
  const canonical = JSON.stringify(await ir(page));
  const title = page.locator(`.build-flow-surface .react-flow__node[data-id="${bridge.nodeId}"] .composer-action-title`);
  const box = await title.boundingBox(); await page.mouse.move(box!.x + 20, box!.y + 8); await page.mouse.down();
  await page.mouse.move(box!.x + 70, box!.y + 28, { steps: 10 }); await page.mouse.up();
  expect(JSON.stringify(await ir(page))).toBe(canonical); expect(await viewport(page).getAttribute('style')).toBe(before);
  const edge = page.locator(`.react-flow__edge[data-id="${bridge.nodeId}-${swap.nodeId}"]`);
  await edge.locator('.react-flow__edge-interaction').click({ force: true }); await page.keyboard.press('Delete');
  await expect(edge).toHaveCount(0); expect((await ir(page)).nodes.find(n => n.nodeId === swap.nodeId)!.dependencies).toEqual([]);
  await connect(page, swap.nodeId, bridge.nodeId);
  expect(workflowOrder(await ir(page)).filter(n => !n.actionType.startsWith('mock-')).map(n => n.nodeId)).toEqual([swap.nodeId, bridge.nodeId]);
  await assertPassiveWallet(page); networkGuard.assertClean();
});


test('UX-009/010 repeated Send cards retain links and the manual viewport through recipient/amount Apply', async ({ page, networkGuard }) => {
  await page.setViewportSize({ width: 1536, height: 1080 }); await open(page);
  const recipient = '0x3333333333333333333333333333333333333333';
  await say(page, 'Send 5 USDC on Arbitrum to ' + recipient);
  await say(page, 'Send 6 USDC on Arbitrum to ' + recipient); await visibleCards(page, 2);
  const nodes = (await ir(page)).nodes.filter(n => n.actionType === 'asset.transfer'); expect(nodes).toHaveLength(2);
  const [a, b] = nodes; expect(a!.nodeId).not.toBe(b!.nodeId);
  await connect(page, b!.nodeId, a!.nodeId);
  const slider = page.locator('.build-flow-surface .canvas-navigator-slider'); await slider.focus(); await page.keyboard.press('ArrowDown');
  await settledViewport(page); const manual = await viewport(page).getAttribute('style');
  const card = page.locator(`.build-flow-surface .react-flow__node[data-id="${a!.nodeId}"]`);
  await card.locator('.composer-action-title').click();
  await card.getByRole('textbox', { name: 'To', exact: true }).fill('0x4444444444444444444444444444444444444444');
  await card.getByRole('textbox', { name: /Source amount/ }).fill('7');
  await card.getByRole('button', { name: 'Review Send change', exact: true }).click();
  expect((await ir(page)).nodes.filter(n => n.actionType === 'asset.transfer').map(n => ({ ...n, dependencies: [] }))).toEqual(nodes);
  await card.getByRole('button', { name: 'Apply proposal', exact: true }).click();
  const changed = await ir(page); expect(changed.nodes.find(n => n.nodeId === a!.nodeId)!.dependencies).toEqual([b!.nodeId]);
  expect(changed.nodes.find(n => n.nodeId === b!.nodeId)).toEqual(b);
  await expect(page.locator(`.react-flow__edge[data-id="${b!.nodeId}-${a!.nodeId}"]`)).toBeVisible();
  expect(await viewport(page).getAttribute('style')).toBe(manual);
  await assertPassiveWallet(page); networkGuard.assertClean();
});
