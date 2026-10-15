// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-LEARNING-001: Telegram with learning enabled, end to end at the webhook (PostgreSQL, Bot API double, MOCKED engine, scripted
 * interpreter that records the glossary it receives — no model, nothing leaves the process). A sender is its own learning identity: their saved
 * meaning reaches only their interpreter requests; MEMORY / MEMORY OFF / MEMORY ON work; STOP erases what FloFi remembers; and with learning off
 * the same words behave exactly as before.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../../../packages/cloud-runtime/test/pg-harness.ts';
import type { ChannelInterpreter } from '../core/conversation.ts';
import { recordingRuntime } from '../core/engine.test-harness.ts';
import { telegramUserDigest } from './config.ts';
import { botApi, callbackUpdate, TELEGRAM_OTHER_USER, TELEGRAM_USER, telegramEnv, telegramRequest, textUpdate } from './fixtures.test-harness.ts';
import { handleTelegramWebhook } from './handler.ts';

let t: TestDatabase, d: ReturnType<typeof deployment>;
// One deployment for the whole conversation history: its channel secret keys the sender digest (a new secret is a new learning identity).
beforeAll(async () => { t = await createTestDatabase(); d = deployment(); });
afterAll(async () => { await t?.drop(); });
const LEARNING = { FLOFI_LEARNING: 'enabled', FLOFI_LEARNING_SECRET: randomBytes(32).toString('hex'), FLOFI_CHANNEL_COPILOT: 'enabled',
  FLOFI_TELEGRAM_ALLOWED_USERS: [TELEGRAM_USER, TELEGRAM_OTHER_USER].map(id => telegramUserDigest(String(id))).join(',') };
const UNSUPPORTED = { version: '2', language: 'EN', kind: 'UNSUPPORTED', reason: 'Not a request.' };

function deployment(overrides: Record<string, string | undefined> = LEARNING) {
  const f = telegramEnv(overrides), api = botApi(), calls: string[] = [], host = { db: t.db, tenantId: 'default' };
  const glossaries: (string | null)[] = [];
  const interpreter: ChannelInterpreter = async (_request, options) => { glossaries.push(options?.glossary ?? null); return { ok: true, intent: UNSUPPORTED }; };
  const post = (update: unknown) => handleTelegramWebhook(telegramRequest(update, f.webhookSecret), { env: f.env, host, runtime: recordingRuntime(calls), fetch: api.fetch,
    interpreter, logger: null, sleep: async () => undefined });
  const say = (text: string, user = TELEGRAM_USER) => post(textUpdate(text, { user }));
  return { ...f, api, post, say, glossaries, calls };
}
const rows = async (sql: string) => (await t.db.query(sql)).rows;

describe('BUILD-CHAT-LEARNING-001 Telegram learning (PostgreSQL, Bot API double)', () => {
  it('a sender saves a meaning with FloFi’s button; only that sender’s interpreter requests carry it', async () => {
    await d.say('/start');
    await d.say('Whenever I say arb, I mean Arbitrum');
    expect(d.api.texts().at(-1)).toMatch(/In this conversation, I'll read “arb” as Arbitrum One \(real funds\)\. Remember this for this Telegram account/);
    expect(d.glossaries).toEqual([]); // a memory statement never reaches the interpreter
    expect(await rows(`SELECT count(*)::int AS n FROM learning_subjects`)).toEqual([{ n: 0 }]); // nothing stored before the click
    await d.post(callbackUpdate('c1'));
    expect(d.api.texts().at(-1)).toMatch(/^Saved: “arb” = Arbitrum One/);
    expect(await rows(`SELECT kind, memory_enabled, notice_version FROM learning_subjects`)).toEqual([{ kind: 'CHANNEL', memory_enabled: true, notice_version: 1 }]);
    expect(await rows(`SELECT term, target FROM learning_memories`)).toEqual([{ term: 'arb', target: 'network:ARBITRUM' }]);

    await d.say('bridge 10 USDC from Base to arb');
    expect(d.glossaries.at(-1)).toContain('"arb" → network ARBITRUM (the user said so in this conversation)');
    await d.say('new'); // a new conversation: the saved meaning, not this conversation's, applies
    await d.say('bridge 10 USDC from Base to arb');
    expect(d.glossaries.at(-1)).toContain('"arb" → network ARBITRUM (the user\'s own saved meaning)');
    await d.say('bridge 10 USDC from Base to arb', TELEGRAM_OTHER_USER);
    expect(d.glossaries.at(-1)).toBeNull();
    // No text, term or sender id in the content-free feedback.
    const events = await rows(`SELECT scope, kind, evidence, outcome FROM learning_feedback_events ORDER BY event_id`);
    expect(events).toEqual(expect.arrayContaining([{ scope: 'TELEGRAM', kind: 'MEMORY_SAVED', evidence: 'USER_ASSERTED', outcome: null },
      { scope: 'TELEGRAM', kind: 'INTERPRETED', evidence: 'SYSTEM', outcome: 'OK' }]));
    expect(JSON.stringify(await rows(`SELECT * FROM learning_feedback_events`))).not.toMatch(/arb|900000001/);
  });

  it('MEMORY lists the sender’s own meanings only; MEMORY OFF pauses them; MEMORY ON resumes; STOP erases them', async () => {
    await d.say('memory');
    expect(d.api.texts().at(-1)).toMatch(/^FloFi remembers for this chat account:\n• arb → Arbitrum One \(real funds\)/);
    await d.say('memory', TELEGRAM_OTHER_USER);
    expect(d.api.texts().at(-1)).toMatch(/^FloFi does not remember anything for this chat account yet/);
    await d.say('pausar memória');
    expect(d.api.texts().at(-1)).toMatch(/^Memória pausada/);
    await d.say('bridge 10 USDC from Base to arb');
    expect(d.glossaries.at(-1)).toBeNull();
    await d.say('memory on');
    await d.say('bridge 10 USDC from Base to arb');
    expect(d.glossaries.at(-1)).toContain('"arb"');
    await d.say('stop');
    expect(await rows(`SELECT count(*)::int AS n FROM learning_memories`)).toEqual([{ n: 0 }]);
    expect(await rows(`SELECT count(*)::int AS n FROM learning_subjects`)).toEqual([{ n: 0 }]);
  });

  it('with learning off, the same words reach the interpreter exactly as before and nothing is stored', async () => {
    const off = deployment({ ...LEARNING, FLOFI_LEARNING: undefined }), before = await rows(`SELECT count(*)::int AS n FROM learning_subjects`);
    await off.say('memory');
    await off.say('Whenever I say arb, I mean Arbitrum');
    expect(off.glossaries).toEqual([null, null]);
    expect(await rows(`SELECT count(*)::int AS n FROM learning_subjects`)).toEqual(before);
  });
});
