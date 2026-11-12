// SPDX-License-Identifier: AGPL-3.0-only
/** Phase 7B: normal product, real handles, canonical probe, passive wallet, all financial gates off. */
import type { Page } from '@playwright/test';
import { test, expect, installPassiveWallet, assertPassiveWallet, readWorkflowIr, sendChatCommand } from './fixtures';
import { replayProviderLogos } from './asset-logo-replay';
import { workflowOrder, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { continueToBuilder, openBuilder, useDockedToolbar, useToolbarRail } from './build-entry-navigation';
const cards = (page: Page) => page.locator('.build-flow-surface .react-flow__node');
const viewport = (page: Page) => page.locator('.build-flow-surface .react-flow__viewport');
const ir = async (page: Page) => JSON.parse(await readWorkflowIr(page)) as SemanticWorkflow;
async function open(page: Page) {
  await replayProviderLogos(page); await installPassiveWallet(page, '0xa4b1'); await openBuilder(page);
  await expect(page.getByRole('log', { name: 'Conversation' })).toContainText('Hi FloFier!');
}
/** BUILD-FLOFI-CONVERSATIONAL-001: the chat commits the request at once (no proposal to apply). */
const say = sendChatCommand;
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

/**
 * BUILD AAVE-V3-EXPANSION-001: a step added after another is linked to it automatically (an ordering dependency). These tests author their own
 * links, so they first remove that automatic link through the same edge selection and Delete an owner uses.
 */
async function disconnect(page: Page, source: string, target: string) {
  const edge = page.locator(`.build-flow-surface .react-flow__edge[data-id="${source}-${target}"]`);
  await expect(edge).toBeVisible();
  // A straight edge has a zero-height box, so it is selected by clicking its midpoint on screen (its 20px interaction stroke).
  const point = await edge.locator('.react-flow__edge-interaction').evaluate((path: SVGPathElement) => {
    const at = path.getPointAtLength(path.getTotalLength() / 2), m = path.getScreenCTM()!;
    return { x: at.x * m.a + at.y * m.c + m.e, y: at.x * m.b + at.y * m.d + m.f };
  });
  await page.mouse.click(point.x, point.y); await page.keyboard.press('Delete');
  await expect(edge).toHaveCount(0);
  await expect.poll(async () => (await ir(page)).nodes.find(n => n.nodeId === target)?.dependencies).toEqual([]);
}

/** Every button of a toolbar is visible, hit-testable at its centre, inside the toolbar and the graph, and the toolbar never scrolls. */
async function toolbarGeometry(page: Page, name: string) {
  const toolbar = page.getByRole('toolbar', { name, exact: true }), graph = page.locator('.build-flow-surface');
  const surface = (await graph.boundingBox())!;
  const geometry = await toolbar.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, scrollX: element.scrollWidth - element.clientWidth, scrollY: element.scrollHeight - element.clientHeight,
      buttons: [...element.querySelectorAll('button')].map(b => { const r = b.getBoundingClientRect(), label = b.querySelector('span')?.getBoundingClientRect();
        return { hit: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('button') === b, name: b.getAttribute('aria-label'), text: b.textContent?.trim(), x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, labelWidth: label?.width ?? 0 }; }) };
  });
  for (const button of geometry.buttons) {
    expect(button.hit, button.name ?? '').toBe(true); expect(button.width).toBeGreaterThan(18);
    expect(button.x).toBeGreaterThanOrEqual(geometry.left - 1); expect(button.right).toBeLessThanOrEqual(geometry.right + 1);
    expect(button.y).toBeGreaterThanOrEqual(geometry.top - 1); expect(button.bottom).toBeLessThanOrEqual(geometry.bottom + 1);
  }
  expect(geometry.scrollX).toBeLessThanOrEqual(1); expect(geometry.scrollY).toBeLessThanOrEqual(1);
  return { ...geometry, surface };
}

// BUILD-FLOFI-BUILDER-UX-002 (owner-approved Editor brief): the step actions live in the vertical rail by default; the docked row (an owner's choice)
// wraps instead of overflowing, in English and in Portuguese (it used to overflow in Portuguese). P0 approved UX (board 04): the rail is grouped
// (Swap, Bridge, Send | Pool, Supply, Withdraw | Borrow, Repay, Lending | Stocks), Privacy is not offered until it exists, Undo / Redo / ··· sit in
// the Canvas header and Duplicate / Delete float above the selected card (no separate utilities toolbar).
for (const width of [1440, 1536, 1920]) test(`UX-008 every Canvas tool fits — rail by default, docked row in EN and PT — at ${width}px`, async ({ page, networkGuard }, testInfo) => {
  await page.setViewportSize({ width, height: 1080 }); await open(page);
  const actions = ['Swap','Bridge','Send','Pool / Liquidity','Supply','Withdraw','Borrow','Repay','Lending','Stocks'];
  const rail = await toolbarGeometry(page, 'Canvas tools');
  expect(rail.buttons.map(b => b.text)).toEqual(actions);
  // One column inside the graph.
  for (const button of rail.buttons) expect(button.x).toBeCloseTo(rail.buttons[0]!.x, 0);
  expect(rail.left).toBeGreaterThanOrEqual(rail.surface.x); expect(rail.bottom).toBeLessThanOrEqual(rail.surface.y + rail.surface.height + 1);
  await expect(page.getByRole('toolbar', { name: 'Workflow utilities', exact: true })).toHaveCount(0);
  const header = page.locator('.build-canvas-head .canvas-head-actions');
  expect(await header.getByRole('button').evaluateAll(buttons => buttons.map(b => b.getAttribute('aria-label')))).toEqual(['Undo', 'Redo', 'More options']);
  await testInfo.attach(`toolbar-rail-${width}px`, { body: await page.locator('.build-flow-surface').screenshot(), contentType: 'image/png' });
  for (const language of ['EN', 'PT'] as const) {
    if (language === 'PT') { await page.evaluate(() => localStorage.setItem('flofi.language', 'PT')); await page.reload(); await continueToBuilder(page); }
    await useDockedToolbar(page);
    const docked = await toolbarGeometry(page, language === 'PT' ? 'Ferramentas do Canvas' : 'Canvas tools');
    expect(docked.buttons).toHaveLength(actions.length);
    // Every labelled control shows its whole label.
    for (const button of docked.buttons) expect(button.labelWidth, button.text ?? '').toBeGreaterThan(12);
    for (const [index, button] of docked.buttons.entries()) if (index && button.y === docked.buttons[index - 1]!.y) expect(button.x).toBeGreaterThanOrEqual(docked.buttons[index - 1]!.right - 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    await testInfo.attach(`toolbar-docked-${language}-${width}px`, { body: await page.locator('.build-canvas-head').screenshot(), contentType: 'image/png' });
    await useToolbarRail(page);
  }
  await page.evaluate(() => localStorage.setItem('flofi.language', 'EN')); await page.reload(); await continueToBuilder(page);
  const toolbar = page.getByRole('toolbar', { name: 'Canvas tools' });
  // Privacy is not offered until it exists (no disabled placeholder); fit never enables an unimplemented financial capability.
  await expect(toolbar.getByRole('button', { name: 'Privacy', exact: true })).toHaveCount(0);
  await toolbar.getByRole('button', { name: 'Add swap', exact: true }).click(); await expect(cards(page)).toHaveCount(1);
  await page.getByRole('toolbar', { name: 'Selected step actions' }).getByRole('button', { name: 'Delete', exact: true }).click(); await expect(cards(page)).toHaveCount(0);
  await assertPassiveWallet(page); networkGuard.assertClean();
});

test('UX-009 fits committed insertions 1–5; proposals and ordinary edits do not refit', async ({ page, networkGuard }) => {
  await page.setViewportSize({ width: 1536, height: 1080 }); await open(page);
  for (let count = 1; count <= 5; count++) {
    // BUILD-FLOFI-CONVERSATIONAL-001: each chat request is a committed insertion.
    await say(page, 'Swap 5 USDC for WETH on Base');
    await visibleCards(page, count);
  }
  // A proposal (a chat request that would replace the workflow's steps stays one) neither refits the viewport nor changes the IR.
  await settledViewport(page);
  const before = await viewport(page).getAttribute('style'), canonical = await ir(page);
  await page.locator('#mock-prompt').fill('compose supply 1 USDC to Aave then borrow 0.1 USDC then swap borrowed USDC to WETH on Base Sepolia slippage 50 bps owner 0x1111111111111111111111111111111111111111');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Review proposed change:/ })).toBeVisible();
  expect(await viewport(page).getAttribute('style')).toBe(before); expect(await ir(page)).toEqual(canonical);
  await page.getByRole('button', { name: /^Review proposed change:/ }).click();
  await page.getByRole('button', { name: 'Dismiss proposal', exact: true }).click();
  const after = await viewport(page).getAttribute('style');
  await cards(page).first().locator('.composer-action-title').click();
  expect(await viewport(page).getAttribute('style')).toBe(after);
  const amount = cards(page).first().getByRole('textbox', { name: /Source amount/ }); await amount.fill('6');
  await expect(amount).toHaveValue('6');
  const quoteNote = cards(page).first().locator('.composer-quote-note');
  await expect(quoteNote).toHaveText('Quote service is not configured. Contact support.');
  await expect(quoteNote).toHaveAttribute('title', /^CLOUD_RUNTIME_NOT_CONFIGURED · [a-f0-9-]{36}$/);
  expect(await viewport(page).getAttribute('style')).toBe(after);
  await cards(page).first().getByRole('button', { name: 'Select source token', exact: true }).click();
  await page.getByRole('region', { name: 'Source token picker', exact: true }).locator('label:has(input[aria-label="WETH"])').click();
  await page.getByRole('button', { name: 'Hide token picker', exact: true }).click();
  expect(await viewport(page).getAttribute('style')).toBe(after);
  // P0 approved UX (board 04): the zoom slider is gone; Zoom in (+) still stops at the engine's maximum, 1.4.
  const zoomIn = page.locator('.build-flow-surface .canvas-navigator').getByRole('button', { name: 'Zoom in', exact: true });
  for (let step = 0; step < 12 && await zoomIn.isEnabled(); step++) { await zoomIn.click(); await settledViewport(page); }
  await expect(zoomIn).toBeDisabled();
  expect(await viewport(page).evaluate(element => new DOMMatrixReadOnly(getComputedStyle(element).transform).a)).toBeCloseTo(1.4, 2);
  await assertPassiveWallet(page); networkGuard.assertClean();
});

test('UX-010 real handles author Bridge → Swap, preserve layout on reconnect, and remove canonical dependencies', async ({ page, networkGuard }) => {
  await page.setViewportSize({ width: 1536, height: 1080 }); await open(page);
  await say(page, 'Swap 5 USDC for WETH on Base');
  await say(page, 'bridge 5 USDC from Base to Arbitrum'); await visibleCards(page, 2);
  const draft = await ir(page), swap = draft.nodes.find(n => n.actionType === 'asset.swap.exact-input')!, bridge = draft.nodes.find(n => n.actionType === 'asset.bridge')!;
  await disconnect(page, swap.nodeId, bridge.nodeId);
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
  const added = (await ir(page)).nodes.filter(n => n.actionType === 'asset.transfer'); expect(added).toHaveLength(2);
  await disconnect(page, added[0]!.nodeId, added[1]!.nodeId);
  const nodes = (await ir(page)).nodes.filter(n => n.actionType === 'asset.transfer');
  const [a, b] = nodes; expect(a!.nodeId).not.toBe(b!.nodeId);
  await connect(page, b!.nodeId, a!.nodeId);
  // P0 approved UX (board 04): a manual zoom through the navigator's Zoom out (−) (the slider is gone).
  await page.locator('.build-flow-surface .canvas-navigator').getByRole('button', { name: 'Zoom out', exact: true }).click();
  await settledViewport(page); const manual = await viewport(page).getAttribute('style');
  const card = page.locator(`.build-flow-surface .react-flow__node[data-id="${a!.nodeId}"]`);
  await card.locator('.composer-action-title').click();
  await card.getByRole('textbox', { name: 'To', exact: true }).fill('0x4444444444444444444444444444444444444444');
  await card.getByRole('textbox', { name: /Source amount/ }).fill('7');
  // A typed draft is not the workflow until it is applied (P0 workflow execution: Enter applies it directly, no Review/Apply proposal).
  expect((await ir(page)).nodes.filter(n => n.actionType === 'asset.transfer').map(n => ({ ...n, dependencies: [] }))).toEqual(nodes);
  await card.getByRole('textbox', { name: /Source amount/ }).press('Enter');
  const changed = await ir(page); expect(changed.nodes.find(n => n.nodeId === a!.nodeId)!.dependencies).toEqual([b!.nodeId]);
  expect(changed.nodes.find(n => n.nodeId === b!.nodeId)).toEqual(b);
  await expect(page.locator(`.react-flow__edge[data-id="${b!.nodeId}-${a!.nodeId}"]`)).toBeVisible();
  expect(await viewport(page).getAttribute('style')).toBe(manual);
  await assertPassiveWallet(page); networkGuard.assertClean();
});

// FIX-BRIDGE-CATALOG-CANCEL-001: the visual card uses the same catalogs as the inspector; live metadata never proves a route.
test('Bridge picker searches independent Arbitrum and Robinhood catalogs and authors a canonical non-legacy asset pair', async ({ page, networkGuard }, testInfo) => {
  await open(page);
  await page.getByRole('button', { name: 'Add bridge', exact: true }).click();
  const card = cards(page).last();
  await card.getByRole('button', { name: 'Configure source asset', exact: true }).click();
  let picker = page.getByRole('region', { name: 'Source bridge picker', exact: true });
  await picker.getByRole('button', { name: 'Arbitrum', exact: true }).click();
  await expect(picker.getByRole('searchbox', { name: 'Search Arbitrum tokens', exact: true })).toBeVisible();
  await expect(picker.getByRole('button', { name: 'Arbitrum', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const columns = await picker.locator('.composer-bridge-picker-column').evaluateAll(nodes => nodes.map(n => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, width: r.width }; }));
  expect(columns).toHaveLength(2); expect(columns[1]!.x).toBeGreaterThanOrEqual(columns[0]!.right); expect(columns[0]!.y).toBeCloseTo(columns[1]!.y, 0);
  expect(columns.every(column => column.width > 100)).toBe(true);
  expect((await picker.boundingBox())!.height).toBeLessThan(350);
  await expect(picker.locator('.brand-icon').first()).toBeVisible();
  await picker.locator('label:has(input[aria-label="WETH"])').click();
  await page.screenshot({ path: testInfo.outputPath('bridge-arbitrum-source.png') });
  await card.getByRole('button', { name: 'Configure destination asset', exact: true }).click();
  picker = page.getByRole('region', { name: 'Destination bridge picker', exact: true });
  await picker.getByRole('button', { name: 'Robinhood Chain', exact: true }).click();
  const search = picker.getByRole('searchbox', { name: 'Search Robinhood Chain tokens', exact: true });
  await expect(search).toBeVisible();
  await search.fill('Tesla');
  await expect(picker.getByRole('list', { name: 'Robinhood Chain token results', exact: true })).toContainText('TSLA');
  await expect(picker.getByRole('radio', { checked: true })).toHaveCount(0);
  await search.fill('');
  await picker.locator('label:has(input[aria-label="ETH"])').click();
  await expect(card.getByRole('button', { name: 'Configure source asset', exact: true })).toContainText('WETH');
  await page.screenshot({ path: testInfo.outputPath('bridge-robinhood-destination.png') });
  await card.getByRole('button', { name: 'Hide bridge picker', exact: true }).click();
  const amount = card.getByRole('textbox', { name: /amount/i }).first();
  await amount.fill('0.01'); await amount.press('Enter');
  await expect.poll(async () => (await ir(page)).nodes.some(n => n.adapterConstraints.adapters.some(a => a.id === 'flofi.router.universal'))).toBe(true);
  const workflow = await ir(page), node = workflow.nodes.find(n => n.actionType === 'asset.bridge')!;
  expect(node.adapterConstraints.adapters).toContainEqual({ id: 'flofi.router.universal', version: '1.0.0' });
  const { readUniversalBridgeNode } = await import('@defi-workflow-engine/workflow-contracts');
  expect(readUniversalBridgeNode(node)).toMatchObject({ sourceChain: 'eip155:42161', destinationChain: 'eip155:4663',
    inputAsset: { kind: 'TOKEN', address: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', decimals: 18 }, outputAsset: { kind: 'NATIVE', decimals: 18 }, slippageBps: 100 });
  // Applying an asset creates no liquidity claim and asks no signing method.
  await expect(card).not.toContainText('Executable');
  await assertPassiveWallet(page); networkGuard.assertClean();
});

test('Bridge picker offers searchable metadata on all five mainnets and refuses to infer route availability', async ({ page, networkGuard }) => {
  await open(page); await page.route('https://img.jup.ag/**', route => route.fulfill({ status: 404, body: '' }));
  await page.getByRole('button', { name: 'Add bridge', exact: true }).click();
  const card = cards(page).last();
  await card.getByRole('button', { name: 'Configure source asset', exact: true }).click();
  const picker = page.getByRole('region', { name: 'Source bridge picker', exact: true });
  for (const network of ['Ethereum', 'Base', 'Arbitrum', 'Robinhood Chain', 'Solana']) {
    await picker.getByRole('button', { name: network, exact: true }).click();
    await expect(picker.getByRole('searchbox', { name: `Search ${network} tokens`, exact: true })).toBeVisible();
    await expect(picker.getByRole('button', { name: network, exact: true })).toHaveAttribute('aria-pressed', 'true');
  }
  await expect(card).not.toContainText('Executable'); await assertPassiveWallet(page); networkGuard.assertClean();
});
