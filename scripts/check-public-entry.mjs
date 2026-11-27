// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../apps/reference-dapp/package.json', import.meta.url));
const { chromium, webkit } = require('@playwright/test');
const hosts = ['flofi.xyz', 'www.flofi.xyz'];
const canonical = 'https://flofi.xyz';

async function checkHost(browser, engine, host) {
  const context = await browser.newContext({ locale: 'pt-BR' });
  const documents = [];
  const pageErrors = [];
  const result = { engine, version: browser.version(), host, time: new Date().toISOString(), documents, pageErrors };
  try {
    const page = await context.newPage();
    page.on('response', response => {
      if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
        const url = new URL(response.url());
        documents.push({
          url: url.origin + url.pathname,
          status: response.status(),
          edgeId: response.headers()['x-vercel-id'],
        });
      }
    });
    page.on('pageerror', error => {
      pageErrors.push(error.message.slice(0, 240));
    });

    const landing = await page.goto(`https://${host}/`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    assert.equal(landing?.status(), 200, 'Landing HTTP status');
    assert.equal(page.url(), `${canonical}/`, 'Landing canonical URL');
    if (host === 'www.flofi.xyz') {
      assert.equal(documents.find(document => document.url === 'https://www.flofi.xyz/')?.status, 308, 'www redirect');
    }
    await page.locator('main h1').first().waitFor({ state: 'visible', timeout: 10_000 });
    result.landingProtocol = await page.evaluate(() => performance.getEntriesByType('navigation')[0]?.nextHopProtocol);

    await page.locator('header a[href="/login"]').first().click({ timeout: 10_000 });
    await page.waitForURL(`${canonical}/login`, { waitUntil: 'domcontentloaded', timeout: 10_000 });
    assert.equal(documents.find(document => document.url === `${canonical}/login`)?.status, 200, 'Sign-in HTTP status');
    await page.getByRole('button', { name: /^Google$/i }).click({ trial: true, timeout: 15_000 });
    await page.getByRole('button', { name: /^e-?mail$/i }).click({ timeout: 10_000 });
    await page.locator('input[type="email"]').waitFor({ state: 'visible', timeout: 5_000 });
    result.passed = true;
  } catch (error) {
    result.passed = false;
    result.error = error.message.slice(0, 700);
  } finally {
    await context.close();
  }
  return result;
}

for (const [engine, runtime] of Object.entries({ chromium, webkit })) {
  let browser;
  try {
    browser = await runtime.launch(engine === 'chromium' ? { channel: 'chromium' } : {});
    for (const host of hosts) {
      const result = await checkHost(browser, engine, host);
      console.log(JSON.stringify(result));
      if (!result.passed) process.exitCode = 1;
    }
  } catch (error) {
    console.log(JSON.stringify({ engine, passed: false, error: error.message.slice(0, 700) }));
    process.exitCode = 1;
  } finally {
    await browser?.close();
  }
}
