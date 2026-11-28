// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { findStepReference, pickStep, readStepEdit } from './step-reference';
import { buildWorkflow, contextFor, FIXTURE } from './copilot-test-fixtures';
import { workflowSteps } from './workflow-steps';

// BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (A03): FloFi reads step references and amounts itself, before any model.
describe('natural-language step references', () => {
  it('reads an ordinal, a card, a kind and a previous step in Portuguese and English', () => {
    expect(readStepEdit('Altere a segunda etapa para 0,2.')).toEqual({ kind: 'AMOUNT', target: { step: null, ordinal: 'SECOND' }, amount: '0.2', asset: null });
    expect(readStepEdit('Mude o supply para 0,2.')).toEqual({ kind: 'AMOUNT', target: { step: 'SUPPLY', ordinal: null }, amount: '0.2', asset: null });
    expect(readStepEdit('Mude a primeira etapa para 1,5')?.target).toEqual({ step: null, ordinal: 'FIRST' });
    expect(readStepEdit('Altere o último card para 3')?.target).toEqual({ step: null, ordinal: 'LAST' });
    expect(readStepEdit('Mude a bridge para 2 USDC')).toEqual({ kind: 'AMOUNT', target: { step: 'BRIDGE', ordinal: null }, amount: '2', asset: 'usdc' });
    expect(readStepEdit('Altere o depósito para 7')?.target).toEqual({ step: 'SUPPLY', ordinal: null });
    expect(readStepEdit('Altere o pagamento anterior para 5')?.target).toEqual({ step: 'TRANSFER', ordinal: null });
    expect(readStepEdit('Altere a 2ª etapa para 4')?.target).toEqual({ step: null, ordinal: 'SECOND' });
    expect(readStepEdit('Mude a etapa 3 para 4')?.target).toEqual({ step: null, ordinal: 'THIRD' });
    expect(readStepEdit('troca esse supply para 2 USDC')?.target).toEqual({ step: 'SUPPLY', ordinal: null });
    expect(readStepEdit('Change the second step to 0.2')?.target).toEqual({ step: null, ordinal: 'SECOND' });
    expect(readStepEdit('change the last card to 5')?.target).toEqual({ step: null, ordinal: 'LAST' });
    expect(readStepEdit('Set the previous payment to 5 USDC')?.target).toEqual({ step: 'TRANSFER', ordinal: null });
    expect(readStepEdit('change the second swap to 4')?.target).toEqual({ step: 'SWAP', ordinal: 'SECOND' });
    expect(readStepEdit('change the swap amount to 3')?.target).toEqual({ step: 'SWAP', ordinal: null });
    expect(readStepEdit('Change step 2 to 0.5')?.target).toEqual({ step: null, ordinal: 'SECOND' });
    expect(readStepEdit('change it to 3')?.target).toEqual({ step: null, ordinal: null });
  });
  it('keeps every digit of a decimal comma and asks when the amount reads two ways', () => {
    expect(readStepEdit('Altere a segunda etapa para 0,123456789')).toMatchObject({ kind: 'AMOUNT', amount: '0.123456789' });
    expect(readStepEdit('Mude o supply para 0,000001')).toMatchObject({ kind: 'AMOUNT', amount: '0.000001' });
    expect(readStepEdit('Altere a segunda etapa para 1,000')).toMatchObject({ kind: 'AMBIGUOUS_AMOUNT', readings: ['1', '1000'] });
  });
  it('reads nothing that is not exactly one step and one amount (the normal flow handles it)', () => {
    for (const text of ['swap 1 USDC to ETH on Base', 'change the swap to 4 USDC with 1% slippage', 'set the first swap slippage to 1%', 'make it 2',
      'change the destination to Arbitrum Sepolia', 'muda o destino para Arbitrum Sepolia', 'change the USDC maximum to 50', 'troca 1 USDC por ETH na Base',
      'Altere a segunda etapa', 'O que significa supply?', `change the bridge to ${'0x'.padEnd(42, '1')}`, 'change the range to 2500 to 3500 USDC per WETH'])
      expect(readStepEdit(text), text).toBeNull();
  });
  it('finds a reference inside a question and picks it from the canonical steps', () => {
    expect(findStepReference('O que faz a segunda etapa?')).toEqual({ step: null, ordinal: 'SECOND' });
    expect(findStepReference('what does the bridge do?')).toEqual({ step: 'BRIDGE', ordinal: null });
    expect(findStepReference('quanto custa?')).toBeNull();
    const workflow = buildWorkflow([FIXTURE.baseSwap, FIXTURE.supply]), steps = workflowSteps(workflow, contextFor(workflow));
    expect(pickStep({ step: null, ordinal: 'SECOND' }, steps).step?.kind).toBe('SUPPLY');
    expect(pickStep({ step: 'SUPPLY', ordinal: null }, steps).step?.nodeId).toBe(pickStep({ step: null, ordinal: 'SECOND' }, steps).step?.nodeId);
    expect(pickStep({ step: 'BRIDGE', ordinal: null }, steps)).toEqual({ step: null, candidates: [] });
  });
});
