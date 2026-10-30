// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ARB-001 Phase 7 — owner-approved workflow UX on normal /app (authoring only). Committed Copilot replay, passive wallet (account and
 * chain reads only), every financial gate off, live-quote answers replayed in the browser. MOCKED evidence; no provider, Review or execution.
 */
import type { Locator, Page } from '@playwright/test';
import { hashArtifactBytes, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { test, expect, assertPassiveWallet, installPassiveWallet, readWorkflowIr, sendChatCommand, CHAT_COMMITTED } from './fixtures';
import { replayProviderLogos } from './asset-logo-replay';
import { composeStrategy } from '../src/engine/strategy-engine';
import { openBuilder } from './build-entry-navigation';

test.skip(process.env.FLOFI_WORKFLOW_UX_AUTHORING_E2E !== 'MOCKED_LOOPBACK_ONLY', 'Runs under playwright.workflow-ux.config.ts');
// The EIP-55 reference vector (mixed case) and the same address with one letter's case flipped (checksum fails).
const MIXED = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', BAD = '0x5aaeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const cards = (page: Page) => page.locator('.build-flow-surface .composer-card');
const conversation = (page: Page) => page.getByRole('log', { name: 'Conversation' });
const revision = (page: Page) => page.locator('.summary-bar');
const actionsCount = (page: Page) => page.locator('.build-canvas-head .revision');
async function open(page: Page) {
  await replayProviderLogos(page); await installPassiveWallet(page, '0xa4b1'); await openBuilder(page);
  await expect(conversation(page)).toContainText('Hi FloFier!');
}
async function say(page: Page, text: string) {
  await page.locator('#mock-prompt').fill(text); await page.getByRole('button', { name: 'Send', exact: true }).click();
}
async function chooseNetwork(page: Page, card: Locator, network: string) {
  await card.getByRole('button', { name: 'Select source token', exact: true }).click();
  await page.getByRole('region', { name: 'Source asset picker', exact: true }).getByRole('button', { name: network, exact: true }).click();
  await page.getByRole('button', { name: 'Hide token picker', exact: true }).click();
}
/** The canonical Send for this workspace identity (MCP composes the same meaning at `workflow-local`). */
async function expectCanonicalSend(page: Page, recipient: string) {
  const actual = JSON.parse(await readWorkflowIr(page)) as SemanticWorkflow;
  const composed = composeStrategy({ version: 1, action: 'transfer', network: 'arbitrum-one', asset: 'USDC', amount: '5', recipient } as never);
  expect(composed.ok).toBe(true); if (!composed.ok) return;
  expect(actual).toEqual({ ...structuredClone(composed.workflow), workflowId: actual.workflowId });
}

test.describe('UX-001 / UX-005 Send card and destination', () => {
  test('the toolbar and card say Send; the To field is network-aware and its address becomes the canonical recipient', async ({ page, networkGuard }) => {
    await open(page);
    const add = page.getByRole('button', { name: 'Add send', exact: true });
    await expect(add).toHaveAttribute('title', 'Add Send'); await expect(add).toContainText('Send');
    await expect(page.getByRole('button', { name: /transfer/i })).toHaveCount(0);
    await add.click();
    const card = cards(page).first(), to = card.getByRole('textbox', { name: 'To', exact: true });
    await expect(card.locator('.composer-action-title')).toContainText('1. Send');
    // On a mainnet wallet the new Send already targets a recipient-capable network: an empty destination blocks Review.
    await expect(to).toBeVisible(); await expect(to).toHaveValue(''); await expect(to).toHaveAttribute('placeholder', '0x…');
    await expect(card.getByRole('button', { name: 'Review Send change', exact: true })).toBeDisabled();
    await chooseNetwork(page, card, 'Arbitrum One');
    await card.getByRole('button', { name: 'Select source token', exact: true }).click();
    const tokens = page.getByRole('region', { name: 'Source token picker', exact: true });
    await tokens.locator('label:has(input[aria-label="USDC"])').click();
    await expect(tokens.getByRole('radio', { name: 'USDC', exact: true })).toBeChecked();
    await page.getByRole('button', { name: 'Hide token picker', exact: true }).click();
    await card.getByRole('textbox', { name: 'Source amount (USDC)', exact: true }).fill('5');
    const review = card.getByRole('button', { name: 'Review Send change', exact: true });
    await expect(to).not.toHaveAttribute('readonly', ''); await expect(to).toHaveValue(''); await expect(to).toHaveAttribute('placeholder', '0x…');
    await expect(review).toBeDisabled();
    for (const invalid of ['0x1234', BAD]) {
      await to.fill(invalid); await expect(to).toHaveAttribute('aria-invalid', 'true');
      await expect(card.getByText('Enter a valid recipient address for this network.', { exact: true })).toBeVisible(); await expect(review).toBeDisabled();
    }
    await to.fill(` ${MIXED} `); await expect(to).not.toHaveAttribute('aria-invalid', 'true'); await expect(review).toBeEnabled();
    await expect(revision(page)).toHaveAttribute('data-workflow-revision', '0');
    await review.click(); await card.getByRole('button', { name: 'Apply proposal', exact: true }).click();
    await expect(revision(page)).toHaveAttribute('data-workflow-revision', '1');
    const authored = cards(page).first();
    await expect(authored.locator('.composer-action-title')).toContainText('1. Send');
    await expect(authored.getByRole('textbox', { name: 'To', exact: true })).toHaveValue(MIXED.toLowerCase());
    await expectCanonicalSend(page, MIXED.toLowerCase());
    await assertPassiveWallet(page); networkGuard.assertClean();
  });

  test('an owner-only self-transfer network shows To as the connected wallet, read-only', async ({ page, networkGuard }) => {
    await replayProviderLogos(page); await installPassiveWallet(page, '0x14a34'); await openBuilder(page);
    await page.getByRole('button', { name: 'Add send', exact: true }).click();
    const card = cards(page).first(), to = card.getByRole('textbox', { name: 'To', exact: true });
    await chooseNetwork(page, card, 'Robinhood Chain Testnet');
    await expect(to).toHaveAttribute('readonly', ''); await expect(to).toHaveAttribute('placeholder', 'Your connected wallet');
    await expect(to).toHaveAttribute('title', 'This network sends only to your connected wallet.');
    await assertPassiveWallet(page); networkGuard.assertClean();
  });

  test('Copilot: an exact Send without a destination asks, and the answer authors the same canonical recipient', async ({ page, networkGuard }) => {
    await open(page);
    await say(page, 'Send 5 USDC on Arbitrum');
    await expect(conversation(page).locator('.message').last()).toContainText('Which wallet should I send it to?');
    await expect(page.getByRole('button', { name: /^Review proposed change:/ })).toHaveCount(0);
    await say(page, BAD);
    await expect(conversation(page).locator('.message').last()).toContainText('That is not a valid address on this network.');
    await say(page, MIXED);
    // BUILD-FLOFI-CONVERSATIONAL-001: the completed request is committed at once (no proposal to apply).
    await expect(conversation(page).locator('.message').last()).toContainText('Send added to your workflow: 5 USDC');
    await expect(page.getByRole('button', { name: /^Review proposed change:/ })).toHaveCount(0);
    await expect(revision(page)).toHaveAttribute('data-workflow-revision', '1');
    await expect(cards(page).first().getByRole('textbox', { name: 'To', exact: true })).toHaveValue(MIXED.toLowerCase());
    await expectCanonicalSend(page, MIXED.toLowerCase());
    await assertPassiveWallet(page); networkGuard.assertClean();
  });

  test('Copilot: natural language asks for the destination and fills the same To field; a provided one fills it directly', async ({ page, networkGuard }) => {
    await open(page);
    await say(page, 'Please send 5 USDC on Arbitrum');
    const answer = () => conversation(page).locator('.message.ai').last();
    await expect(answer()).toContainText('Which wallet should I send it to?');
    await expect(page.getByRole('button', { name: /^Review proposed change:/ })).toHaveCount(0);
    await say(page, MIXED);
    await expect(answer()).toContainText(`Interpreted as “transfer 5 USDC on Arbitrum One to ${MIXED.toLowerCase()}”`);
    await expect(answer()).toContainText(CHAT_COMMITTED);
    await expect(cards(page).first().getByRole('textbox', { name: 'To', exact: true })).toHaveValue(MIXED.toLowerCase());
    await expectCanonicalSend(page, MIXED.toLowerCase());

    await openBuilder(page); await expect(conversation(page)).toContainText('Hi FloFier!');
    const recipient = '0x3333333333333333333333333333333333333333';
    await say(page, 'Please Send 5 USDC on Arbitrum to ' + recipient);
    await expect(answer()).toContainText('Interpreted as'); await expect(answer()).toContainText(CHAT_COMMITTED);
    await expect(cards(page).first().getByRole('textbox', { name: 'To', exact: true })).toHaveValue(recipient);
    await expectCanonicalSend(page, recipient);
    await assertPassiveWallet(page); networkGuard.assertClean();
  });
});

test('UX-002 the existing Automate action is a clock icon beside rename/save, and the old Canvas control is gone', async ({ page, networkGuard }) => {
  await open(page);
  const header = page.locator('.build-canvas-head .canvas-name'), automate = page.getByRole('button', { name: 'Automate this workflow', exact: true });
  await expect(header.getByRole('button', { name: 'Rename workflow', exact: true })).toBeVisible();
  await expect(automate).toHaveCount(0);
  await sendChatCommand(page, 'send 5 USDC on Arbitrum to 0x3333333333333333333333333333333333333333');
  await expect(automate).toHaveCount(1);
  await expect(header.getByRole('button', { name: 'Automate this workflow', exact: true })).toHaveAttribute('title', 'Automate this workflow');
  const order = await header.locator('button').evaluateAll(buttons => buttons.map(button => button.className));
  expect(order).toEqual(['workflow-rename', 'workflow-save', 'workflow-automate']);
  await expect(page.locator('.canvas-automate-action')).toHaveCount(0);
  const [save, clock] = await Promise.all([header.getByRole('button', { name: 'Save workflow', exact: true }).boundingBox(), automate.boundingBox()]);
  expect(Math.abs(save!.y - clock!.y)).toBeLessThan(2); expect(clock!.x - (save!.x + save!.width)).toBeLessThan(12);
  await automate.focus(); await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/app\/automations$/);
  await assertPassiveWallet(page); networkGuard.assertClean();
});

/**
 * UX-006, BUILD-FLOFI-CONVERSATIONAL-001: a chat request is committed at once, so on the empty Canvas the card itself replaces the droplet (no
 * proposal to confirm). A proposal remains only for a chat change that would drop an unnamed step, and keeps the existing placement.
 */
test.describe('UX-006 chat authoring in the empty Canvas', () => {
  test('a chat request becomes the card at once in place of the empty state; the chat’s Undo restores it', async ({ page, networkGuard }) => {
    await open(page);
    const empty = page.locator('.build-flow-surface .canvas-empty'), artifact = page.getByRole('button', { name: /^Review proposed change:/ });
    await expect(empty).toContainText('Start your workflow'); await expect(actionsCount(page)).toHaveText('0 actions');
    await say(page, 'Swap 5 USDC for WETH on Base');
    await expect(conversation(page).locator('.message.ai').last()).toContainText('Interpreted as');
    await expect(conversation(page).locator('.message.ai').last()).toContainText('Swap added to your workflow: 5 USDC');
    await expect(artifact).toHaveCount(0); await expect(empty).toHaveCount(0);
    await expect(actionsCount(page)).toHaveText('1 action'); await expect(cards(page)).toHaveCount(1);
    await expect(revision(page)).toHaveAttribute('data-workflow-revision', '1');
    await conversation(page).locator('.message').last().getByRole('button', { name: 'Undo this change', exact: true }).click();
    await expect(empty).toContainText('Start your workflow'); await expect(actionsCount(page)).toHaveText('0 actions');
    await expect(revision(page)).toHaveAttribute('data-workflow-revision', '2');
    await assertPassiveWallet(page); networkGuard.assertClean();
  });

  test('a non-empty workflow keeps the existing proposal placement', async ({ page, networkGuard }) => {
    await open(page);
    await sendChatCommand(page, 'swap 50 USDC to WETH on Base Sepolia slippage 50 bps');
    await say(page, 'compose supply 0.1 USDC to Aave then borrow 0.01 USDC then swap borrowed USDC to WETH on Base Sepolia slippage 50 bps owner 0x1111111111111111111111111111111111111111');
    const artifact = page.getByRole('button', { name: /^Review proposed change:/ });
    await expect(artifact).toBeVisible(); await expect(artifact).not.toHaveClass(/proposal-artifact-centered/);
    const [box, surface] = await Promise.all([artifact.boundingBox(), page.locator('.build-flow-surface').boundingBox()]);
    expect(Math.abs(surface!.x + surface!.width - (box!.x + box!.width) - 16)).toBeLessThan(2); expect(Math.abs(box!.y - surface!.y - 16)).toBeLessThan(2);
    await expect(actionsCount(page)).toHaveText('1 action');
    await assertPassiveWallet(page); networkGuard.assertClean();
  });
});

type Seen = { readonly at: number; readonly body: { workflow: SemanticWorkflow; nodeId: string } };
/** Replays build-estimate answers in the browser (MOCKED): bound to each exact snapshot, delayed per request, never a provider call. */
async function replayQuotes(page: Page, answer: (index: number, seen: Seen) => { delayMs: number; expected: string | null; symbol?: string }) {
  const seen: Seen[] = [];
  await page.route('**/api/build-estimate', async route => {
    const body = JSON.parse(route.request().postData() ?? '{}') as Seen['body'], index = seen.push({ at: Date.now(), body }) - 1;
    const { delayMs, expected, symbol = 'WETH' } = answer(index, seen[index]!);
    await new Promise(resolve => setTimeout(resolve, delayMs));
    const node = body.workflow.nodes.find(node => node.nodeId === body.nodeId)!;
    const json = expected === null ? { ok: false, code: 'ESTIMATE_UNAVAILABLE' } : { ok: true, estimate: { nodeId: body.nodeId, chain: node.chainId, provider: 'Uniswap V3',
      workflowHash: hashArtifactBytes('semantic-workflow', new TextEncoder().encode(JSON.stringify(body.workflow))), expected, minimum: expected, symbol,
      slippageBps: node.userConstraints.find(c => c.kind === 'MAXIMUM_SLIPPAGE_BPS')?.maximumBps,
      expiresAt: new Date(Date.now() + 60_000).toISOString() } };
    await route.fulfill({ json }).catch(() => undefined);
  });
  return seen;
}
const amountOf = (seen: Seen) => JSON.stringify(seen.body.workflow.nodes.find(node => node.nodeId === seen.body.nodeId)).match(/"amount":"(\d+)"/)?.[1];

test.describe('UX-007 fast live quote feedback', () => {
  for (const network of ['Arbitrum One', 'Base'] as const) test(`${network} Swap: calculating at once, one coalesced request, latest amount wins, no Simulate`, async ({ page, networkGuard }) => {
    // Request 2 (amount 10) is answered after request 3 (amount 1000): its late, different answer must never be shown.
    const seen = await replayQuotes(page, index => [{ delayMs: 200, expected: '0.04' }, { delayMs: 700, expected: '9.99' }, { delayMs: 50, expected: '0.4' }][index] ?? { delayMs: 50, expected: '0.4' });
    await page.clock.install();
    await open(page);
    await page.getByRole('button', { name: 'Add swap', exact: true }).click();
    const card = cards(page).first(); await chooseNetwork(page, card, network);
    const input = card.getByRole('textbox', { name: 'Source amount (USDC)', exact: true });
    const destination = card.getByRole('group', { name: 'Destination amount (unquoted placeholder)', exact: true });
    // Slow runners must not turn the typing sequence into real pauses beyond the debounce window.
    await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1000);
    const t0 = Date.now();
    await input.pressSequentially('100', { delay: 40 });
    await expect(destination).toContainText('Calculating…'); const calculating = Date.now() - t0;
    await expect(card.locator('.composer-quote-note')).toContainText('Calculating estimate…');
    expect(seen).toHaveLength(0);
    await page.clock.runFor(200);
    await page.clock.resume();
    await expect(destination).toContainText('0.04'); const shown = Date.now() - t0;
    expect(seen.map(amountOf)).toEqual(['100000000']); const requested = seen[0]!.at - t0;
    test.info().annotations.push({ type: 'mocked timing (ms)', description: `${network}: calculating ${calculating}, request ${requested}, estimate ${shown} (controlled 200 ms debounce; 200 ms replay delay)` });
    await expect(card.locator('.composer-quote-note')).toContainText('Approximate · Uniswap V3 · Simulate before review');
    // A newer amount supersedes a slower older answer; the older one never overwrites it.
    await input.fill('10'); await expect(destination).toContainText('Calculating…');
    await expect.poll(() => seen.length).toBe(2); await input.fill('1000');
    await expect(destination).toContainText('0.4'); await page.waitForTimeout(900); await expect(destination).toContainText('0.4'); await expect(destination).not.toContainText('9.99');
    expect(seen.map(amountOf)).toEqual(['100000000', '10000000', '1000000000']);
    // Estimation only: the draft is not applied, simulated, reviewed or signed.
    await expect(revision(page)).toHaveAttribute('data-workflow-revision', '0');
    await expect(page.getByRole('complementary', { name: 'Simulation Summary' })).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Workflow stages' }).getByRole('button', { name: 'Build', exact: true })).toHaveAttribute('aria-current', 'page');
    await assertPassiveWallet(page); networkGuard.assertClean();
  });

  test('an unavailable route says Quote unavailable and never keeps another amount\'s quote', async ({ page, networkGuard }) => {
    await replayQuotes(page, (_index, s) => ({ delayMs: 20, expected: amountOf(s) === '7000000' ? null : '0.002' }));
    await open(page);
    await page.getByRole('button', { name: 'Add swap', exact: true }).click();
    const card = cards(page).first(); await chooseNetwork(page, card, 'Arbitrum One');
    const input = card.getByRole('textbox', { name: 'Source amount (USDC)', exact: true });
    const destination = card.getByRole('group', { name: 'Destination amount (unquoted placeholder)', exact: true });
    await input.fill('5'); await expect(destination).toContainText('0.002');
    await input.fill('7'); await expect(card.locator('.composer-quote-note')).toContainText('Quote unavailable');
    await expect(destination).not.toContainText('0.002'); await expect(destination).toContainText('—');
    await input.fill('5'); await expect(destination).toContainText('0.002');
    await assertPassiveWallet(page); networkGuard.assertClean();
  });

  test('Robinhood Stock Token swap (Stocks card) uses the same live quote', async ({ page, networkGuard }) => {
    const seen = await replayQuotes(page, () => ({ delayMs: 20, expected: '0.026', symbol: 'AAPL' }));
    await open(page);
    await page.getByRole('button', { name: 'Stocks', exact: true }).click();
    const card = cards(page).filter({ hasText: 'Robinhood' }).first();
    const input = card.getByRole('textbox', { name: /^Stocks amount/ });
    await input.pressSequentially('10', { delay: 30 });
    await expect(card.locator('.composer-quote-note')).toContainText(/Calculating estimate…|Approximate · Uniswap V3/);
    await expect(card.getByRole('group', { name: 'Destination amount (unquoted placeholder)', exact: true })).toContainText('0.026');
    expect(seen).toHaveLength(1); expect(seen[0]!.body.workflow.nodes.some(node => node.chainId === 'eip155:4663')).toBe(true);
    await expect(revision(page)).toHaveAttribute('data-workflow-revision', '0');
    await assertPassiveWallet(page); networkGuard.assertClean();
  });
});
