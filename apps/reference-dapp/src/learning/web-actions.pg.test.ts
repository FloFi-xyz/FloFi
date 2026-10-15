// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-LEARNING-001: the web chat's learning path on PostgreSQL, as the server actions run it — verified wallet sessions (simulated as the
 * cookie reader would return them), strict parsing of browser input, the Memory status, and the glossary each user's model request carries.
 */
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import { createReplayTransport, interpretCopilotV2 } from '../server/copilot-service.ts';
import { pickPrincipal, webLearningService } from '../server/learning-web.ts';
import type { WalletPrincipal } from '../server/session-principal.ts';
import { evaluateKnowledge } from './evaluation.ts';
import { KNOWLEDGE_SCHEMA, validateKnowledgeDocument } from './knowledge.ts';
import { createLearningStore } from './store.ts';
import { applyAction, applySettings, parseClientEvents, parseInterpretOptions, parseMemoryAction, requestGlossary, statusView } from './web-actions.ts';

const SECRET = randomBytes(32).toString('hex'), NOW = new Date('2026-10-15T12:00:00.000Z');
const ENV = { FLOFI_LEARNING: 'enabled', FLOFI_LEARNING_SECRET: SECRET };
const EVM_A: WalletPrincipal = { namespace: 'eip155', address: '0x' + 'a'.repeat(40) }, EVM_B: WalletPrincipal = { namespace: 'eip155', address: '0x' + 'b'.repeat(40) };
const SOL_A: WalletPrincipal = { namespace: 'solana', address: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU' };
const SAVE_ARB = { op: 'SAVE', entry: { term: 'Arb', target: 'network:ARBITRUM' } };
const opened: TestDatabase[] = [];
afterEach(async () => { await Promise.allSettled(opened.splice(0).map(t => t.drop())); }, 60_000);
async function setup() {
  const t = await createTestDatabase();
  opened.push(t);
  const service = await webLearningService(ENV, async () => ({ db: t.db, tenantId: 'default' }));
  if (typeof service === 'string') throw new Error(service);
  return { t, service };
}

describe('BUILD-CHAT-LEARNING-001 web chat learning (PostgreSQL)', () => {
  it('off by default, unavailable when storage fails: the chat sees no learning context', async () => {
    expect(await webLearningService({})).toBe('OFF');
    expect(await webLearningService({ FLOFI_LEARNING: 'enabled' })).toBe('OFF'); // no dedicated secret
    expect(await webLearningService({ FLOFI_LEARNING: 'enabled', FLOFI_LEARNING_SECRET: SECRET, API_AUTH_TOKEN: SECRET })).toBe('OFF'); // a reused secret
    expect(await webLearningService(ENV, async () => { throw new Error('SCHEMA_NOT_MIGRATED'); })).toBe('UNAVAILABLE');
    expect(await statusView('OFF', [EVM_A], null)).toEqual({ enabled: false });
    expect(await statusView('UNAVAILABLE', [EVM_A], null)).toMatchObject({ enabled: true, learning: { memory: 'UNAVAILABLE' }, entries: [] });
    expect(await applyAction('UNAVAILABLE', [EVM_A], null, SAVE_ARB)).toEqual({ ok: false, code: 'LEARNING_UNAVAILABLE' });
  });

  it('A saves a meaning; only A’s verified wallet sees it — B, A’s Solana wallet and an anonymous browser do not', async () => {
    const { service } = await setup();
    expect(await applyAction(service, [EVM_A], null, SAVE_ARB)).toEqual({ ok: true });
    const a = await statusView(service, [EVM_A], null);
    expect(a).toMatchObject({ enabled: true, identity: { namespace: 'eip155', short: '0xaaaa…aaaa' }, memoryEnabled: true, entries: [{ term: 'arb', target: 'network:ARBITRUM' }],
      learning: { memory: 'AVAILABLE', owner: { EN: 'your wallet 0xaaaa…aaaa', PT: 'sua carteira 0xaaaa…aaaa' }, private: [{ term: 'arb' }] } });
    expect((await statusView(service, [EVM_B], null))).toMatchObject({ entries: [], learning: { private: [] } });
    expect((await statusView(service, [EVM_A, SOL_A], 'solana'))).toMatchObject({ identity: { namespace: 'solana' }, entries: [], learning: { private: [] } });
    expect((await statusView(service, [], null))).toMatchObject({ identity: null, entries: [], learning: { memory: 'ANONYMOUS', private: [] } });
  });

  it('identity switching never borrows another wallet: a requested namespace that is not proven is anonymous', () => {
    expect(pickPrincipal([EVM_A], 'solana')).toBeNull();
    expect(pickPrincipal([EVM_A, SOL_A], null)).toEqual({ kind: 'WALLET', namespace: 'eip155', account: EVM_A.address });
    expect(pickPrincipal([SOL_A], null)).toEqual({ kind: 'WALLET', namespace: 'solana', account: SOL_A.address });
    expect(pickPrincipal([], 'eip155')).toBeNull();
  });

  it('the model request of A carries A’s meaning; B’s carries none of A’s; both carry an approved global entry', async () => {
    const { t, service } = await setup();
    await applyAction(service, [EVM_A], null, SAVE_ARB);
    const store = createLearningStore(t.db, 'default'), document = validateKnowledgeDocument({ schema: KNOWLEDGE_SCHEMA, entries: [
      { term: 'eth sepolia', target: 'network:ETHEREUM_SEPOLIA', language: 'ANY', candidateId: null }] });
    const evaluation = await store.recordEvaluation({ purpose: 'PUBLISH', baseVersion: null, document, corpus: 'learning-corpus.v1', passed: true,
      result: evaluateKnowledge(document, null), createdBy: 'cli' }, NOW);
    await store.appendKnowledge({ expectedVersion: 0, document, evaluationId: evaluation.evaluationId, restoredFrom: null, createdBy: 'cli', reason: null }, NOW);
    const messages = [{ role: 'user', text: 'Bridge 10 USDC from Base to Arb, then swap on eth sepolia' }];
    const bodies: Record<string, string> = {};
    for (const [name, principals] of [['A', [EVM_A]], ['B', [EVM_B]], ['anonymous', []]] as const) {
      const session = await service.session(pickPrincipal(principals, null));
      const { glossary } = requestGlossary(service, session, messages, []);
      const replay = createReplayTransport({ format: 'flofi.copilot-replay.v2', entries: [{ user: [messages[0]!.text], answer: { output: { intent: {
        version: '2', language: 'EN', kind: 'UNSUPPORTED', reason: 'x' } } } }] }, 'segment');
      await interpretCopilotV2({ version: '2', messages }, { mode: 'replay', glossary, settings: { model: 'replay', temperature: 0, maxOutputTokens: 4096, reasoningEffort: null },
        transport: async request => { bodies[name] = request.body; return replay(request); } });
    }
    expect(bodies.A).toContain('\\"arb\\" → network ARBITRUM (the user\'s own saved meaning)');
    for (const name of ['A', 'B', 'anonymous']) expect(bodies[name]).toContain('\\"eth sepolia\\" → network ETHEREUM_SEPOLIA (FloFi glossary)');
    expect(bodies.B).not.toContain('\\"arb\\"');
    expect(bodies.anonymous).not.toContain('\\"arb\\"');
  });

  it('settings require a proven wallet; browser input is parsed strictly', async () => {
    const { service } = await setup();
    expect(await applySettings(service, [], null, { memory: false })).toEqual({ ok: false, code: 'LEARNING_IDENTITY_REQUIRED' });
    expect(await applySettings(service, [EVM_A], null, { memory: 'no' })).toEqual({ ok: false, code: 'LEARNING_REQUEST_INVALID' });
    expect(await applySettings(service, [EVM_A], null, { account: '0x' + 'b'.repeat(40) })).toEqual({ ok: false, code: 'LEARNING_REQUEST_INVALID' });
    expect(await applySettings(service, [EVM_A], null, { contribute: true })).toEqual({ ok: true });
    expect(await applyAction(service, [EVM_A], null, { op: 'SAVE', entry: SAVE_ARB.entry, account: '0x' + 'b'.repeat(40) })).toEqual({ ok: false, code: 'LEARNING_REQUEST_INVALID' });
    expect(parseMemoryAction({ op: 'SAVE', entry: { term: 'base', target: 'network:BASE_SEPOLIA' } })).toBeNull();
    expect(parseMemoryAction({ op: 'FORGET_ALL' })).toEqual({ op: 'FORGET_ALL' });
    expect(parseMemoryAction({ op: 'LANGUAGE', language: 'ES' })).toBeNull();
    expect(parseClientEvents([{ kind: 'TURN', outcome: 'PROPOSAL', language: 'PT', privateEntries: 1 }, { kind: 'INTERPRETED' }, { kind: 'MEMORY_SAVED' },
      { kind: 'PROPOSAL_APPLIED', outcome: 'free text here' }, 'x'])).toEqual([
      { kind: 'TURN', outcome: 'PROPOSAL', language: 'PT', privateEntries: 1, globalEntries: 0, knowledgeVersion: null },
      { kind: 'PROPOSAL_APPLIED', outcome: null, language: null, privateEntries: 0, globalEntries: 0, knowledgeVersion: null }]);
    expect(parseInterpretOptions({ identity: 'solana', aliases: [{ term: 'arb', target: 'network:ARBITRUM' }, { term: 'base', target: 'network:BASE_SEPOLIA' }] }))
      .toEqual({ identity: 'solana', aliases: [{ term: 'arb', target: 'network:ARBITRUM', source: 'SESSION' }] });
    expect(parseInterpretOptions('x')).toEqual({ identity: null, aliases: [] });
  });
});
