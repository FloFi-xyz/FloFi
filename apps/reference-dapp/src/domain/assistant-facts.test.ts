// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { editorReducer } from './editor';
import { assistantSimulation, platformFeeFacts } from './assistant-facts';
import { answerReadOnly, readOnlyQuestion, type AssistantSimulation } from './assistant-answers';
import type { LifecycleView } from './conversation-lifecycle';
import type { SimulationSource } from './simulation-presentation';
import { buildWorkflow, contextFor, FIXTURE } from './copilot-test-fixtures';
import { workflowSteps } from './workflow-steps';
import { reviewFixture, reviewNow } from '../test-utils/review-fixture';

/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (A04/A05/A08): the assistant's simulation facts are the current revision's own (the same projection the
 * Simulate panel and the chat's Review card show), FloFi's fee comes from the platform fee policy's principal accounting, and every read-only answer
 * states only those facts. Nothing here proposes or changes anything.
 */
const fixture = reviewFixture();
const view = (patch: Partial<LifecycleView> = {}): LifecycleView => ({ workflow: fixture.workflow, context: fixture.context, source: fixture.source, authorization: fixture.authorization,
  wallet: fixture.wallet, progress: null, invalidWorkflow: false, ...patch });
const canonical = (workflow = fixture.workflow) => ({ workflow, context: fixture.context });

describe('the simulation facts are bound to the current revision', () => {
  it('a current simulation carries its quote expiry, expected and minimum outputs and FloFi\'s fee', () => {
    const facts = assistantSimulation(view(), canonical(), reviewNow);
    expect(facts).toMatchObject({ status: 'CURRENT', revision: fixture.workflow.revision, expiresAt: reviewNow + 120_000,
      steps: [{ number: 1, kind: 'SWAP', action: 'Swap', input: '100 USDC', output: '0.025 WETH', minimum: '0.024875 WETH' }],
      missing: ['Network cost'], platformFee: { rate: '0.80%', status: 'FEEABLE', amounts: ['0.8 USDC'], recorded: null } });
  });
  it('a simulation of another revision, an expired one, one running and none carry no figure', () => {
    const edited = editorReducer({ workflow: fixture.workflow, error: null }, { type: 'SET_SWAP_AMOUNT', nodeId: fixture.workflow.nodes.at(-1)!.nodeId, amount: '50', source: 'CANVAS',
      baseRevision: fixture.workflow.revision }, fixture.context).workflow;
    const changed = assistantSimulation(view({ workflow: edited }), canonical(edited), reviewNow);
    expect(changed).toMatchObject({ status: 'CHANGED', steps: [], costs: [], expiresAt: null, revision: edited.revision });
    expect(changed.platformFee.amounts).toEqual(['0.4 USDC']);
    expect(assistantSimulation(view(), canonical(), reviewNow + 121_000)).toMatchObject({ status: 'EXPIRED', steps: [], expiresAt: null });
    const busy = { ...fixture.source, state: { ...fixture.source.state, busy: true } } as SimulationSource;
    expect(assistantSimulation(view({ source: busy }), canonical(), reviewNow)).toMatchObject({ status: 'RUNNING', steps: [] });
    const none = { kind: 'public', state: { busy: false, error: null, retired: false, recoveryOnly: false, available: true, run: null } } as unknown as SimulationSource;
    expect(assistantSimulation(view({ source: none, authorization: { ...fixture.authorization, key: null, manifest: null, policy: null } }), canonical(), reviewNow))
      .toMatchObject({ status: 'NONE', steps: [] });
    const retired = { ...fixture.source, state: { ...fixture.source.state, retired: true } } as SimulationSource;
    expect(assistantSimulation(view({ source: retired }), canonical(), reviewNow)).toMatchObject({ status: 'CHANGED', steps: [] });
  });
});

describe('FloFi\'s fee is the platform fee policy\'s own basis (0.80%, never charged at this time)', () => {
  const fee = (sentences: readonly string[]) => { const workflow = buildWorkflow(sentences); return platformFeeFacts(workflow, contextFor(workflow)); };
  it('charges the principal the owner introduces, once per asset, and nothing on a borrow', () => {
    expect(fee([FIXTURE.mainnetBridge])).toEqual({ rate: '0.80%', status: 'FEEABLE', amounts: ['0.08 USDC'], recorded: null });
    expect(fee([FIXTURE.supply])).toMatchObject({ status: 'FEEABLE', amounts: ['0.04 USDC'] });
    expect(fee([FIXTURE.borrow])).toMatchObject({ status: 'NOT_APPLICABLE', amounts: [] });
    expect(fee([])).toMatchObject({ status: 'NOT_APPLICABLE', amounts: [] });
    expect(fee([FIXTURE.baseSwap, FIXTURE.mainnetBridge]).amounts).toEqual(['0.096 USDC']);
  });
});

describe('read-only questions are told apart from changes', () => {
  it('reads questions about the simulation, costs, output, economics and the workflow in Portuguese and English', () => {
    const kinds: readonly (readonly [string, string])[] = [['A simulação ainda está válida?', 'SIMULATION'], ['Is the simulation still valid?', 'SIMULATION'],
      ['Quando a cotação expira?', 'SIMULATION'], ['Quanto custa?', 'COSTS'], ['Quais são as taxas?', 'COSTS'], ['What are the fees?', 'COSTS'], ['Qual é a taxa da FloFi?', 'COSTS'],
      ['Quanto vou receber?', 'OUTPUT'], ['How much will I get?', 'OUTPUT'], ['Compensa fazer uma bridge de 0,1 USDC?', 'WORTH'], ['Is it worth it?', 'WORTH'],
      ['Vale a pena fazer esse swap?', 'WORTH'], ['Quantas etapas tem o fluxo?', 'WORKFLOW'], ['What are the steps?', 'WORKFLOW'], ['O que faz a segunda etapa?', 'STEP'],
      ['What does the bridge do in my workflow?', 'STEP']];
    for (const [text, kind] of kinds) expect(readOnlyQuestion(text)?.kind, text).toBe(kind);
    expect(readOnlyQuestion('Compensa fazer uma bridge de 0,1 USDC?')).toMatchObject({ target: { step: 'BRIDGE', ordinal: null }, amount: { units: 1n, scale: 1, symbol: 'USDC' } });
  });
  it('never reads a change, an action request or a concept question as one', () => {
    for (const text of ['Altere a segunda etapa para 0,2.', 'Mude o supply para 0,2', 'swap 1 USDC to ETH on Base', 'faça uma bridge de 0,1 USDC para a Arbitrum',
      'Bridge 0.1 USDC from Base to Arbitrum', 'O que significa supply?', 'What is slippage?', 'Review workflow', 'sim'])
      expect(readOnlyQuestion(text), text).toBeNull();
  });
});

describe('read-only answers state only the current revision\'s facts', () => {
  const steps = workflowSteps(fixture.workflow, fixture.context), current = assistantSimulation(view(), canonical(), reviewNow);
  const answer = (text: string, facts: AssistantSimulation, language: 'EN' | 'PT' = 'PT') => answerReadOnly(readOnlyQuestion(text)!, facts, steps, language, reviewNow);
  it('a current simulation: its validity and figures, answer first', () => {
    expect(answer('A simulação ainda está válida?', current)).toEqual({ offerSimulation: false, notes: [],
      text: 'A simulação atual vale por mais cerca de 2 min. Etapa 1 (Trocar 100 USDC): cerca de 0,025 WETH, no mínimo 0,024875 WETH.' });
    expect(answer('How much will I get?', current, 'EN').text).toBe('Step 1 (Swap 100 USDC): about 0.025 WETH, at least 0.024875 WETH.');
  });
  it('costs list the verified lines, what the simulation does not provide, and FloFi\'s fee as not charged', () => {
    const costs = answer('Quanto custa?', current);
    expect(costs.text).toBe('A simulação atual não lista custos. Taxa da FloFi: 0,80% (0,8 USDC), não cobrada no momento.');
    expect(costs.notes).toEqual(['A simulação não informa: custo de rede.']);
  });
  it('an expired, changed or missing simulation is never presented as current: FloFi says so and offers to simulate', () => {
    const expired = assistantSimulation(view(), canonical(), reviewNow + 121_000);
    expect(answer('Quanto vou receber?', expired)).toEqual({ text: 'A última simulação expirou, então os números dela não valem mais. Quer simular de novo?', notes: [], offerSimulation: true });
    expect(answer('Quanto vou receber?', expired).text).not.toMatch(/0,025|0\.025/);
    const none = { ...current, status: 'NONE' as const, steps: [], costs: [], missing: [], expiresAt: null };
    expect(answer('Is the simulation still valid?', none, 'EN')).toMatchObject({ text: 'There is no simulation of this workflow yet. Do you want to simulate it now?', offerSimulation: true });
    expect(answer('Quanto custa?', { ...none, status: 'CHANGED' }).text).toBe(
      'O fluxo mudou depois da última simulação, então os números dela não valem mais. Quer simular de novo? Taxa da FloFi: 0,80% (0,8 USDC), não cobrada no momento.');
  });
  it('is it worth it: the value against the verified same-asset costs, as a share, without a price and without blocking', () => {
    const bridge: AssistantSimulation = { ...current, steps: [{ number: 1, kind: 'BRIDGE', action: 'Bridge', input: '0.1 USDC', output: '0.095897 USDC', outputLabel: 'Quoted destination output',
      minimum: '0.095 USDC', provider: 'Relay' }], costs: [{ label: 'Route fee', value: '0.004103 USDC', treatment: 'INCLUDED' }, { label: 'Maximum network fee', value: '0.00002 ETH', treatment: 'CEILING' }] };
    const bridgeSteps = workflowSteps(buildWorkflow([FIXTURE.mainnetBridge]), contextFor(buildWorkflow([FIXTURE.mainnetBridge])));
    const worth = answerReadOnly(readOnlyQuestion('Compensa fazer uma bridge de 0,1 USDC?')!, bridge, bridgeSteps, 'PT', reviewNow);
    expect(worth).toEqual({ notes: [], offerSimulation: false, text: 'Na simulação atual, a bridge de 0,1 USDC entrega cerca de 0,095897 USDC: os custos são 0,004103 USDC, cerca de 4,1% '
      + 'do valor. Pago à parte: taxa máxima da rede 0,00002 ETH. É um custo moderado para esse valor.' });
    const english = answerReadOnly(readOnlyQuestion('Is it worth bridging 0.1 USDC?')!, bridge, bridgeSteps, 'EN', reviewNow);
    expect(english.text).toMatch(/^In the current simulation, the bridge of 0\.1 USDC delivers about 0\.095897 USDC: costs are 0\.004103 USDC, about 4\.1% of the amount\./);
    // Only the route's verified deduction: when no fee line is in the same asset, what does not arrive (input minus the quoted output) is the cost.
    const deducted = { ...bridge, costs: [] };
    expect(answerReadOnly(readOnlyQuestion('Compensa fazer uma bridge de 0,1 USDC?')!, deducted, bridgeSteps, 'PT', reviewNow).text).toContain('os custos são 0,004103 USDC, cerca de 4,1% do valor');
    const other = answerReadOnly(readOnlyQuestion('Compensa fazer uma bridge de 0,5 USDC?')!, bridge, bridgeSteps, 'PT', reviewNow);
    expect(other).toMatchObject({ text: 'A simulação atual é de 0,1 USDC, não de 0,5 USDC. Altere o valor e simule de novo para comparar.' });
    expect(answerReadOnly(readOnlyQuestion('Compensa fazer uma bridge de 0,1 USDC?')!, { ...bridge, status: 'EXPIRED', steps: [], costs: [] }, bridgeSteps, 'PT', reviewNow))
      .toEqual({ text: 'Para comparar o valor com os custos, preciso de uma simulação atual. Quer simular agora?', notes: [], offerSimulation: true });
    expect(answerReadOnly(readOnlyQuestion('Compensa fazer uma bridge de 0,1 USDC?')!, current, steps, 'PT', reviewNow).text)
      .toBe('Este fluxo ainda não tem uma bridge. Adicione e simule para ver os custos.');
  });
  it('the workflow and one of its steps, by its number or kind', () => {
    const workflow = buildWorkflow([FIXTURE.baseSwap, FIXTURE.supply]), two = workflowSteps(workflow, contextFor(workflow));
    expect(answerReadOnly(readOnlyQuestion('O que faz a segunda etapa?')!, current, two, 'PT', reviewNow).text).toBe('Etapa 2: Faz supply de 5 USDC na Aave V3 na Base Sepolia para 0x1111111111111111111111111111111111111111.');
    expect(answerReadOnly(readOnlyQuestion('What are the steps?')!, current, two, 'EN', reviewNow).text)
      .toBe('Your workflow has 2 steps: 1. Swap 2 USDC → WETH · Base; 2. Supply 5 USDC · Aave V3 · Base Sepolia.');
  });
});
