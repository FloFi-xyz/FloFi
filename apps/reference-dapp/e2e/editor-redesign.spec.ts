// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-BUILDER-UX-002 (owner-approved Editor brief): the Editor's Create → Simulate → Execute stepper, the workflow header (name, networks, real
 * state), the cards' discreet status, the FloFi panel's live summary with "Show step", and the footer's count, real notices and single Simulate
 * control — in English and Portuguese, desktop and phone. Presentation only: nothing here simulates, approves, signs or submits.
 * P0 approved UX (boards 03b, 04): the stepper sits in the top bar and the global navigation lives in the ☰ drawer; a card states a status only when
 * there is something to do ("Configured" is the workflow's state, shown once in the Canvas header); the FloFi panel's summary is the collapsed
 * "Plan · n steps", shown from two steps on.
 */
import { test, expect, sendChatCommand, readWorkflowIr } from './fixtures';
import { openBuilder, editorSectionAction, editorSteps, expectEditorSection, navigationDrawer, navigationLink, openNavigation } from './build-entry-navigation';
import { chooseLanguage } from './app-origin';

test('the stepper opens the Editor sections in order, marks only where the owner is, and keeps the global navigation', async ({ page }) => {
  await openBuilder(page);
  const steps = editorSteps(page);
  await expect(steps.getByRole('button')).toHaveText(['1Create', '2Simulate', '3Execute']);
  await expect(steps.getByRole('button', { name: 'Create', exact: true })).toHaveAttribute('aria-current', 'step');
  // The global navigation is the drawer's: New workflow (Chat), Editor (current) and Dashboard come first.
  await openNavigation(page);
  await expect(navigationDrawer(page).getByRole('link').first()).toHaveText('New workflow');
  await expect(navigationLink(page, 'Editor')).toHaveAttribute('aria-current', 'page');
  await expect(navigationLink(page, 'Dashboard')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(navigationDrawer(page)).toHaveCount(0);
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
  for (const name of ['Simulate', 'Execute'] as const) {
    await expect(editorSectionAction(page, name)).toBeDisabled();
    await expect(editorSectionAction(page, name)).toHaveAttribute('title', 'Configure the action amount on the Canvas first');
    // P0 approved UX (board 16): a closed step also states its reason in its accessible name.
    await expect(editorSectionAction(page, name)).toHaveAccessibleName(new RegExp(`^${name} ?: Configure the action amount on the Canvas first$`));
  }
});

test('header, cards, FloFi summary and footer state only the real workflow; Show step selects the step that needs attention', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBuilder(page);
  const canvas = page.getByRole('region', { name: 'Workflow canvas', exact: true });
  const summary = page.getByRole('region', { name: 'Plan', exact: true });
  const footer = page.locator('footer.summary-bar');
  await expect(canvas.locator('.editor-state-pill')).toHaveText('Workflow state: No steps yet');
  // Board 04: with no step (or one) there is nothing to summarise, so the Plan is not shown.
  await expect(summary).toHaveCount(0);
  await sendChatCommand(page, 'Swap 2 USDC to WETH on Base Sepolia slippage 50 bps');
  await expect(canvas.locator('.editor-state-pill')).toHaveText('Workflow state: Configured');
  await expect(canvas.getByRole('list', { name: 'Workflow networks', exact: true })).toHaveText('Base Sepolia');
  // Board 04: "Configured" is the workflow's state in the header, never repeated on the card.
  await expect(canvas.locator('.composer-status')).toHaveCount(0);
  await expect(summary).toHaveCount(0);
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
  // The Plan appears from two steps on, collapsed to one line that names the step needing attention; it expands into the steps.
  const plan = summary.getByRole('button', { name: /^Plan · 2 steps/ });
  await expect(plan).toHaveAttribute('aria-expanded', 'false');
  await plan.click();
  await expect(plan).toHaveAttribute('aria-expanded', 'true');
  await expect(summary.getByRole('listitem')).toHaveCount(2);
  await expect(summary.locator('.editor-overview-attention')).toContainText('Step 2 needs attention');
  await expect(summary.locator('.editor-overview-attention')).toContainText('Check this step’s slippage limit.');
  // The pill shares the card foot with Settings and never covers it (once laid over it, CI's font metrics hid the control's centre).
  for (const node of await page.locator('.build-flow-surface .react-flow__node').filter({ has: page.locator('.composer-status') }).all()) {
    const pill = (await node.locator('.composer-status').boundingBox())!, settings = (await node.getByRole('button', { name: 'Action settings', exact: true }).boundingBox())!;
    expect(pill.x >= settings.x + settings.width || pill.x + pill.width <= settings.x || pill.y >= settings.y + settings.height || pill.y + pill.height <= settings.y).toBe(true);
  }
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
  // P0 hotfix (locale contract): the language cookie is authoritative (storage alone no longer overrides the suite's English cookie).
  await chooseLanguage(page.context(), 'PT');
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await openBuilder(page);
    await expect(editorSteps(page).getByRole('button', { name: 'Criar', exact: true })).toHaveAttribute('aria-current', 'step');
    await expect(editorSteps(page).getByRole('button', { name: 'Simular', exact: true })).toBeVisible();
    await page.getByLabel('Descreva o seu fluxo').fill('Swap 2 USDC to WETH on Base Sepolia slippage 50 bps');
    await page.getByRole('button', { name: 'Enviar mensagem', exact: true }).click();
    // Board 04: the configured state is the header's (translated), not repeated on the card; one step has no Plan to summarise.
    await expect(page.locator('.build-canvas-head .editor-state-pill')).toContainText('Pronto para simular');
    await expect(page.locator('.build-flow-surface .composer-card')).toHaveCount(1);
    await expect(page.locator('.build-flow-surface .composer-status')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Plano', exact: true })).toHaveCount(0);
    // On a phone the docked tool row is the default and keeps 44 px targets.
    const pool = page.getByRole('toolbar', { name: 'Ferramentas do Canvas' }).getByRole('button', { name: 'Adicionar pool', exact: true });
    const box = (await pool.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
    await expect(page.locator('footer.summary-bar').getByRole('button', { name: 'Simular fluxo', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});
