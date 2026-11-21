// SPDX-License-Identifier: AGPL-3.0-only
/** Real product/API/service code; synthetic loopback read responses. No financial execution claim. */
import { test, expect } from './fixtures';
import { installJourneyWallet, walletRequests, setWalletChain } from './journey-fixtures';
import { createTestWallet } from '../../../packages/reference-reconciler/test/test-wallet';
import { hashArtifactBytes, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { expectEditorSection, openBuilder, openEditorSection, openReviewTechnicalDetails } from './build-entry-navigation';

for (const [network, chain] of [['Base Sepolia', '0x14a34'], ['Ethereum Sepolia', '0xaa36a7']] as const) {
  test(`${network}: Canvas → real read client estimate → Simulate → Review; locale preserves authority and wallet changes invalidate it`, async ({ page, request, networkGuard }) => {
    test.setTimeout(90_000);
    if (process.env.FLOFI_SWAP_READ_E2E !== 'MOCKED_LOOPBACK_ONLY') throw Error('READ_HARNESS_REQUIRED');
    const owner = createTestWallet(); await installJourneyWallet(page, [owner], { chain });
    const workflows: SemanticWorkflow[] = [];
    page.on('request', event => { if (event.url().endsWith('/api/build-estimate')) workflows.push(event.postDataJSON().workflow as SemanticWorkflow); });
    await openBuilder(page);
    // BUILD-FLOFI-PRODUCT-UX-001: compact chrome shows the short address; network stays in the title tooltip.
    await expect(page.getByRole('group', { name: 'Wallet connection' }).locator('.wallet-connection')).toHaveAttribute('title', new RegExp(network));
    await page.getByRole('button', { name: 'Add swap', exact: true }).click();
    const card = page.locator('.build-flow-surface .composer-card').first();
    await card.getByRole('button', { name: 'Select source token', exact: true }).click();
    await page.getByRole('region', { name: 'Action network picker', exact: true }).getByRole('button', { name: network, exact: true }).click();
    await page.getByRole('button', { name: 'Hide token picker', exact: true }).click();
    await card.getByRole('textbox', { name: 'Source amount (USDC)', exact: true }).fill('1');
    await card.getByRole('textbox', { name: 'Source amount (USDC)', exact: true }).press('Enter');
    await expect(card.locator('.composer-destination-box')).toContainText('0.0005');
    await expect(card.locator('.composer-provider')).toHaveText('Uniswap V3');
    await expect(card.locator('.composer-provider')).toHaveAttribute('title', 'Estimate from Uniswap V3');
    await expect(card).not.toContainText(/Approximate|Simulate before review/);
    await expect(card.locator('.composer-quote-note')).toHaveCount(0);
    await expect.poll(() => workflows.length).toBeGreaterThan(0);
    const workflow = workflows.at(-1)!, revision = await page.locator('.summary-bar').getAttribute('data-workflow-revision');
    const hash = hashArtifactBytes('semantic-workflow', new TextEncoder().encode(JSON.stringify(workflow)));
    await openEditorSection(page, 'Simulate');
    // BUILD-FLOFI-CHAT-E2E-FIX-002 / P0 approved UX (board 06): the chat-first Simulation Summary (and its embedded Review) is the Review
    // panel's collapsed Technical details (the panel is beside the canvas from 1200 px).
    await openReviewTechnicalDetails(page);
    const summary = page.getByRole('complementary', { name: 'Simulation Summary', exact: true });
    const review = page.locator('.review-authorization-details');
    const primary = page.locator('.canvas-primary-action');
    await page.getByRole('button', { name: 'Simulate workflow', exact: true }).click();
    await expect(summary.getByRole('region', { name: 'Expected result' })).toContainText('0.0005 WETH');
    await expect(summary).not.toContainText('The workflow has changed.');
    // BUILD-FLOFI-UX-EDITOR-FINOPS-001 (Caio, B2) / UX-05: Simulate states the result with no authorization; its panel's "Continue to authorization" opens
    // Execute (C1), where the one owner action, "Authorize workflow" (Review acceptance, then the wallet request), is offered. This read-only
    // acceptance never clicks it: nothing is accepted or requested, and locale and wallet changes act on the fresh Review's authority.
    await expect(page.getByRole('button', { name: /^Authorize (in wallet|workflow)$/ })).toHaveCount(0);
    const reviewOperation = page.locator('.simulation-panel-action').getByRole('button', { name: 'Continue to authorization', exact: true });
    await expect(reviewOperation).toBeEnabled();
    await expect(page.locator('footer.summary-bar button[data-lifecycle-action]')).toHaveCount(0);
    await review.locator('> summary').click();
    for (const limit of ['Wallet', 'Network', 'Permissions', 'Max spend', 'Max slippage', 'Minimum received', 'Valid until']) await expect(review).toContainText(limit);
    await expect(review.getByRole('button')).toHaveCount(0);
    await expect(page.locator('main pre, .simulation-technical, .review-workspace')).toHaveCount(0);
    // Quote arrival does not edit the IR or semantic revision.
    await expect(page.locator('.summary-bar')).toHaveAttribute('data-workflow-revision', revision!);
    expect(hashArtifactBytes('semantic-workflow', new TextEncoder().encode(JSON.stringify(workflows.at(-1))))).toBe(hash);
    await reviewOperation.click();
    await expectEditorSection(page, 'Execute');
    await expect(primary.getByRole('button', { name: 'Authorize workflow', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Authorize workflow', exact: true })).toHaveCount(1);
    const before = await walletRequests(page);
    expect(before).not.toContain('eth_sendTransaction');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('switch', { name: 'Language', exact: true }).click(); await page.keyboard.press('Escape');
    await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
    await expect(primary.getByRole('button', { name: 'Autorizar fluxo', exact: true })).toBeEnabled();
    expect(await walletRequests(page)).toEqual(before);
    await expect(page.locator('.summary-bar')).toHaveAttribute('data-workflow-revision', revision!);
    // Returning to the reviewed network cannot revive authorization.
    await setWalletChain(page, '0x1');
    await expect(primary.getByRole('button', { name: 'Autorizar fluxo', exact: true })).toHaveCount(0);
    await setWalletChain(page, chain);
    await expect(primary.getByRole('button', { name: 'Autorizar fluxo', exact: true })).toHaveCount(0);
    // C2 wording on Execute: the Review must be refreshed (the step's "Simulate again", nothing sent).
    await expect(primary.getByRole('button', { name: 'Atualizar revisão', exact: true })).toBeVisible();
    expect(await walletRequests(page)).not.toContain('eth_sendTransaction');
    const reads = await request.get('https://127.0.0.1:8558/', { ignoreHTTPSErrors: true });
    expect((await reads.json()).methods.every((method: string) => ['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call'].includes(method))).toBe(true);
    networkGuard.assertClean();
  });
}
