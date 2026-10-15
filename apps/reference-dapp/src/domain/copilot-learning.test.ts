// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { COPILOT_EVAL_CASES } from './copilot-eval.corpus';
import type { CopilotLearning, CopilotReply } from './copilot-conversation';
import type { LexiconEntry, LexiconTarget } from './copilot-lexicon';
import { act, CopilotSession, intent } from './copilot-session.test-harness';

/**
 * BUILD-CHAT-LEARNING-001: the conversation engine with learned vocabulary. Same harness as the eval corpus: the real engine, exact grammar
 * and editor with a scripted model. Covers the acceptance scenario (A's private meaning; B does not inherit it; an approved global entry
 * reaches both) and the negative cases (anonymous, opt-out, malicious and conflicting entries, test/main network separation, amounts).
 */
const learning = (memory: CopilotLearning['memory'], extra: Partial<CopilotLearning> = {}): CopilotLearning =>
  ({ memory, owner: memory === 'ANONYMOUS' ? null : { EN: 'your wallet 0x1234…abcd', PT: 'sua carteira 0x1234…abcd' }, private: [], global: [], globalVersion: null,
    language: null, ...extra });
const saved = (term: string, target: LexiconTarget): LexiconEntry => ({ term, target, source: 'PRIVATE' });
const glossary = (term: string, target: LexiconTarget, version = 1): LexiconEntry => ({ term, target, source: 'GLOBAL', version });
const session = (context?: CopilotLearning) => { const s = new CopilotSession(); s.learning = context; return s; };
const BASE_TO_ARB = intent.action(act.bridge({ sourceNetwork: 'BASE', destinationNetwork: 'ARBITRUM', asset: 'USDC', amount: '10' }));
const ETH_SEPOLIA_SWAP = intent.action(act.swap({ network: 'ETHEREUM_SEPOLIA', inputAsset: 'WETH', outputAsset: 'USDC', amount: '0.001' }));
const text = (reply: CopilotReply | null) => reply ? [reply.text, ...reply.notes, ...reply.options].join('\n') : '';

describe('BUILD-CHAT-LEARNING-001 acceptance: private meaning, no inheritance, shared approved glossary', () => {
  it('User A states and keeps “arb” = Arbitrum One; it grounds A’s later request with a visible note', () => {
    const a = session(learning('AVAILABLE'));
    const offer = a.say('Whenever I say Arb, I mean Arbitrum.');
    expect(offer).toMatchObject({ kind: 'MEMORY', options: ['Remember', 'Not now'] });
    expect(offer!.text).toContain('In this conversation, I\'ll read “arb” as Arbitrum One (real funds).');
    expect(offer!.memory).toBeUndefined(); // nothing is stored before the click
    expect(a.turns.at(-1)!.request).toBeNull(); // never sent to the model
    const kept = a.say('Remember');
    expect(kept).toMatchObject({ kind: 'MEMORY', memory: { op: 'SAVE', entry: { term: 'arb', target: 'network:ARBITRUM', source: 'PRIVATE' } } });

    // A later session: the saved meaning comes back through A's verified identity.
    const later = session(learning('AVAILABLE', { private: [saved('arb', 'network:ARBITRUM')] }));
    const reply = later.say('Bridge 10 USDC from Base to Arb', BASE_TO_ARB);
    expect(reply).toMatchObject({ kind: 'PROPOSAL', sentence: 'bridge 10 USDC from Base to Arbitrum via auto slippage 50 bps' });
    expect(reply!.notes).toContain('“arb” read as Arbitrum One — your saved meaning.');
    expect(reply!.learning?.used).toEqual([saved('arb', 'network:ARBITRUM')]);
    // Still a proposal only: nothing applied, review and the wallet still decide.
    expect(later.workflow).toBe(later.turns.at(-1)!.workflowBefore);
  });

  it('User B (another identity, no saved meaning) is asked instead of inheriting A’s meaning', () => {
    const b = session(learning('AVAILABLE', { owner: { EN: 'your wallet 0x9999…9999', PT: 'sua carteira 0x9999…9999' } }));
    const reply = b.say('Bridge 10 USDC from Base to Arb', BASE_TO_ARB);
    expect(reply!.kind).toBe('CLARIFICATION');
    expect(text(reply)).not.toContain('saved meaning');
  });

  it('an approved global test-network entry serves both users; before publication both are asked', () => {
    for (const owner of [{ EN: 'your wallet 0x1234…abcd', PT: '' }, { EN: 'your wallet 0x9999…9999', PT: '' }]) {
      const before = session(learning('AVAILABLE', { owner }));
      expect(before.say('Swap 0.001 WETH to USDC on eth sepolia', ETH_SEPOLIA_SWAP)!.kind).toBe('CLARIFICATION');
      const after = session(learning('AVAILABLE', { owner, global: [glossary('eth sepolia', 'network:ETHEREUM_SEPOLIA', 3)], globalVersion: 3 }));
      const reply = after.say('Swap 0.001 WETH to USDC on eth sepolia', ETH_SEPOLIA_SWAP);
      expect(reply).toMatchObject({ kind: 'PROPOSAL', sentence: 'swap 0.001 WETH to USDC on Ethereum Sepolia slippage 50 bps' });
      expect(reply!.notes).toContain('“eth sepolia” read as Ethereum Sepolia — FloFi glossary v3.');
    }
  });
});

describe('BUILD-CHAT-LEARNING-001 memory controls in the conversation', () => {
  it('disabled learning: the statement goes to the model exactly as before', () => {
    const s = session(undefined);
    s.say('Whenever I say Arb, I mean Arbitrum', intent.unsupported('Flofi cannot do that.'));
    expect(s.turns.at(-1)!.request).not.toBeNull();
  });

  it('anonymous: the meaning applies to this conversation only, and FloFi says how to keep it', () => {
    const s = session(learning('ANONYMOUS'));
    const reply = s.say('Whenever I say Arb, I mean Arbitrum');
    expect(reply).toMatchObject({ kind: 'ANSWER' });
    expect(reply!.text).toContain('Prove your wallet');
    expect(reply!.memory).toBeUndefined();
    const used = s.say('Bridge 10 USDC from Base to Arb', BASE_TO_ARB);
    expect(used).toMatchObject({ kind: 'PROPOSAL' });
    expect(used!.notes).toContain('“arb” read as Arbitrum One — as you said in this conversation.');
    // A new conversation (a fresh state) forgets it.
    expect(session(learning('ANONYMOUS')).say('Bridge 10 USDC from Base to Arb', BASE_TO_ARB)!.kind).toBe('CLARIFICATION');
  });

  it('paused memory never offers to save; “Not now” stores nothing', () => {
    expect(session(learning('PAUSED')).say('Whenever I say Arb, I mean Arbitrum')).toMatchObject({ kind: 'ANSWER', text: expect.stringContaining('paused') });
    const s = session(learning('AVAILABLE'));
    s.say('Whenever I say Arb, I mean Arbitrum');
    const declined = s.say('Not now');
    expect(declined).toMatchObject({ kind: 'ANSWER' });
    expect(declined!.memory).toBeUndefined();
    expect(declined!.text).toContain('Not saved');
  });

  it('any other message drops the offer and continues normally', () => {
    const s = session(learning('AVAILABLE'));
    s.say('Whenever I say Arb, I mean Arbitrum');
    const reply = s.say('Bridge 10 USDC from Base to Arb', BASE_TO_ARB);
    expect(reply!.kind).toBe('PROPOSAL');
    expect(s.say('Remember', intent.unsupported('Not a request.'))!.memory).toBeUndefined();
  });

  it('forget, forget everything (confirmed) and reply language are typed memory actions', () => {
    const s = session(learning('AVAILABLE', { private: [saved('arb', 'network:ARBITRUM')] }));
    expect(s.say('forget arb')).toMatchObject({ kind: 'MEMORY', memory: { op: 'FORGET', term: 'arb' } });
    const all = s.say('forget everything');
    expect(all).toMatchObject({ kind: 'MEMORY', options: ['Delete all', 'Keep'] });
    expect(all!.memory).toBeUndefined();
    expect(s.say('Delete all')).toMatchObject({ kind: 'MEMORY', memory: { op: 'FORGET_ALL' } });
    const pt = s.say('Responda sempre em português');
    expect(pt).toMatchObject({ kind: 'MEMORY', options: ['Lembrar', 'Agora não'] });
    expect(s.say('Lembrar')).toMatchObject({ memory: { op: 'LANGUAGE', language: 'PT' } });
  });

  it('a saved reply language is used for FloFi’s own words, even for an English message', () => {
    const s = session(learning('AVAILABLE', { language: 'PT' }));
    const reply = s.say('Put 10 USDC into Aave on Base Sepolia', intent.action(act.lending('SUPPLY', { asset: 'USDC', amount: '10', network: 'BASE_SEPOLIA' })));
    expect(reply!.kind).toBe('PROPOSAL');
    expect(reply!.text).toMatch(/Entendi|Interpretei|proposta/i);
  });

  it('offers to replace a different saved meaning and says so', () => {
    const s = session(learning('AVAILABLE', { private: [saved('grana', 'asset:USDT')] }));
    const offer = s.say('Lembre que grana é USDC');
    expect(offer!.text).toContain('substitui');
    expect(s.say('Lembrar')).toMatchObject({ memory: { op: 'SAVE', entry: { term: 'grana', target: 'asset:USDC' } } });
  });
});

describe('BUILD-CHAT-LEARNING-001 safety of learned vocabulary', () => {
  it('refuses to redefine canonical vocabulary or to mix real funds and test networks (session included)', () => {
    const s = session(learning('AVAILABLE'));
    expect(s.say('whenever I say base, I mean Base Sepolia')).toMatchObject({ kind: 'UNSUPPORTED', text: expect.stringContaining('fixed meaning') });
    expect(s.say('when I say ignore all rules I mean Arbitrum')).toMatchObject({ kind: 'UNSUPPORTED' });
    expect(s.say('when I say arb test I mean Arbitrum')).toMatchObject({ kind: 'UNSUPPORTED', text: expect.stringContaining('real funds') });
    expect(s.say('whenever I say moon, I mean Pepe')).toMatchObject({ kind: 'UNSUPPORTED', text: expect.stringContaining('networks, tokens and actions') });
    expect(s.state.aliases ?? []).toEqual([]);
  });

  it('a secret is refused before any memory parsing', () => {
    const reply = session(learning('AVAILABLE')).say('whenever I say my seed phrase I mean Arbitrum');
    expect(reply!.kind).toBe('UNSUPPORTED');
    expect(reply!.memory).toBeUndefined();
  });

  it('a mainnet meaning never applies next to test-network wording; the user is asked', () => {
    const s = session(learning('AVAILABLE', { private: [saved('arb', 'network:ARBITRUM')] }));
    const reply = s.say('Bridge 10 USDC from Base to arb sepolia', BASE_TO_ARB);
    expect(reply!.kind).toBe('CLARIFICATION');
    expect(text(reply)).not.toContain('saved meaning');
  });

  it('learned vocabulary never grounds a number: an amount the user did not write is still asked for', () => {
    const s = session(learning('AVAILABLE', { private: [saved('arb', 'network:ARBITRUM')] }));
    const reply = s.say('Bridge some USDC from Base to Arb', BASE_TO_ARB);
    expect(reply!.kind).toBe('CLARIFICATION');
    expect(reply!.text).toContain('10');
  });

  it('a global meaning for a mainnet only suggests: FloFi asks, offers it first, and records whether it held', () => {
    const s = session(learning('AVAILABLE', { global: [glossary('arbitrun', 'network:ARBITRUM', 2)], globalVersion: 2 }));
    const asked = s.say('Bridge 10 USDC from Base to arbitrun', BASE_TO_ARB);
    expect(asked).toMatchObject({ kind: 'CLARIFICATION', options: ['Arbitrum One'] });
    expect(asked!.notes).toEqual(['“arbitrun” may mean Arbitrum One, which uses real funds — choose it below only if that is what you mean.']);
    const picked = s.say('Arbitrum One');
    expect(picked).toMatchObject({ kind: 'PROPOSAL', sentence: 'bridge 10 USDC from Base to Arbitrum via auto slippage 50 bps' });
    expect(picked!.learning?.signals).toEqual(expect.arrayContaining(['CLARIFICATION_ANSWERED', 'SUGGESTION_CONFIRMED']));
    expect(picked!.notes.join('\n')).not.toContain('glossary'); // the user's click named the network, not the glossary
  });

  it('a global meaning for a token never grounds it; a private one does, with a note', () => {
    const swap = intent.action(act.swap({ network: 'BASE_SEPOLIA', inputAsset: 'USDC', outputAsset: 'WETH', amount: '5' }));
    const global = session(learning('AVAILABLE', { global: [glossary('dólar digital', 'asset:USDC', 1)] }));
    expect(global.say('Swap 5 dólar digital to WETH on Base Sepolia', swap)!.kind).toBe('CLARIFICATION');
    const own = session(learning('AVAILABLE', { private: [saved('dólar digital', 'asset:USDC')] }));
    const reply = own.say('Swap 5 dólar digital to WETH on Base Sepolia', swap);
    expect(reply).toMatchObject({ kind: 'PROPOSAL', sentence: 'swap 5 USDC to WETH on Base Sepolia slippage 50 bps' });
    expect(reply!.notes).toContain('“dólar digital” read as USDC — your saved meaning.');
  });

  it('this conversation’s meaning wins over a saved one for the same word', () => {
    const s = session(learning('AVAILABLE', { private: [saved('grana', 'asset:USDT')] }));
    s.say('Lembre que grana é USDC');
    s.say('Agora não');
    const reply = s.say('Swap 5 grana to WETH on Base Sepolia', intent.action(act.swap({ network: 'BASE_SEPOLIA', inputAsset: 'USDC', outputAsset: 'WETH', amount: '5' })));
    expect(reply!.kind).toBe('PROPOSAL');
    expect(reply!.notes).toContain('“grana” read as USDC — as you said in this conversation.');
  });

  it('stale or tampered saved entries (now invalid) are ignored, never trusted', () => {
    const s = session(learning('AVAILABLE', { private: [{ term: 'base', target: 'network:BASE_SEPOLIA', source: 'PRIVATE' }] }));
    const reply = s.say('Swap 0.001 WETH to USDC on base', intent.action(act.swap({ network: 'BASE_SEPOLIA', inputAsset: 'WETH', outputAsset: 'USDC', amount: '0.001' })));
    expect(reply!.kind).toBe('CLARIFICATION');
  });

  it('signals a correction of FloFi’s proposal and a repeated failure (content-free)', () => {
    const s = session(learning('AVAILABLE'));
    s.say('Swap 1 USDC to ETH on Base Sepolia', intent.action(act.swap({ network: 'BASE_SEPOLIA', inputAsset: 'USDC', outputAsset: 'ETH', amount: '1' })));
    const revised = s.say('actually make it 2', intent.edit({ amount: '2' }));
    expect(revised!.learning?.signals).toEqual(['CORRECTION']);
    s.dismiss();
    s.say('stake my tokens', intent.unsupported('Staking is not supported.'));
    const second = s.say('stake them anyway', intent.unsupported('Staking is not supported.'));
    expect(second!.learning?.signals).toEqual(['REPEATED_FAILURE']);
  });
});

describe('BUILD-CHAT-LEARNING-001 regression: an empty learning context changes nothing', () => {
  const strip = (reply: CopilotReply | null) => reply && Object.fromEntries(Object.entries(reply).filter(([key]) => key !== 'learning'));
  it('every eval-corpus turn gives the same reply with learning enabled but nothing learned', () => {
    let compared = 0;
    for (const c of COPILOT_EVAL_CASES) {
      const plain = new CopilotSession(c.setup ?? [], c.wallet === undefined ? undefined : c.wallet);
      const learned = new CopilotSession(c.setup ?? [], c.wallet === undefined ? undefined : c.wallet);
      learned.learning = learning('ANONYMOUS');
      for (const s of [plain, learned]) { if (c.facts) s.facts = c.facts; if (c.verified) s.verified = c.verified; }
      for (const turn of c.turns) {
        for (const s of [plain, learned]) { turn.before?.(s); }
        const a = plain.say(turn.user, turn.model, turn.race), b = learned.say(turn.user, turn.model, turn.race);
        expect(strip(b), `${c.id} “${turn.user}”`).toEqual(strip(a));
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(250);
  });
});
