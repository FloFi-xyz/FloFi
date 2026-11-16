// SPDX-License-Identifier: AGPL-3.0-only
/** HOTFIX-P1-FLIGHT-ACCESS-AND-CHAT-RECOVERY-001: what this tab keeps of the FloFi chat, for whom and for how long. A memory Storage only. */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from './chat-message';
import { CONVERSATION_LIMITS, CONVERSATION_STORAGE_PREFIX, conversationStorageKey, forgetConversations, historical, readConversation, writeConversation } from './conversation-persistence';
import { conversationScopeOf } from '../server/conversation-scope';

let map: Map<string, string>;
const storage = () => ({ get length() { return map.size; }, key: (index: number) => [...map.keys()][index] ?? null, getItem: (key: string) => map.get(key) ?? null,
  setItem: (key: string, value: string) => { map.set(key, value); }, removeItem: (key: string) => { map.delete(key); } });
const A = 'A'.repeat(32), B = 'B'.repeat(32), NOW = Date.parse('2026-11-16T13:00:00Z');
const intro: ChatMessage = { id: 0, role: 'system', text: 'Hi FloFier!' };
const asked: ChatMessage = { id: 1, role: 'you', text: 'Swap 0.5 USDC to SOL on Solana' };
const answered: ChatMessage = { id: 2, role: 'flofi', text: 'Swap added to your workflow.', question: 'Would you like to add another action or review your workflow?',
  options: ['Add another action', 'Review workflow'], language: 'EN', variants: { EN: { text: 'Swap added.', options: ['Add another action'], question: 'Next?' },
    PT: { text: 'Troca adicionada.', options: ['Adicionar outra ação'], question: 'Próximo?' } } };
beforeEach(() => { map = new Map(); });

describe('conversation scope and keys', () => {
  it('derives one opaque scope per tenant and account, never the account id itself', () => {
    const scope = conversationScopeOf('default', 'acct_0123456789abcdef0123456789abcdef');
    expect(scope).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(scope).toBe(conversationScopeOf('default', 'acct_0123456789abcdef0123456789abcdef'));
    expect(scope).not.toBe(conversationScopeOf('other-tenant', 'acct_0123456789abcdef0123456789abcdef'));
    expect(scope).not.toBe(conversationScopeOf('default', 'acct_ffffffffffffffffffffffffffffffff'));
    expect(scope).not.toContain('acct_');
    expect(conversationStorageKey(scope, 'workflow-1')).toBe(`${CONVERSATION_STORAGE_PREFIX}${scope}:workflow-1`);
    for (const bad of [null, undefined, '', 'short', 'has space'.repeat(4), '0x1111111111111111111111111111111111111111']) expect(conversationStorageKey(bad, 'workflow-1')).toBeNull();
    expect(conversationStorageKey(A, '')).toBeNull(); expect(conversationStorageKey(A, '../x')).toBeNull();
  });
});

describe('what is kept', () => {
  it('keeps the conversation of one account and workflow as read-only history (no answer buttons or open question)', () => {
    writeConversation(storage(), A, 'workflow-1', [intro, asked, answered], NOW);
    const restored = readConversation(storage(), A, 'workflow-1', NOW + 60_000)!;
    expect(restored.map(message => message.text)).toEqual([intro.text, asked.text, answered.text]);
    expect(restored[2]).toEqual(historical(answered));
    expect(restored[2]).not.toHaveProperty('options'); expect(restored[2]).not.toHaveProperty('question');
    expect(restored[2]!.variants).toEqual({ EN: { text: 'Swap added.' }, PT: { text: 'Troca adicionada.' } });
  });
  it('another account, another workflow or a record copied under another key reads nothing', () => {
    writeConversation(storage(), A, 'workflow-1', [intro, asked], NOW);
    expect(readConversation(storage(), B, 'workflow-1', NOW)).toBeNull();
    expect(readConversation(storage(), A, 'workflow-2', NOW)).toBeNull();
    map.set(conversationStorageKey(B, 'workflow-1')!, map.get(conversationStorageKey(A, 'workflow-1')!)!);
    expect(readConversation(storage(), B, 'workflow-1', NOW)).toBeNull();
  });
  it('writes nothing until the owner has said something, and nothing without a usable identity or storage', () => {
    writeConversation(storage(), A, 'workflow-1', [intro], NOW);
    writeConversation(storage(), null, 'workflow-1', [intro, asked], NOW);
    writeConversation(null, A, 'workflow-1', [intro, asked], NOW);
    expect(map.size).toBe(0);
  });
  it('never writes a typed private key, seed phrase or 64-hex secret', () => {
    const secrets = [`0x${'1f'.repeat(32)}`, 'my seed phrase is', 'abandon ability able about above absent absorb abstract absurd abuse access accident'];
    writeConversation(storage(), A, 'workflow-1', [intro, ...secrets.map((text, index) => ({ id: index + 1, role: 'you' as const, text })), { ...asked, id: 9 }], NOW);
    const stored = [...map.values()].join('');
    for (const secret of secrets) expect(stored).not.toContain(secret);
    expect(readConversation(storage(), A, 'workflow-1', NOW)!.map(message => message.text)).toEqual([intro.text, asked.text]);
  });
  it('refuses malformed or foreign records instead of repairing them', () => {
    const key = conversationStorageKey(A, 'workflow-1')!;
    for (const value of ['not json', 'null', '[]', JSON.stringify({ format: 'other', scope: A, workflowId: 'workflow-1', savedAt: NOW, messages: [intro] }),
      JSON.stringify({ format: 'flofi.conversation.v1', scope: A, workflowId: 'workflow-1', savedAt: NOW, messages: [{ id: 'x', role: 'you', text: 'hi' }] }),
      JSON.stringify({ format: 'flofi.conversation.v1', scope: A, workflowId: 'workflow-1', savedAt: NOW, messages: [{ id: 1, role: 'admin', text: 'hi' }] }),
      JSON.stringify({ format: 'flofi.conversation.v1', scope: A, workflowId: 'workflow-1', savedAt: NOW, messages: [] })]) {
      map.set(key, value);
      expect(readConversation(storage(), A, 'workflow-1', NOW), value).toBeNull();
    }
  });
});

describe('how long and how much', () => {
  it('drops a conversation older than the retention period (and removes it)', () => {
    writeConversation(storage(), A, 'workflow-1', [intro, asked], NOW);
    expect(readConversation(storage(), A, 'workflow-1', NOW + CONVERSATION_LIMITS.retentionMs)).not.toBeNull();
    expect(readConversation(storage(), A, 'workflow-1', NOW + CONVERSATION_LIMITS.retentionMs + 1)).toBeNull();
    expect(map.size).toBe(0);
  });
  it('keeps the newest messages within the message and size limits', () => {
    const many = Array.from({ length: CONVERSATION_LIMITS.messages + 50 }, (_, id) => ({ id, role: 'you' as const, text: `message ${id}` }));
    writeConversation(storage(), A, 'workflow-1', many, NOW);
    const kept = readConversation(storage(), A, 'workflow-1', NOW)!;
    expect(kept).toHaveLength(CONVERSATION_LIMITS.messages);
    expect(kept.at(-1)!.text).toBe(`message ${CONVERSATION_LIMITS.messages + 49}`);
    const large = Array.from({ length: 40 }, (_, id) => ({ id, role: 'you' as const, text: 'x'.repeat(20_000) }));
    writeConversation(storage(), A, 'workflow-2', large, NOW);
    expect(map.get(conversationStorageKey(A, 'workflow-2')!)!.length).toBeLessThanOrEqual(CONVERSATION_LIMITS.bytes);
    expect(readConversation(storage(), A, 'workflow-2', NOW)!.at(-1)!.id).toBe(39);
  });
  it('keeps at most the newest conversations of the account, and removes another account\'s when this one writes', () => {
    for (let index = 0; index < CONVERSATION_LIMITS.conversations + 5; index++) writeConversation(storage(), A, `workflow-${index}`, [intro, asked], NOW + index);
    expect(map.size).toBe(CONVERSATION_LIMITS.conversations);
    expect(readConversation(storage(), A, 'workflow-0', NOW + 100)).toBeNull();
    expect(readConversation(storage(), A, `workflow-${CONVERSATION_LIMITS.conversations + 4}`, NOW + 100)).not.toBeNull();
    writeConversation(storage(), B, 'workflow-b', [intro, asked], NOW + 200);
    expect([...map.keys()]).toEqual([conversationStorageKey(B, 'workflow-b')]);
  });
  it('sign-out removes every kept conversation of this tab; New workflow removes only its own', () => {
    writeConversation(storage(), A, 'workflow-1', [intro, asked], NOW); writeConversation(storage(), A, 'workflow-2', [intro, asked], NOW);
    map.set('flofi:editor-workflow:v1', 'kept');
    forgetConversations(storage(), { scope: A, workflowId: 'workflow-1' });
    expect(readConversation(storage(), A, 'workflow-1', NOW)).toBeNull(); expect(readConversation(storage(), A, 'workflow-2', NOW)).not.toBeNull();
    forgetConversations(storage());
    expect([...map.keys()]).toEqual(['flofi:editor-workflow:v1']);
  });
  it('a full or blocked storage never breaks the chat', () => {
    const full = { ...storage(), setItem: () => { throw new Error('QuotaExceededError'); } };
    expect(() => writeConversation(full, A, 'workflow-1', [intro, asked], NOW)).not.toThrow();
    const blocked = { ...storage(), getItem: () => { throw new Error('SecurityError'); } };
    expect(readConversation(blocked, A, 'workflow-1', NOW)).toBeNull();
  });
});
