// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-NATIVE-CHANNEL-SIGNING-001: native wallet signing from a Telegram conversation, end to end at the HTTP boundary on a disposable PostgreSQL
 * (Bot API double, MOCKED in-memory Solana flow, a test wallet speaking the Phantom deeplink protocol with real NaCl encryption). The approval message
 * offers "Sign with Phantom / Solflare" (a channel-keyed token in the URL fragment, never stored); the Review is posted IN the conversation with a
 * single-use confirmation; only that confirmation produces the wallet's signing request; one broadcast; the conversation is told it was sent and then
 * receives the approval's status. Channel code runs none of the signing steps.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SOLANA_DEVNET_TRANSFER } from '@defi-workflow-engine/action-registry';
import { createMockedSolanaTransferChain, createMockedSolanaWallet } from '@defi-workflow-engine/reference-compiler';
import { createTestDatabase, type TestDatabase } from '../../../../../packages/cloud-runtime/test/pg-harness.ts';
import { createEmbeddedRuntime } from '../../server/flow-runtime.ts';
import { embeddedMcpRuntime } from '../../mcp/runtime.ts';
import { nativeSigningService, startFromChannelToken } from '../../server/native-signing/runtime.ts';
import { callbackParts, deeplinkTestWallet } from '../../wallet/deeplink/test-wallet.test-harness.ts';
import { handleChannelDispatch } from '../dispatch-http.ts';
import { botApi, telegramEnv, telegramRequest, textUpdate } from './fixtures.test-harness.ts';
import { handleTelegramWebhook } from './handler.ts';

let t: TestDatabase;
beforeAll(async () => { t = await createTestDatabase(); });
afterAll(async () => { await t?.drop(); });
type Keyboard = { inline_keyboard: { text: string; url?: string; callback_data?: string }[][] };
const keyboardOf = (call: { params: Record<string, unknown> }) => {
  const markup = call.params.reply_markup;
  return (typeof markup === 'string' ? JSON.parse(markup) : markup) as Keyboard | undefined;
};
const textOf = (call: { params: Record<string, unknown> }) => String(call.params.text ?? call.params.caption ?? '');

describe('BUILD-FLOFI-NATIVE-CHANNEL-SIGNING-001 Telegram native wallet signing (PostgreSQL, Bot API double, MOCKED flow)', () => {
  it('Sign with Phantom → proof → Review in the chat → Confirm → exact signature → one broadcast → sent and status in the chat', async () => {
    const tenantId = `ns-${randomBytes(6).toString('hex')}`;
    await t.db.query('INSERT INTO tenants (tenant_id) VALUES ($1)', [tenantId]);
    const chain = createMockedSolanaTransferChain({ profile: SOLANA_DEVNET_TRANSFER, send: 'OK' }), key = createMockedSolanaWallet(), recipient = createMockedSolanaWallet().owner;
    chain.fundWallet(key.owner, 3_000_000_000n);
    const dispatchToken = randomBytes(24).toString('base64url'), tg = telegramEnv({ FLOFI_PUBLIC_ORIGIN: 'https://flofi.test' });
    const env = { ...tg.env, TENANT_ID: tenantId, DATABASE_URL: t.url, FLOFI_RUNTIME: 'embedded', GRYLOO_SOLANA_TRANSFER_HARNESS: 'MOCKED_LOOPBACK_ONLY',
      FLOFI_SESSION_SECRET: 'n'.repeat(40), FLOFI_CHANNEL_DISPATCH_TOKEN_SHA256: createHash('sha256').update(dispatchToken).digest('hex') } as Record<string, string>;
    const runtime = await createEmbeddedRuntime(env, { rpc: { 'solana-devnet-transfer': chain.rpc }, busyRetries: 3 });
    try {
      const api = botApi(), host = { db: runtime.db, tenantId: runtime.tenantId }, engine = embeddedMcpRuntime(runtime), now = () => new Date();
      expect(runtime.tenantId).toBe(tenantId);
      const common = { env, host, runtime: engine, interpreter: null, now, sleep: async () => undefined, random: () => 0.5 };
      const say = async (text: string) => { const r = await handleTelegramWebhook(telegramRequest(textUpdate(text), tg.webhookSecret), { ...common, fetch: api.fetch }); expect(r.status).toBe(200); };
      const overrides = { host, runtime: engine, channelSeams: { telegramFetch: api.fetch },
        flow: (async (flow: string, method: string, args: readonly unknown[], context: { principal: string }) =>
          runtime.backend.callFlow(flow as never, method, args, undefined, context.principal)) as never };
      const service = await nativeSigningService(env, overrides);
      const deliver = (url: string) => { const p = callbackParts(url); return service.callback(p.handoffId, p.sessionId, p.tag, p.params); };

      await say(`send 0.01 SOL to ${recipient} on Solana Devnet`);
      const approval = [...api.delivered()].reverse().find(call => keyboardOf(call)?.inline_keyboard[0]?.[0]?.url?.includes('/approve#'))!;
      const keyboard = keyboardOf(approval)!;
      expect(keyboard.inline_keyboard[1]).toEqual([{ text: 'Sign with Phantom', url: expect.stringMatching(/^https:\/\/flofi\.test\/api\/native-signing\/start#ns1\./) },
        { text: 'Sign with Solflare', url: expect.stringMatching(/^https:\/\/flofi\.test\/api\/native-signing\/start#ns1\./) }]);
      expect(textOf(approval)).toContain('sign in your wallet app with the Phantom or Solflare button');
      const token = new URL(keyboard.inline_keyboard[1]![0]!.url!).hash.slice(1);

      const started = await startFromChannelToken(env, token, overrides);
      const wallet = deeplinkTestWallet('phantom', key);
      const proof = await deliver(wallet.approve(started.connectUrl)) as { url: string };
      const before = api.delivered().length;
      await deliver(wallet.approve(proof.url));
      // The Review, in the conversation, with a one-tap confirmation; nothing signed or sent yet.
      const review = api.delivered().slice(before).find(call => textOf(call).startsWith('Review: transfer on Solana Devnet'))!;
      expect(textOf(review)).toContain('You send: 0.01 SOL');
      expect(textOf(review)).toContain(`To: ${recipient}`);
      const confirm = keyboardOf(review)!.inline_keyboard[0]![0]!;
      expect(confirm).toEqual({ text: 'Confirm in Phantom', url: expect.stringMatching(/^https:\/\/flofi\.test\/api\/native-signing\/apr_[a-z2-7]{26}\/nsg_[a-z2-7]{26}\/confirm\/[A-Za-z0-9_-]{22}$/) });
      expect(chain.state.sent).toHaveLength(0);
      // A tampered tag never confirms.
      const [, , , handoffId, sessionId, , tag] = new URL(confirm.url!).pathname.split('/');
      await expect(service.confirm({ handoffId: handoffId!, sessionId: sessionId!, confirmTag: 'A'.repeat(22) })).rejects.toThrow('NATIVE_CONFIRMATION_INVALID');

      const signing = await service.confirm({ handoffId: handoffId!, sessionId: sessionId!, confirmTag: tag! }) as { url: string };
      const sentAt = api.delivered().length;
      await deliver(wallet.approve(signing.url));
      expect(chain.state.sent).toHaveLength(1);
      // Sent once; FloFi's observation reconciled it (MOCKED chain) and the approval's own notification posted the verified receipt to the chat.
      const after = api.delivered().slice(sentAt).map(textOf);
      expect(after[0]).toContain('Signed in Phantom and sent once by FloFi');
      expect(after.join('\n')).toMatch(/Execution reconciled ✅ · evidence: MOCKED[\s\S]*Receipt: https:\/\/flofi\.test\/app\/dashboard\/runs\/soltd-[a-f0-9]{32}/);
      // The scheduled dispatch follows the same approval and never posts it twice.
      const swept = api.delivered().length;
      const r = await handleChannelDispatch(new Request('https://flofi.test/api/channels/dispatch', { headers: { authorization: `Bearer ${dispatchToken}` } }),
        { ...common, seams: { telegramFetch: api.fetch } });
      expect(r.status).toBe(200);
      expect(api.delivered().slice(swept).map(textOf).filter(text => /reconciled/i.test(text))).toEqual([]);
      expect(chain.state.sent).toHaveLength(1);
    } finally { await runtime.close(); }
  });
});
