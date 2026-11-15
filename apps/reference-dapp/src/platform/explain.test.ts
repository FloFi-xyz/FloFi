// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The shared explanations (`explain.ts`) and the concept catalog's step reverse (`conceptsForSteps`): FloFi's own copy, read from the composed
 * workflow only. No network, no model, no live value.
 */
import { describe, expect, it } from 'vitest';
import { answerConcept, CONCEPT_IDS, conceptInWorkflow, conceptsForSteps } from '../domain/intelligence/concepts';
import { STRATEGY_EXAMPLES } from '../engine/strategy-examples';
import { explainConcept, explainWorkflow, LIVE_VALUES_NOTE } from './explain.ts';
import { PlatformRefusal } from './refusal.ts';
import { composeWorkflowOrRefuse } from './strategy.ts';

const BENEFICIARY = '0x0000000000000000000000000000000000000001';
const compose = (strategy: unknown) => composeWorkflowOrRefuse(strategy, undefined, 'ENGINEERING');
const refusal = (run: () => unknown) => { try { run(); } catch (error) { if (error instanceof PlatformRefusal) return { code: error.message, extra: error.extra }; throw error; } return null; };
const example = (id: string) => STRATEGY_EXAMPLES.find(e => e.id === id)!.strategy;

describe('conceptsForSteps: the reverse of each concept\'s steps', () => {
  it('agrees with conceptInWorkflow for every concept and every example step (one source of truth: the catalog\'s own `steps`)', () => {
    const steps = STRATEGY_EXAMPLES.flatMap(e => compose(e.strategy).steps.flatMap(c => c.steps));
    expect(new Set(steps.map(s => s.detail.type)).size).toBeGreaterThanOrEqual(8);
    for (const step of steps) for (const id of CONCEPT_IDS) {
      const applies = !conceptInWorkflow(id, [step], 'EN', () => 'x').text.startsWith('Your current workflow has no step');
      expect(conceptsForSteps([step]).includes(id), `${step.detail.type} ${id}`).toBe(applies);
    }
    expect(conceptsForSteps([])).toEqual([]);
  });
  it('names lending risk for a borrow, slippage for a swap, impermanent loss for liquidity — in catalog order, without duplicates', () => {
    const borrow = conceptsForSteps(compose(example('borrow-base')).steps[0]!.steps);
    expect(borrow).toEqual(expect.arrayContaining(['COLLATERAL', 'HEALTH_FACTOR', 'LIQUIDATION', 'LTV', 'TOKEN_APPROVAL']));
    expect(borrow).not.toContain('SLIPPAGE');
    expect(conceptsForSteps(compose(example('swap-base')).steps[0]!.steps)).toEqual(expect.arrayContaining(['SLIPPAGE', 'TOKEN_APPROVAL']));
    expect(conceptsForSteps(compose(example('add-liquidity-base')).steps[0]!.steps)).toEqual(expect.arrayContaining(['IMPERMANENT_LOSS', 'CONCENTRATED_LIQUIDITY']));
    const both = conceptsForSteps([...compose(example('swap-base')).steps[0]!.steps, ...compose(example('swap-arbitrum')).steps[0]!.steps]);
    expect(both).toEqual([...new Set(both)]);
    expect(both).toEqual(CONCEPT_IDS.filter(id => both.includes(id)));
  });
});

describe('explainConcept', () => {
  it('equals the shared catalog answer, by id or by a term in the user\'s words, and states that it is not live data', () => {
    const byId = explainConcept({ concept: 'HEALTH_FACTOR', level: 'SIMPLE', language: 'PT' }), shared = answerConcept('HEALTH_FACTOR', { level: 'SIMPLE', language: 'PT' });
    expect(byId).toMatchObject({ id: 'HEALTH_FACTOR', resolvedFrom: 'CONCEPT', text: shared.text, notes: shared.notes, generalKnowledge: true, liveData: false,
      liveValues: LIVE_VALUES_NOTE.PT });
    expect(explainConcept({ term: 'perda impermanente' })).toMatchObject({ id: 'IMPERMANENT_LOSS', resolvedFrom: 'TERM', language: 'EN',
      text: answerConcept('IMPERMANENT_LOSS', { language: 'EN' }).text });
    // Small typos are tolerated by the shared matcher.
    expect(explainConcept({ term: 'slipage' }).id).toBe('SLIPPAGE');
    expect(explainConcept({ concept: 'COLLATERAL', protocol: 'AAVE' }).text).toBe(answerConcept('COLLATERAL', { protocol: 'AAVE', language: 'EN' }).text);
  });
  it('refuses an unknown term with the catalog ids (never the term), and anything but exactly one of concept / term', () => {
    expect(refusal(() => explainConcept({ term: 'zorblax quux' }))).toEqual({ code: 'CONCEPT_UNKNOWN', extra: { concepts: [...CONCEPT_IDS] } });
    expect(refusal(() => explainConcept({}))).toMatchObject({ code: 'CONCEPT_INPUT_INVALID' });
    expect(refusal(() => explainConcept({ concept: 'SLIPPAGE', term: 'slippage' }))).toMatchObject({ code: 'CONCEPT_INPUT_INVALID' });
  });
});

describe('explainWorkflow', () => {
  it('a borrow: collateral, health factor and liquidation first, each located in the workflow; no live value; the deterministic review', () => {
    const w = compose(example('borrow-base')), explained = explainWorkflow(w, 'EN');
    expect(explained).toMatchObject({ workflowHash: w.workflowHash, fundsClass: 'REAL_FUNDS', stepCount: 1, generalKnowledge: true, liveData: false });
    expect(explained.liveValues).toMatch(/No live health factor, LTV, price or APY is given here/);
    expect(explained.steps).toEqual([expect.objectContaining({ index: 1, workflowStep: 0, action: 'borrow', kind: 'BORROW',
      keyConcepts: ['COLLATERAL', 'HEALTH_FACTOR', 'LIQUIDATION', 'LTV'], description: expect.stringMatching(/Borrow/) })]);
    const highlighted = explained.concepts.filter(c => c.highlighted).map(c => c.id);
    expect(highlighted).toEqual(['COLLATERAL', 'LTV', 'HEALTH_FACTOR', 'LIQUIDATION']);
    expect(explained.concepts.slice(0, 4).every(c => c.highlighted)).toBe(true);
    expect(explained.concepts.map(c => c.id)).toEqual(expect.arrayContaining(conceptsForSteps(w.steps[0]!.steps)));
    const health = explained.concepts.find(c => c.id === 'HEALTH_FACTOR')!;
    expect(health.text).toBe(answerConcept('HEALTH_FACTOR', { language: 'EN' }).text);
    expect(health.inWorkflow).toMatch(/^In your workflow, health factor shows up here:\n1\. Borrow/);
    expect(explained.review.steps[0]!.findings.map(f => f.code)).toContain('OWNER_APPROVAL_REQUIRED');
    // FloFi's copy carries illustrative numbers only inside EXAMPLE-level text, which this never uses.
    expect(JSON.stringify(explained)).not.toMatch(/Illustrative example/);
  });
  it('a two-step workflow: each canonical step keeps its workflow step; slippage and approvals for the swap, collateral for the supply', () => {
    const strategy = { version: 2, steps: [example('swap-base'), { action: 'supply', network: 'base', asset: 'USDC', amount: '1', beneficiary: BENEFICIARY }] };
    const explained = explainWorkflow(compose(strategy), 'EN');
    expect(explained.stepCount).toBe(2);
    expect(explained.steps.map(s => [s.workflowStep, s.action, s.keyConcepts])).toEqual([[0, 'swap', ['SLIPPAGE', 'TOKEN_APPROVAL']], [1, 'supply', ['COLLATERAL', 'TOKEN_APPROVAL']]]);
    expect(explained.review.steps).toHaveLength(2);
    expect(explained.concepts.find(c => c.id === 'SLIPPAGE')!.inWorkflow).toMatch(/^In your workflow, slippage shows up here:\n1\. Swap/);
  });
  it('liquidity highlights impermanent loss; a Solana swap has no ERC-20 approval; Portuguese is Portuguese', () => {
    const liquidity = explainWorkflow(compose(example('add-liquidity-base')), 'EN');
    expect(liquidity.steps[0]!.keyConcepts).toEqual(['IMPERMANENT_LOSS', 'CONCENTRATED_LIQUIDITY', 'TOKEN_APPROVAL']);
    expect(liquidity.concepts.find(c => c.id === 'IMPERMANENT_LOSS')!.highlighted).toBe(true);
    expect(explainWorkflow(compose(example('swap-solana')), 'EN').steps[0]!.keyConcepts).toEqual(['SLIPPAGE']);
    const pt = explainWorkflow(compose(example('borrow-base')), 'PT');
    expect(pt.liveValues).toMatch(/Nenhum health factor, LTV, preço ou APY ao vivo/);
    expect(pt.concepts.find(c => c.id === 'LIQUIDATION')!.text).toBe(answerConcept('LIQUIDATION', { language: 'PT' }).text);
  });
});
