// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { handleTelegramWebhook } from './telegram/handler';
import { telegramEnv, telegramRequest, textUpdate } from './telegram/fixtures.test-harness';

it('authenticates provider ingress under beta and never short-circuits with BETA_CHANNEL_ACCESS_CLOSED before the durable store', async () => {
  for (const mode of ['beta', 'closed', 'invalid']) {
    const f = telegramEnv({ FLOFI_BETA_ACCESS: mode }), fetch = vi.fn();
    const response = await handleTelegramWebhook(telegramRequest(textUpdate('swap 1 ETH to USDC on Base'), f.webhookSecret), { env: f.env, fetch });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, code: 'CHANNEL_STORE_UNAVAILABLE' });
    expect(fetch).not.toHaveBeenCalled();
    const forged = await handleTelegramWebhook(telegramRequest(textUpdate('help'), null), { env: f.env, fetch });
    expect(forged.status).toBe(401);
  }
});
