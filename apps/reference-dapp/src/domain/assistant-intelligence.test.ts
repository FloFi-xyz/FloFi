// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { CopilotSession, intent } from './copilot-session.test-harness';
import { FIXTURE } from './copilot-test-fixtures';
import { contextCard, operationalState } from './intelligence/operational-state';
import { termQuestion } from './operation-terms';
import type { AssistantSimulation } from './assistant-answers';
import type { CopilotReply } from './copilot-conversation';

/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001: the conversation engine answers questions without changing anything (A04), reads step references and
 * amounts itself (A03), reads the current revision's simulation facts (A05) and replies in the person's conversational language (A09). No model is
 * called for any deterministic turn: a turn that would need one throws in the harness.
 */
/** As the web chat: the turn carries the person's conversational language (`replyLanguage`) besides the interface language. */
class Session extends CopilotSession {
  replyLanguage: 'EN' | 'PT' | undefined = undefined;
  override env() { return { ...super.env(), ...this.replyLanguage ? { replyLanguage: this.replyLanguage } : {} }; }
}
const text = (reply: CopilotReply | null) => [reply?.text ?? '', ...reply?.notes ?? [], ...reply?.options ?? []].join('\n');
const INTERNAL = /ABORT|MODE_A|node-\d|COPILOT_[A-Z_]+|SET_[A-Z_]+|ADD_[A-Z_]+|schema|parser/;

describe('A04: questions are answered and never create or modify operations', () => {
  it('"O que significa supply?" is a short Portuguese definition of depositing into a lending protocol, with no proposal', () => {
    const s = new Session([FIXTURE.baseSwap]); s.interfaceLanguage = 'EN'; s.replyLanguage = 'PT'; const before = s.workflow;
    const reply = s.say('O que significa supply?')!;
    expect(reply).toMatchObject({ kind: 'ANSWER', topic: 'CONCEPT' });
    expect(reply.text).toBe('Supply é depositar seus tokens em um protocolo de empréstimo, como a Aave, para render juros. Você pode sacá-los depois, e eles podem servir de colateral para um empréstimo.');
    expect(reply.command).toBeUndefined(); expect(s.pending).toBeNull(); expect(s.workflow).toBe(before);
    expect(s.turns.at(-1)!.request).toBeNull();
    // The related concept keeps its follow-ups: an example of lending.
    expect(s.say('Me dá um exemplo')!.text).toMatch(/^Exemplo ilustrativo \(não é cotação\): você fornece 500 USDC/);
  });
  it('the meaning of FloFi\'s operations in English, and nothing else is read as one', () => {
    const s = new Session(); s.interfaceLanguage = 'PT'; s.replyLanguage = 'EN';
    expect(s.say('What does borrow mean?')!.text).toMatch(/^Borrow means taking tokens from a lending protocol/);
    for (const question of ['O que é swap?', 'what is a batch payment?', 'o que quer dizer repay']) expect(termQuestion(question), question).not.toBeNull();
    for (const request of ['supply 5 USDC to Aave on Base Sepolia', 'o que significa slippage?', 'O que significa supply de 5 USDC?']) expect(termQuestion(request), request).toBeNull();
  });
  it('answers never expose a failure-policy code, an authorization class, a node id or a command type', () => {
    const s = new CopilotSession([FIXTURE.supply, FIXTURE.bridge]);
    for (const [question, model] of [['What is the first step?', intent.question('STEP_DETAIL', { ordinal: 'FIRST' })], ['What happens if it fails?', intent.question('FAILURE')],
      ['Which approvals will I sign?', intent.question('APPROVALS')], ['What does this workflow do?', intent.question('WORKFLOW_OVERVIEW')]] as const)
      expect(text(s.say(question, model)), question).not.toMatch(INTERNAL);
    s.say(FIXTURE.borrow);
    expect(text(s.say('What does this proposal change?', intent.question('PROPOSAL'))), 'proposal').not.toMatch(INTERNAL);
  });
});

describe('A03: natural-language step references resolve against the canonical workflow, without a model', () => {
  const setup = [FIXTURE.baseSwap, FIXTURE.supply];
  it('"Altere a segunda etapa para 0,2." and "Mude o supply para 0,2." target the same operation with the same exact amount', () => {
    const ordinal = new CopilotSession(setup).say('Altere a segunda etapa para 0,2.')!, kind = new CopilotSession(setup).say('Mude o supply para 0,2.')!;
    for (const reply of [ordinal, kind]) {
      expect(reply.kind).toBe('PROPOSAL');
      expect(reply.command).toMatchObject({ type: 'SET_SUPPLY', nodeId: 'node-003', input: { amount: '0.2', asset: 'USDC', network: 'Base Sepolia' } });
      expect(reply.text).toContain('Interpretado como uma mudança no passo 2');
    }
    expect(JSON.stringify(ordinal.command)).toBe(JSON.stringify(kind.command));
  });
  it('the last card, the first step and English references; a Portuguese decimal comma keeps every digit', () => {
    expect(new CopilotSession(setup).say('Altere o último card para 0,123456')!.command).toMatchObject({ type: 'SET_SUPPLY', input: { amount: '0.123456' } });
    expect(new CopilotSession(setup).say('Change the first step to 0.5')!.command).toMatchObject({ type: 'SET_SWAP_AMOUNT', nodeId: 'node-002', amount: '0.5' });
    expect(new CopilotSession(setup).say('Set the supply to 7 USDC')!.command).toMatchObject({ type: 'SET_SUPPLY', input: { amount: '7' } });
    expect(new CopilotSession([FIXTURE.mainnetBridge]).say('Mude a bridge para 2')!.command).toMatchObject({ type: 'SET_ROUTER_BRIDGE', input: { amount: '2' } });
  });
  it('asks only when the target or the amount is genuinely ambiguous, and never guesses', () => {
    const two = new CopilotSession([FIXTURE.supply, 'supply 6 USDC to Aave on Base Sepolia']);
    const which = two.say('Mude o supply para 0,2')!;
    expect(which.kind).toBe('CLARIFICATION'); expect(which.command).toBeUndefined();
    expect(which.options).toEqual(['Passo 1 · Supply 5 USDC · Aave V3 · Base Sepolia', 'Passo 2 · Supply 6 USDC · Aave V3 · Base Sepolia']);
    expect(two.say('Passo 2 · Supply 6 USDC · Aave V3 · Base Sepolia')!.command).toMatchObject({ type: 'SET_SUPPLY', nodeId: 'node-003', input: { amount: '0.2' } });
    const amount = new CopilotSession(setup), asked = amount.say('Altere a segunda etapa para 1,000')!;
    expect(asked).toMatchObject({ kind: 'CLARIFICATION', options: ['1', '1000'], text: '“1,000” pode ser 1 ou 1000. Qual valor você quer?' });
    expect(amount.say('1000')!.command).toMatchObject({ type: 'SET_SUPPLY', input: { amount: '1000' } });
    expect(new CopilotSession(setup).say('Altere a terceira etapa para 2')).toMatchObject({ kind: 'UNSUPPORTED' });
  });
  it('a token after the amount that is not the step\'s own is not read as an amount change (the model reads it)', () => {
    expect(() => new CopilotSession(setup).say('Mude o supply para 2 ETH')).toThrow(/unexpected model call/);
  });
});

describe('A05: the engine reads the current revision\'s simulation facts', () => {
  const details = (status: AssistantSimulation['status']): AssistantSimulation => ({ workflowId: 'w', revision: 1, status, expiresAt: status === 'CURRENT' ? Date.parse('2026-11-28T12:05:00Z') : null,
    steps: status === 'CURRENT' ? [{ number: 1, kind: 'SUPPLY', action: 'Supply', input: '5 USDC', output: null, outputLabel: 'Expected action', minimum: null, provider: 'Aave V3' }] : [],
    costs: status === 'CURRENT' ? [{ label: 'Maximum network fee', value: '0.0001 ETH', treatment: 'CEILING' }] : [], additional: [], ceilings: [], missing: [],
    platformFee: { rate: '0.80%', status: 'FEEABLE', amounts: ['0.04 USDC'], recorded: null }, problem: null, actionable: true });
  const session = (status: AssistantSimulation['status']) => {
    const s = new CopilotSession([FIXTURE.supply]); s.now = Date.parse('2026-11-28T12:00:00Z');
    s.facts = { simulation: { status: status === 'CURRENT' ? 'CURRENT' : status === 'NONE' ? 'NONE' : 'STALE', details: details(status) } };
    return s;
  };
  it('a simulation question the model classified is answered from the verified figures (never "no simulation" while one is current)', () => {
    const reply = session('CURRENT').say('how is my simulation looking', intent.question('SIMULATION'))!;
    expect(reply.text).toBe('The current simulation is valid for about 5 more min. Step 1 (Supply 5 USDC): no estimated output.');
    expect(reply.text).not.toMatch(/no simulation/i);
    const costs = session('CURRENT').say('gas?', intent.question('MARKET_DATA'))!;
    expect(costs.text).not.toContain('0.0001');
    expect(session('CURRENT').say('what are the fees for this', intent.question('MARKET_DATA'))!.text)
      .toBe('Estimated costs in the current simulation: Maximum network fee: 0.0001 ETH. FloFi fee: 0.80% (0.04 USDC), not charged at this time.');
  });
  it('an expired or changed simulation is said so, with no figure', () => {
    expect(session('EXPIRED').say('how is my simulation looking', intent.question('SIMULATION'))!.text).toBe('The last simulation expired, so its figures no longer apply. Do you want to simulate again?');
    expect(session('CHANGED').say('how is my simulation looking', intent.question('SIMULATION'))!.text).toMatch(/^The workflow changed after the last simulation/);
  });
  it('the model reads the same facts through the context card, bound to the revision (figures only while current)', () => {
    const current = session('CURRENT'), card = contextCard(operationalState(current.state, current.env()));
    expect(card.simulation).toEqual({ status: 'CURRENT', revision: 1, expiresAt: '2026-11-28T12:05:00.000Z', steps: [{ step: 1, action: 'Supply', input: '5 USDC', output: null, minimum: null }],
      costs: [{ label: 'Maximum network fee', value: '0.0001 ETH' }], platformFee: { rate: '0.80%', amounts: ['0.04 USDC'], recorded: null, charged: false } });
    const expired = session('EXPIRED');
    expect(contextCard(operationalState(expired.state, expired.env())).simulation).toMatchObject({ status: 'EXPIRED', expiresAt: null, steps: [], costs: [] });
    expect(JSON.stringify(card)).not.toMatch(/node-\d|eip155:|0x[0-9a-fA-F]{40}/);
  });
});

describe('A09: replies follow the conversational language, not the interface', () => {
  it('the turn\'s reply language wins over the interface language, for FloFi\'s copy and the model request', () => {
    const s = new Session([FIXTURE.baseSwap]); s.interfaceLanguage = 'EN'; s.replyLanguage = 'PT';
    let sent: unknown = null;
    s.say('quero fazer staking do meu eth na lido', request => { sent = request.replyLanguage; return { ok: true, intent: intent.unsupported('Staking is not supported by FloFi yet.', 'EN') as never }; });
    expect(sent).toBe('PT');
    expect(s.turns.at(-1)!.reply!.text).not.toContain('Staking is not supported');
  });
  it('"reply in English" holds for the conversation on a Portuguese screen (it no longer points to the screen setting)', () => {
    const s = new CopilotSession([FIXTURE.baseSwap]); s.interfaceLanguage = 'PT';
    s.learning = { memory: 'AVAILABLE', owner: null, private: [], global: [], globalVersion: null, language: null };
    expect(s.say('reply in English')!.text).toBe('From now on I’ll reply in English.');
    expect(s.state.languageSet).toBe('EN');
    expect(s.say('O que significa supply?')!.text).toMatch(/^Supply means depositing your tokens/);
  });
});
