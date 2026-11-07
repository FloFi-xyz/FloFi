// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-AUTOMATION-002 → BUILD-FLOFI-UNIVERSAL-WORKFLOW-002 (ADR-0008, invariant S1: FloFi never pays a user's network fees).
 *
 * "Automatic within limits" executed every step from FloFi's delegated executor, whose session address SENT and PAID FOR each redemption.
 * This build retires that executor: it can no longer send, sign for or pay for anything, and every operation that would create new
 * executor-paid authority is refused at the product boundary (EXECUTOR_FUNDED_GAS_RETIRED; unit and PostgreSQL proofs in
 * src/delegation/*.test.ts). This profile used to prove the delegated journey end to end; it now proves, in a real browser under
 * `next start` on the same MOCKED loopback harness WITH delegation configured (virtual passkey, disposable session signers under /tmp, the
 * deterministic test clock), that the retired path cannot be entered from any authoring surface and that nothing is signed or sent:
 *
 *   Credentials  the enrollment form is gone and the retirement reason is shown; no wallet signature is requested.
 *   Automations  "Automatic within limits" is disabled with the reason; "Ask every time" stays the choice.
 *   Chat         the same for a typed price-trigger draft (the committed replay; the AI only interprets).
 *   Canvas       the same for "Automate this workflow"; a multi-step workflow is pointed to the Canvas run, where the owner's wallet pays.
 *
 * Owner-confirmed automations ("Ask every time") are unchanged and certified by the automations profiles.
 */
import type { Page } from '@playwright/test';
import { query } from './automation-fixtures';
import { assertDelegationHarness, chainControl, createDelegationOwner, evmWalletRequests, expect, installDelegationEvmWallet, SIGNING_METHODS, test } from './delegation-fixtures';
import { sendChatCommand, proveConnectedEvmWallet } from './fixtures';
import { openBuilder } from './build-entry-navigation';

type Sends = { evm: number; solana: number };
const RETIRED = 'Automatic execution is retired: it ran from FloFi\'s account, and FloFi never pays your network fees. Choose "Ask every time": your own wallet confirms and pays.';
/** This owner's executor-funded records: none may exist (rules other than owner-confirmed, Credentials, delegated authority, executions). */
const delegatedRows = async (owner: string) => {
  const of = (table: string) => `SELECT count(*)::int AS n FROM ${table} WHERE owner_account = $1`, account = [owner.toLowerCase()];
  const count = async (sql: string) => (await query<{ n: number }>(sql, account))[0]!.n;
  return { rules: await count(`${of('automation_rules')} AND execution_mode <> 'CONFIRM_EACH_TIME'`), grants: await count(of('credential_grants')),
    authorizations: await count(of('delegated_authorizations')), executions: await count(of('delegated_executions')) };
};

/** A fresh owner with a funded MOCKED account, its wallet proven once; returns what must stay untouched. */
async function provenOwner(page: Page) {
  await chainControl('MOCK_reset');
  const owner = await createDelegationOwner();
  await chainControl('MOCK_evmOwner', [owner.address, '1000000000']);
  await installDelegationEvmWallet(page, owner);
  await page.goto('/app/passkeys');
  // BUILD-SOLANA-TRANSFER-UX-001: the sign-in reuses the EVM wallet already connected in this browser (no selector).
  await proveConnectedEvmWallet(page, page.locator('body'), owner.address);
  // Proven: the passkey form appears only for a verified owner (the proof must finish before the next navigation).
  await expect(page.getByRole('region', { name: 'Passkeys', exact: true }).getByRole('textbox', { name: 'Passkey name', exact: true })).toBeVisible();
  // The wallet's request log is per page: every page after the sign-in must ask the wallet to sign nothing at all.
  const signing = async () => (await evmWalletRequests(page)).filter(m => SIGNING_METHODS.includes(m));
  return { owner, signing, sends: await chainControl<Sends>('MOCK_sends') };
}

test.describe('BUILD-FLOFI-UNIVERSAL-WORKFLOW-002 retired executor-funded automation (MOCKED loopback chains, delegation configured)', () => {
  test.beforeAll(() => assertDelegationHarness());

  test('Credentials and Automations: no enrollment and no "Automatic within limits"; the reason is shown; nothing is signed, sent or stored', async ({ page }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    const { owner, signing, sends } = await provenOwner(page);

    // Credentials: the retirement reason replaces the enrollment form.
    await page.goto('/app/credentials');
    const execution = page.getByRole('region', { name: 'Automatic execution', exact: true });
    await expect(execution).toContainText('Enrollment is retired: FloFi no longer executes from its own account and never pays your network fees. Existing Credentials can still be revoked.');
    await expect(execution.getByRole('form', { name: 'Enroll a wallet for automatic execution', exact: true })).toHaveCount(0);
    await expect(execution.getByRole('button', { name: 'Enroll with my wallet', exact: true })).toHaveCount(0);
    expect(await signing()).toEqual([]);

    // Automations: "Automatic within limits" is visible, disabled, and says why; "Ask every time" is the choice.
    await page.goto('/app/automations');
    const workspace = page.getByRole('region', { name: 'Automations', exact: true });
    await workspace.getByRole('button', { name: /Recurring buy/ }).click();
    const mode = workspace.getByRole('radiogroup', { name: 'Execution', exact: true });
    await expect(mode.getByRole('radio', { name: 'Ask every time', exact: true })).toBeChecked();
    await expect(mode.getByRole('radio', { name: 'Automatic within limits', exact: true })).toBeDisabled();
    await expect(workspace).toContainText(RETIRED);
    await expect(workspace.getByRole('form', { name: 'Create an automatic workflow', exact: true })).toHaveCount(0);

    expect(await signing()).toEqual([]);
    expect(await chainControl<Sends>('MOCK_sends')).toEqual(sends);
    expect(await delegatedRows(owner.address)).toEqual({ rules: 0, grants: 0, authorizations: 0, executions: 0 });
    expect(errors).toEqual([]);
  });

  test('Chat: a draft that says "automatically" still offers only "Ask every time"; automatic execution is disabled with the reason', async ({ page }) => {
    if (process.env.FLOFI_COPILOT !== 'replay') throw new Error('REPLAY_REQUIRED');
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    const { owner, signing, sends } = await provenOwner(page);

    // The committed replay is the AI's typed reading of this message: a PRICE_TRIGGER draft with no mode, limit, expiry or Credential.
    await openBuilder(page);
    await page.locator('#mock-prompt').fill('If ETH drops 5% from $3000, buy 50 USDC of ETH on Base Sepolia automatically, max 200 USDC/week.');
    await page.locator('.chat-form button[type=submit]').click();
    const proposal = page.getByRole('region', { name: 'Automation proposal', exact: true });
    await expect(proposal).toContainText('Price falls 5% from $3000');
    const mode = proposal.getByRole('radiogroup', { name: 'Execution', exact: true });
    await expect(mode.getByRole('radio', { name: 'Ask every time', exact: true })).toBeChecked();
    await expect(mode.getByRole('radio', { name: 'Automatic within limits', exact: true })).toBeDisabled();
    await expect(mode).toContainText(RETIRED);
    await expect(proposal.getByRole('button', { name: 'Check credentials and limits', exact: true })).toHaveCount(0);

    expect(await signing()).toEqual([]);
    expect(await chainControl<Sends>('MOCK_sends')).toEqual(sends);
    expect(await delegatedRows(owner.address)).toEqual({ rules: 0, grants: 0, authorizations: 0, executions: 0 });
    expect(errors).toEqual([]);
  });

  test('Canvas: "Automate this workflow" disables automatic execution with the reason and points a two-step workflow to the Canvas run', async ({ page }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    const { owner, signing, sends } = await provenOwner(page);

    // The owner authors a two-step workflow on the Canvas (FloFi's deterministic grammar, applied through the normal proposal review).
    await openBuilder(page);
    for (const sentence of ['swap 50 USDC to WETH on Base Sepolia slippage 50 bps', 'swap 40 USDC to WETH on Base Sepolia slippage 50 bps']) {
      await sendChatCommand(page, sentence);
    }
    // UX-002: the existing action is the clock icon beside the workflow name's rename/save controls.
    await page.locator('.build-canvas-head .canvas-name').getByRole('button', { name: 'Automate this workflow', exact: true }).click();

    await expect(page).toHaveURL(/\/app\/automations$/);
    const panel = page.getByRole('region', { name: 'Automate this workflow', exact: true });
    await expect(panel.locator('.delegation-steps > li')).toHaveText(['Step 1 · 50 USDC → WETH · Base Sepolia', 'Step 2 · 40 USDC → WETH · Base Sepolia']);
    const mode = panel.getByRole('radiogroup', { name: 'Execution', exact: true });
    await expect(mode.getByRole('radio', { name: 'Ask every time', exact: true })).toBeChecked();
    await expect(mode.getByRole('radio', { name: 'Automatic within limits', exact: true })).toBeDisabled();
    await expect(mode).toContainText(RETIRED);
    await expect(panel).toContainText('Ask every time runs one-step workflows. This workflow has 2 steps: run it from the Canvas, where your own wallet confirms and pays for each step.');
    await expect(panel.getByRole('button', { name: 'Check credentials and limits', exact: true })).toHaveCount(0);

    expect(await signing()).toEqual([]);
    expect(await chainControl<Sends>('MOCK_sends')).toEqual(sends);
    expect(await delegatedRows(owner.address)).toEqual({ rules: 0, grants: 0, authorizations: 0, executions: 0 });
    expect(errors).toEqual([]);
  });
});
