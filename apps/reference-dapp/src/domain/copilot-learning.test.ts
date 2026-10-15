// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { COPILOT_EVAL_CASES } from './copilot-eval.corpus';
import type { CopilotLearning, CopilotReply } from './copilot-conversation';
import type { LexiconEntry, LexiconTarget } from './copilot-lexicon';
import { act, CopilotSession, intent } from './copilot-session.test-harness';
import { parseLocalCommand } from './commands';
import { initialEditor } from './editor';
import { BASE_CONTEXT, TEST_WALLET } from './copilot-test-fixtures';
import { learningCopy } from './copilot-learning-copy';

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
  it('User A states “arb” = Arbitrum One (no offer, no click); it grounds A’s later request with a visible note', () => {
    // BUILD-CHAT-LEARNING-002: with persistent automatic learning permitted for A, the statement is answered in one sentence and observed.
    const a = session(learning('AVAILABLE', { automatic: 'ON' }));
    const stated = a.say('Whenever I say Arb, I mean Arbitrum.');
    expect(stated).toMatchObject({ kind: 'ANSWER', text: 'Got it — from now on I\'ll read “arb” as Arbitrum One (real funds).', options: [] });
    expect(stated!.memory).toBeUndefined();
    expect(stated!.learning?.observations).toEqual([{ kind: 'STATED', term: 'arb', target: 'network:ARBITRUM', via: 'CHAT' }]);
    expect(a.turns.at(-1)!.request).toBeNull(); // never sent to the model

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

  it('anonymous: the meaning applies to this conversation only, and FloFi invites nothing (no sign-in, no teaching prompt)', () => {
    const s = session(learning('ANONYMOUS'));
    const reply = s.say('Whenever I say Arb, I mean Arbitrum');
    expect(reply).toMatchObject({ kind: 'ANSWER', text: 'Got it — in this conversation I\'ll read “arb” as Arbitrum One (real funds).' });
    expect(reply!.memory).toBeUndefined();
    expect(reply!.learning?.observations).toEqual([]);
    const used = s.say('Bridge 10 USDC from Base to Arb', BASE_TO_ARB);
    expect(used).toMatchObject({ kind: 'PROPOSAL' });
    expect(used!.notes).toContain('“arb” read as Arbitrum One — as you said in this conversation.');
    // A new conversation (a fresh state) forgets it.
    expect(session(learning('ANONYMOUS')).say('Bridge 10 USDC from Base to Arb', BASE_TO_ARB)!.kind).toBe('CLARIFICATION');
  });

  it('without persistent automatic learning (paused, not permitted) a statement is never observed; nothing offers to save it', () => {
    for (const context of [learning('PAUSED'), learning('AVAILABLE', { automatic: 'OFF' }), learning('AVAILABLE')]) {
      const reply = session(context).say('Whenever I say Arb, I mean Arbitrum');
      expect(reply).toMatchObject({ kind: 'ANSWER', text: 'Got it — in this conversation I\'ll read “arb” as Arbitrum One (real funds).', options: [] });
      expect(reply!.learning?.observations).toEqual([]);
      expect(reply!.memory).toBeUndefined();
    }
  });

  it('“Remember” is no longer a button: after a statement it is ordinary text for the interpreter', () => {
    const s = session(learning('AVAILABLE', { automatic: 'ON' }));
    s.say('Whenever I say Arb, I mean Arbitrum');
    expect(s.say('Remember', intent.unsupported('Not a request.'))!.memory).toBeUndefined();
    expect(s.turns.at(-1)!.request).not.toBeNull();
    const reply = s.say('Bridge 10 USDC from Base to Arb', BASE_TO_ARB);
    expect(reply!.kind).toBe('PROPOSAL');
  });

  it('forget, forget everything (confirmed) and reply language are typed memory actions', () => {
    const s = session(learning('AVAILABLE', { private: [saved('arb', 'network:ARBITRUM')] }));
    expect(s.say('forget arb')).toMatchObject({ kind: 'MEMORY', memory: { op: 'FORGET', term: 'arb' } });
    const all = s.say('forget everything');
    expect(all).toMatchObject({ kind: 'MEMORY', options: ['Delete all', 'Keep'] });
    expect(all!.memory).toBeUndefined();
    expect(s.say('Delete all')).toMatchObject({ kind: 'MEMORY', memory: { op: 'FORGET_ALL' } });
    // A reply language applies at once; it is observed (stated) only where persistent automatic learning is permitted.
    expect(s.say('Responda sempre em português')).toMatchObject({ kind: 'ANSWER', text: 'A partir de agora, respondo em português.', options: [] });
    const observed = session(learning('AVAILABLE', { automatic: 'ON' })).say('Responda sempre em português');
    expect(observed!.learning?.observations).toEqual([{ kind: 'LANGUAGE', language: 'PT', stated: true }]);
  });

  it('a saved reply language is used for FloFi’s own words, even for an English message', () => {
    const s = session(learning('AVAILABLE', { language: 'PT' }));
    const reply = s.say('Put 10 USDC into Aave on Base Sepolia', intent.action(act.lending('SUPPLY', { asset: 'USDC', amount: '10', network: 'BASE_SEPOLIA' })));
    expect(reply!.kind).toBe('PROPOSAL');
    expect(reply!.text).toMatch(/Entendi|Interpretei|proposta/i);
  });

  it('a new statement for a word saved differently applies at once and is observed (the store keeps the latest statement)', () => {
    const s = session(learning('AVAILABLE', { automatic: 'ON', private: [saved('grana', 'asset:USDT')] }));
    const reply = s.say('Lembre que grana é USDC');
    expect(reply).toMatchObject({ kind: 'ANSWER', text: 'Entendi — a partir de agora, vou entender “grana” como USDC.' });
    expect(reply!.learning?.observations).toEqual([{ kind: 'STATED', term: 'grana', target: 'asset:USDC', via: 'CHAT' }]);
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

describe('BUILD-CHAT-LEARNING-002 invisible learning in the conversation', () => {
  const SOL_DEV = (amount: string) => intent.action(act.swap({ network: 'SOLANA_DEVNET', inputAsset: 'SOL', outputAsset: 'DEVUSDC', amount }));
  const ETH_SEP = (amount: string) => intent.action(act.swap({ network: 'ETHEREUM_SEPOLIA', inputAsset: 'WETH', outputAsset: 'USDC', amount }));
  const events = (reply: CopilotReply | null) => reply?.learning?.events ?? [];

  it('an answer to FloFi’s question adapts the word for the rest of the conversation (test network: it then grounds, with a note)', () => {
    const s = session(learning('AVAILABLE', { automatic: 'ON' }));
    expect(s.say('Swap 0.1 SOL to devUSDC on sol dev', SOL_DEV('0.1'))).toMatchObject({ kind: 'CLARIFICATION', options: expect.arrayContaining(['Solana Devnet']) });
    const answered = s.say('Solana Devnet');
    expect(answered).toMatchObject({ kind: 'PROPOSAL', sentence: 'swap 0.1 SOL to devUSDC on Solana Devnet slippage 50 bps' });
    expect(answered!.learning?.observations).toEqual([{ kind: 'CLARIFIED', term: 'sol dev', target: 'network:SOLANA_DEVNET', via: 'CHAT' }]);
    expect(events(answered)).toContainEqual({ kind: 'ADAPTATION', outcome: 'CLARIFIED_NETWORK' });
    s.dismiss();
    const next = s.say('Troca 0,2 SOL por devUSDC na sol dev', SOL_DEV('0.2'));
    expect(next).toMatchObject({ kind: 'PROPOSAL', sentence: 'swap 0.2 SOL to devUSDC on Solana Devnet slippage 50 bps' });
    expect(next!.notes).toContain('“sol dev” read as Solana Devnet — as you chose earlier in this conversation.');
    expect(events(next)).toContainEqual({ kind: 'INFERRED_USED', outcome: 'ADAPTED' });
    // A new conversation starts without it: in-session adaptation is never stored.
    expect(session(learning('AVAILABLE', { automatic: 'ON' })).say('Swap 0.2 SOL to devUSDC on sol dev', SOL_DEV('0.2'))!.kind).toBe('CLARIFICATION');
  });

  it('a real-funds answer is only offered first next time, never proposed from the inference', () => {
    const s = session(learning('ANONYMOUS'));
    s.say('Bridge de 10 USDC da Base pra arb', BASE_TO_ARB);
    expect(s.say('Arbitrum One')).toMatchObject({ kind: 'PROPOSAL' });
    s.dismiss();
    const again = s.say('Bridge 5 USDC from Base to arb', intent.action(act.bridge({ sourceNetwork: 'BASE', destinationNetwork: 'ARBITRUM', asset: 'USDC', amount: '5' })));
    expect(again).toMatchObject({ kind: 'CLARIFICATION', options: ['Arbitrum One'] });
    expect(again!.notes).toEqual(['You used “arb” for Arbitrum One before. It uses real funds, so it is first below — choose it only if that is what you mean.']);
  });

  it('a correction of a reading FloFi made on its own withdraws it; the word is asked about again', () => {
    const s = session(learning('AVAILABLE', { automatic: 'ON', learned: [{ term: 'eth sep', target: 'network:ETHEREUM_SEPOLIA', source: 'LEARNED' }] }));
    const read = s.say('Swap 0.002 WETH to USDC on eth sep', ETH_SEP('0.002'));
    expect(read).toMatchObject({ kind: 'PROPOSAL', sentence: 'swap 0.002 WETH to USDC on Ethereum Sepolia slippage 50 bps' });
    expect(read!.notes).toContain('“eth sep” read as Ethereum Sepolia — learned from your earlier choices.');
    const corrected = s.say('no, I meant Base Sepolia', intent.edit({ network: 'BASE_SEPOLIA' }));
    expect(corrected).toMatchObject({ kind: 'PROPOSAL', sentence: 'swap 0.002 WETH to USDC on Base Sepolia slippage 50 bps' });
    expect(corrected!.learning?.observations).toEqual([{ kind: 'CONTRADICTED', term: 'eth sep', target: 'network:ETHEREUM_SEPOLIA', via: 'CHAT' }]);
    expect(events(corrected)).toEqual(expect.arrayContaining([{ kind: 'ADAPTATION', outcome: 'CORRECTED_NETWORK_CHAT' }, { kind: 'INFERRED_CORRECTED', outcome: 'LEARNED' }]));
    s.dismiss();
    expect(s.say('Swap 0.003 WETH to USDC on eth sep', ETH_SEP('0.003'))!.kind).toBe('CLARIFICATION');
  });

  it('a change of objective is not a correction (PT and EN); nothing is observed', () => {
    for (const [text, language] of [['na verdade, vamos fazer na Base Sepolia', 'PT'], ['actually, let’s use Base Sepolia instead', 'EN']] as const) {
      const s = session(learning('AVAILABLE', { automatic: 'ON', learned: [{ term: 'eth sep', target: 'network:ETHEREUM_SEPOLIA', source: 'LEARNED' }] }));
      s.say('Swap 0.002 WETH to USDC on eth sep', ETH_SEP('0.002'));
      const changed = s.say(text, intent.edit({ network: 'BASE_SEPOLIA' }, {}, language));
      expect(changed!.kind).toBe('PROPOSAL');
      expect(changed!.learning?.observations ?? []).toEqual([]);
      expect(events(changed)).toContainEqual({ kind: 'CORRECTION_IGNORED', outcome: 'OBJECTIVE_CHANGED' });
    }
  });

  it('changing a value the user named, or an amount, is never a correction', () => {
    const s = session(learning('AVAILABLE', { automatic: 'ON' }));
    s.say('Swap 0.002 WETH to USDC on Ethereum Sepolia', ETH_SEP('0.002'));
    expect(events(s.say('no, I meant Base Sepolia', intent.edit({ network: 'BASE_SEPOLIA' })))).toContainEqual({ kind: 'CORRECTION_IGNORED', outcome: 'CANONICAL' });
    const t = session(learning('AVAILABLE', { automatic: 'ON', learned: [{ term: 'eth sep', target: 'network:ETHEREUM_SEPOLIA', source: 'LEARNED' }] }));
    t.say('Swap 0.002 WETH to USDC on eth sep', ETH_SEP('0.002'));
    const mixed = t.say('no, I meant 0.003 on Base Sepolia', intent.edit({ network: 'BASE_SEPOLIA', amount: '0.003' }));
    expect(mixed!.learning?.observations ?? []).toEqual([]);
    expect(events(mixed)).toContainEqual({ kind: 'CORRECTION_IGNORED', outcome: 'FINANCIAL_FIELD' });
  });

  it('applying a proposal FloFi read on its own confirms it; editing exactly that value on the canvas corrects it', () => {
    const s = session(learning('AVAILABLE', { automatic: 'ON', learned: [{ term: 'sol dev', target: 'network:SOLANA_DEVNET', source: 'LEARNED' }] }));
    const proposed = s.say('Swap 0.1 SOL to devUSDC on sol dev', SOL_DEV('0.1'));
    expect(proposed!.kind).toBe('PROPOSAL');
    expect(s.apply()).toMatchObject({ observations: [{ kind: 'CONFIRMED', term: 'sol dev', target: 'network:SOLANA_DEVNET', via: 'CHAT' }],
      events: [{ kind: 'INFERRED_CONFIRMED', outcome: 'LEARNED' }] });
    const node = s.workflow.nodes.find(n => n.actionType !== 'mock-trigger' && !n.actionType.startsWith('mock-'))!;
    // A layout move or any change that leaves the step as it was is nothing.
    expect(s.canvas(workflow => ({ ...workflow }))).toBeNull();
    const edited = s.canvas({ type: 'SET_SOLANA_SWAP', nodeId: node.nodeId, input: { network: 'Solana', from: 'SOL', to: 'USDC', amount: '0.1', slippage: '50' } as never,
      source: 'CANVAS', baseRevision: s.workflow.revision });
    // Network and token changed together: a new objective, not a correction of how FloFi read one word.
    expect(edited).toMatchObject({ observations: [], events: [{ kind: 'CORRECTION_IGNORED', outcome: 'SEVERAL_FIELDS' }] });
  });

  it('a canvas change of exactly the network FloFi inferred corrects it; a named value, several fields or a removed step are not corrections', () => {
    const SUPPLY = intent.action(act.lending('SUPPLY', { network: 'BASE_SEPOLIA', asset: 'USDC', amount: '5' }));
    // Grounding lets FloFi infer only test networks, and the canvas switches a step's network only where the same tokens exist on both (Aave:
    // Base Sepolia ⇄ Base). So the applied step's network reading is marked as inferred here, as the engine marks a word it read on its own.
    const applied = (inferred: boolean) => {
      const s = session(learning('AVAILABLE', { automatic: 'ON' }));
      expect(s.say('Put 5 USDC into Aave on Base Sepolia', SUPPLY)).toMatchObject({ kind: 'PROPOSAL', sentence: 'supply 5 USDC to Aave on Base Sepolia' });
      s.apply();
      if (inferred) s.state = { ...s.state, referents: s.state.referents.map(r => !r.applied ? r : { ...r, readings: r.readings!.map(x => x.field !== 'network' ? x
        : { ...x, via: 'INFERRED' as const, term: 'bsep', source: 'LEARNED' as const }) }) };
      const step = s.state.referents.find(r => r.applied)!.step;
      const edit = (change: Record<string, string>) => s.canvas({ type: 'SET_SUPPLY', nodeId: step.nodeId, input: { ...(step.detail as { input: object }).input, ...change } as never,
        source: 'CANVAS', baseRevision: s.workflow.revision });
      return { s, step, edit };
    };
    const inferred = applied(true);
    expect(inferred.edit({ network: 'Base' })).toMatchObject({ observations: [{ kind: 'CONTRADICTED', term: 'bsep', target: 'network:BASE_SEPOLIA', via: 'CANVAS' }],
      events: expect.arrayContaining([{ kind: 'ADAPTATION', outcome: 'CORRECTED_NETWORK_CANVAS' }, { kind: 'INFERRED_CORRECTED', outcome: 'LEARNED' }]) });
    expect(inferred.s.state.suppressed).toEqual([{ term: 'bsep', target: 'network:BASE_SEPOLIA' }]);
    // A step is evaluated once: a later change of it is not observed again.
    expect(inferred.edit({ network: 'Base Sepolia' })).toBeNull();
    expect(applied(false).edit({ network: 'Base' })).toMatchObject({ observations: [], events: [{ kind: 'CORRECTION_IGNORED', outcome: 'CANONICAL' }] });
    expect(applied(true).edit({ network: 'Base', amount: '7' })).toMatchObject({ observations: [], events: [{ kind: 'CORRECTION_IGNORED', outcome: 'FINANCIAL_FIELD' }] });
    const removed = applied(true);
    expect(removed.s.canvas(workflow => ({ ...workflow, revision: workflow.revision + 1, nodes: workflow.nodes.filter(n => n.nodeId !== removed.step.nodeId) }))?.events)
      .toEqual([{ kind: 'CORRECTION_IGNORED', outcome: 'STEP_REMOVED' }]);
  });

  it('learned meanings never override the current request: a stated meaning in this conversation and the user’s own words win', () => {
    const s = session(learning('AVAILABLE', { automatic: 'ON', learned: [{ term: 'grana', target: 'asset:USDT', source: 'LEARNED' }] }));
    s.say('Lembre que grana é USDC');
    const reply = s.say('Swap 5 grana to WETH on Base Sepolia', intent.action(act.swap({ network: 'BASE_SEPOLIA', inputAsset: 'USDC', outputAsset: 'WETH', amount: '5' })));
    expect(reply!.notes).toContain('“grana” read as USDC — as you said in this conversation.');
    const named = session(learning('AVAILABLE', { learned: [{ term: 'eth sep', target: 'network:ETHEREUM_SEPOLIA', source: 'LEARNED' }] }));
    const own = named.say('Swap 0.001 WETH to USDC on Base Sepolia', intent.action(act.swap({ network: 'BASE_SEPOLIA', inputAsset: 'WETH', outputAsset: 'USDC', amount: '0.001' })));
    expect(own).toMatchObject({ kind: 'PROPOSAL', sentence: 'swap 0.001 WETH to USDC on Base Sepolia slippage 50 bps' });
    expect(own!.notes.join('\n')).not.toContain('learned');
  });

  it('nothing learned ever supplies a value: an amount the user did not write is asked for', () => {
    const s = session(learning('AVAILABLE', { automatic: 'ON', learned: [{ term: 'sol dev', target: 'network:SOLANA_DEVNET', source: 'LEARNED' }] }));
    const reply = s.say('Swap SOL to devUSDC on sol dev', SOL_DEV('0.1'));
    expect(reply!.kind).toBe('CLARIFICATION');
    expect(reply!.command).toBeUndefined();
  });

  it('observations need persistent learning to be permitted; content-free events do not', () => {
    const s = session(learning('AVAILABLE', { automatic: 'OFF' }));
    s.say('Swap 0.1 SOL to devUSDC on sol dev', SOL_DEV('0.1'));
    const answered = s.say('Solana Devnet');
    expect(answered!.learning?.observations).toEqual([]);
    expect(events(answered)).toContainEqual({ kind: 'ADAPTATION', outcome: 'CLARIFIED_NETWORK' });
    // Session-only deployments adapt the same way and have nothing to store.
    const only = session(learning('SESSION'));
    only.say('Swap 0.1 SOL to devUSDC on sol dev', SOL_DEV('0.1'));
    only.say('Solana Devnet');
    only.dismiss();
    expect(only.say('Swap 0.2 SOL to devUSDC on sol dev', SOL_DEV('0.2'))!.kind).toBe('PROPOSAL');
  });

  it('the learned starting language is only a starting point: the user’s own words decide', () => {
    const s = session(learning('AVAILABLE', { languageHint: 'PT' }));
    expect(s.say('my private key is 0x' + 'a'.repeat(64))!.text).toMatch(/chave|nunca|não/i);
    const english = s.say('Put 10 USDC into Aave on Base Sepolia', intent.action(act.lending('SUPPLY', { asset: 'USDC', amount: '10', network: 'BASE_SEPOLIA' })));
    expect(english!.text).toMatch(/^Interpreted as/);
  });
});

describe('BUILD-CHAT-LEARNING-001 the exact grammar never captures a memory button or statement', () => {
  it('every offer label and memory statement reaches the engine (the panel and channels try the exact grammar first)', () => {
    const labels = (['EN', 'PT'] as const).flatMap(language => [...learningCopy(language).forgetAllOptions]);
    for (const text of [...labels, 'Whenever I say Arb, I mean Arbitrum', 'forget arb', 'forget everything', 'esqueça tudo', 'Responda sempre em português', 'memory'])
      expect(() => parseLocalCommand(text, initialEditor().workflow, BASE_CONTEXT, TEST_WALLET), text).toThrow();
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
