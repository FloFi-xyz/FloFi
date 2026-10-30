// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-TELEGRAM-PUBLIC-001: public Telegram access end to end at the HTTP boundary, on a disposable loopback PostgreSQL with a recording
 * engine runtime (MOCKED flows) and a Bot API double behind a fake `fetch` (nothing leaves the process).
 *
 * With FLOFI_TELEGRAM_ACCESS_MODE=public and no allowlist, a person nobody ever authorized starts with /start, gets a proposal and
 * continues in FloFi, where only their own (intended) wallet can claim it; Telegram signs nothing and reaches no execution path. The
 * allowlist stays the default. Admission is bounded per sender (spent first) and globally, atomically across concurrent deliveries; the
 * model budget is shared by every conversation and, once spent, natural language is answered "busy" while exact commands still work.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../../../packages/cloud-runtime/test/pg-harness.ts';
import { claimApproval, PlatformRefusal, type WalletRef } from '../../platform/index.ts';
import { approvalSurface } from '../../server/approval-surface.ts';
import { recordingRuntime } from '../core/engine.test-harness.ts';
import type { ChannelInterpreter } from '../core/conversation.ts';
import { botApi, telegramEnv, telegramRequest, textUpdate } from './fixtures.test-harness.ts';
import { handleTelegramWebhook } from './handler.ts';

const OWNER = '0x1111111111111111111111111111111111111111', STRANGER_WALLET = '0x3333333333333333333333333333333333333333';
// Telegram user ids no allowlist ever listed.
const STRANGER = 7_700_001_234, SECOND_STRANGER = 7_700_005_678;
let t: TestDatabase;
beforeAll(async () => { t = await createTestDatabase(); });
afterAll(async () => { await t?.drop(); });
// Fixed windows persist per bucket; every test starts from empty windows.
beforeEach(async () => { await t.db.query(`DELETE FROM mcp_rate_limits WHERE bucket LIKE 'channel:%'`); });

function deployment(overrides: Record<string, string | undefined> = {}, interpreter: ChannelInterpreter | null = null) {
  const f = telegramEnv({ FLOFI_TELEGRAM_ACCESS_MODE: 'public', FLOFI_TELEGRAM_ALLOWED_USERS: undefined, ...overrides }), api = botApi(), calls: string[] = [], logs: string[] = [];
  const host = { db: t.db, tenantId: 'default' }, runtime = recordingRuntime(calls);
  const logger = { info: (e: string, x?: unknown) => logs.push(JSON.stringify([e, x])), warn: (e: string, x?: unknown) => logs.push(JSON.stringify([e, x])) };
  const say = async (text: string, user: number) => {
    const response = await handleTelegramWebhook(telegramRequest(textUpdate(text, { user }), f.webhookSecret), { env: f.env, host, runtime, fetch: api.fetch, interpreter, logger,
      sleep: async () => undefined });
    return { status: response.status, code: (await response.json() as { code: string }).code };
  };
  const to = (user: number) => api.delivered().filter(call => Number(call.params.chat_id) === user)
    .map(call => String(call.method === 'sendPhoto' ? call.params.caption : call.params.text));
  const surface = () => approvalSurface(f.env, () => undefined, { host, runtime });
  return { ...f, api, calls, logs, say, to, surface };
}
const refusal = async (work: Promise<unknown>) => { try { await work; return 'NO_REFUSAL'; } catch (e) { return e instanceof PlatformRefusal ? e.message : String(e); } };
const evm = (address: string): WalletRef => ({ namespace: 'eip155', address });
const events = async () => (await t.db.query(`SELECT count(*)::int AS n FROM channel_events WHERE channel = 'TELEGRAM'`)).rows[0]!.n as number;

describe('BUILD-TELEGRAM-PUBLIC-001 public Telegram access (PostgreSQL, Bot API double, MOCKED engine)', () => {
  it('a person nobody authorized starts with /start, gets a proposal and continues in FloFi with their own wallet only', async () => {
    const d = deployment();
    expect(await d.say('/start', STRANGER)).toEqual({ status: 200, code: 'ACCEPTED' });
    expect(d.to(STRANGER)).toEqual([expect.stringMatching(/^FloFi \(automated assistant\)/), expect.stringMatching(/^What I can do/)]);
    await d.say(`supply 100 USDC to Aave on Base Sepolia beneficiary ${STRANGER_WALLET}`, STRANGER);
    expect(d.to(STRANGER).at(-1)).toMatch(/^Strategy ready:[\s\S]*Nothing is authorized yet/);
    const url = d.api.lastLink()!;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:3100\/approve#flofi_chs_[A-Za-z0-9_-]{43}$/);
    const secret = decodeURIComponent(new URL(url).hash.slice(1));
    // FloFi requires the person's own wallet proof, and only the wallet named in their request can continue.
    expect(await refusal(claimApproval(await d.surface(), secret, [], false))).toBe('EVM_WALLET_PROOF_REQUIRED');
    expect(await refusal(claimApproval(await d.surface(), secret, [evm(OWNER)], false))).toBe('CHANNEL_INTENDED_WALLET_MISMATCH');
    expect((await claimApproval(await d.surface(), secret, [evm(STRANGER_WALLET)], false)).view).toMatchObject({ status: 'CLAIMED', claimedByYou: true });
    // Telegram authorizes nothing and nothing reached an execution path.
    await d.say('yes, execute it', STRANGER);
    expect(d.to(STRANGER).at(-1)).toMatch(/^Nothing can be authorized here/);
    expect(d.calls).not.toContain('EXECUTION_PATH');
    // A second stranger is an independent conversation that receives only its own replies.
    await d.say('/start', SECOND_STRANGER);
    expect(d.to(SECOND_STRANGER)).toEqual([expect.stringMatching(/^FloFi \(automated assistant\)/), expect.stringMatching(/^What I can do/)]);
    expect(d.to(SECOND_STRANGER).join('\n')).not.toContain('Strategy ready');
    // Logs never carry a user id, a wallet, message text or the link.
    expect(d.logs.join('\n')).not.toMatch(new RegExp(`${STRANGER}|${STRANGER_WALLET}|flofi_chs_|supply 100`));
  });

  it('admits an unlisted stranger without a public-mode override', async () => {
    const d = deployment({ FLOFI_TELEGRAM_ACCESS_MODE: undefined });
    expect(await d.say('/start', STRANGER)).toEqual({ status: 200, code: 'ACCEPTED' });
    expect(d.to(STRANGER)).toEqual([expect.stringMatching(/^FloFi \(automated assistant\)/), expect.stringMatching(/^What I can do/)]);
  });

  it('bounds admission per sender first, then globally, before anything is stored, and says nothing about who was limited', async () => {
    const d = deployment({ FLOFI_TELEGRAM_PUBLIC_SENDER_LIMIT: '2', FLOFI_TELEGRAM_PUBLIC_GLOBAL_LIMIT: '3' });
    const before = await events();
    expect([(await d.say('help', STRANGER)).code, (await d.say('help', STRANGER)).code]).toEqual(['ACCEPTED', 'ACCEPTED']);
    // The sender's third update is acknowledged (no Telegram retry) and dropped; it did not spend the global window.
    expect(await d.say('help', STRANGER)).toEqual({ status: 200, code: 'TELEGRAM_PUBLIC_RATE_LIMITED' });
    expect(await d.say('help', SECOND_STRANGER)).toEqual({ status: 200, code: 'ACCEPTED' });
    expect(await d.say('help', 7_700_009_999)).toEqual({ status: 200, code: 'TELEGRAM_PUBLIC_RATE_LIMITED' });
    expect(await events()).toBe(before + 3);
    expect(d.logs.filter(line => line.includes('channel.public_rate_limited'))).toEqual([
      JSON.stringify(['channel.public_rate_limited', { channel: 'TELEGRAM', kind: 'sender' }]),
      JSON.stringify(['channel.public_rate_limited', { channel: 'TELEGRAM', kind: 'global' }])]);
  });

  it('never admits more than the global window under concurrent deliveries from many senders', async () => {
    const d = deployment({ FLOFI_TELEGRAM_PUBLIC_GLOBAL_LIMIT: '5', FLOFI_TELEGRAM_PUBLIC_SENDER_LIMIT: '1' });
    const codes = await Promise.all(Array.from({ length: 12 }, (_, i) => d.say('help', 7_710_000_000 + i).then(r => r.code)));
    expect(codes.filter(code => code === 'ACCEPTED')).toHaveLength(5);
    expect(codes.filter(code => code === 'TELEGRAM_PUBLIC_RATE_LIMITED')).toHaveLength(7);
  });

  it('shares one model budget across conversations: once spent, natural language is answered "busy" and exact commands still work', async () => {
    let modelCalls = 0;
    const interpreter: ChannelInterpreter = async () => { modelCalls += 1; return { ok: false, code: 'COPILOT_NOT_CONFIGURED' }; };
    const d = deployment({ FLOFI_CHANNEL_COPILOT: 'enabled', FLOFI_CHANNEL_MODEL_BUDGET_HOURLY: '1', FLOFI_CHANNEL_MODEL_BUDGET_DAILY: '1' }, interpreter);
    await d.say('I would like to earn some yield on my stablecoins', STRANGER);
    expect(modelCalls).toBe(1);
    await d.say('I would like to earn some yield on my stablecoins', SECOND_STRANGER);
    expect(modelCalls).toBe(1);
    expect(d.to(SECOND_STRANGER).at(-1)).toMatch(/handling too many requests/);
    await d.say(`supply 100 USDC to Aave on Base Sepolia beneficiary ${STRANGER_WALLET}`, SECOND_STRANGER);
    expect(d.to(SECOND_STRANGER).at(-1)).toMatch(/^Strategy ready:/);
    expect(modelCalls).toBe(1);
  });
});
