// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyCommand, FIXTURE, OTHER_ADDRESS } from './copilot-test-fixtures';
import { act, CopilotSession, intent, TEST_WALLET } from './copilot-session.test-harness';
import { looksSecret } from './copilot-conversation';
import { workflowSteps } from './workflow-steps';
import { registerFixtureCatalogs } from './intelligence/intelligence.test-harness';
import { resetNetworkCatalogs } from './asset-catalogs';
import { setActiveNetworkScope } from './network-scope';

const supply5 = act.lending('SUPPLY', { asset: 'USDC', amount: '5' });

describe('bounded multi-turn conversation', () => {
  it('suggests the current workflow output in an open network clarification and keeps an explicit choice', () => {
    const session = new CopilotSession(['swap 1 USDC to WETH on Arbitrum One']);
    const original = session.workflow;
    const asked = session.say(`Send 0.0001 WETH to ${OTHER_ADDRESS}`, intent.action(act.transfer({ amount: '0.0001', asset: 'WETH', recipient: OTHER_ADDRESS })))!;
    expect(asked.kind).toBe('CLARIFICATION');
    expect(asked.notes).toContain('The previous step delivers WETH on Arbitrum One.');
    expect(asked.options[0]).toBe('Arbitrum One');
    expect(session.workflow).toBe(original);
    const chosen = session.say('Base')!;
    expect(chosen).toMatchObject({ kind: 'PROPOSAL', command: { input: { network: 'Base', asset: 'WETH' } } });
    expect(session.workflow).toBe(original);
  });
  it('asks for the network, takes the button answer without a model call, then revises the pending proposal', () => {
    const session = new CopilotSession();
    const asked = session.say('Quero colocar 5 USDC na Aave.', intent.action(supply5, 'PT'))!;
    // BUILD-BASE-001: Aave USDC also runs on Base mainnet; real funds are offered, never chosen for the user.
    expect(asked).toMatchObject({ kind: 'CLARIFICATION', options: ['Base Sepolia', 'Base', 'Arbitrum One', 'Ethereum'] });
    expect(asked.text).toContain('Em qual rede?');
    expect(session.pending).toBeNull();
    const proposed = session.say('Base Sepolia')!;
    expect(session.turns.at(-1)!.request).toBeNull();
    expect(proposed).toMatchObject({ kind: 'PROPOSAL', sentence: `supply 5 USDC to Aave on Base Sepolia` });
    expect(proposed.text).toContain('Interpretado como “supply 5 USDC to Aave on Base Sepolia”');
    expect(session.workflow.revision).toBe(0);
    const revised = session.say('Na verdade muda para 2.', intent.edit({ amount: '2' }, {}, 'PT'))!;
    expect(revised).toMatchObject({ kind: 'PROPOSAL', command: { type: 'ADD_SUPPLY', input: { amount: '2', beneficiary: TEST_WALLET } } });
    expect(revised.text).toContain('nova versão da proposta pendente');
    expect(revised.notes.join(' ')).toContain('Mantido da proposta pendente: rede, token, beneficiário.');
    expect(session.workflow.revision).toBe(0);
    session.apply();
    expect(workflowSteps(session.workflow, session.context)[0]).toMatchObject({ kind: 'SUPPLY', detail: { input: { amount: '2' } } });
  });
  it('asks where a bridge should go instead of completing the pair, and fills the button deterministically', () => {
    const session = new CopilotSession();
    const asked = session.say('Bridge 1 USDC from Base Sepolia.', intent.action(act.bridge({ sourceNetwork: 'BASE_SEPOLIA', asset: 'USDC', amount: '1' })))!;
    expect(asked).toMatchObject({ kind: 'CLARIFICATION', text: 'To prepare this bridge, Flofi still needs the destination network.', options: ['Arbitrum Sepolia'] });
    expect(session.say('Arbitrum Sepolia')).toMatchObject({ kind: 'PROPOSAL', sentence: 'bridge 1 USDC from Base Sepolia to Arbitrum Sepolia via auto slippage 100 bps' });
  });
  it('fills a bare amount answer locally and keeps every other value grounded', () => {
    const session = new CopilotSession();
    expect(session.say('Swap USDC to WETH on Base Sepolia', intent.action(act.swap({ network: 'BASE_SEPOLIA', inputAsset: 'USDC', outputAsset: 'WETH' })))).toMatchObject({ kind: 'CLARIFICATION' });
    expect(session.say('3')).toMatchObject({ kind: 'PROPOSAL', sentence: 'swap 3 USDC to WETH on Base Sepolia slippage 100 bps' });
  });
  it('edits an applied step through its typed edit command and leaves the workflow alone until Apply', () => {
    const session = new CopilotSession([FIXTURE.testnetSwap]);
    const before = session.workflow;
    const edited = session.say('change it to 2', intent.edit({ amount: '2' }))!;
    expect(edited).toMatchObject({ kind: 'PROPOSAL', command: { type: 'SET_SWAP_AMOUNT', nodeId: 'node-002', amount: '2' } });
    expect(edited.text).toContain('Interpreted as a change to step 1 (Swap 3 USDC → WETH · Base Sepolia)');
    expect(session.workflow).toBe(before);
    session.apply();
    expect(workflowSteps(session.workflow, session.context)[0]!.detail).toMatchObject({ amount: '2' });
  });
  it('never lets the model invent a value: "make it smaller" becomes a question', () => {
    const session = new CopilotSession([FIXTURE.supply]);
    const reply = session.say('Make it smaller', intent.edit({ amount: '2' }))!;
    expect(reply.kind).toBe('CLARIFICATION');
    expect(reply.text).toContain('could not find the amount 2');
    expect(session.pending).toBeNull();
  });
  it('asks which swap when two match, and resolves the chosen button to that exact node', () => {
    const session = new CopilotSession([FIXTURE.baseSwap, FIXTURE.baseSwap2]);
    const asked = session.say('change the swap to 2', intent.edit({ amount: '2' }, { step: 'SWAP' }))!;
    expect(asked).toMatchObject({ kind: 'CLARIFICATION', text: 'Which swap do you mean?',
      options: ['Step 1 · Swap 2 USDC → WETH · Base', 'Step 2 · Swap 3 USDC → WETH · Base'] });
    expect(session.pending).toBeNull();
    expect(session.say('Step 2 · Swap 3 USDC → WETH · Base')).toMatchObject({ kind: 'PROPOSAL', command: { type: 'SET_SWAP_AMOUNT', nodeId: 'node-003', amount: '2' } });
    expect(session.turns.at(-1)!.request).toBeNull();
  });
  it('resolves ordinals against the canonical IR and removes only what the canvas could', () => {
    const session = new CopilotSession([FIXTURE.supply]);
    expect(session.say('Remove o primeiro passo', intent.remove({ ordinal: 'FIRST' }, 'PT'))).toMatchObject({ kind: 'PROPOSAL', command: { type: 'REMOVE', nodeId: 'node-002' } });
    session.dismiss();
    expect(new CopilotSession().say('remove the first step', intent.remove({ ordinal: 'FIRST' }))!.text).toContain('This workflow has 0 steps');
    expect(session.say('remove the fifth step', intent.remove({ ordinal: 'FIFTH' }))!.text).toContain('This workflow has 1 step');
  });
  it('repeats an earlier proposal only with a repeat cue, carrying its values with provenance', () => {
    const session = new CopilotSession();
    session.say(FIXTURE.testnetSwap);
    session.dismiss();
    const repeated = session.say('Do the same thing but with 2 USDC', intent.repeat({ amount: '2' }))!;
    expect(repeated).toMatchObject({ kind: 'PROPOSAL', sentence: 'swap 2 USDC to WETH on Base Sepolia slippage 50 bps' });
    expect(repeated.notes.join(' ')).toContain('Kept from your earlier proposal');
    session.dismiss();
    expect(session.say('Swap with 2 USDC', intent.repeat({ amount: '2' }))!.text).toContain('only when you ask for “the same” or “again”');
  });
  it('reuses a named field only with reuse wording, and asks for anything else', () => {
    const session = new CopilotSession();
    session.say(FIXTURE.testnetSwap);
    session.dismiss();
    const reuse = { from: { step: null, ordinal: null }, fields: ['network'] };
    const reply = session.say('Now supply 2 USDC on the same network', intent.action(act.lending('SUPPLY', { asset: 'USDC', amount: '2' }), 'EN', reuse))!;
    expect(reply).toMatchObject({ kind: 'PROPOSAL', sentence: 'supply 2 USDC to Aave on Base Sepolia' });
    session.dismiss();
    expect(session.say('Now supply 2 USDC', intent.action(act.lending('SUPPLY', { asset: 'USDC', amount: '2' }), 'EN', reuse))!.kind).toBe('CLARIFICATION');
  });
  it('answers read-only questions from Flofi state without proposing or changing anything', () => {
    const session = new CopilotSession([FIXTURE.testnetSwap]);
    session.say(FIXTURE.baseSwap.replace('Base', 'Base Sepolia').replace('2 USDC', '4 USDC'));
    const pending = session.pending, before = session.workflow;
    const answer = session.say('What does this workflow do?', intent.question('WORKFLOW_OVERVIEW'))!;
    expect(answer.kind).toBe('ANSWER');
    expect(answer.command).toBeUndefined();
    expect(answer.notes.join('\n')).toContain('Swaps 3 USDC for WETH on Base Sepolia through Uniswap v3');
    expect(answer.notes.at(-1)).toBe('Read only: nothing was proposed, changed, signed or executed.');
    expect(session.pending).toBe(pending);
    expect(session.workflow).toBe(before);
    expect(session.say('O que a simulação mostrou?', intent.question('SIMULATION', null, 'PT'))!.text).toContain('Ainda não há resultado de simulação');
    expect(session.say("What's the APY on Aave?", intent.question('MARKET_DATA'))!.text).toContain('never estimates them');
  });
});

describe('stale context and safety', () => {
  it('discards an answer when the workflow, the proposal or the wallet changed meanwhile', () => {
    const canvasEdit = (s: CopilotSession) => { s.workflow = applyCommand(s.workflow, { type: 'ADD', kind: 'read', source: 'CANVAS', baseRevision: s.workflow.revision }); };
    const session = new CopilotSession([FIXTURE.supply]);
    expect(session.say('make it 2', intent.edit({ amount: '2' }), canvasEdit))
      .toMatchObject({ kind: 'FAILED', text: 'The workflow changed while Flofi Copilot was interpreting, so nothing was proposed. Send your message again.' });
    expect(session.pending).toBeNull();
    expect(session.say('make it 2', intent.edit({ amount: '2' }), s => { s.wallet = OTHER_ADDRESS; })!.text).toContain('Your wallet or its network changed');
    session.say(FIXTURE.testnetSwap.replace('3 USDC', '1 USDC'));
    expect(session.say('make it 2', intent.edit({ amount: '2' }), s => s.dismiss())!.text).toContain('The pending proposal changed');
  });
  it('refuses Flofi\'s own step button after the workflow changed', () => {
    const session = new CopilotSession([FIXTURE.baseSwap, FIXTURE.baseSwap2]);
    session.say('change the swap to 2', intent.edit({ amount: '2' }, { step: 'SWAP' }));
    session.workflow = applyCommand(session.workflow, { type: 'ADD', kind: 'read', source: 'CANVAS', baseRevision: session.workflow.revision });
    const reply = session.say('Step 2 · Swap 3 USDC → WETH · Base')!;
    expect(reply).toMatchObject({ kind: 'FAILED' });
    expect(reply.text).toContain('changed after Flofi asked');
    expect(session.pending).toBeNull();
  });
  it('never sends a private key or seed phrase anywhere', () => {
    const session = new CopilotSession();
    const reply = session.say('My private key is 0x' + 'ab'.repeat(32))!;
    expect(reply.kind).toBe('UNSUPPORTED');
    expect(session.turns.at(-1)!.request).toBeNull();
    expect(session.state.transcript).toEqual([]);
    expect(looksSecret('table river cloud stone light paper green music water house chair bread')).toBe(true);
    expect(looksSecret('Swap 2 USDC to WETH on Base Sepolia')).toBe(false);
  });
});

// P0 hotfix (locale contract): a closed replay fixture (or a model that ignored the reply-language note) may answer in English on a Portuguese
// screen. Its own sentences are never shown then; FloFi's deterministic copy in the person's language stands, and offered values stay.
describe('model sentences in another language than the interface', () => {
  it('an English refusal or question on a Portuguese screen is replaced by FloFi\'s Portuguese copy', () => {
    const refusing = new CopilotSession(); refusing.interfaceLanguage = 'PT';
    const refused = refusing.say('quero fazer staking do meu eth na lido', intent.unsupported('Staking is not supported by FloFi yet.', 'EN'));
    expect(refused?.text).toBeTruthy(); expect(refused!.text).not.toContain('Staking is not supported');
    const asking = new CopilotSession(); asking.interfaceLanguage = 'PT';
    const question = asking.say('trocar USDC', intent.clarify(['outputAsset'], 'Which token should you receive?', ['WETH', 'cbBTC'], 'EN'));
    expect(question?.text).toBeTruthy(); expect(question!.text).not.toContain('Which token');
    expect(question!.options).toEqual(expect.arrayContaining(['WETH', 'cbBTC']));
  });
  it('a model sentence already in the interface language is kept', () => {
    const s = new CopilotSession(); s.interfaceLanguage = 'EN';
    expect(s.say('stake my eth on lido', intent.unsupported('Staking is not supported by FloFi yet.', 'EN'))?.text).toContain('Staking is not supported by FloFi yet.');
  });
});

/**
 * BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001: several sends become ONE Batch Payment only when every send is a payment the person paired in their
 * own words (chat review H2); sends Batch Payment does not pay stay separate transfers, exactly as before (M1); and more sends than a sequence may hold
 * are answered exactly as before unless they are one Batch Payment (M3).
 */
describe('Batch Payment from the chat', () => {
  const A = '0x2222222222222222222222222222222222222222', B = '0x3333333333333333333333333333333333333333', C = '0x4444444444444444444444444444444444444444';
  const D = '0x5555555555555555555555555555555555555555', E = '0x6666666666666666666666666666666666666666';
  const send = (network: string, asset: string, amount: string, recipient: string) => act.transfer({ network, asset, amount, recipient });
  const base = (amount: string, recipient: string) => send('BASE', 'USDC', amount, recipient);
  beforeAll(() => { registerFixtureCatalogs(); setActiveNetworkScope('PUBLIC_MAINNET'); });
  afterAll(() => { resetNetworkCatalogs(); setActiveNetworkScope(null); });
  it('the canonical request is ONE Batch Payment, every recipient and amount in the person\'s order', () => {
    const session = new CopilotSession([]);
    const reply = session.say(`Send 25 USDC to ${A}, 50 USDC to ${B} and 75 USDC to ${C} on Base`, intent.composition([base('25', A), base('50', B), base('75', C)]))!;
    expect(reply).toMatchObject({ kind: 'PROPOSAL', command: { type: 'ADD_BATCH_PAYMENT', input: { network: 'Base', asset: 'USDC',
      payments: [{ recipient: A, amount: '25' }, { recipient: B, amount: '50' }, { recipient: C, amount: '75' }] } } });
    expect(reply.text).toContain(`1. 25 USDC → ${A} 2. 50 USDC → ${B} 3. 75 USDC → ${C} It runs only as one atomic authorization of your wallet`);
    // Portuguese pairs its payments with "para".
    const pt = new CopilotSession([]);
    expect(pt.say(`Envie 25 USDC para ${A} e 50 USDC para ${B} na Base`, intent.composition([base('25', A), base('50', B)], 'PT'))).toMatchObject({ kind: 'PROPOSAL',
      command: { type: 'ADD_BATCH_PAYMENT', input: { payments: [{ recipient: A, amount: '25' }, { recipient: B, amount: '50' }] } } });
  });
  it('chat review H2: swapped amounts, a duplicated amount or a dropped recipient never become the batch: FloFi lists both readings and asks', () => {
    const text = `Send 1 USDC to ${A} and 1000 USDC to ${B} on Base`;
    for (const sends of [[base('1000', A), base('1', B)], [base('1000', A), base('1000', B)], [base('1', A), base('1000', A)]]) {
      const session = new CopilotSession([]);
      const reply = session.say(text, intent.composition(sends))!;
      expect(reply.kind, JSON.stringify(sends)).toBe('CLARIFICATION');
      expect(reply.command).toBeUndefined(); expect(session.pending).toBeNull();
      expect(reply.text).toContain(`Your message pairs: 1. 1 USDC → ${A}; 2. 1000 USDC → ${B}.`);
      expect(reply.text).toContain(`The interpretation read: 1. ${sends[0]!.amount} USDC → ${sends[0]!.recipient}; 2. ${sends[1]!.amount} USDC → ${sends[1]!.recipient}.`);
    }
    // A dropped recipient: three payments written, two (or one) read.
    const three = `Send 25 USDC to ${A}, 50 USDC to ${B} and 75 USDC to ${C} on Base`;
    for (const model of [intent.composition([base('25', A), base('50', B)]), intent.composition([base('25', A), base('75', C)]), intent.action(base('25', A))]) {
      const session = new CopilotSession([]);
      const reply = session.say(three, model)!;
      expect(reply.kind).toBe('CLARIFICATION'); expect(session.pending).toBeNull();
      expect(reply.text).toContain(`Your message pairs: 1. 25 USDC → ${A}; 2. 50 USDC → ${B}; 3. 75 USDC → ${C}.`);
    }
    // In Portuguese too; and the person's next message, pairing each payment, is the one FloFi reads.
    const session = new CopilotSession([]);
    const asked = session.say(`Envie 1 USDC para ${A} e 1000 USDC para ${B} na Base`, intent.composition([base('1000', A), base('1', B)], 'PT'))!;
    expect(asked.kind).toBe('CLARIFICATION');
    expect(asked.text).toContain(`Sua mensagem associa: 1. 1 USDC → ${A}; 2. 1000 USDC → ${B}. A interpretação leu: 1. 1000 USDC → ${A}; 2. 1 USDC → ${B}.`);
    expect(session.say(`1 USDC para ${A} e 1000 USDC para ${B}`, intent.composition([base('1', A), base('1000', B)], 'PT'))).toMatchObject({ kind: 'PROPOSAL',
      command: { type: 'ADD_BATCH_PAYMENT', input: { payments: [{ recipient: A, amount: '1' }, { recipient: B, amount: '1000' }] } } });
  });
  it('chat review C1: an amount with several readings ("1.000") is asked about, never paired with the reading the interpretation chose', () => {
    const text = `Send 1000 USDC to ${A} and 1.000 USDC to ${B} on Base`;
    const session = new CopilotSession([]);
    const asked = session.say(text, intent.composition([base('1000', A), base('1000', B)]))!;
    expect(asked).toMatchObject({ kind: 'CLARIFICATION', options: ['1', '1000'] });
    expect(asked.command).toBeUndefined(); expect(session.pending).toBeNull();
    expect(asked.text).toBe(`Your message pairs: 1. 1000 USDC → ${A}; 2. 1.000 USDC → ${B}. “1.000” can be read as 1 and 1000. Which amount do you mean? Reply with the number.`);
    // The person's answer settles that payment: the batch pays exactly what they said, in their order.
    expect(session.say('1', intent.composition([base('1000', A), base('1', B)]))).toMatchObject({ kind: 'PROPOSAL',
      command: { type: 'ADD_BATCH_PAYMENT', input: { payments: [{ recipient: A, amount: '1000' }, { recipient: B, amount: '1' }] } } });
    // An interpretation that ignores the answer is not the batch: FloFi lists both and asks.
    const ignored = new CopilotSession([]);
    ignored.say(text, intent.composition([base('1000', A), base('1000', B)]));
    const unpaired = ignored.say('1', intent.composition([base('1000', A), base('1000', B)]))!;
    expect(unpaired.kind).toBe('CLARIFICATION'); expect(ignored.pending).toBeNull();
    expect(unpaired.text).toContain(`The interpretation read: 1. 1000 USDC → ${A}; 2. 1000 USDC → ${B}.`);
    // A reply that is not one of the readings settles nothing: the same question again.
    const other = new CopilotSession([]);
    other.say(text, intent.composition([base('1000', A), base('1000', B)]));
    expect(other.say('5', intent.composition([base('1000', A), base('1000', B)]))).toMatchObject({ kind: 'CLARIFICATION', options: ['1', '1000'] });
    expect(other.pending).toBeNull();
    // In Portuguese too.
    const pt = new CopilotSession([]);
    const perguntou = pt.say(`Envie 1000 USDC para ${A} e 1.000 USDC para ${B} na Base`, intent.composition([base('1000', A), base('1000', B)], 'PT'))!;
    expect(perguntou).toMatchObject({ kind: 'CLARIFICATION', options: ['1', '1000'] });
    expect(perguntou.text).toBe(`Sua mensagem associa: 1. 1000 USDC → ${A}; 2. 1.000 USDC → ${B}. “1.000” pode ser lido como 1 e 1000. Qual valor você quer? Responda com o número.`);
    expect(pt.pending).toBeNull();
  });
  it('a recipient the person wrote twice is refused, never merged (after the pairing check)', () => {
    const session = new CopilotSession([]);
    const reply = session.say(`Send 1 USDC to ${A} and 2 USDC to ${A} on Base`, intent.composition([base('1', A), base('2', A)]))!;
    expect(reply.kind).toBe('UNSUPPORTED'); expect(session.pending).toBeNull();
    expect(reply.text).toBe(`${A} appears more than once. A Batch Payment pays each recipient once and FloFi never merges or drops a payment: say the one amount for that recipient.`);
  });
  it('chat review H2: a message without one explicit clause per payment is asked about, never paired by value', () => {
    const session = new CopilotSession([]);
    const reply = session.say(`Pay ${A} 1 USDC and ${B} 1000 USDC on Base`, intent.composition([base('1', A), base('1000', B)]))!;
    expect(reply.kind).toBe('CLARIFICATION');
    expect(reply.text).toContain('Your message pairs: no payment written as “<amount> <token> to <address>”.');
  });
  it('chat review M1: Stock Token sends stay two separate transfers, exactly as before Batch Payment', () => {
    const session = new CopilotSession([]);
    const reply = session.say(`Send 1 TSLA to ${A} and 2 TSLA to ${B} on Robinhood Chain`,
      intent.composition([send('ROBINHOOD', 'TSLA', '1', A), send('ROBINHOOD', 'TSLA', '2', B)]))!;
    expect(reply).toMatchObject({ kind: 'PROPOSAL', command: { type: 'ADD_SEQUENCE', steps: [{ type: 'ADD_RH_TRANSFER', input: { asset: 'TSLA', amount: '1', recipient: A } },
      { type: 'ADD_RH_TRANSFER', input: { asset: 'TSLA', amount: '2', recipient: B } }] } });
    expect(reply.text).not.toMatch(/BATCH_PAYMENT|INVALID_COMMAND/);
  });
  it('chat review M3: more sends than a sequence holds are one Batch Payment, or the interpretation\'s "too many steps" answer exactly as before', () => {
    const tooMany = 'The AI returned more steps than one proposal may contain, so it was discarded. Nothing changed. You can also type an exact command.';
    const five = new CopilotSession([]);
    expect(five.say(`Send 1 USDC to ${A}, 2 USDC to ${B}, 3 USDC to ${C}, 4 USDC to ${D} and 5 USDC to ${E} on Base`,
      intent.composition([base('1', A), base('2', B), base('3', C), base('4', D), base('5', E)]))).toMatchObject({ kind: 'PROPOSAL', command: { type: 'ADD_BATCH_PAYMENT' } });
    // Five Stock Token sends cannot be one Batch Payment, and five separate transfers are more steps than a proposal may hold.
    const stocks = new CopilotSession([]);
    const tsla = [A, B, C, D, E].map((recipient, index) => send('ROBINHOOD', 'TSLA', String(index + 1), recipient));
    expect(stocks.say(`Send 1 TSLA to ${A}, 2 TSLA to ${B}, 3 TSLA to ${C}, 4 TSLA to ${D} and 5 TSLA to ${E} on Robinhood Chain`, intent.composition(tsla)))
      .toEqual({ kind: 'FAILED', text: tooMany, notes: [], options: [], code: 'COPILOT_TOO_MANY_ACTIONS' });
    expect(stocks.pending).toBeNull();
    // Four sends on two networks are not one Batch Payment shape at all: discarded at once, as before.
    const mixed = new CopilotSession([]);
    expect(mixed.say(`Send 1 USDC to ${A} and 2 USDC to ${B} on Base, then 3 USDC to ${C} and 4 USDC to ${D} on Arbitrum One`,
      intent.composition([base('1', A), base('2', B), send('ARBITRUM', 'USDC', '3', C), send('ARBITRUM', 'USDC', '4', D)])))
      .toEqual({ kind: 'FAILED', text: tooMany, notes: [], options: [], code: 'COPILOT_TOO_MANY_ACTIONS' });
  });
  it('chat review C5: sends that name no network are a Batch Payment shape only in the public product; elsewhere "too many steps" exactly as before', () => {
    const tooMany = 'The AI returned more steps than one proposal may contain, so it was discarded. Nothing changed. You can also type an exact command.';
    const text = `Send 1 USDC to ${A}, 2 USDC to ${B}, 3 USDC to ${C}, 4 USDC to ${D} and 5 USDC to ${E}`;
    const unnamed = () => intent.composition([A, B, C, D, E].map((recipient, index) => send(null as never, 'USDC', String(index + 1), recipient)));
    // Public product: the sequence authoring asks for the network (nothing is discarded).
    const mainnet = new CopilotSession([]);
    const asked = mainnet.say(text, unnamed())!;
    expect(asked.code).not.toBe('COPILOT_TOO_MANY_ACTIONS'); expect(asked.kind).toBe('CLARIFICATION'); expect(mainnet.pending).toBeNull();
    setActiveNetworkScope('ENGINEERING');
    try {
      const engineering = new CopilotSession([]);
      expect(engineering.say(text, unnamed())).toEqual({ kind: 'FAILED', text: tooMany, notes: [], options: [], code: 'COPILOT_TOO_MANY_ACTIONS' });
      expect(engineering.pending).toBeNull();
    } finally { setActiveNetworkScope('PUBLIC_MAINNET'); }
  });
});
