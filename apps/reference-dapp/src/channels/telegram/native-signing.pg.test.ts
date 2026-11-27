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
import { callbackParts, deeplinkTestWallet } from '../../server/native-signing/deeplink/test-wallet.test-harness.ts';
import { handleChannelDispatch } from '../dispatch-http.ts';
import { botApi, telegramEnv, telegramRequest, textUpdate } from './fixtures.test-harness.ts';
import { handleTelegramWebhook } from './handler.ts';
import { ownerFlowRuntime } from '../../workflow-runs/workflow-run.test-harness.ts';

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
      // The note follows the authorization line (and says the status is shared with this conversation when signed that way).
      expect(textOf(approval).indexOf('Nothing is authorized yet')).toBeLessThan(textOf(approval).indexOf('Or sign in your wallet app'));
      expect(textOf(approval)).toContain('shares this operation\'s status and receipt with this conversation');
      const token = new URL(keyboard.inline_keyboard[1]![0]!.url!).hash.slice(1);

      const startedAt = api.delivered().length;
      const started = await startFromChannelToken(env, token, overrides);
      const wallet = deeplinkTestWallet('phantom', key);
      const proof = await deliver(wallet.approve(started.connectUrl)) as { url: string };
      const before = api.delivered().length;
      await deliver(wallet.approve(proof.url));
      // The Review, in the conversation, with a one-tap confirmation; nothing signed or sent yet.
      const review = api.delivered().slice(before).find(call => textOf(call).startsWith('Review: transfer on Solana Devnet'))!;
      expect(textOf(review)).toContain('You send: 0.01 SOL');
      expect(textOf(review)).toContain(`To: ${recipient}`);
      // The owner's own wallet is shortened in the conversation (it may be a group); the recipient is in full.
      expect(textOf(review)).toContain(`From your wallet: ${key.owner.slice(0, 4)}…${key.owner.slice(-4)}`);
      expect(textOf(review)).not.toContain(key.owner);
      const confirm = keyboardOf(review)!.inline_keyboard[0]![0]!;
      expect(confirm).toEqual({ text: 'Confirm in Phantom', url: expect.stringMatching(/^https:\/\/flofi\.test\/api\/native-signing\/apr_[a-z2-7]{26}\/nsg_[a-z2-7]{26}\/confirm\/[A-Za-z0-9_-]{22}$/) });
      expect(chain.state.sent).toHaveLength(0);
      // A tampered tag never confirms.
      const [, , , handoffId, sessionId, , tag] = new URL(confirm.url!).pathname.split('/');
      await expect(service.confirm({ handoffId: handoffId!, sessionId: sessionId!, confirmRef: 'A'.repeat(22) })).rejects.toThrow('NATIVE_CONFIRMATION_INVALID');

      const signing = await service.confirm({ handoffId: handoffId!, sessionId: sessionId!, confirmRef: tag! }) as { url: string };
      const sentAt = api.delivered().length;
      await deliver(wallet.approve(signing.url));
      expect(chain.state.sent).toHaveLength(1);
      // Sent once; FloFi's observation reconciled it (MOCKED chain) and the approval's own notification posted the verified receipt to the chat.
      const after = api.delivered().slice(sentAt).map(textOf);
      expect(after[0]).toContain('Signed in Phantom and handed to the network once by FloFi');
      expect(after.join('\n')).toMatch(/Execution reconciled ✅ · evidence: MOCKED[\s\S]*Receipt: https:\/\/flofi\.test\/app\/dashboard\/runs\/soltd-[a-f0-9]{32}/);
      // The bounded follow-up after the broadcast (scheduled after the wallet's return page) reaches the same notifications: never posted twice.
      const followed = api.delivered().length;
      expect(await service.follow(handoffId!, sessionId!, { attempts: 2, sleep: async () => undefined })).toBe('RECONCILED');
      expect(api.delivered().slice(followed).map(textOf).filter(text => /reconciled/i.test(text))).toEqual([]);
      // The scheduled dispatch follows the same approval and never posts it twice.
      const swept = api.delivered().length;
      const r = await handleChannelDispatch(new Request('https://flofi.test/api/channels/dispatch', { headers: { authorization: `Bearer ${dispatchToken}` } }),
        { ...common, seams: { telegramFetch: api.fetch } });
      expect(r.status).toBe(200);
      expect(api.delivered().slice(swept).map(textOf).filter(text => /reconciled/i.test(text))).toEqual([]);
      expect(chain.state.sent).toHaveLength(1);
      // Signed in the wallet app with the Review here: no status notice sent the person to FloFi at any point.
      for (const text of api.delivered().slice(startedAt).map(textOf)) expect(text).not.toMatch(/loaded in FloFi|wallet authorization in FloFi|Review accepted in FloFi/);
      // A stopped conversation's button starts nothing.
      await say('STOP');
      await expect(startFromChannelToken(env, token, overrides)).rejects.toThrow('NATIVE_START_INVALID');
    } finally { await runtime.close(); }
  });
});

/**
 * KAN-20 (WS02 evaluation A.5 / T4): a Solana Batch Payment authored in Telegram keeps FloFi's /approve link and never gets the native signing buttons
 * (it is SEQUENTIAL: one user-funded SOLANA_SIGN_ALL group, not a SINGLE_FLOW flow), while a single Solana transfer in the same deployment still does.
 * MOCKED owner flows with Solana user-funded groups enabled; nothing is signed or sent.
 */
describe('KAN-20: a Solana Batch Payment from Telegram keeps the /approve link', () => {
  it('the batch APPROVAL message carries the /approve link and no Phantom / Solflare buttons; a single Solana transfer keeps them', async () => {
    const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
    const A = '2CERLkG39Jq8zc8FaVkmHjkpsptwQVFMwzvWQgdtmCzb', B = 'C4o8DvwfiPWCQPPH4AfDLBtG7vbCixVKYdwj1S4pDrty';
    const tenantId = `nb-${randomBytes(6).toString('hex')}`;
    await t.db.query('INSERT INTO tenants (tenant_id) VALUES ($1)', [tenantId]);
    const tg = telegramEnv({ FLOFI_CHANNEL_HANDOFF_MAINNET_NETWORKS: 'solana' });
    const env = { ...tg.env, TENANT_ID: tenantId, FLOFI_WORKFLOW_RUNS: 'enabled' } as Record<string, string>;
    const now = () => new Date();
    const flows = ownerFlowRuntime(['solana-transfer'], { enabled: true, delegation: null,
      userFunded: { enabled: true, code: null, chains: [SOLANA], bundlerChains: [], solanaNonceAccounts: false, bridgeRoutes: [] } }, now);
    const api = botApi(), common = { env, host: { db: t.db, tenantId }, runtime: flows.runtime, interpreter: null, now, sleep: async () => undefined, random: () => 0.5 };
    const say = async (text: string) => { const r = await handleTelegramWebhook(telegramRequest(textUpdate(text), tg.webhookSecret), { ...common, fetch: api.fetch }); expect(r.status).toBe(200); };
    const approvalMessage = () => [...api.delivered()].reverse().find(call => keyboardOf(call)?.inline_keyboard[0]?.[0]?.url?.includes('/approve#'));
    const nativeRow = (call: { params: Record<string, unknown> }) => keyboardOf(call)!.inline_keyboard.flat().filter(b => /Phantom|Solflare|native-signing/.test(`${b.text} ${b.url ?? ''}`));

    await say(`send 0.01 SOL to ${A} and 0.02 SOL to ${B}`);
    const batch = approvalMessage();
    expect(batch, api.texts().join('\n---\n')).toBeTruthy();
    expect(keyboardOf(batch!)!.inline_keyboard[0]).toEqual([{ text: 'Authorize', url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:3100\/approve#flofi_chs_/) }]);
    expect(nativeRow(batch!)).toEqual([]);
    expect(textOf(batch!)).not.toContain('sign in your wallet app with the Phantom or Solflare button');
    // The stored approval is the batch, planned SEQUENTIAL, with its recipients exactly as written.
    const { rows } = await t.db.query(`SELECT plan, strategy FROM mcp_handoffs WHERE tenant_id = $1 ORDER BY created_at`, [tenantId]);
    expect(rows).toHaveLength(1);
    expect((rows[0] as { plan: { kind: string; flow: string | null } }).plan).toMatchObject({ kind: 'SEQUENTIAL', flow: null });
    expect(JSON.stringify((rows[0] as { strategy: unknown }).strategy)).toContain(`"recipient":"${A}"`);

    // Control: in the same deployment a single Solana transfer is natively signable and gets the buttons.
    await say(`send 0.01 SOL to ${A} on Solana`);
    const single = approvalMessage()!;
    expect(single).not.toBe(batch);
    expect(nativeRow(single).map(b => b.text)).toEqual(['Sign with Phantom', 'Sign with Solflare']);
  });
});
