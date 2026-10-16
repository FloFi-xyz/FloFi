// SPDX-License-Identifier: AGPL-3.0-only
import { expect, openProposalReview, openSimulationDetails, acceptProductReview } from './fixtures';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { createMockedSolanaWallet } from '@defi-workflow-engine/reference-compiler';
import { chooseSolanaWallet, installSolanaWallet } from './jupiter-fixtures';

/** MOCKED Solana Devnet loopback only. The wallet's disposable key lives only in this test process's memory. */
export async function resetDevnetHarness(options: Record<string, unknown> = {}, funding: { lamports?: string; devUsdc?: string } = {}) {
  if (process.env.GRYLOO_SOLANA_DEVNET_E2E !== 'MOCKED_LOOPBACK_ONLY' || !process.env.GRYLOO_SOLANA_DEVNET_JOURNAL?.startsWith(join(tmpdir(), 'gryloo-demo001-'))) throw new Error('MOCK_RESET_DENIED');
  await rm(process.env.GRYLOO_SOLANA_DEVNET_JOURNAL, { recursive: true, force: true });
  const wallet = createMockedSolanaWallet();
  await devnetControl({ action: 'reset', owner: wallet.owner, options, ...funding });
  return wallet;
}
export async function devnetControl(body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch('http://127.0.0.1:8552/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return (await response.json() as { result: unknown }).result;
}
/** A multi-cluster wallet, like common Wallet Standard Solana wallets. */
export const installDevnetWallet = (page: Page, wallet: ReturnType<typeof createMockedSolanaWallet>, behavior: Parameters<typeof installSolanaWallet>[2] = {}) =>
  installSolanaWallet(page, wallet, { chains: ['solana:mainnet', 'solana:devnet'], ...behavior });
export const devnetPanel = (page: Page) => page.getByRole('region', { name: 'Solana Devnet swap' });
export async function authorDevnetSwap(page: Page, via: 'canvas' | 'chat' = 'canvas') {
  await page.goto('/__engineering');
  if (via === 'chat') {
    await page.locator('#mock-prompt').fill('Swap 10 test USDC to test SOL on Solana Devnet');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
  } else {
    await page.getByText('Advanced action setup').click();
    await page.locator('#swap-network').selectOption('SOLANA_DEVNET');
    const form = page.getByRole('form', { name: 'Create Solana Devnet swap' });
    await form.getByLabel('From token').selectOption('SOL'); await form.getByLabel('To token').selectOption('devUSDC');
    await form.getByLabel('Amount').fill('0.1');
    await form.getByRole('button', { name: 'Review swap proposal' }).click();
  }
  await openProposalReview(page);
  await page.getByRole('button', { name: 'Apply proposal' }).click();
}
export async function reviewDevnetSwap(page: Page) {
  await page.getByRole('button', { name: 'Simulate workflow' }).click(); await openSimulationDetails(page);
  await chooseSolanaWallet(devnetPanel(page));
  await devnetPanel(page).getByRole('button', { name: 'Simulate swap' }).click();
  await devnetPanel(page).getByRole('definition').filter({ hasText: '→ expected' }).waitFor();
  await acceptProductReview(page);
}

/** The Canvas re-fits after each edit; positions are read only once its viewport transform has stopped changing. */
async function settledViewport(page: Page) {
  let last: string | null = null, stable = 0;
  await expect.poll(async () => {
    const current = await page.locator('.build-flow-surface .react-flow__viewport').getAttribute('style');
    stable = current === last ? stable + 1 : 0; last = current;
    return stable;
  }, { intervals: [100] }).toBeGreaterThanOrEqual(3);
}
/** Drags the swap's output onto the position's input (after moving the position card clear of the swap; layout only). */
export async function linkSwapToPosition(page: Page, swap = 'node-002', position = 'node-003') {
  const node = (id: string) => page.locator(`.build-flow-surface .react-flow__node[data-id="${id}"]`);
  await settledViewport(page);
  const title = (await node(position).locator('.composer-action-title').boundingBox())!;
  await page.mouse.move(title.x + 10, title.y + title.height / 2); await page.mouse.down();
  await page.mouse.move(title.x + 360, title.y + 220, { steps: 12 }); await page.mouse.up();
  await settledViewport(page);
  // A live quote's answer resizes its card and moves the card's vertically centred handles, so a press measured before the answer lands
  // on the card and drags it instead (CircleCI, main d926f87). The client gives up on an estimate after 15 s, so every quote settles.
  await expect(page.locator('.build-flow-surface .composer-quote-note').filter({ hasText: 'Calculating estimate' })).toHaveCount(0, { timeout: 20_000 });
  const b = (await node(position).locator('.react-flow__handle.target').boundingBox())!;
  // hover() presses the output where it is now (stable and receiving the pointer), not where an earlier measurement saw it.
  await node(swap).locator('.react-flow__handle.source').hover(); await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 16 }); await page.mouse.up();
  await expect(page.locator(`.build-flow-surface .react-flow__edge[data-id="${swap}-${position}"]`)).toBeVisible();
}
