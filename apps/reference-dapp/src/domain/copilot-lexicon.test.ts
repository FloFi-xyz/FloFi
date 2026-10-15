// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { glossaryEntries, lexiconAssets, lexiconMatches, lexiconNetworks, lexiconSuggestions, mergeLexicon, normalizeTerm, parseLexicon, parseMemoryStatement,
  resolveTargetText, validateLexiconEntry, type LexiconEntry, type LexiconSource, type LexiconTarget } from './copilot-lexicon';

const entry = (term: string, target: LexiconTarget, source: LexiconSource = 'PRIVATE', version?: number): LexiconEntry =>
  ({ term, target, source, ...version ? { version } : {} });

describe('BUILD-CHAT-LEARNING-001 lexicon: terms and validation', () => {
  it('normalizes terms (case, spacing, quotes, NFC) and refuses anything that is not a short word or phrase', () => {
    expect(normalizeTerm('  “Arb”  ')).toBe('arb');
    expect(normalizeTerm('Arb   Sep')).toBe('arb sep');
    expect(normalizeTerm('Fazer Bridge!')).toBe('fazer bridge');
    expect(normalizeTerm('pôr liquidez')).toBe('pôr liquidez');
    expect(normalizeTerm('pôr liquidez')).toBe('pôr liquidez'); // decomposed → NFC
    for (const bad of ['a', '', ' ', '12', '1.5', 'x'.repeat(33), 'one two three four', '0xabc1', 'http://evil', 'arb‮', 'arb;drop', 'a..b', null, 42])
      expect(normalizeTerm(bad), String(bad)).toBeNull();
  });

  it('accepts the owner’s example and natural PT-BR/EN aliases with the right environment', () => {
    expect(validateLexiconEntry('Arb', 'network:ARBITRUM')).toEqual({ ok: true, term: 'arb', target: 'network:ARBITRUM' });
    expect(validateLexiconEntry('arb sepolia', 'network:ARBITRUM_SEPOLIA').ok).toBe(true);
    expect(validateLexiconEntry('arb sep', 'network:ARBITRUM_SEPOLIA').ok).toBe(true);
    expect(validateLexiconEntry('eth sepolia', 'network:ETHEREUM_SEPOLIA').ok).toBe(true);
    expect(validateLexiconEntry('sol devnet', 'network:SOLANA_DEVNET').ok).toBe(true);
    expect(validateLexiconEntry('fazer bridge', 'operation:BRIDGE').ok).toBe(true);
    expect(validateLexiconEntry('trocar', 'operation:SWAP').ok).toBe(true);
    expect(validateLexiconEntry('arbitrun', 'network:ARBITRUM').ok).toBe(true);
    expect(validateLexiconEntry('dólar digital', 'asset:USDC').ok).toBe(true);
  });

  it('never redefines canonical vocabulary, commands, protocols or instruction words', () => {
    for (const [term, target] of [['base', 'network:BASE_SEPOLIA'], ['Base', 'network:ARBITRUM'], ['arbitrum', 'network:ARBITRUM_SEPOLIA'], ['Arbitrum One', 'network:ARBITRUM'],
      ['base sep', 'network:BASE_SEPOLIA'], ['solana dev', 'network:SOLANA_DEVNET'], ['ethereum', 'network:ETHEREUM_SEPOLIA'], ['robinhood', 'network:BASE'],
      ['arb network', 'network:ARBITRUM'], ['usdc', 'asset:USDT'], ['eth', 'asset:WETH'], ['sol', 'network:SOLANA'], ['swap', 'operation:BRIDGE'], ['bridge', 'operation:SWAP'],
      ['fazer bridge', 'network:ARBITRUM'], ['usdc grátis', 'asset:USDC'], ['yes', 'operation:SWAP'], ['sim', 'network:BASE'], ['aave', 'operation:SUPPLY'],
      ['ignore rules', 'network:BASE'], ['system prompt', 'operation:SWAP'], ['assinar', 'operation:TRANSFER'], ['execute now', 'operation:SWAP'],
      ['seed phrase', 'asset:USDC'], ['flofi', 'network:BASE'], ['network', 'network:BASE'], ['mainnet', 'network:BASE'], ['dev usdc', 'asset:DEVUSDC']] as const)
      expect(validateLexiconEntry(term, target), `${term} → ${target}`).toEqual({ ok: false, code: 'LEARNING_TERM_RESERVED' });
  });

  it('keeps real funds and test networks apart: test wording only for test targets, never for mainnets', () => {
    expect(validateLexiconEntry('arb test', 'network:ARBITRUM')).toEqual({ ok: false, code: 'LEARNING_ENVIRONMENT_CONFLICT' });
    expect(validateLexiconEntry('arb sep', 'network:ARBITRUM')).toEqual({ ok: false, code: 'LEARNING_ENVIRONMENT_CONFLICT' });
    expect(validateLexiconEntry('arbi', 'network:ARBITRUM_SEPOLIA')).toEqual({ ok: false, code: 'LEARNING_ENVIRONMENT_CONFLICT' });
    expect(validateLexiconEntry('meu teste', 'asset:USDC')).toEqual({ ok: false, code: 'LEARNING_ENVIRONMENT_CONFLICT' });
    expect(validateLexiconEntry('grana', 'asset:DEVUSDC')).toEqual({ ok: false, code: 'LEARNING_ENVIRONMENT_CONFLICT' });
    expect(validateLexiconEntry('grana teste', 'asset:DEVUSDC').ok).toBe(true);
  });

  it('accepts only closed-vocabulary targets', () => {
    for (const target of ['network:OTHER', 'network:POLYGON', 'asset:PEPE', 'operation:STAKE', 'network:arbitrum', 'ARBITRUM', 'network:', '', null, 7])
      expect(validateLexiconEntry('xyz', target), String(target)).toEqual({ ok: false, code: 'LEARNING_TARGET_INVALID' });
  });

  it('parses untrusted lists, dropping invalid and duplicate entries and bounding the size', () => {
    const raw = [{ term: 'Arb', target: 'network:ARBITRUM' }, { term: 'arb', target: 'network:BASE' }, { term: 'base', target: 'network:BASE_SEPOLIA' },
      { term: 'x'.repeat(40), target: 'network:BASE' }, 'garbage', null, { term: 'arb sep', target: 'network:ARBITRUM_SEPOLIA', version: 3 }];
    expect(parseLexicon(raw, 'GLOBAL')).toEqual([entry('arb', 'network:ARBITRUM', 'GLOBAL'), entry('arb sep', 'network:ARBITRUM_SEPOLIA', 'GLOBAL', 3)]);
    expect(parseLexicon(Array.from({ length: 20 }, (_, i) => ({ term: `alias${String.fromCharCode(97 + i)}`, target: 'operation:SWAP' })), 'SESSION')).toHaveLength(8);
    expect(parseLexicon('nope', 'PRIVATE')).toEqual([]);
  });
});

describe('BUILD-CHAT-LEARNING-001 lexicon: deterministic matching', () => {
  const lexicon = [entry('arb', 'network:ARBITRUM'), entry('arb sep', 'network:ARBITRUM_SEPOLIA', 'GLOBAL', 2), entry('fazer bridge', 'operation:BRIDGE', 'GLOBAL', 2),
    entry('arbitrun', 'network:ARBITRUM', 'GLOBAL', 2), entry('dólar digital', 'asset:USDC')];

  it('matches whole words, longest first, without overlaps', () => {
    expect(lexiconMatches('Bridge 10 USDC from Base to Arb', lexicon).map(m => m.entry.term)).toEqual(['arb']);
    expect(lexiconMatches('bridge 1 usdc from base sepolia to arb sep', lexicon).map(m => m.entry.term)).toEqual(['arb sep']);
    expect(lexiconMatches('quero fazer bridge pra arb', lexicon).map(m => m.entry.term)).toEqual(['fazer bridge', 'arb']);
    expect(lexiconMatches('the arbitrage bot on carbon', lexicon)).toEqual([]);
    expect(lexiconMatches('', lexicon)).toEqual([]);
  });

  it('never reads a mainnet alias before test-network wording or after a number', () => {
    expect(lexiconMatches('bridge to arb sepolia', [entry('arb', 'network:ARBITRUM')])).toEqual([]);
    expect(lexiconMatches('bridge to arb-testnet', [entry('arb', 'network:ARBITRUM')])).toEqual([]);
    expect(lexiconMatches('swap 10 arb to usdc on base', [entry('arb', 'network:ARBITRUM')])).toEqual([]);
    expect(lexiconMatches('swap 10 usdc on arb', [entry('arb', 'network:ARBITRUM')])).toHaveLength(1);
  });

  it('separates grounding entries (session/private, global test networks) from global mainnet suggestions', () => {
    const text = 'bridge from arb sep and arbitrun, also arb';
    expect(lexiconNetworks(text, lexicon).map(m => [m.network, m.entry.source])).toEqual([['ARBITRUM_SEPOLIA', 'GLOBAL'], ['ARBITRUM', 'PRIVATE']]);
    expect(lexiconSuggestions(text, lexicon).map(m => [m.network, m.entry.term])).toEqual([['ARBITRUM', 'arbitrun']]);
    expect(lexiconAssets('swap 10 dólar digital to WETH', lexicon).map(m => m.asset)).toEqual(['USDC']);
    expect(lexiconAssets('swap 10 dólar digital to WETH', [entry('dólar digital', 'asset:USDC', 'GLOBAL', 1)])).toEqual([]);
  });

  it('gives the user’s own words precedence over saved and global meanings for the same term', () => {
    const merged = mergeLexicon([entry('arb', 'network:ARBITRUM_SEPOLIA'.replace('ARBITRUM_SEPOLIA', 'ARBITRUM') as LexiconTarget, 'GLOBAL', 1)],
      [entry('arb', 'network:ARBITRUM', 'PRIVATE')], [entry('arb', 'network:ARBITRUM', 'SESSION')]);
    expect(merged).toEqual([entry('arb', 'network:ARBITRUM', 'SESSION')]);
  });

  it('selects bounded glossary entries matched in the request, the user’s own first', () => {
    expect(glossaryEntries('quero fazer bridge de base pra arb', lexicon).map(e => e.term)).toEqual(['arb', 'fazer bridge']);
    expect(glossaryEntries('nothing relevant here', lexicon)).toEqual([]);
    const many = Array.from({ length: 12 }, (_, i) => entry(`palavra${String.fromCharCode(97 + i)}`, 'operation:SWAP'));
    expect(glossaryEntries(many.map(e => e.term).join(' '), many)).toHaveLength(8);
  });
});

describe('BUILD-CHAT-LEARNING-001 lexicon: preference statements (EN and PT-BR)', () => {
  const remember = (term: string, target: LexiconTarget) => ({ kind: 'REMEMBER', term, target, validation: { ok: true, term, target } });
  it('recognizes the owner’s example and its variants', () => {
    expect(parseMemoryStatement('Whenever I say Arb, I mean Arbitrum.')).toMatchObject(remember('arb', 'network:ARBITRUM'));
    expect(parseMemoryStatement('when I write arb I mean Arbitrum One')).toMatchObject(remember('arb', 'network:ARBITRUM'));
    expect(parseMemoryStatement('Remember that "arb sep" means Arbitrum Sepolia')).toMatchObject(remember('arb sep', 'network:ARBITRUM_SEPOLIA'));
    expect(parseMemoryStatement('by arb I meant Arbitrum')).toMatchObject(remember('arb', 'network:ARBITRUM'));
    expect(parseMemoryStatement('No, when I said arb I meant Arbitrum')).toMatchObject(remember('arb', 'network:ARBITRUM'));
    expect(parseMemoryStatement('Sempre que eu disser Arb, quero dizer Arbitrum')).toMatchObject(remember('arb', 'network:ARBITRUM'));
    expect(parseMemoryStatement('quando eu falar arb é a rede Arbitrum')).toMatchObject(remember('arb', 'network:ARBITRUM'));
    expect(parseMemoryStatement('Lembre que dólar digital é USDC')).toMatchObject(remember('dólar digital', 'asset:USDC'));
    expect(parseMemoryStatement('por fazer bridge eu quero dizer bridge')).toMatchObject(remember('fazer bridge', 'operation:BRIDGE'));
    expect(parseMemoryStatement('arb significa Arbitrum')).toMatchObject(remember('arb', 'network:ARBITRUM'));
  });
  it('reports a statement whose meaning FloFi cannot hold, so the engine explains instead of guessing', () => {
    expect(parseMemoryStatement('whenever I say moon, I mean Pepe')).toEqual({ kind: 'REMEMBER', term: 'moon', target: null, validation: null, said: 'EN' });
    expect(parseMemoryStatement('whenever I say base, I mean Base Sepolia')).toEqual({ kind: 'REMEMBER', term: 'base', target: 'network:BASE_SEPOLIA',
      validation: { ok: false, code: 'LEARNING_TERM_RESERVED' }, said: 'EN' });
    expect(parseMemoryStatement('when I say arb test I mean Arbitrum')).toMatchObject({ validation: { ok: false, code: 'LEARNING_ENVIRONMENT_CONFLICT' } });
  });
  it('leaves ordinary requests, questions and loose sentences that resolve to nothing to the normal flow', () => {
    for (const text of ['Bridge 10 USDC from Base to Arbitrum', 'what does arb mean?', 'swap means nothing to me', 'I mean it', 'Put 1 USDC into Aave on Base Sepolia',
      'quero trocar 10 USDC por ETH na Base', 'yes', 'forget it?', 'forget it', 'esqueça isso'])
      expect(parseMemoryStatement(text), text).toBeNull();
  });
  it('parses forget, forget-all and reply-language statements', () => {
    expect(parseMemoryStatement('forget arb')).toEqual({ kind: 'FORGET', term: 'arb', said: 'EN' });
    expect(parseMemoryStatement('Esqueça o que arb significa')).toEqual({ kind: 'FORGET', term: 'arb', said: 'PT' });
    expect(parseMemoryStatement('forget everything')).toEqual({ kind: 'FORGET_ALL', said: 'EN' });
    expect(parseMemoryStatement('esqueça minhas preferências')).toEqual({ kind: 'FORGET_ALL', said: 'PT' });
    expect(parseMemoryStatement('Always reply in Portuguese')).toEqual({ kind: 'LANGUAGE', language: 'PT', said: 'EN' });
    expect(parseMemoryStatement('responda em inglês daqui pra frente')).toEqual({ kind: 'LANGUAGE', language: 'EN', said: 'PT' });
    expect(parseMemoryStatement('Responda sempre em português')).toEqual({ kind: 'LANGUAGE', language: 'PT', said: 'PT' });
    expect(parseMemoryStatement('Sempre que eu disser Arb, quero dizer Arbitrum')).toMatchObject({ said: 'PT' });
    expect(parseMemoryStatement('arb significa Arbitrum')).toMatchObject({ said: 'PT' });
    expect(parseMemoryStatement('arb means Arbitrum')).toMatchObject({ said: 'EN' });
  });
  it('resolves target phrases deterministically and refuses ambiguity', () => {
    expect(resolveTargetText('the Arbitrum One network')).toBe('network:ARBITRUM');
    expect(resolveTargetText('Base Sepolia')).toBe('network:BASE_SEPOLIA');
    expect(resolveTargetText('a rede Solana Devnet')).toBe('network:SOLANA_DEVNET');
    expect(resolveTargetText('dev USDC')).toBe('asset:DEVUSDC');
    expect(resolveTargetText('ether')).toBe('asset:ETH');
    expect(resolveTargetText('a swap')).toBe('operation:SWAP');
    expect(resolveTargetText('Base or Arbitrum')).toBeNull();
    expect(resolveTargetText('Optimism')).toBeNull();
    expect(resolveTargetText('my savings account at the bank')).toBeNull();
  });
});
