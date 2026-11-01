// SPDX-License-Identifier: AGPL-3.0-only
import { test as base, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { E2E_APP_ORIGIN as APP_ORIGIN, E2E_CARD_ORIGIN } from './app-origin';

export const SYNTHETIC_GUARD_URL = 'https://example.invalid/gryloo-guard-self-test';

type Guard = { readonly unexpected: readonly string[]; assertClean(): void };
const guards = new WeakMap<BrowserContext, Guard>();
/** The app origin, plus the card origin only in the MOCKED card suite (BUILD-FLOFI-PRIVY-UX-001: card entry runs there, never on the app). */
const ALLOWED_ORIGINS: ReadonlySet<string> = new Set([APP_ORIGIN, ...process.env.GRYLOO_CARD_E2E === 'MOCKED_LOOPBACK_ONLY' ? [E2E_CARD_ORIGIN] : []]);

function guardedTest(negativeSelfTest: boolean) {
  return base.extend<{ context: BrowserContext; page: Page; networkGuard: Guard }>({
    context: async ({ browser }, use) => {
      const context = await browser.newContext({
        baseURL: APP_ORIGIN,
        serviceWorkers: 'block', bypassCSP: negativeSelfTest, viewport: { width: 1440, height: 900 },
        colorScheme: 'light', reducedMotion: 'reduce', locale: 'en-US',
      });
      const unexpected: string[] = [];
      const guard: Guard = {
        unexpected,
        assertClean() {
          if (unexpected.length) throw new Error(`Unexpected network attempts: ${unexpected.join(', ')}`);
        },
      };
      guards.set(context, guard);
      let pages = 0;
      context.on('page', () => { pages += 1; if (pages > 1) unexpected.push('UNGUARDED_POPUP'); });
      context.on('serviceworker', () => unexpected.push('SERVICE_WORKER'));
      await context.route('**/*', async (route) => {
        const url = route.request().url();
        let allowed = false;
        try { allowed = ALLOWED_ORIGINS.has(new URL(url).origin); } catch { /* Invalid URL is forbidden. */ }
        if (allowed) await route.continue();
        else { unexpected.push(url); await route.abort('blockedbyclient'); }
      });
      await context.routeWebSocket('**/*', async (route) => {
        unexpected.push(`WEBSOCKET:${route.url()}`);
        await route.close(); // No connectToServer call: no WebSocket egress.
      });
      try {
        await use(context);
        if (negativeSelfTest) {
          expect(unexpected).toEqual([SYNTHETIC_GUARD_URL]);
        } else {
          guard.assertClean();
        }
      } finally {
        await context.close();
      }
    },
    page: async ({ context }, use) => {
      const page = await context.newPage(); // Routes are installed before this call.
      try { await use(page); } finally { await page.close(); }
    },
    networkGuard: async ({ context }, use) => {
      const guard = guards.get(context);
      if (!guard) throw new Error('Network guard was not installed');
      await use(guard);
    },
  });
}

export const test = guardedTest(false);
// Imported solely by the dedicated negative self-test. Its fixture requires
// exactly one recorded synthetic URL and still fails on every other attempt.
export const negativeGuardTest = guardedTest(true);
export { expect };

/** Read-only simulated wallet identity for authoring network pickers, never an owner wallet. */
export async function installPassiveWallet(page: Page, chainId = '0x2105'): Promise<void> {
  await page.addInitScript(chain => {
    const methods: string[] = [];
    Object.defineProperty(window, '__authoringWalletMethods', { get: () => methods });
    Object.defineProperty(window, 'ethereum', { configurable: true, value: {
      request: async ({ method }: { method: string }) => {
        methods.push(method);
        if (method === 'eth_accounts') return ['0x1111111111111111111111111111111111111111'];
        if (method === 'eth_chainId') return chain;
        throw new Error(`Passive authoring wallet refused ${method}`);
      },
    } });
  }, chainId);
}

export async function assertPassiveWallet(page: Page): Promise<void> {
  expect(await page.evaluate(() => [...new Set((window as unknown as { __authoringWalletMethods: string[] }).__authoringWalletMethods)].sort())).toEqual(['eth_accounts', 'eth_chainId']);
}

/**
 * The canonical wallet selector: assert it is open, then explicitly choose one wallet by its name and ecosystem. Opening the
 * selector never invokes a wallet; only this choice does.
 */
export async function chooseWallet(page: Page, name: string, ecosystem: 'Ethereum' | 'Solana' = 'Ethereum', language: 'EN' | 'PT' = 'EN'): Promise<void> {
  const dialog = page.locator('dialog.wallet-selector[open]');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: `${name} ${language === 'PT' ? 'em' : 'on'} ${ecosystem}`, exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

/** Open the current authoring proposal; acceptance remains a separate explicit test action. */
export async function openProposalReview(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Review proposed change:/ }).click();
  await expect(page.getByRole('dialog', { name: 'Proposed change', exact: true })).toBeVisible();
}

/** Inspect existing provider diagnostics through their visible native disclosure. */
export async function openSimulationDetails(page: Page): Promise<void> {
  if (new URL(page.url()).pathname !== '/__engineering') {
    // An explicit diagnostic request enters the opted-in loopback harness without
    // reloading the persistent workspace or exposing diagnostics on normal routes.
    await page.evaluate(() => {
      if (!(window as unknown as { __flofiEngineeringWorkflow?: string }).__flofiEngineeringWorkflow) throw Error('ENGINEERING_HARNESS_REQUIRED');
      window.history.pushState(null, '', '/__engineering');
    });
  }
  const details = page.locator('.simulation-technical');
  await expect(details).toBeVisible();
  if (!(await details.evaluate(element => (element as HTMLDetailsElement).open))) await details.locator('> summary').click();
}

/**
 * BUILD-SOLANA-TRANSFER-UX-001: the one shared owner action after a simulation, on every network and action. It accepts the current Review
 * and then makes the first wallet request (there is no separate Execute click); the wallet's own confirmation stays separate.
 */
export const AUTHORIZE_IN_WALLET = 'Authorize in wallet';
/** Every Canvas CTA that can lead to a wallet request: an unaccepted Review ("approve") is one too, because it requests the wallet next. */
export const FINANCIAL_CANVAS_ACTIONS = ['approve', 'execute', 'continue'].map(kind => `button[data-lifecycle-action="${kind}"]:enabled`).join(', ');

/**
 * Use the shared product Review. MOCKED results must fail this authorization boundary. The single "Authorize in wallet" click accepts the
 * Review and, when the reviewed runtime is ready, makes the first wallet request (the caller's wallet fixture answers it); the workspace
 * then shows Execute.
 */
export async function acceptProductReview(page: Page): Promise<void> {
  const authorize = page.locator('.canvas-primary-action').getByRole('button', { name: AUTHORIZE_IN_WALLET, exact: true });
  await expect(authorize).toBeEnabled();
  await expect(authorize).toHaveAttribute('data-lifecycle-action', 'approve');
  await authorize.click();
  await expect(page.locator('.canvas-primary-action button[data-lifecycle-action="approve"]')).toHaveCount(0);
  const execute = page.getByRole('navigation', { name: 'Workflow stages' }).getByRole('button', { name: 'Execute', exact: true });
  if (await execute.getAttribute('aria-current') !== 'page') await execute.click();
}

/** BUILD-SOLANA-TRANSFER-UX-001: the minimal signing surface `/approve` opens on (chat-first; the Canvas is optional, "View in FloFi"). */
export const signingSurface = (page: Page) => page.getByRole('main', { name: 'Authorize with your wallet', exact: true });
/**
 * BUILD-SOLANA-TRANSFER-UX-001: the EVM wallet already connected in this browser is recognized: the proposal's proof opens no wallet selector
 * (no Credentials step) and only asks that wallet to sign FloFi's sign-in message.
 */
export async function proveConnectedEvmWallet(page: Page, region: Locator, account: string): Promise<void> {
  // BUILD-FLOFI-PRODUCT-UX-001: compact chrome keeps the address (and chain) in the title tooltip.
  await expect(page.locator('.build009-wallet-info')).toHaveAttribute('title', new RegExp(account, 'i'));
  await region.getByRole('button', { name: 'Connect wallet and prove ownership' }).click();
  await expect(page.locator('dialog.wallet-selector[open]')).toHaveCount(0);
}

/**
 * The fresh simulation FloFi prepared itself for a loaded proposal, read on the Canvas ("View in FloFi" from the signing surface) with the
 * opted-in engineering diagnostics. Read-only: it never simulates, accepts or signs anything itself.
 */
export async function openProposalSimulationDetails(page: Page): Promise<void> {
  if (await signingSurface(page).count()) await page.getByRole('button', { name: 'Open Canvas', exact: true }).click();
  await page.getByRole('navigation', { name: 'Workflow stages' }).getByRole('button', { name: 'Simulate', exact: true }).click();
  await openSimulationDetails(page);
}

/** A blocked workflow may offer simulation, but never an enabled financial CTA (including an "Authorize in wallet" Review acceptance). */
export async function assertNoFinancialCanvasAction(page: Page): Promise<void> {
  const primary = page.locator('.canvas-primary-action');
  await expect(primary).toHaveCount(1);
  await expect(primary.locator(FINANCIAL_CANVAS_ACTIONS)).toHaveCount(0);
  await expect(page.getByRole('button', { name: AUTHORIZE_IN_WALLET, exact: true }).and(page.locator(':enabled'))).toHaveCount(0);
  await expect(page.locator('.execution-summary button.primary')).toHaveCount(0);
}

/** Apply a reviewed authoring proposal through the visible contextual popover. This grants no financial authority. */
/** BUILD-FLOFI-CONVERSATIONAL-001: FloFi's confirmation that the chat committed a change to the workflow (English or Portuguese). */
export const CHAT_COMMITTED = /added to your workflow|updated: |removed from your workflow|Prepared for Simulate\. Nothing is removed|Adicionado ao seu workflow|Etapa atualizada|Removido do seu workflow|Preparado para a simulação/;
/**
 * BUILD-FLOFI-CONVERSATIONAL-001: a valid chat request is committed to the canonical workflow at once — no proposal to accept — and FloFi confirms
 * in the chat what the stored workflow now holds. Waits for that one new confirmation.
 */
export async function sendChatCommand(page: Page, text: string): Promise<void> {
  const committed = page.getByRole('log', { name: 'Conversation' }).locator('.message', { hasText: CHAT_COMMITTED });
  const before = await committed.count();
  await page.getByLabel('Describe your flow').fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  // Catalog reads and interpretation can take a moment on a cold server (the proposal flow allowed the click timeout).
  await expect(committed).toHaveCount(before + 1, { timeout: 30_000 });
  await expect(page.getByRole('button', { name: /^Review proposed change:/ })).toHaveCount(0);
}
export async function applyPendingProposal(page: Page): Promise<void> {
  await openProposalReview(page);
  const apply = page.getByRole('dialog', { name: 'Proposed change', exact: true }).getByRole('button', { name: 'Apply proposal', exact: true });
  await expect(apply).toBeEnabled();
  await apply.click();
}

/** Inspect canonical IR using the explicitly enabled loopback-only read probe, with no product debug surface. */
export async function readWorkflowIr(page: Page): Promise<string> {
  await page.waitForFunction(() => Boolean((window as unknown as { __flofiEngineeringWorkflow?: string }).__flofiEngineeringWorkflow), undefined, { timeout: 10_000 }).catch(() => {
    throw new Error('The guarded canonical workflow probe is not enabled');
  });
  return page.evaluate(() => (window as unknown as { __flofiEngineeringWorkflow: string }).__flofiEngineeringWorkflow);
}

/** Select an authored action and open its settings (BUILD-FLOFI-CONVERSATIONAL-001: the card-anchored dialog that replaced the bottom inspector). */
export async function openFirstActionSettings(page: Page): Promise<void> {
  const card = page.locator('.build-flow-surface .composer-card').first();
  // BUILD-SOLANA-MAINNET-001: a Swap card's center arrow switches From and To, so the card is selected by its title.
  await card.locator('.composer-action-title').click();
  const settings = card.getByRole('button', { name: 'Action settings', exact: true });
  if (await settings.getAttribute('aria-expanded') !== 'true') await settings.click();
}
