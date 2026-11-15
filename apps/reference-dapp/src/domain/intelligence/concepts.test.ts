// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-FLOFI-UNIFIED-COPILOT-001: the shared DeFi concept catalog (deterministic, FloFi-authored, never live data). */
import { describe, expect, it } from 'vitest';
import { answerConcept, CONCEPT_IDS, conceptCatalog, conceptFollowUp, conceptInWorkflow, conceptNumbers, conceptProtocols, conceptQuestion, matchConcept } from './concepts';
import type { WorkflowStep } from '../workflow-steps';

describe('concept matching', () => {
  it('recognizes every concept from EN and PT words, accents and small typos', () => {
    const cases: [string, string][] = [
      ['O que é colateral?', 'COLLATERAL'], ['what is collateral', 'COLLATERAL'], ['o que é slippage?', 'SLIPPAGE'], ['o que e slipage', 'SLIPPAGE'],
      ['explain impermanent loss', 'IMPERMANENT_LOSS'], ['o que é perda impermanente?', 'IMPERMANENT_LOSS'], ['qual a diferença entre APY e APR?', 'APY_APR'],
      ['o que é health factor', 'HEALTH_FACTOR'], ['o que é o fator de saúde?', 'HEALTH_FACTOR'], ['what is LTV?', 'LTV'], ['como funciona a liquidação?', 'LIQUIDATION'],
      ['o que significa range de preço?', 'CONCENTRATED_LIQUIDITY'], ['what is concentrated liquidity', 'CONCENTRATED_LIQUIDITY'], ['o que é um pool de liquidez?', 'LIQUIDITY_POOL'],
      ['como funciona a Aave?', 'AAVE'], ['o que é a Uniswap?', 'UNISWAP'], ['what is Jupiter?', 'JUPITER'], ['o que é a Orca?', 'ORCA'],
      ['o que é gas?', 'GAS_FEES'], ['como funciona uma bridge?', 'BRIDGE'], ['o que é WETH?', 'WRAPPED_TOKEN'], ['o que é um token approval?', 'TOKEN_APPROVAL'],
      ['como manter minha carteira segura?', 'WALLET_SECURITY'], ['como funciona a autorização delegada?', 'AUTOMATION_DELEGATION'],
      ['o que é empréstimo em DeFi?', 'LENDING_BORROWING'], ['o que é taxa de juros?', 'APY_APR'],
    ];
    for (const [text, id] of cases) expect([text, matchConcept(text)]).toEqual([text, id]);
    expect(matchConcept('olá, tudo bem?')).toBeNull();
    // Short aliases never match by typo: "gás" is gas, but "gasolina" or "aaves" do not become concepts by distance.
    expect(matchConcept('gasolina')).toBeNull();
  });
  it('answers only clean conceptual questions locally, never action requests', () => {
    expect(conceptQuestion('O que é slippage?')).toBe('SLIPPAGE');
    expect(conceptQuestion('me explica o que é colateral')).toBe('COLLATERAL');
    expect(conceptQuestion('como funciona o supply na aave?')).not.toBeNull();
    expect(conceptQuestion('health factor?')).toBe('HEALTH_FACTOR');
    expect(conceptQuestion('o que é uniswap v3?')).toBe('UNISWAP');
    // Requests (amounts, addresses, an action before the question) go to the interpreter.
    expect(conceptQuestion('swap 1 ETH to USDC with 1% slippage')).toBeNull();
    expect(conceptQuestion('faz um swap e me explica o que é slippage')).toBeNull();
    expect(conceptQuestion('quero fornecer liquidez na uniswap')).toBeNull();
    expect(conceptQuestion('slippage de 1%?')).toBeNull();
    expect(conceptQuestion('envia para 0x1111111111111111111111111111111111111111 o que é gas')).toBeNull();
    expect(conceptQuestion('slippage')).toBeNull();
  });
  it('reads follow-ups about the concept just explained', () => {
    expect(conceptFollowUp('Não entendi.')).toEqual({ kind: 'LEVEL', level: 'SIMPLE' });
    expect(conceptFollowUp("I don't understand")).toEqual({ kind: 'LEVEL', level: 'SIMPLE' });
    expect(conceptFollowUp('Me dá um exemplo')).toEqual({ kind: 'LEVEL', level: 'EXAMPLE' });
    expect(conceptFollowUp('mais detalhes')).toEqual({ kind: 'LEVEL', level: 'ADVANCED' });
    expect(conceptFollowUp('E como isso funciona na Aave?')).toEqual({ kind: 'PROTOCOL', protocol: 'AAVE' });
    expect(conceptFollowUp('how about Uniswap?')).toEqual({ kind: 'PROTOCOL', protocol: 'UNISWAP' });
    expect(conceptFollowUp('E no meu workflow?')).toEqual({ kind: 'WORKFLOW' });
    // A request that names a protocol is not a follow-up.
    expect(conceptFollowUp('quero fazer supply na aave')).toBeNull();
    expect(conceptFollowUp('supply 10 USDC on Aave')).toBeNull();
    expect(conceptFollowUp('ok')).toBeNull();
  });
});

describe('concept answers', () => {
  it('has complete EN and PT copy for every concept, with distinct levels', () => {
    for (const id of CONCEPT_IDS) for (const language of ['EN', 'PT'] as const) {
      const levels = (['STANDARD', 'SIMPLE', 'EXAMPLE', 'ADVANCED'] as const).map(level => answerConcept(id, { level, language }).text);
      expect(new Set(levels).size, `${id} ${language}`).toBe(4);
      for (const text of levels) { expect(text.length).toBeGreaterThan(60); expect(text.length).toBeLessThan(700); }
    }
    expect(conceptCatalog('PT')).toHaveLength(CONCEPT_IDS.length);
  });
  it('labels examples as illustrative and every answer as general knowledge, never a live value', () => {
    const example = answerConcept('HEALTH_FACTOR', { level: 'EXAMPLE', language: 'EN' });
    expect(example.text).toMatch(/Illustrative/);
    expect(example.notes).toContain('Illustrative numbers only, not a quote.');
    const standard = answerConcept('APY_APR', { language: 'PT' });
    expect(standard.notes.join(' ')).toMatch(/não dados ao vivo/);
    // Every example number is declared, so the eval's grounded-number invariant can allow exactly those.
    expect(conceptNumbers('SLIPPAGE')).toEqual(expect.arrayContaining(['100', '0.5', '50', '99.5']));
    // FloFi's own policies are stated, and the catalog never claims to watch or protect a position.
    expect(answerConcept('LIQUIDATION', { language: 'EN' }).notes[0]).toMatch(/does not watch or protect open positions/);
    expect(answerConcept('TOKEN_APPROVAL', { language: 'EN' }).notes[0]).toMatch(/never unlimited/);
    expect(answerConcept('AUTOMATION_DELEGATION', { language: 'EN' }).notes[0]).toMatch(/never authorizes spending/);
  });
  it('offers follow-ups that the follow-up reader understands, and protocol notes where they exist', () => {
    const first = answerConcept('COLLATERAL', { language: 'PT' });
    expect(first.options).toEqual(['Explica mais simples', 'Me dá um exemplo', 'Como funciona na Aave?', 'Mais detalhes']);
    for (const option of first.options) expect(conceptFollowUp(option), option).not.toBeNull();
    const aave = answerConcept('COLLATERAL', { language: 'PT', protocol: 'AAVE' });
    expect(aave.text).toMatch(/^Na Aave V3/);
    expect(aave.state).toEqual({ id: 'COLLATERAL', level: 'STANDARD', protocol: 'AAVE' });
    expect(answerConcept('WALLET_SECURITY', { language: 'EN', protocol: 'AAVE' }).text).toMatch(/^I have no Aave-specific note/);
    expect(conceptProtocols('SLIPPAGE')).toEqual(['UNISWAP', 'JUPITER', 'ACROSS']);
  });
  it('explains a concept in the user\'s workflow from canonical steps only', () => {
    const swap = { detail: { type: 'CATALOG_SWAP', network: 'Arbitrum One', from: 'ETH', to: 'USDC', amount: '0.00005', slippage: '50' } } as unknown as WorkflowStep;
    const lending = { detail: { type: 'AAVE', operation: 'SUPPLY', input: {} } } as unknown as WorkflowStep;
    const inWorkflow = conceptInWorkflow('SLIPPAGE', [swap, lending], 'PT', step => step.detail.type === 'CATALOG_SWAP' ? 'Troca 0.00005 ETH por USDC, slippage máximo de 50 bps.' : 'outro');
    expect(inWorkflow.text).toBe('No seu workflow, slippage aparece aqui:\n1. Troca 0.00005 ETH por USDC, slippage máximo de 50 bps.');
    expect(conceptInWorkflow('HEALTH_FACTOR', [swap], 'EN', () => '').text).toMatch(/^Your current workflow has no step where health factor applies/);
    expect(answerConcept('SLIPPAGE', { language: 'EN', workflowSteps: [swap] }).options).toContain('And in my workflow?');
  });
});
