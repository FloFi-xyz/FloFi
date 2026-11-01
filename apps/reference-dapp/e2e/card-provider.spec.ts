// SPDX-License-Identifier: AGPL-3.0-only
// Credentials → Add card through Mercado Pago's Secure Fields, against the MOCKED loopback provider harness and an SDK stand-in.
// No request reaches Mercado Pago, no real card is used and nothing is charged.
import { test, expect } from './fixtures';
import { APP_ORIGIN } from './app-origin';
import { E2E_CARD_ORIGIN as CARD_ORIGIN } from './app-origin';
import { cardHarnessRequests, fillSecureField, installMercadoPagoSdkStandIn, MERCADO_PAGO_SDK, resetCardHarness, SERVER_ONLY_WOOVI_APP_ID, TEST_CARD } from './card-provider-fixtures';
import type { Frame, Page } from '@playwright/test';

test.skip(process.env.GRYLOO_CARD_E2E !== 'MOCKED_LOOPBACK_ONLY', 'Mercado Pago card entry requires the isolated loopback provider harness');

const STORAGE = 'flofi.credentials.v1', SERVER_TOKEN = 'TEST-flofi-loopback-harness-server-only', EMAIL = 'test_payer_12345@testuser.com';
const dialog = (page: Page) => page.locator('dialog.card-entry[open]');
/** BUILD-FLOFI-PRIVY-UX-001: the provider's entry runs in a frame from the card origin, never in the product page that hosts the signer. */
const entry = (page: Page) => page.frameLocator('iframe.card-entry-frame');
const entryFrame = (page: Page): Frame => page.frames().find(frame => frame.url().startsWith(`${CARD_ORIGIN}/card-entry`))!;
const stored = (page: Page) => page.evaluate(key => localStorage.getItem(key) ?? '', STORAGE);
/** Everything the browser sent to FloFi and every text FloFi returned, to prove what crossed the boundary. */
function recordAppTraffic(page: Page) {
  const sent: string[] = [], received: string[] = [];
  const ours = (url: string) => [APP_ORIGIN, CARD_ORIGIN].includes(new URL(url).origin);
  page.on('request', request => { if (ours(request.url())) sent.push(`${request.url()}\n${request.postData() ?? ''}`); });
  page.on('response', response => { if (ours(response.url())) received.push(response.url());
    void response.text().then(text => received.push(text), () => undefined); });
  return { sent, received };
}
async function openAddCard(page: Page, theme: 'light' | 'dark' = 'light') {
  await page.addInitScript(value => localStorage.setItem('flofi.theme', value), theme);
  const sdk = await installMercadoPagoSdkStandIn(page);
  await page.goto('/app/credentials');
  await expect(page.getByText('No cards yet', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add card', exact: true }).click();
  await expect(dialog(page).getByRole('heading', { name: 'Add a card' })).toBeVisible();
  await expect(entry(page).getByRole('button', { name: 'Add card' })).toBeEnabled();
  return sdk;
}
async function enterCard(page: Page, holder = 'APRO', pan: string = TEST_CARD.pan) {
  await fillSecureField(page, 'cardNumber', pan);
  await fillSecureField(page, 'expirationDate', TEST_CARD.expiry);
  await fillSecureField(page, 'securityCode', TEST_CARD.cvv);
  await entry(page).getByLabel('Name on card').fill(holder);
  await entry(page).getByLabel('Number', { exact: true }).fill('123.456.789-09');
  await entry(page).getByLabel('Email').fill(EMAIL);
  await entry(page).getByRole('button', { name: 'Add card' }).click();
}

test.beforeEach(async () => { await resetCardHarness(); });

for (const theme of ['light', 'dark'] as const) {
  test(`${theme}: Add card collects the card only in Mercado Pago's secure fields and keeps only safe metadata`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const traffic = recordAppTraffic(page);
    const sdk = await openAddCard(page, theme);
    // The official SDK location, the public key only, one provider iframe per card field; FloFi renders no card-data input of its own.
    expect(sdk).toEqual([MERCADO_PAGO_SDK]);
    expect(await entryFrame(page).evaluate(() => ({ ...(window as unknown as { __mpHarness: { publicKey: string; locale: string; mounted: string[] } }).__mpHarness, fields: undefined })))
      .toEqual({ publicKey: 'TEST-flofi-loopback-harness', locale: 'pt-BR', mounted: ['cardNumber', 'expirationDate', 'securityCode'], fields: undefined });
    await expect(entry(page).locator('.card-entry-secure iframe')).toHaveCount(3);
    for (const label of ['Card number', 'Expiry', 'Security code']) await expect(entry(page).getByRole('group', { name: label }).locator('iframe')).toHaveCount(1);
    // The SDK never ran in the product page that hosts the FloFi wallet signer; its document has no card field of any kind.
    expect(await page.evaluate(() => 'MercadoPago' in window || '__mpHarness' in window)).toBe(false);
    await expect(dialog(page).locator('input, select')).toHaveCount(0);
    expect(await entry(page).locator('input, select').evaluateAll(fields => fields.map(field => (field as HTMLInputElement).name)))
      .toEqual(['cardholderName', 'identificationType', 'identificationNumber', 'email']);
    await expect(entry(page).getByLabel('Document').locator('option')).toHaveText(['CPF', 'CNPJ']);
    for (const box of await entry(page).locator('.card-entry-secure').all()) expect((await box.boundingBox())!.height).toBeGreaterThanOrEqual(36);

    await enterCard(page);
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.locator('.workspace-notice')).toHaveText('Visa •••• 5682 added to Credentials.');
    const card = page.getByRole('article', { name: 'Visa •••• 5682' });
    await expect(card).toContainText('Visa · Mercado Pago');
    await expect(card).toContainText('•••• 5682 · Expires 11/30');
    await expect(page.getByText('No cards yet', { exact: true })).toHaveCount(0);

    // FloFi's server sent Mercado Pago only the email and the one-time token, with its server-side token, and never a payment call.
    const requests = await cardHarnessRequests();
    expect(requests.map(entry => `${entry.method} ${entry.path.replace(/[0-9]+-harnessCustomer/, 'CUSTOMER')}`)).toEqual(['POST /v1/customers', 'POST /v1/customers/CUSTOMER/cards']);
    expect(requests.every(entry => entry.authorization === 'server-token')).toBe(true);
    expect(JSON.parse(requests[0]!.body)).toEqual({ email: EMAIL });
    expect(Object.keys(JSON.parse(requests[1]!.body))).toEqual(['token']);
    for (const text of [...requests.map(entry => entry.body), ...traffic.sent, await stored(page)]) {
      expect(text).not.toContain(TEST_CARD.pan);
      expect(text).not.toMatch(new RegExp(`(?<![A-Za-z0-9_-])${TEST_CARD.cvv}(?![A-Za-z0-9_-])`));
    }
    // The browser store holds provider references and display metadata only: no BIN, cardholder data, document or email.
    const saved = await stored(page);
    expect(JSON.parse(saved).cards).toEqual([expect.objectContaining({ provider: 'mercado_pago', providerName: 'Mercado Pago', brand: 'visa', last4: '5682', expMonth: 11, expYear: 2030 })]);
    expect(saved).not.toMatch(new RegExp(`${TEST_CARD.bin}|APRO|12345678909|123\\.456|test_payer|security`));
    // The server-only provider credentials (card and payment) never reach the browser, in any page, script or action response.
    expect(traffic.received.join('\n')).not.toContain(SERVER_TOKEN);
    expect(traffic.received.join('\n')).not.toContain(SERVER_ONLY_WOOVI_APP_ID);
    await page.reload();
    await expect(page.getByRole('article', { name: 'Visa •••• 5682' })).toContainText('Visa · Mercado Pago');
    expect(errors).toEqual([]);
  });
}

test('a provider response that carries a card number fails closed and nothing is saved', async ({ page }) => {
  await openAddCard(page);
  await enterCard(page, 'ECHO PAN');
  await expect(entry(page).locator('p[role="alert"]')).toHaveText('The card could not be added. Nothing was saved.');
  // The provider did answer, with a card number in its response, and FloFi's server refused it.
  expect((await cardHarnessRequests()).filter(entry => entry.method === 'POST' && entry.path.endsWith('/cards'))).toHaveLength(1);
  await expect(entry(page).getByRole('button', { name: 'Add card' })).toBeEnabled();
  await entry(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator('.workspace-wallet-card')).toHaveCount(0);
  expect(await stored(page)).toBe('');
});

test('invalid card data stays in the secure fields: nothing reaches FloFi or the provider', async ({ page }) => {
  const traffic = recordAppTraffic(page);
  await openAddCard(page);
  const before = traffic.sent.length;
  await enterCard(page, 'APRO', '4235647728025683');
  await expect(entry(page).locator('p[role="alert"]')).toHaveText('Check the card details and try again.');
  expect(traffic.sent.slice(before).filter(entry => entry.includes('harness_'))).toEqual([]);
  expect(await cardHarnessRequests()).toEqual([]);
});

test('Remove deletes only this card’s saved reference at the provider, never anything else', async ({ page }) => {
  await openAddCard(page);
  await enterCard(page);
  const card = page.getByRole('article', { name: 'Visa •••• 5682' });
  await card.getByRole('button', { name: 'Remove Visa •••• 5682' }).click();
  await expect(card.getByRole('group', { name: 'Remove Visa •••• 5682' })).toContainText('The card itself is not affected.');
  await card.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.locator('.workspace-notice')).toHaveText('Card removed from FloFi.');
  await expect(page.getByText('No cards yet', { exact: true })).toBeVisible();
  await expect(page.getByText('No wallets yet', { exact: true })).toBeVisible();
  const requests = await cardHarnessRequests();
  const saved = requests.find(entry => entry.method === 'POST' && entry.path.endsWith('/cards'))!;
  expect(requests.filter(entry => entry.method === 'DELETE').map(entry => entry.path)).toEqual([`${saved.path}/8987269650`]);
  expect(JSON.parse(await stored(page)).cards).toEqual([]);
});

test('the card page exists only on the card origin, framed only by the product, and the product origin never runs the card SDK', async ({ page, request }) => {
  // The product origin never serves the card page; the card origin serves nothing but it (and its static assets).
  expect((await request.get(`${APP_ORIGIN}/card-entry`)).status()).toBe(404);
  for (const path of ['/', '/app', '/login', '/app/credentials']) expect((await request.get(`${CARD_ORIGIN}${path}`, { maxRedirects: 0 })).status(), path).toBe(404);
  const card = await request.get(`${CARD_ORIGIN}/card-entry`);
  expect(card.status()).toBe(200);
  const policy = card.headers()['content-security-policy'] ?? '';
  expect(policy).toContain(`frame-ancestors ${APP_ORIGIN}`);
  expect(policy).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/]{22}==' 'strict-dynamic'/);
  // The product page that hosts the FloFi wallet signer allows no third-party script at all, and certainly not the card SDK.
  const product = (await request.get(`${APP_ORIGIN}/app/credentials`)).headers()['content-security-policy'] ?? '';
  expect(product).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/]{22}==' 'unsafe-eval'(;|$)/);
  expect(product).not.toMatch(/mercadopago|strict-dynamic|https?:\/\/[^ ;]*\.js/);
  expect(product).toContain("frame-ancestors 'none'");
  // Opened on its own, the card page loads nothing.
  const sdk = await installMercadoPagoSdkStandIn(page);
  await page.goto(`${CARD_ORIGIN}/card-entry`);
  await expect(page.getByText('Open Add card from Credentials in FloFi.')).toBeVisible();
  expect(sdk).toEqual([]);
});

test('Add card accepts a token only from the card frame, and the frame checks the email before asking the provider for a token', async ({ page }) => {
  await openAddCard(page);
  // A message from anywhere but the card origin's frame (here the product page itself) is ignored: nothing reaches FloFi or the provider.
  await page.evaluate(() => window.postMessage({ type: 'flofi-card-token', token: 'harness_spoofed0000', email: 'a@b.co' }, '*'));
  await page.waitForTimeout(500);
  expect(await cardHarnessRequests()).toEqual([]);
  await expect(dialog(page)).toHaveCount(1);
  // An email the product would not accept is refused in the frame, before any token is minted.
  await fillSecureField(page, 'cardNumber', TEST_CARD.pan);
  await fillSecureField(page, 'expirationDate', TEST_CARD.expiry);
  await fillSecureField(page, 'securityCode', TEST_CARD.cvv);
  await entry(page).getByLabel('Name on card').fill('APRO');
  await entry(page).getByLabel('Number', { exact: true }).fill('123.456.789-09');
  await entry(page).getByLabel('Email').fill('not-an-email');
  await entry(page).getByRole('button', { name: 'Add card' }).click();
  await expect(entry(page).locator('p[role="alert"]')).toHaveText('Enter a valid email address.');
  await expect(entry(page).getByRole('button', { name: 'Add card' })).toBeEnabled();
  expect(await cardHarnessRequests()).toEqual([]);
  // Escape in the frame cancels Add card, as it did inside the dialog.
  await entry(page).getByLabel('Email').press('Escape');
  await expect(dialog(page)).toHaveCount(0);
});
