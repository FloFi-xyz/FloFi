// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-LEARNING-001/002: Telegram with learning enabled, end to end at the webhook (PostgreSQL, Bot API double, MOCKED engine, scripted
 * interpreter that records the glossary it receives — no model, nothing leaves the process). A sender is its own learning identity: what FloFi
 * keeps reaches only their interpreter requests; there is no offer or button; what is kept depends on the deployment's basis (legitimate interest,
 * consent, off) and the sender's MEMORY ON / OFF; STOP erases everything; and with learning off the same words behave exactly as before.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../../../packages/cloud-runtime/test/pg-harness.ts';
import type { ChannelInterpreter } from '../core/conversation.ts';
import { recordingRuntime } from '../core/engine.test-harness.ts';
import { telegramUserDigest } from './config.ts';
import { botApi, TELEGRAM_OTHER_USER, TELEGRAM_USER, telegramEnv, telegramRequest, textUpdate } from './fixtures.test-harness.ts';
import { handleTelegramWebhook } from './handler.ts';

let t: TestDatabase, d: ReturnType<typeof deployment>;
// One deployment for the whole conversation history: its channel secret keys the sender digest (a new secret is a new learning identity).
beforeAll(async () => { t = await createTestDatabase(); d = deployment(); });
afterAll(async () => { await t?.drop(); });
const LEARNING = { FLOFI_LEARNING: 'enabled', FLOFI_LEARNING_SECRET: randomBytes(32).toString('hex'), FLOFI_CHANNEL_COPILOT: 'enabled',
  FLOFI_LEARNING_AUTOMATIC: 'legitimate_interest',
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

describe('BUILD-CHAT-LEARNING-002 Telegram learning (PostgreSQL, Bot API double)', () => {
  it('no offer, no button: a statement applies to the conversation; under legitimate interest it is kept for that sender only', async () => {
    await d.say('/start');
    await d.say('Whenever I say arb, I mean Arbitrum');
    expect(d.api.texts().at(-1)).toBe('Got it — from now on I\'ll read “arb” as Arbitrum One (real funds).');
    expect(d.api.texts().join('\n')).not.toMatch(/Remember|Lembrar|teach|ensinar/);
    expect(d.glossaries).toEqual([]); // a memory statement never reaches the interpreter
    // Kept without any click: the subject (a keyed digest), the meaning, and the evidence saying the user stated it.
    expect(await rows(`SELECT kind, memory_enabled, memory_consent_at FROM learning_subjects`)).toEqual([{ kind: 'CHANNEL', memory_enabled: false, memory_consent_at: null }]);
    expect(await rows(`SELECT term, target FROM learning_memories`)).toEqual([{ term: 'arb', target: 'network:ARBITRUM' }]);
    expect(await rows(`SELECT term, target, stated, promoted_at IS NOT NULL AS learned FROM learning_evidence`)).toEqual([
      { term: 'arb', target: 'network:ARBITRUM', stated: 1, learned: true }]);

    await d.say('bridge 10 USDC from Base to arb');
    expect(d.glossaries.at(-1)).toContain('"arb" → network ARBITRUM (the user said so in this conversation)');
    await d.say('new'); // a new conversation: the kept meaning, not this conversation's, applies
    await d.say('bridge 10 USDC from Base to arb');
    expect(d.glossaries.at(-1)).toContain('"arb" → network ARBITRUM (the user\'s own saved meaning)');
    await d.say('bridge 10 USDC from Base to arb', TELEGRAM_OTHER_USER);
    expect(d.glossaries.at(-1)).toBeNull();
    // No text, term or sender id in the content-free feedback.
    const events = await rows(`SELECT scope, kind, evidence, outcome FROM learning_feedback_events ORDER BY event_id`);
    expect(events).toEqual(expect.arrayContaining([{ scope: 'TELEGRAM', kind: 'AUTOMATIC', evidence: 'SYSTEM', outcome: 'STATED_LEARNED' },
      { scope: 'TELEGRAM', kind: 'ADAPTATION', evidence: 'OBSERVED', outcome: 'STATED' }, { scope: 'TELEGRAM', kind: 'INTERPRETED', evidence: 'SYSTEM', outcome: 'OK' }]));
    expect(JSON.stringify(await rows(`SELECT * FROM learning_feedback_events`))).not.toMatch(/arb|900000001/);
  });

  it('MEMORY lists the sender’s own meanings only; MEMORY OFF is an objection that erases what was learned; MEMORY ON resumes; STOP erases everything', async () => {
    await d.say('memory');
    expect(d.api.texts().at(-1)).toMatch(/^FloFi remembers for this chat account:\n• arb → Arbitrum One \(real funds\)/);
    await d.say('memory', TELEGRAM_OTHER_USER);
    expect(d.api.texts().at(-1)).toBe('FloFi keeps nothing for this chat account.');
    await d.say('pausar memória');
    expect(d.api.texts().at(-1)).toMatch(/^Memória desligada/);
    expect(await rows(`SELECT enabled, basis FROM learning_automatic_settings`)).toEqual([{ enabled: false, basis: 'LEGITIMATE_INTEREST' }]);
    expect(await rows(`SELECT count(*)::int AS n FROM learning_memories`)).toEqual([{ n: 0 }]);
    await d.say('Whenever I say arb, I mean Arbitrum');
    expect(await rows(`SELECT count(*)::int AS n FROM learning_memories`)).toEqual([{ n: 0 }]); // an objection is honoured: nothing kept
    await d.say('new');
    await d.say('bridge 10 USDC from Base to arb');
    expect(d.glossaries.at(-1)).toBeNull();
    await d.say('memory on');
    await d.say('Whenever I say arb, I mean Arbitrum');
    await d.say('new');
    await d.say('bridge 10 USDC from Base to arb');
    expect(d.glossaries.at(-1)).toContain('"arb"');
    // The other sender is learned too (their own language evidence): STOP erases exactly this sender, with every observation.
    const subjects = Number((await rows(`SELECT count(*)::int AS n FROM learning_subjects`))[0]!.n);
    await d.say('stop');
    expect(await rows(`SELECT count(*)::int AS n FROM learning_memories`)).toEqual([{ n: 0 }]);
    expect(await rows(`SELECT count(*)::int AS n FROM learning_subjects`)).toEqual([{ n: subjects - 1 }]);
    expect(await rows(`SELECT count(*)::int AS n FROM learning_evidence WHERE term <> ''`)).toEqual([{ n: 0 }]);
  });

  it('under consent, nothing is kept until the sender turns memory on; with persistent learning off, nothing is ever kept', async () => {
    const consent = deployment({ ...LEARNING, FLOFI_LEARNING_AUTOMATIC: 'consent' }), before = await rows(`SELECT count(*)::int AS n FROM learning_subjects`);
    await consent.say('/start');
    await consent.say('Whenever I say arb, I mean Arbitrum');
    expect(consent.api.texts().at(-1)).toBe('Got it — in this conversation I\'ll read “arb” as Arbitrum One (real funds).');
    expect(await rows(`SELECT count(*)::int AS n FROM learning_subjects`)).toEqual(before);
    await consent.say('memory on');
    expect(await rows(`SELECT s.memory_enabled, a.enabled, a.basis, a.notice_version FROM learning_subjects s JOIN learning_automatic_settings a USING (tenant_id, subject_id)`))
      .toEqual([{ memory_enabled: true, enabled: true, basis: 'CONSENT', notice_version: 2 }]);
    await consent.say('Whenever I say arb, I mean Arbitrum');
    expect(consent.api.texts().at(-1)).toBe('Got it — from now on I\'ll read “arb” as Arbitrum One (real funds).');
    await consent.say('stop');
    const off = deployment({ ...LEARNING, FLOFI_LEARNING_AUTOMATIC: undefined });
    const counts = async () => (await rows(`SELECT (SELECT count(*) FROM learning_subjects)::int AS subjects, (SELECT count(*) FROM learning_memories)::int AS memories,
      (SELECT count(*) FROM learning_evidence)::int AS evidence`))[0] as { subjects: number; memories: number; evidence: number };
    const before2 = await counts();
    await off.say('/start');
    await off.say('Whenever I say arb, I mean Arbitrum');
    await off.say('bridge 10 USDC from Base to arb');
    await off.say('memory on');
    await off.say('Whenever I say arb, I mean Arbitrum');
    // Only the pause switch's subject row: no meaning, no evidence.
    expect(await counts()).toEqual({ ...before2, subjects: before2.subjects + 1 });
  });

  it('with learning off, the same words reach the interpreter exactly as before and nothing is stored', async () => {
    const off = deployment({ ...LEARNING, FLOFI_LEARNING: undefined }), before = await rows(`SELECT count(*)::int AS n FROM learning_subjects`);
    await off.say('memory');
    await off.say('Whenever I say arb, I mean Arbitrum');
    expect(off.glossaries).toEqual([null, null]);
    expect(await rows(`SELECT count(*)::int AS n FROM learning_subjects`)).toEqual(before);
  });
});
