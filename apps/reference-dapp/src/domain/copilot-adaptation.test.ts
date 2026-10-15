// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { actionDiff, affinityTerm, clarifiedAdaptation, confirmedAdaptation, correctionAdaptation, correctionCue, fieldsOfAction, hasAffinity, messageLanguage,
  operationTerm, proposalReadings, type ProposalReading, type ReadingFields } from './copilot-adaptation';
import { isLexiconTarget, validateLexiconEntry, type LexiconEntry } from './copilot-lexicon';
import type { CopilotAction } from './copilot-intent';

/**
 * BUILD-CHAT-LEARNING-002: the deterministic signal rules, without the engine. PT-BR first, EN covered: which word a user meant, whether a message
 * corrects FloFi or changes the objective, and which changes are never evidence (values the user named or chose, financial fields).
 */
const swap = (fields: Partial<Record<string, string | null>> = {}): CopilotAction => ({ type: 'SWAP', network: 'ETHEREUM_SEPOLIA', inputAsset: 'WETH', outputAsset: 'USDC',
  amount: '0.001', slippageBps: '50', ...fields } as CopilotAction);
const reading = (field: ProposalReading['field'], target: string, via: ProposalReading['via'], term: string | null = null,
  source: ProposalReading['source'] = null): ProposalReading => ({ field, target: target as ProposalReading['target'], via, term, source });

describe('BUILD-CHAT-LEARNING-002 lexical affinity: which word of the request the user meant', () => {
  it.each([
    ['Bridge 10 USDC from Base to arb', 'network:ARBITRUM', 'arb'],
    ['Faz bridge de 10 USDC da Base pra arb', 'network:ARBITRUM', 'arb'],
    ['Bridge 1 USDC from Base Sepolia to arb sep', 'network:ARBITRUM_SEPOLIA', 'arb sep'],
    ['manda 1 usdc da base sepolia pra arb teste', 'network:ARBITRUM_SEPOLIA', 'arb teste'],
    ['Swap 0.001 WETH to USDC on eth sep', 'network:ETHEREUM_SEPOLIA', 'eth sep'],
    ['Troca 0,1 SOL por devUSDC na sol dev', 'network:SOLANA_DEVNET', 'sol dev'],
    ['Faz bridge de 10 USDC da Base pra solona', 'network:SOLANA', 'solona'],
    ['bridge 10 usdc from base to arbitrun', 'network:ARBITRUM', 'arbitrun'],
  ])('“%s” → %s means “%s”', (text, target, term) => {
    expect(affinityTerm(text, target as never)).toEqual({ ok: true, term });
  });
  it('refuses what cannot be one word for that meaning: real funds with test wording, token words, canonical names, nothing related, two candidates', () => {
    // "arb" alone can never mean a test network; "arb sep" can never mean Arbitrum One.
    expect(affinityTerm('Bridge to arb', 'network:ARBITRUM_SEPOLIA')).toEqual({ ok: false, reason: 'TERM_INVALID' });
    expect(affinityTerm('Bridge to arb sep', 'network:ARBITRUM')).toEqual({ ok: false, reason: 'NO_TERM' });
    expect(affinityTerm('Swap 10 arb to USDC', 'network:ARBITRUM')).toEqual({ ok: false, reason: 'NO_TERM' });
    // A token ("sol") or a canonical network name ("base", "arbitrum") already has its fixed meaning.
    expect(affinityTerm('Swap 1 SOL to USDC', 'network:SOLANA')).toEqual({ ok: false, reason: 'NO_TERM' });
    expect(affinityTerm('Swap SOL to USDC', 'network:SOLANA')).toEqual({ ok: false, reason: 'TERM_INVALID' });
    expect(affinityTerm('swap on base sep', 'network:BASE_SEPOLIA')).toEqual({ ok: false, reason: 'TERM_INVALID' });
    expect(affinityTerm('bridge to arbitrum', 'network:ARBITRUM')).toEqual({ ok: false, reason: 'TERM_INVALID' });
    expect(affinityTerm('bridge to the moon', 'network:ARBITRUM')).toEqual({ ok: false, reason: 'NO_TERM' });
    expect(affinityTerm('from arbi to arbitrun', 'network:ARBITRUM')).toEqual({ ok: false, reason: 'AMBIGUOUS' });
    // Numbers and addresses are never part of a word FloFi learns.
    expect(affinityTerm('send 10 to 0x1111111111111111111111111111111111111111', 'network:ARBITRUM')).toEqual({ ok: false, reason: 'NO_TERM' });
  });
  it('affinity needs the words in order and the first one to match the network family', () => {
    expect(hasAffinity('arb sep', 'network:ARBITRUM_SEPOLIA')).toBe(true);
    expect(hasAffinity('sep arb', 'network:ARBITRUM_SEPOLIA')).toBe(false);
    expect(hasAffinity('eth sepolia', 'network:BASE_SEPOLIA')).toBe(false);
    expect(hasAffinity('ar', 'network:ARBITRUM')).toBe(false);
  });
});

describe('BUILD-CHAT-LEARNING-002 a correction versus a change of objective', () => {
  it.each([
    ['no, I meant arb sepolia', 'CORRECTION'], ['No, actually I meant Base Sepolia', 'CORRECTION'], ['that’s wrong, I said Ethereum Sepolia', 'CORRECTION'],
    ['wrong network', 'CORRECTION'], ['não, eu quis dizer Base Sepolia', 'CORRECTION'], ['não era essa, eu falei arb sep', 'CORRECTION'], ['rede errada', 'CORRECTION'],
    ['não, 3', 'CORRECTION'], ['no', 'CORRECTION'],
    ['actually, let’s use Base Sepolia', 'OBJECTIVE'], ['on second thought make it Ethereum Sepolia', 'OBJECTIVE'], ['switch to Base Sepolia instead', 'OBJECTIVE'],
    ['mudei de ideia, faz na Ethereum Sepolia', 'OBJECTIVE'], ['na verdade, vamos fazer na Base Sepolia', 'OBJECTIVE'], ['prefiro a Ethereum Sepolia', 'OBJECTIVE'],
    ['make it 2', null], ['muda pra Ethereum Sepolia', null], ['Base Sepolia', null],
  ])('“%s” → %s', (text, expected) => expect(correctionCue(text)).toBe(expected));
});

describe('BUILD-CHAT-LEARNING-002 which changes are corrections', () => {
  const before: ReadingFields = fieldsOfAction(swap()), after: ReadingFields = fieldsOfAction(swap({ network: 'BASE_SEPOLIA' }));
  const base = { before, after, changed: ['network' as const], financial: false, request: 'Swap 0.001 WETH to USDC on eth sep' };
  it('only a value FloFi read on its own can be corrected; what the user named or chose is their objective', () => {
    const inferred = [reading('network', 'network:ETHEREUM_SEPOLIA', 'INFERRED', 'eth sep', 'ADAPTED')];
    const corrected = correctionAdaptation({ ...base, readings: inferred, via: 'CHAT', cue: 'CORRECTION' });
    expect(corrected.observations).toEqual([{ kind: 'CONTRADICTED', term: 'eth sep', target: 'network:ETHEREUM_SEPOLIA', via: 'CHAT' }]);
    expect(corrected.suppressed).toEqual([{ term: 'eth sep', target: 'network:ETHEREUM_SEPOLIA' }]);
    expect(corrected.events).toContainEqual({ kind: 'INFERRED_CORRECTED', outcome: 'ADAPTED' });
    // "eth sep" has no affinity with Base Sepolia: nothing is learned for the new value, the withdrawn meaning is enough.
    expect(corrected.adapted).toEqual([]);
    for (const [via, outcome] of [['NAMED', 'CANONICAL'], ['CARRIED', 'CANONICAL'], ['ASKED', 'USER_CHOSEN'], ['STATED', 'USER_CHOSEN']] as const) {
      const result = correctionAdaptation({ ...base, readings: [reading('network', 'network:ETHEREUM_SEPOLIA', via, 'eth sep')], via: 'CHAT', cue: 'CORRECTION' });
      expect(result).toMatchObject({ observations: [], adapted: [], suppressed: [], events: [{ kind: 'CORRECTION_IGNORED', outcome }] });
    }
  });
  it('a change of objective, an unexplained chat change and any financial change are never evidence', () => {
    const inferred = [reading('network', 'network:ETHEREUM_SEPOLIA', 'INFERRED', 'eth sep', 'LEARNED')];
    expect(correctionAdaptation({ ...base, readings: inferred, via: 'CHAT', cue: 'OBJECTIVE' })).toMatchObject({ observations: [],
      events: [{ kind: 'CORRECTION_IGNORED', outcome: 'OBJECTIVE_CHANGED' }] });
    expect(correctionAdaptation({ ...base, readings: inferred, via: 'CHAT', cue: null })).toMatchObject({ observations: [],
      events: [{ kind: 'CORRECTION_IGNORED', outcome: 'AMBIGUOUS' }] });
    for (const via of ['CHAT', 'CANVAS'] as const) expect(correctionAdaptation({ ...base, financial: true, readings: inferred, via, cue: 'CORRECTION' }))
      .toMatchObject({ observations: [], events: [{ kind: 'CORRECTION_IGNORED', outcome: 'FINANCIAL_FIELD' }] });
    // On the canvas there is no message: changing exactly the value FloFi filled in on its own is the correction.
    expect(correctionAdaptation({ ...base, readings: inferred, via: 'CANVAS', cue: null }).observations).toEqual([
      { kind: 'CONTRADICTED', term: 'eth sep', target: 'network:ETHEREUM_SEPOLIA', via: 'CANVAS' }]);
  });
  it('a corrected word is learned for the new value only when it has affinity with it', () => {
    const readings = [reading('network', 'network:ARBITRUM', 'INFERRED', 'arbi', 'GLOBAL')];
    const result = correctionAdaptation({ readings, before: { network: 'network:ARBITRUM' }, after: { network: 'network:ARBITRUM_SEPOLIA' }, changed: ['network'],
      financial: false, via: 'CHAT', cue: 'CORRECTION', request: 'bridge to arbi' });
    // "arbi" cannot mean a test network (no test wording): withdrawn, and nothing learned in its place.
    expect(result.observations.map(o => o.kind)).toEqual(['CONTRADICTED']);
    expect(result.events).toContainEqual({ kind: 'CORRECTION_IGNORED', outcome: 'TERM_INVALID' });
  });
  it('an operation the model chose can be corrected; the one unexplained verb becomes this conversation’s word for it (interpreter hint only)', () => {
    const request = 'passar 10 USDC da Base Sepolia pra Arbitrum Sepolia';
    expect(operationTerm(request, 'operation:BRIDGE', { sourceNetwork: 'network:BASE_SEPOLIA', destinationNetwork: 'network:ARBITRUM_SEPOLIA' }))
      .toEqual({ ok: true, term: 'passar' });
    expect(operationTerm('quero mover e passar 10 USDC', 'operation:BRIDGE', {})).toEqual({ ok: false, reason: 'AMBIGUOUS' });
    expect(operationTerm('bridge 10 USDC', 'operation:BRIDGE', {})).toEqual({ ok: false, reason: 'NO_TERM' });
    const result = correctionAdaptation({ readings: [reading('operation', 'operation:TRANSFER', 'MODEL')], before: { operation: 'operation:TRANSFER' },
      after: { operation: 'operation:BRIDGE' }, changed: ['operation'], financial: false, via: 'CHAT', cue: 'CORRECTION', request });
    expect(result.observations).toEqual([{ kind: 'CORRECTED', term: 'passar', target: 'operation:BRIDGE', via: 'CHAT' }]);
    expect(result.adapted).toEqual([{ term: 'passar', target: 'operation:BRIDGE', source: 'ADAPTED' }]);
  });
});

describe('BUILD-CHAT-LEARNING-002 readings, clarifications and confirmations', () => {
  const lexicon: LexiconEntry[] = [{ term: 'eth sep', target: 'network:ETHEREUM_SEPOLIA', source: 'ADAPTED' }];
  it('records how each field was read: named, asked, inferred, carried or chosen by the interpreter', () => {
    const fields = fieldsOfAction(swap());
    expect(fields).toEqual({ operation: 'operation:SWAP', network: 'network:ETHEREUM_SEPOLIA', inputAsset: 'asset:WETH', outputAsset: 'asset:USDC' });
    expect(proposalReadings(fields, 'Swap 0.001 WETH to USDC on eth sep', '', lexicon, new Set()).find(r => r.field === 'network'))
      .toEqual(reading('network', 'network:ETHEREUM_SEPOLIA', 'INFERRED', 'eth sep', 'ADAPTED'));
    expect(proposalReadings(fields, 'Swap 0.001 WETH to USDC on eth sep', 'Ethereum Sepolia', [], new Set()).find(r => r.field === 'network')?.via).toBe('ASKED');
    expect(proposalReadings(fields, 'Swap 0.001 WETH to USDC on Ethereum Sepolia', '', lexicon, new Set()).find(r => r.field === 'network')?.via).toBe('NAMED');
    expect(proposalReadings(fields, 'same again', '', [], new Set(['network'])).find(r => r.field === 'network')?.via).toBe('CARRIED');
    expect(proposalReadings(fields, 'Swap WETH', '', [], new Set()).find(r => r.field === 'operation')?.via).toBe('NAMED');
  });
  it('an answer to FloFi’s question adapts the word; an applied inferred reading is confirmed', () => {
    const asked = [reading('network', 'network:SOLANA_DEVNET', 'ASKED')];
    expect(clarifiedAdaptation(asked, 'Troca 0,1 SOL por devUSDC na sol dev')).toMatchObject({
      observations: [{ kind: 'CLARIFIED', term: 'sol dev', target: 'network:SOLANA_DEVNET', via: 'CHAT' }],
      adapted: [{ term: 'sol dev', target: 'network:SOLANA_DEVNET', source: 'ADAPTED' }], events: [{ kind: 'ADAPTATION', outcome: 'CLARIFIED_NETWORK' }] });
    expect(clarifiedAdaptation(asked, 'Troca 0,1 SOL por devUSDC').events).toEqual([{ kind: 'CORRECTION_IGNORED', outcome: 'CLARIFIED_NO_TERM' }]);
    expect(confirmedAdaptation([reading('network', 'network:ETHEREUM_SEPOLIA', 'INFERRED', 'eth sep', 'LEARNED'), reading('asset', 'asset:USDC', 'NAMED')]))
      .toMatchObject({ observations: [{ kind: 'CONFIRMED', term: 'eth sep', target: 'network:ETHEREUM_SEPOLIA' }], events: [{ kind: 'INFERRED_CONFIRMED', outcome: 'LEARNED' }] });
  });
  it('every observation is a validated word and one closed-vocabulary value: never an amount, an address or a slippage', () => {
    const texts = ['Swap 0.001 WETH to USDC on eth sep with 1% slippage', 'send 25.5 USDC to 0x2222222222222222222222222222222222222222 on arbitrun',
      'Bridge 1000 USDC from Base to arb at 30 bps', 'Troca 0,1 SOL por devUSDC na sol dev, slippage 2%'];
    for (const text of texts) for (const target of ['network:ARBITRUM', 'network:ETHEREUM_SEPOLIA', 'network:SOLANA_DEVNET', 'asset:USDC'] as const) {
      const found = affinityTerm(text, target);
      if (!found.ok) continue;
      expect(validateLexiconEntry(found.term, target)).toMatchObject({ ok: true });
      expect(found.term).not.toMatch(/\d|0x|%|bps/);
      expect(isLexiconTarget(target)).toBe(true);
    }
  });
});

describe('BUILD-CHAT-LEARNING-002 field changes', () => {
  it('distinguishes an interpretable change from a financial one and from a replaced step', () => {
    expect(actionDiff(swap(), swap({ network: 'BASE_SEPOLIA' }))).toEqual({ changed: ['network'], financial: false, replaced: false });
    expect(actionDiff(swap(), swap({ amount: '2' }))).toEqual({ changed: [], financial: true, replaced: false });
    expect(actionDiff(swap(), swap({ network: 'BASE_SEPOLIA', slippageBps: '100' }))).toEqual({ changed: ['network'], financial: true, replaced: false });
    expect(actionDiff(swap(), swap({ outputAsset: 'TSLA' })).financial).toBe(true);   // a catalog token FloFi cannot name: never a correction
    expect(actionDiff(swap(), { type: 'TRANSFER', network: 'BASE', asset: 'USDC', amount: '1', recipient: null }).replaced).toBe(true);
  });
});

describe('BUILD-CHAT-LEARNING-002 language evidence', () => {
  it.each([
    ['Quero trocar 10 USDC por WETH na Base Sepolia', 'PT'], ['Faz uma bridge de 2 USDC da Base pra Arbitrum', 'PT'],
    ['Swap 10 USDC to WETH on Base Sepolia', 'EN'], ['Please bridge my USDC from Base to Arbitrum', 'EN'],
    ['10 usdc base → arb', null], ['swap 10 USDC para WETH', null], ['ok', null],
  ])('“%s” → %s', (text, expected) => expect(messageLanguage(text)).toBe(expected));
});
