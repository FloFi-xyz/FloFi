// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-LEARNING-001: WhatsApp with learning enabled, end to end at the signed webhook (PostgreSQL, fixture transport, MOCKED engine,
 * scripted interpreter that records the glossary it receives — no model, nothing leaves the process). Same Channel Core path as Telegram: a
 * sender is its own learning identity (never a wallet, never a Telegram sender), nothing offers to remember (BUILD-CHAT-LEARNING-002: a statement is
 * kept under the deployment's basis), MEMORY lists the sender's own meanings, and STOP erases them.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../../../packages/cloud-runtime/test/pg-harness.ts';
import type { ChannelInterpreter } from '../core/conversation.ts';
import { recordingRuntime } from '../core/engine.test-harness.ts';
import { inbound, sha256Hex, USER_BSUID, webhookRequest, whatsAppEnv } from './fixtures.test-harness.ts';
import { handleWhatsAppWebhook } from './handler.ts';
import { fixtureTransport, type FixtureRecord } from './transport.ts';

const OTHER_BSUID = 'BR.FLOFITESTUSER0002', OTHER_PHONE = '5511900000002';
const UNSUPPORTED = { version: '2', language: 'PT', kind: 'UNSUPPORTED', reason: 'Não é um pedido.' };
let t: TestDatabase, d: ReturnType<typeof deployment>;
function deployment() {
  const fixture = whatsAppEnv({ FLOFI_LEARNING: 'enabled', FLOFI_LEARNING_SECRET: randomBytes(32).toString('hex'), FLOFI_CHANNEL_COPILOT: 'enabled',
    FLOFI_LEARNING_AUTOMATIC: 'legitimate_interest',
    FLOFI_WHATSAPP_ALLOWED_SENDERS: [USER_BSUID, OTHER_BSUID].map(sha256Hex).join(',') });
  const sent: FixtureRecord[] = [], glossaries: (string | null)[] = [], calls: string[] = [];
  const interpreter: ChannelInterpreter = async (_request, options) => { glossaries.push(options?.glossary ?? null); return { ok: true, intent: UNSUPPORTED }; };
  const say = (text: string, other = false) => handleWhatsAppWebhook(webhookRequest(inbound([{ text, ...other ? { bsuid: OTHER_BSUID, from: OTHER_PHONE } : {} }]),
    fixture.appSecret), { env: fixture.env, host: { db: t.db, tenantId: 'default' }, runtime: recordingRuntime(calls), transport: fixtureTransport(sent), interpreter,
    logger: null, sleep: async () => undefined });
  const texts = () => sent.map(r => { const b = r.body as { text?: { body?: string }; interactive?: { body?: { text?: string } } }; return b.text?.body ?? b.interactive?.body?.text ?? ''; });
  return { say, texts, glossaries };
}
const rows = async (sql: string) => (await t.db.query(sql)).rows;
// One deployment for the whole history: its channel secret keys the sender digest (a new secret is a new learning identity).
beforeAll(async () => { t = await createTestDatabase(); d = deployment(); });
afterAll(async () => { await t?.drop(); });

describe('BUILD-CHAT-LEARNING-002 WhatsApp learning (PostgreSQL, fixture transport)', () => {
  it('a sender’s answer to FloFi’s question and their statements adapt the conversation; what is kept reaches only that sender; MEMORY lists it; STOP erases it', async () => {
    await d.say('ajuda');
    await d.say('Sempre que eu disser arb, quero dizer Arbitrum');
    expect(d.texts().at(-1)).toBe('Entendi — a partir de agora, vou entender “arb” como Arbitrum One (fundos reais).');
    expect(d.texts().join('\n')).not.toMatch(/Lembrar|Quer que eu lembre/);
    expect(d.glossaries).toEqual([]);
    expect(await rows(`SELECT kind, memory_consent_at FROM learning_subjects`)).toEqual([{ kind: 'CHANNEL', memory_consent_at: null }]);

    await d.say('novo');
    await d.say('faz bridge de 10 USDC da Base pra arb');
    expect(d.glossaries.at(-1)).toContain('"arb" → network ARBITRUM (the user\'s own saved meaning)');
    await d.say('faz bridge de 10 USDC da Base pra arb', true);
    expect(d.glossaries.at(-1)).toBeNull();

    await d.say('memória');
    expect(d.texts().at(-1)).toMatch(/^O FloFi lembra para esta conta do chat:\n• arb → Arbitrum One \(fundos reais\)/);
    await d.say('memória', true);
    expect(d.texts().at(-1)).toBe('O FloFi não guarda nada para esta conta do chat.');
    expect(JSON.stringify(await rows(`SELECT * FROM learning_subjects`))).not.toMatch(/5511900000001|FLOFITESTUSER/);
    expect(JSON.stringify(await rows(`SELECT * FROM learning_evidence`))).not.toMatch(/5511900000001|FLOFITESTUSER/);

    // The other sender is learned too (the language of their own messages): STOP erases exactly this sender, with every observation.
    const subjects = Number((await rows(`SELECT count(*)::int AS n FROM learning_subjects`))[0]!.n);
    await d.say('parar');
    expect(await rows(`SELECT count(*)::int AS n FROM learning_memories`)).toEqual([{ n: 0 }]);
    expect(await rows(`SELECT count(*)::int AS n FROM learning_subjects`)).toEqual([{ n: subjects - 1 }]);
    expect(await rows(`SELECT count(*)::int AS n FROM learning_evidence WHERE term <> ''`)).toEqual([{ n: 0 }]);
  });
});
