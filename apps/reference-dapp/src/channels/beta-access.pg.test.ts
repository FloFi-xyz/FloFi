// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { createTestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness';
import { handleTelegramWebhook } from './telegram/handler';
import { botApi, telegramEnv, telegramRequest, textUpdate } from './telegram/fixtures.test-harness';
import { recordingRuntime } from './core/engine.test-harness';
import { handleChannelDispatch } from './dispatch-http';
it('leaves queued private authoring pending during beta while the authenticated dispatch still performs delivery/status/retention', async () => {
  const t = await createTestDatabase();
  try {
    const token = randomBytes(32).toString('hex'), f = telegramEnv({ FLOFI_CHANNEL_DISPATCH_TOKEN_SHA256: createHash('sha256').update(token).digest('hex') });
    const api = botApi(), calls: string[] = [], runtime = recordingRuntime(calls), host = { db: t.db, tenantId: 'default' };
    const received = await handleTelegramWebhook(telegramRequest(textUpdate('supply 5 USDC to Aave on Base Sepolia beneficiary 0x' + '1'.repeat(40)), f.webhookSecret),
      { env: f.env, host, runtime, fetch: api.fetch, interpreter: null, schedule: () => undefined, visuals: null });
    expect(received.status).toBe(200);
    expect((await t.db.query(`SELECT 1 FROM channel_events WHERE status='PENDING'`)).rowCount).toBe(1);
    f.env.FLOFI_BETA_ACCESS = 'beta';
    const response = await handleChannelDispatch(new Request('http://127.0.0.1:3100/api/channels/dispatch', { method: 'POST', headers: { authorization: 'Bearer ' + token } }),
      { env: f.env, host, runtime, seams: { telegramFetch: api.fetch }, interpreter: null, visuals: null });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, object: 'channel_dispatch', turns: 0, purged: true });
    expect((await t.db.query(`SELECT 1 FROM channel_events WHERE status='PENDING'`)).rowCount).toBe(1);
    expect((await t.db.query('SELECT 1 FROM mcp_handoffs')).rowCount).toBe(0);
    expect(calls).toEqual([]);
  } finally { await t.drop(); }
});
