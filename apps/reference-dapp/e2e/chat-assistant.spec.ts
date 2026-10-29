// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-BRIDGE-LIVE-FIX-003 — the FloFi Assistant and native ETH in the chat. The header is the official FloFi symbol + "FloFi Assistant", the
 * welcome is one short paragraph (EN/PT-BR), the assistant's messages carry the FloFi symbol and the owner's a person icon, and the chat never
 * overflows at 1920/1440/1280/1024/390/375 px. Native ETH named in the chat is authored as the network's native ETH (IR `nativeId`), never WETH;
 * ETH → WETH is a WETH9 wrap; a missing network is asked for. Runs on the execution-continuity loopback runtime (MOCKED, nothing is sent).
 */
import type { Page } from '@playwright/test';
import { test, expect, readWorkflowIr } from './fixtures';

type IrNode = { inputs: { name: string; value: { asset?: unknown } }[]; adapterConstraints: { protocols: string[] }; userConstraints: { kind: string }[] };
const workflowIr = async (page: Page) => JSON.parse(await readWorkflowIr(page)) as { nodes: IrNode[] };

test.skip(process.env.FLOFI_SWAP_EXECUTION_E2E !== 'MOCKED_LOOPBACK_ONLY', 'Requires the opt-in loopback execution harness profile');
test.setTimeout(120_000);
const chat = (page: Page) => page.locator('.chat-messages[role="log"]');
const flofi = (page: Page) => chat(page).locator('.message:not(.you):not(.conversation-execution-message)').last();
async function say(page: Page, text: string) {
  await page.locator('#mock-prompt').fill(text);
  await page.locator('.chat-form button[type=submit]').click();
}
// This profile has no Copilot model, so the chat shows the command-only variant of the welcome (the model variant's exact EN/PT-BR copy is pinned
// by the unit suite): the same greeting and closing sentence, one short paragraph.
const WELCOME = { EN: [/^Hi FloFier! /, 'Then simulate, review, and execute with your wallet.'], PT: [/^Olá, FloFier! /, 'Depois simule, revise e execute com sua carteira.'] } as const;

const VIEWPORTS = [[1920, 1080], [1440, 1000], [1280, 900], [1024, 800], [390, 844], [375, 812]] as const;
for (const [width, height] of VIEWPORTS) for (const language of width === 1440 || width === 390 ? ['EN', 'PT'] as const : ['EN'] as const) {
  test(`FloFi Assistant at ${width}px (${language}): official symbol + title, short welcome, avatars, no overflow`, async ({ page }, testInfo) => {
    if (language === 'PT') await page.addInitScript(() => localStorage.setItem('flofi.language', 'PT'));
    await page.setViewportSize({ width, height });
    await page.goto('/app');
    const assistant = page.locator('aside.copilot');
    const title = assistant.locator('.copilot-head .assistant-title');
    await expect(title).toHaveText('FloFi Assistant');
    await expect(title.locator('img[src="/brand/flofi-symbol-light.svg"]')).toBeVisible();
    await expect(assistant).not.toContainText('ASSISTANT');
    const welcome = chat(page).locator('.message').first().locator('p');
    await expect(welcome).toHaveText(WELCOME[language][0]); await expect(welcome).toContainText(WELCOME[language][1]);
    expect((await welcome.innerText()).length).toBeLessThan(200);
    await expect(chat(page).locator('.chat-row-flofi').first().locator('.flofi-avatar img').first()).toBeVisible();
    await say(page, 'swap 10 USDC to WETH on Base Sepolia slippage 100 bps');
    await expect(flofi(page)).toContainText(language === 'PT' ? /adicionad/i : 'Swap added to your workflow');
    const you = chat(page).locator('.chat-row-you').last();
    await expect(you.locator('.user-avatar svg')).toBeVisible();
    await expect(chat(page).locator('.chat-row-flofi').last().locator('.flofi-avatar')).toBeVisible();
    // The avatar sits beside its own bubble (same row), never over it; the owner's row is on the right.
    const [bubble, avatar] = [await you.locator('.message.you').boundingBox(), await you.locator('.user-avatar').boundingBox()];
    expect(avatar!.x).toBeGreaterThanOrEqual(bubble!.x + bubble!.width - 1);
    // No horizontal page overflow; the header and its symbol are fully inside the assistant panel.
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    const [panel, head] = [await assistant.boundingBox(), await title.boundingBox()];
    expect(head!.x).toBeGreaterThanOrEqual(panel!.x); expect(head!.x + head!.width).toBeLessThanOrEqual(panel!.x + panel!.width + 0.5);
    await assistant.scrollIntoViewIfNeeded();
    await assistant.screenshot({ path: testInfo.outputPath(`flofi-assistant-${width}-${language}.png`) });
  });
}

test('native ETH in chat: a native-ETH swap and a WETH9 wrap on Base, a missing network asked for, test networks refused', async ({ page }) => {
  await page.goto('/app');
  await say(page, 'Swap 0.001 ETH to USDC on Base');
  await expect(flofi(page)).toContainText('Swap added to your workflow: 0.001 ETH');
  let ir = await workflowIr(page);
  let swap = ir.nodes.at(-1)!;
  expect(swap.inputs.find(input => input.name === 'amount-in')!.value.asset).toEqual({ chainId: 'eip155:8453', nativeId: 'ETH', decimals: 18 });
  expect(JSON.stringify(swap)).not.toContain('0x4200000000000000000000000000000000000006');
  await say(page, 'Wrap 0.01 ETH to WETH on Base');
  await expect(flofi(page)).toContainText('WETH9');
  ir = await workflowIr(page); swap = ir.nodes.at(-1)!;
  expect(swap.adapterConstraints.protocols).toEqual(['weth9']);
  expect(swap.userConstraints.map(constraint => constraint.kind)).toEqual(['MAXIMUM_INPUT']);
  const nodes = ir.nodes.length;
  await say(page, 'Wrap 0.01 ETH to WETH');
  await expect(chat(page).locator('.message').last()).toContainText('On which network should FloFi wrap or unwrap?');
  await say(page, 'swap 0.01 ETH to USDC on Base Sepolia slippage 50 bps');
  await expect(chat(page).locator('.message').last()).toContainText('On this network FloFi has no native ETH swap');
  expect((await workflowIr(page)).nodes).toHaveLength(nodes);
});
