// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-BUILDER-UX-002 (owner-approved Editor brief): the Editor's Create → Simulate → Execute stepper, the workflow header (name, networks, real
 * state), the cards' discreet status, the FloFi panel's live summary with "Show step", and the footer's count, real notices and single Simulate
 * control — in English and Portuguese, desktop and phone. Presentation only: nothing here simulates, approves, signs or submits.
 */
import { test, expect, sendChatCommand, readWorkflowIr } from './fixtures';
import { openBuilder, editorSteps, expectEditorSection } from './build-entry-navigation';

test('the stepper opens the Editor sections in order, marks only where the owner is, and keeps the global navigation', async ({ page }) => {
  await openBuilder(page);
  const steps = editorSteps(page);
  await expect(steps.getByRole('button')).toHaveText(['1Create', '2Simulate', '3Execute']);
  await expect(steps.getByRole('button', { name: 'Create', exact: true })).toHaveAttribute('aria-current', 'step');
  await expect(page.getByRole('navigation', { name: 'Workflow stages' }).getByRole('button')).toHaveText(['Dashboard', 'Chat', 'Editor']);
  await sendChatCommand(page, 'Swap 2 USDC to WETH on Base Sepolia slippage 50 bps');
  await steps.getByRole('button', { name: 'Simulate', exact: true }).click();
  await expectEditorSection(page, 'Simulate');
  await expect(steps.getByRole('button', { name: 'Simulate', exact: true })).toHaveAttribute('aria-current', 'step');
  await expect(steps.locator('[aria-current="step"]')).toHaveCount(1);
  await steps.getByRole('button', { name: 'Execute', exact: true }).click();
  await expectEditorSection(page, 'Execute');
  await steps.getByRole('button', { name: 'Create', exact: true }).click();
  await expectEditorSection(page, 'Build');
  // An unapplied Canvas amount closes Simulate and Execute, and says why, exactly as the former footer buttons did.
  const amount = page.locator('.build-flow-surface .composer-card').first().getByRole('textbox').first();
  await amount.fill('3');
  for (const name of ['Simulate', 'Execute']) {
    await expect(steps.getByRole('button', { name, exact: true })).toBeDisabled();
    await expect(steps.getByRole('button', { name, exact: true })).toHaveAttribute('title', 'Configure the action amount on the Canvas first');
  }
});

test('header, cards, FloFi summary and footer state only the real workflow; Show step selects the step that needs attention', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBuilder(page);
  const canvas = page.getByRole('region', { name: 'Workflow canvas', exact: true });
  const summary = page.getByRole('region', { name: 'Workflow summary', exact: true });
  const footer = page.locator('footer.summary-bar');
  await expect(canvas.locator('.editor-state-pill')).toHaveText('Workflow state: No steps yet');
  await expect(summary).toContainText('Add a step from the toolbar or describe it to FloFi.');
  await sendChatCommand(page, 'Swap 2 USDC to WETH on Base Sepolia slippage 50 bps');
  await expect(canvas.locator('.editor-state-pill')).toHaveText('Workflow state: Configured');
  await expect(canvas.getByRole('list', { name: 'Workflow networks', exact: true })).toHaveText('Base Sepolia');
  await expect(canvas.locator('.composer-status')).toHaveText(['Configured: Configured. Simulation, Review and your signature come next.']);
  // Simulate is closed here (no wallet is connected), and its control says why; the footer then claims nothing about warnings.
  await expect(footer.locator('.summary-notice')).toHaveCount(0);
  // The footer hosts the one Canvas lifecycle control; no copy of it remains in the Canvas.
  await expect(page.getByRole('button', { name: 'Simulate workflow', exact: true })).toHaveCount(1);
  await expect(footer.locator('.canvas-primary-action button[data-lifecycle-action]')).toHaveCount(1);
  // A second swap whose slippage the workflow's review warns about.
  await sendChatCommand(page, 'Swap 1 USDC to WETH on Base Sepolia slippage 300 bps');
  const ir = JSON.parse(await readWorkflowIr(page)) as { nodes: { nodeId: string }[] };
  const warned = ir.nodes.at(-1)!.nodeId;
  await expect(canvas.locator('.editor-state-pill')).toHaveText('Workflow state: Needs attention');
  await expect(page.locator(`.build-flow-surface .react-flow__node[data-id="${warned}"] .composer-status`)).toHaveAttribute('data-card-status', 'attention');
  await expect(summary.getByRole('listitem')).toHaveCount(2);
  await expect(summary.locator('.editor-overview-attention')).toContainText('Step 2 needs attention');
  await expect(summary.locator('.editor-overview-attention')).toContainText('Check this step’s slippage limit.');
  await expect(footer.locator('.summary-notice')).toContainText('1 step needs attention');
  // Show step selects that card and moves focus to it; nothing in the workflow changes.
  const before = await readWorkflowIr(page);
  await page.locator('.react-flow__pane').click({ position: { x: 600, y: 40 } });
  await summary.getByRole('button', { name: 'Show step', exact: true }).click();
  await expect(page.locator(`.build-flow-surface .react-flow__node[data-id="${warned}"] .composer-card`)).toHaveClass(/active/);
  await expect(page.locator(`.build-flow-surface .react-flow__node[data-id="${warned}"]`)).toBeFocused();
  expect(await readWorkflowIr(page)).toBe(before);
  // Nothing claims a simulation, an approval or an executable transaction.
  await expect(page.locator('.editor-overview, .summary-notice, .composer-status, .editor-state-pill')).not.toContainText([/Simulated|Approved|Ready to execute/]);
});

test('Portuguese and phone widths: the same truthful labels, no horizontal overflow, 44 px tools by default on a phone', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('flofi.language', 'PT'));
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await openBuilder(page);
    await expect(editorSteps(page).getByRole('button', { name: 'Criar', exact: true })).toHaveAttribute('aria-current', 'step');
    await expect(editorSteps(page).getByRole('button', { name: 'Simular', exact: true })).toBeVisible();
    await page.getByLabel('Descreva o seu fluxo').fill('Swap 2 USDC to WETH on Base Sepolia slippage 50 bps');
    await page.getByRole('button', { name: 'Enviar', exact: true }).click();
    await expect(page.locator('.build-flow-surface .composer-status')).toHaveText(['Configurado: Configurado. Depois vêm a simulação, a revisão e a sua assinatura.']);
    await expect(page.getByRole('region', { name: 'Resumo do fluxo', exact: true })).toBeVisible();
    // On a phone the docked tool row is the default and keeps 44 px targets.
    const pool = page.getByRole('toolbar', { name: 'Ferramentas do Canvas' }).getByRole('button', { name: 'Adicionar pool', exact: true });
    const box = (await pool.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
    await expect(page.locator('footer.summary-bar').getByRole('button', { name: 'Simular fluxo', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});
