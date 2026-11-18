// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIFIED-COPILOT-001 acceptance journeys through the real conversation engine, exact grammar, editor and the committed official catalog
 * fixtures, with scripted model answers (no model, provider, wallet or network is reached; nothing is simulated, signed or executed):
 *   A conversational swap with typos · B DeFi education during authoring and resume · C saving and reusing a recipient · D automation management ·
 *   platform guidance · continuity and safety invariants.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CopilotSession, act, intent } from '../copilot-session.test-harness';
import { setActiveNetworkScope } from '../network-scope';
import { registerFixtureCatalogs, resetNetworkCatalogs } from './intelligence.test-harness';
import { SAVED_RECIPIENT_MARKER, savedRecipientLabel, type SavedRecipient } from '../saved-recipients';
import { FIXTURE } from '../copilot-test-fixtures';
import { automationCreated } from '../copilot-conversation';

beforeAll(registerFixtureCatalogs);
afterAll(() => { resetNetworkCatalogs(); setActiveNetworkScope(null); });
beforeEach(() => setActiveNetworkScope('PUBLIC_MAINNET'));
const mainnet = (language: 'EN' | 'PT' | undefined = undefined) => { const s = new CopilotSession(); s.walletChainId = 'eip155:42161'; if (language) s.interfaceLanguage = language; return s; };
const SOL = 'GsWtMd3S5133XPhnfeR1CvPLcLxBSknhVhmaW7fHevBq';
const EVM = '0x52908400098527886e0f7030069857d2e4169ee7';
const saved = (label: string, address: string, ecosystem: 'EVM' | 'SOLANA', id = 'a'): SavedRecipient =>
  ({ id: `rcp_${id.padEnd(26, 'a')}`, label, address, ecosystem, createdAt: '2026-11-15T12:00:00.000Z', updatedAt: '2026-11-15T12:00:00.000Z' });

describe('Journey A — conversational swap with typos', () => {
  it('"trocar etheruem por usdc na arbriturm" asks only for the amount, says how it read the typos, then "0.00005" prepares the swap', () => {
    const s = mainnet('PT');
    const asked = s.say('trocar etheruem por usdc na arbriturm', intent.action(act.swap({ network: 'ARBITRUM', inputAsset: 'ETH', outputAsset: 'USDC', amount: null }), 'PT'))!;
    expect(asked.kind).toBe('CLARIFICATION');
    expect(asked.notes.join(' ')).toMatch(/Entendi “etheruem” como Ethereum e “arbriturm” como Arbitrum One/);
    expect(s.state.draft?.expected).toEqual(['amount']);
    const proposal = s.say('0.00005')!;
    expect(proposal).toMatchObject({ kind: 'PROPOSAL', sentence: 'swap 0.00005 ETH to USDC on Arbitrum One slippage 100 bps' });
    // Nothing was asked twice in the request.
    expect(s.state.ledger?.repeats ?? 0).toBe(0);
  });
  it('a complete request with a misspelled mainnet is never proposed in the same turn: FloFi confirms its reading first (learning corpus M04)', () => {
    const s = mainnet();
    const asked = s.say('Bridge 10 USDC from Base to arbitrun', intent.action(act.bridge({ sourceNetwork: 'BASE', destinationNetwork: 'ARBITRUM', asset: 'USDC', amount: '10' })))!;
    expect(asked).toMatchObject({ kind: 'CLARIFICATION', options: ['Yes, prepare it'] });
    expect(asked.text).toMatch(/^I read “arbitrun” as Arbitrum One\. Shall I prepare: bridge 10 USDC from Base to Arbitrum/);
    expect(asked.command).toBeUndefined();
    expect(s.say('Yes, prepare it')).toMatchObject({ kind: 'PROPOSAL', command: expect.anything() });
  });
  it('"swap ethereum to usdc on arbitrum one" reads Ethereum as the coin ETH, never as a second network', () => {
    // FIX-05 aliases let the exact grammar resolve "ethereum" as native ETH (same identity as the model path). Exact grammar returns null and
    // stages the proposal; the conversational path still produces PROPOSAL when exact grammar does not match.
    const s = mainnet();
    const reply = s.say('swap 0.01 ethereum to usdc on arbitrum one', intent.action(act.swap({ network: 'ARBITRUM', inputAsset: 'ETH', outputAsset: 'USDC', amount: '0.01' })));
    if (reply === null) {
      expect(s.pending?.command).toMatchObject({
        type: 'ADD_CRYPTO_ACTION',
        input: expect.objectContaining({
          amount: '0.01',
          slippage: '100',
          selection: expect.objectContaining({ action: 'swap', from: 'ETH', to: 'USDC', network: 'Arbitrum One' }),
        }),
      });
    } else {
      expect(reply).toMatchObject({ kind: 'PROPOSAL', sentence: 'swap 0.01 ETH to USDC on Arbitrum One slippage 100 bps' });
    }
    // "from Ethereum" is the network, never the coin.
    const network = mainnet().say('please move 5 USDC from ethereum over to base', intent.action(act.bridge({ sourceNetwork: 'ETHEREUM', destinationNetwork: 'BASE', asset: 'USDC', amount: '5' })))!;
    expect(network.kind).toBe('PROPOSAL');
  });
});

describe('Journey B — DeFi education during authoring', () => {
  it('explains slippage, then more simply, keeps the open swap, and "agora continua o swap" resumes it with every value kept', () => {
    const s = mainnet('PT');
    const asked = s.say('quero trocar ETH por USDC na Arbitrum One', intent.action(act.swap({ network: 'ARBITRUM', inputAsset: 'ETH', outputAsset: 'USDC' }), 'PT'))!;
    expect(asked.kind).toBe('CLARIFICATION');
    const question = s.state.draft!.question!;
    const explained = s.say('O que é slippage?')!;
    expect(explained).toMatchObject({ kind: 'ANSWER', topic: 'CONCEPT' });
    expect(explained.text).toMatch(/^Slippage é a diferença/);
    expect(explained.notes).toContain(`Seu pedido continua aberto — ${question}`);
    expect(explained.options).toContain('Continuar meu pedido');
    const simpler = s.say('Não entendi.')!;
    expect(simpler.text).toMatch(/^Slippage é o quanto o preço pode mudar/);
    expect(s.say('Me dá um exemplo')!.text).toMatch(/^Exemplo ilustrativo/);
    // No model was called for any of these, and the draft is exactly the one FloFi asked about.
    expect(s.turns.slice(1).every(turn => turn.request === null)).toBe(true);
    const resumed = s.say('Agora continua o swap')!;
    expect(resumed).toMatchObject({ kind: 'CLARIFICATION' });
    expect(resumed.text).toBe(`Vamos continuar. ${question}`);
    expect(s.state.clarifications).toBe(1);
    expect(s.say('0.001')).toMatchObject({ kind: 'PROPOSAL', sentence: 'swap 0.001 ETH to USDC on Arbitrum One slippage 100 bps' });
  });
  it('follows up on a protocol and on the user\'s own workflow, and never states a live value', () => {
    const s = mainnet('PT');
    expect(s.say('O que é colateral?')!.text).toMatch(/^Colateral é o que você deposita/);
    expect(s.say('E como isso funciona na Aave?')!.text).toMatch(/^Na Aave V3, ativos depositados/);
    const mine = s.say('E no meu workflow?')!;
    expect(mine.text).toMatch(/^Seu workflow atual não tem nenhum passo em que colateral se aplique/);
    // A live value is not a concept: it goes to the interpreter (MARKET_DATA), never a concept answer.
    expect(() => mainnet().say('What is the APY on Aave?')).toThrow('unexpected model call');
  });
  it('a question classified by the model as CONCEPT is answered from FloFi\'s copy (the model\'s prose is never shown as verified data)', () => {
    const s = mainnet();
    const reply = s.say('hey, impermanent loss — can you walk me through it', { ...intent.question('CONCEPT'), answer: 'It is 50% of your funds.' })!;
    expect(reply).toMatchObject({ kind: 'ANSWER', topic: 'CONCEPT' });
    expect(reply.text).toMatch(/^Impermanent loss is the difference/);
    expect(reply.notes.join(' ')).not.toMatch(/50%/);
  });
});

describe('Journey C — saving and reusing a recipient', () => {
  const bridgeTo = (recipient: string | null, amount = '20') => intent.action(act.bridge({ sourceNetwork: 'BASE', destinationNetwork: 'SOLANA', asset: 'USDC', amount, recipient }), 'PT');
  it('offers to save a new typed address after the proposal, saves it only on the user\'s choice, under the name they give', () => {
    const s = mainnet('PT'); s.recipients = []; s.recipientWrites = true;
    const proposal = s.say(`Quero mandar 20 USDC da Base para minha outra carteira Solana ${SOL}`, bridgeTo(SOL))!;
    expect(proposal.kind).toBe('PROPOSAL');
    expect(proposal.offer).toEqual({ text: expect.stringMatching(/^Quer salvar GsWtMd…evBq em Credenciais/), options: ['Salvar destinatário', 'Agora não'] });
    expect(proposal.offer!.text).toMatch(/não prova que a carteira é sua e não autoriza nada/);
    const named = s.say('Salvar destinatário')!;
    // FloFi's suggestion is neutral (a typed address may be anyone's); the user names it as they like.
    expect(named).toMatchObject({ kind: 'CLARIFICATION', options: ['Destinatário Solana GsWt…evBq'] });
    expect(named.recipientSave).toBeUndefined();
    const saving = s.say('Minha Solana')!;
    expect(saving.recipientSave).toEqual({ label: 'Minha Solana', address: SOL, ecosystem: 'SOLANA' });
    expect(s.state.recipientOffer).toBeNull();
  });
  it('a declined offer saves nothing and is not asked again for that address; an already saved address is never offered', () => {
    const s = mainnet('PT'); s.recipients = []; s.recipientWrites = true;
    expect(s.say(`manda 20 USDC da Base para a Solana ${SOL}`, bridgeTo(SOL))!.offer).toBeDefined();
    expect(s.say('Agora não')).toMatchObject({ kind: 'ANSWER', text: 'Certo, não salvei. Seu pedido continua igual.' });
    expect(s.say(`manda 5 USDC da Base para a Solana ${SOL}`, bridgeTo(SOL, '5'))!.offer).toBeUndefined();
    const known = mainnet('PT'); known.recipients = [saved('Minha Solana', SOL, 'SOLANA')]; known.recipientWrites = true;
    expect(known.say(`manda 20 USDC da Base para a Solana ${SOL}`, bridgeTo(SOL))!.offer).toBeUndefined();
    // Without a surface that can save (a chat channel), nothing is offered.
    expect(mainnet('PT').say(`manda 20 USDC da Base para a Solana ${SOL}`, bridgeTo(SOL))!.offer).toBeUndefined();
  });
  it('"Manda 5 USDC da Base para Minha Solana" resolves the saved name without sending it (or its address) to the model', () => {
    const s = mainnet('PT'); s.recipients = [saved('Minha Solana', SOL, 'SOLANA'), saved('Carteira da empresa', EVM, 'EVM', 'b')];
    let sent = '';
    // The words of a saved name never name a network for the user: "Minha Solana" alone does not choose the Solana destination, so FloFi asks,
    // keeps the saved recipient for the request, and the answer proposes to it (re-checked against the network now named).
    const asked = s.say('Manda 5 USDC da Base para Minha Solana', request => { sent = JSON.stringify(request.messages);
      return { ok: true, intent: intent.action(act.bridge({ sourceNetwork: 'BASE', destinationNetwork: null, asset: 'USDC', amount: '5' }), 'PT') }; })!;
    expect(asked.kind).toBe('CLARIFICATION');
    expect(s.state.draft?.intent.kind === 'ACTION' && s.state.draft.intent.action.type === 'BRIDGE' ? s.state.draft.intent.action.recipient : 'x').toBeNull();
    const reply = s.say('Solana', bridgeTo(null, '5'))!;
    expect(sent).toContain(SAVED_RECIPIENT_MARKER);
    expect(sent).not.toMatch(/Minha Solana|GsWtMd/i);
    expect(reply).toMatchObject({ kind: 'PROPOSAL' });
    expect(reply.sentence).toContain(SOL);
    expect(reply.notes.join(' ')).toMatch(/Destinatário salvo “Minha Solana” \(Solana\): GsWtMd3S5133XPhnfeR1CvPLcLxBSknhVhmaW7fHevBq/);
    // A model that copied the marker into the address field wrote no address: FloFi still resolves the saved name.
    const echoed = mainnet('PT'); echoed.recipients = s.recipients;
    expect(echoed.say('Manda 5 USDC da Base para a rede Solana, para Minha Solana', bridgeTo(SAVED_RECIPIENT_MARKER, '5'))).toMatchObject({ kind: 'PROPOSAL' });
  });
  it('a saved address of the other ecosystem is refused with the reason (a send cannot cross ecosystems), and ambiguity is a question', () => {
    const s = mainnet('PT'); s.recipients = [saved('Minha Solana', SOL, 'SOLANA')];
    const refused = s.say('Envia 5 USDC na Base para Minha Solana', intent.action(act.transfer({ network: 'BASE', asset: 'USDC', amount: '5' }), 'PT'))!;
    expect(refused).toMatchObject({ kind: 'UNSUPPORTED' });
    expect(refused.text).toMatch(/“Minha Solana” é um endereço Solana, e a Base precisa de um endereço EVM\. Para enviar para a Solana a partir da Base, peça uma bridge/);
    const two = mainnet('PT'); two.recipients = [saved('Carteira da empresa Base', EVM, 'EVM'), saved('Carteira da empresa Arbitrum', '0x1111111111111111111111111111111111111111', 'EVM', 'b')];
    const ask = two.say('envia 5 USDC na Base para a carteira da empresa', intent.action(act.transfer({ network: 'BASE', asset: 'USDC', amount: '5' }), 'PT'))!;
    expect(ask).toMatchObject({ kind: 'CLARIFICATION', options: ['Carteira da empresa Base', 'Carteira da empresa Arbitrum'] });
    expect(ask.command).toBeUndefined();
  });
});

describe('Journey D and management — automations', () => {
  it('managing saved automations is prepared for the owner\'s confirmation, never applied by the conversation', () => {
    const s = mainnet('PT');
    const listed = s.say('Quais automações eu tenho ativas?', { version: '2', language: 'PT', kind: 'AUTOMATION_MANAGE', operation: 'LIST' })!;
    expect(listed).toMatchObject({ kind: 'AUTOMATION_MANAGE', manage: { operation: 'LIST', request: 'Quais automações eu tenho ativas?' } });
    const pause = s.say('Pausa essa automação', { version: '2', language: 'PT', kind: 'AUTOMATION_MANAGE', operation: 'PAUSE' })!;
    expect(pause).toMatchObject({ kind: 'AUTOMATION_MANAGE', text: 'Pronto para pausar. Nada muda até você confirmar.' });
    expect(pause.command).toBeUndefined();
  });
  it('Journey D: "Compra 20 USDC de ETH toda sexta às 10h", "E se o preço cair?", "Muda para segunda" — then, once created, a confirmed replacement', () => {
    const s = mainnet('PT');
    const draft = { kind: 'SCHEDULED_DCA', asset: 'ETH', side: 'BUY', network: 'BASE', amount: '20', spendAsset: 'USDC', time: '10:00', condition: null, threshold: null, percent: null };
    const proposal = s.say('Compra 20 USDC de ETH toda sexta às 10h na Base', { version: '2', language: 'PT', kind: 'AUTOMATION', draft })!;
    expect(proposal).toMatchObject({ kind: 'AUTOMATION_PROPOSAL', automation: { schedule: { frequency: 'WEEKLY', weekday: 5, time: '10:00' } } });
    expect(proposal.text).toMatch(/criar nunca autoriza gastos/);
    const price = s.say('E se o preço cair?')!;
    expect(price).toMatchObject({ kind: 'ANSWER', topic: 'AUTOMATIONS' });
    expect(price.text).toMatch(/^Uma compra recorrente propõe a compra no horário agendado, seja qual for o preço/);
    const monday = s.say('Muda para segunda')!;
    expect(monday).toMatchObject({ kind: 'AUTOMATION_PROPOSAL', automation: { schedule: { frequency: 'WEEKLY', weekday: 1, time: '10:00' }, action: { amount: '20' } } });
    expect(s.say('O que acontece se eu não tiver saldo?')!.text).toMatch(/^O FloFi não verifica o seu saldo/);
    // After the owner created it, a change is a replacement the owner confirms in their own automation view — never applied from the chat.
    s.state = automationCreated(s.state);
    expect(s.say('Muda para sexta-feira')).toMatchObject({ kind: 'AUTOMATION_MANAGE', manage: { operation: 'RESCHEDULE', request: 'Muda para sexta-feira' } });
    expect(s.say('Pausa essa automação')).toMatchObject({ kind: 'AUTOMATION_MANAGE', manage: { operation: 'PAUSE' } });
    expect(s.say('por que minha automação não rodou?')).toMatchObject({ kind: 'AUTOMATION_MANAGE', manage: { operation: 'WHY_NOT_RUN' } });
    expect(s.turns.slice(1).every(turn => turn.request === null && turn.reply?.command === undefined)).toBe(true);
  });
});

describe('platform guidance', () => {
  it('answers configuration questions with FloFi\'s own screens, locally and without changing anything', () => {
    const s = mainnet('PT');
    const connect = s.say('Como conecto minha Phantom?')!;
    expect(connect).toMatchObject({ kind: 'ANSWER', topic: 'PLATFORM', link: { path: '/app/credentials' } });
    expect(connect.text).toMatch(/nunca pede frase semente/);
    expect(s.say('Onde vejo minhas automações?')).toMatchObject({ link: { path: '/app/automations' } });
    expect(s.say('Como vejo as transações anteriores?')).toMatchObject({ link: { path: '/app/workflows' } });
    expect(s.say('Não quero mais receber essas notificações')!.text).toMatch(/STOP/);
    expect(s.turns.every(turn => turn.request === null && turn.reply?.command === undefined)).toBe(true);
  });
});

describe('continuity and safety', () => {
  it('an educational question never cancels an open draft and a conversational "ok" never approves anything', () => {
    const s = mainnet('PT');
    s.say('quero trocar ETH por USDC na Arbitrum One', intent.action(act.swap({ network: 'ARBITRUM', inputAsset: 'ETH', outputAsset: 'USDC' }), 'PT'));
    const draft = s.state.draft;
    s.say('o que é gas?');
    expect(s.state.draft).toBe(draft);
    const ok = s.say('ok')!;
    expect(ok.command).toBeUndefined();
    expect(s.pending).toBeNull();
  });
  it('an answer to FloFi\'s open question always wins over a concept with the same word', () => {
    const s = mainnet();
    s.say('please swap 1 USDC on Arbitrum One', intent.action(act.swap({ network: 'ARBITRUM', inputAsset: 'USDC', outputAsset: null, amount: '1' })));
    expect(s.state.draft?.expected).toContain('outputAsset');
    expect(s.say('WETH')).toMatchObject({ kind: 'PROPOSAL' });
  });
});

describe('review regressions (flofi-security, flofi-chat)', () => {
  const OLD = '0x2222222222222222222222222222222222222222', SAVED_EVM = '0x1111111111111111111111111111111111111111';
  it('no saved name or saved address reaches the model in FloFi\'s own transcript entries (a "which one?" question, a proposal summary)', () => {
    const two = mainnet('PT'); two.recipients = [saved('Carteira da empresa Base', EVM, 'EVM'), saved('Carteira da empresa Arbitrum', SAVED_EVM, 'EVM', 'b')];
    expect(two.say('envia 5 USDC na Base para a carteira da empresa', intent.action(act.transfer({ network: 'BASE', asset: 'USDC', amount: '5' }), 'PT'))!.kind).toBe('CLARIFICATION');
    let sent = '';
    two.say('na verdade, troca 1 ETH por USDC na Base', request => { sent = JSON.stringify(request.messages);
      return { ok: true, intent: intent.action(act.swap({ network: 'BASE', inputAsset: 'ETH', outputAsset: 'USDC', amount: '1' }), 'PT') }; });
    expect(sent).not.toMatch(/Carteira da empresa|carteira da empresa/);
    const s = mainnet('PT'); s.recipients = [saved('Minha Solana', SOL, 'SOLANA')];
    expect(s.say('Manda 5 USDC da Base para a rede Solana, para Minha Solana', intent.action(act.bridge({ sourceNetwork: 'BASE', destinationNetwork: 'SOLANA', asset: 'USDC', amount: '5' }), 'PT'))!.sentence).toContain(SOL);
    s.say('agora troca 1 ETH por USDC na Base', request => { sent = JSON.stringify(request.messages);
      return { ok: true, intent: intent.action(act.swap({ network: 'BASE', inputAsset: 'ETH', outputAsset: 'USDC', amount: '1' }), 'PT') }; });
    expect(sent).not.toContain(SOL);
    expect(sent).not.toMatch(/Minha Solana/);
  });
  it('a saved name in a repeat replaces the carried destination, never keeping the old address', () => {
    const s = mainnet('PT'); s.recipients = [saved('Conta da Ana', SAVED_EVM, 'EVM')];
    expect(s.say(`envia 5 USDC na Base para ${OLD}`, intent.action(act.transfer({ network: 'BASE', asset: 'USDC', amount: '5', recipient: OLD }), 'PT'))!.kind).toBe('PROPOSAL');
    s.apply();
    const again = s.say('manda o mesmo para Conta da Ana', intent.repeat({ recipient: SAVED_RECIPIENT_MARKER }, {}, 'PT'))!;
    expect(again.kind).toBe('PROPOSAL');
    expect(again.sentence).toContain(SAVED_EVM);
    expect(again.sentence).not.toContain(OLD);
  });
  it('"which one?" buttons pick exactly that saved recipient for the same request, without a model call', () => {
    const two = mainnet('PT'); two.recipients = [saved('Carteira da empresa Base', EVM, 'EVM'), saved('Carteira da empresa Arbitrum', SAVED_EVM, 'EVM', 'b')];
    two.say('envia 5 USDC na Base para a carteira da empresa', intent.action(act.transfer({ network: 'BASE', asset: 'USDC', amount: '5' }), 'PT'));
    const picked = two.say('Carteira da empresa Arbitrum')!;
    expect(picked).toMatchObject({ kind: 'PROPOSAL' });
    expect(picked.sentence).toContain(SAVED_EVM);
    expect(two.turns.at(-1)!.request).toBeNull();
  });
  it('a typo reading is shown even when FloFi stops on another field, so the later proposal never carries an unseen correction', () => {
    const s = mainnet();
    const stopped = s.say('swap 1 etherr to XYZ on Arbitrum One', intent.action(act.swap({ network: 'ARBITRUM', inputAsset: 'ETH', outputAsset: 'OTHER', amount: '1' })))!;
    expect(stopped.kind).toBe('UNSUPPORTED');
    expect(stopped.notes).toContain('I read “etherr” as Ether.');
    expect(s.say('USDC', intent.action(act.swap({ network: 'ARBITRUM', inputAsset: 'ETH', outputAsset: 'USDC', amount: '1' })))!.kind).toBe('PROPOSAL');
  });
  it('FloFi\'s own answer buttons win over a concept follow-up ("Across only" after "o que é bridge?" selects the route, it explains nothing)', () => {
    const s = mainnet('PT');
    expect(s.say('quero fazer uma bridge de USDC da Base para a Arbitrum One', intent.action(act.bridge({ sourceNetwork: 'BASE', destinationNetwork: 'ARBITRUM', asset: 'USDC' }), 'PT'))!.kind)
      .toBe('CLARIFICATION');
    expect(s.say('o que é bridge?')).toMatchObject({ kind: 'ANSWER', topic: 'CONCEPT' });
    s.state = { ...s.state, draft: { ...s.state.draft!, shown: ['Só Across'], options: [{ label: 'Só Across', fill: { kind: 'ACTION', patch: { routing: 'ACROSS' } } }] } } as typeof s.state;
    const picked = s.say('Só Across', intent.action(act.bridge({ sourceNetwork: 'BASE', destinationNetwork: 'ARBITRUM', asset: 'USDC', routing: 'ACROSS' }), 'PT'))!;
    expect(picked.topic).not.toBe('CONCEPT');
  });
  it('typo targets are distinctive names only: "Base netwrok" is not read as Arbitrum One', () => {
    const reply = mainnet().say('swap 10 USDC to ETH on Base netwrok', intent.action(act.swap({ network: 'BASE', inputAsset: 'USDC', outputAsset: 'ETH', amount: '10' })))!;
    expect(reply.kind).toBe('PROPOSAL');
    expect(JSON.stringify(reply)).not.toMatch(/Arbitrum/);
  });
  it('a request typed while FloFi waits for a name drops the offer instead of becoming the name; "cancelar" declines', () => {
    const s = mainnet('PT'); s.recipients = []; s.recipientWrites = true;
    s.say(`manda 20 USDC da Base para a Solana ${SOL}`, intent.action(act.bridge({ sourceNetwork: 'BASE', destinationNetwork: 'SOLANA', asset: 'USDC', amount: '20', recipient: SOL }), 'PT'));
    s.say('Salvar');
    expect(s.state.recipientOffer?.naming).toBe(true);
    const next = s.say('troca 1 ETH por USDC na Base', intent.action(act.swap({ network: 'BASE', inputAsset: 'ETH', outputAsset: 'USDC', amount: '1' }), 'PT'))!;
    expect(next.recipientSave).toBeUndefined();
    expect(next.kind).toBe('PROPOSAL');
    const t = mainnet('PT'); t.recipients = []; t.recipientWrites = true;
    t.say(`manda 20 USDC da Base para a Solana ${SOL}`, intent.action(act.bridge({ sourceNetwork: 'BASE', destinationNetwork: 'SOLANA', asset: 'USDC', amount: '20', recipient: SOL }), 'PT'));
    t.say('Salvar');
    expect(t.say('cancelar')).toMatchObject({ kind: 'ANSWER', text: 'Certo, não salvei. Seu pedido continua igual.' });
  });
});

describe('review regressions, round 2 (flofi-security, flofi-transfer-payments, flofi-workflow, flofi-bridge, flofi-data-privacy)', () => {
  const ANA = '0x3333333333333333333333333333333333333333', OLD = '0x2222222222222222222222222222222222222222';
  const send = (fields: Record<string, unknown>) => intent.action(act.transfer({ network: 'BASE', asset: 'USDC', ...fields }), 'PT');
  it('a saved recipient survives FloFi\'s follow-up question: "envia USDC na Base para Ana", then "10", sends to Ana', () => {
    const s = mainnet('PT'); s.recipients = [saved('Ana', ANA, 'EVM')];
    expect(s.say('envia USDC na Base para Ana', send({ amount: null }))!.kind).toBe('CLARIFICATION');
    const proposal = s.say('10')!;
    expect(proposal.kind).toBe('PROPOSAL');
    expect(proposal.sentence).toContain(ANA);
  });
  it('"para mim" / "minha carteira" is the connected wallet, never a saved name; names that would capture it cannot be saved', () => {
    const s = mainnet('PT'); s.recipients = [saved('Ana', ANA, 'EVM')];
    const self = s.say('envia 10 USDC na Base para minha carteira, não para a Ana', send({ amount: '10' }))!;
    expect(JSON.stringify(self)).not.toContain(ANA);
    for (const name of ['Carteira', 'Wallet', 'My wallet Ledger', 'Minha carteira EVM', 'sim', 'ok', '10']) expect(savedRecipientLabel(name), name).toBeNull();
  });
  it('"manda o mesmo para mim" repeats to the connected wallet, never to the carried third party', () => {
    const s = mainnet('PT');
    expect(s.say(`envia 5 USDC na Base para ${OLD}`, send({ amount: '5', recipient: OLD }))!.kind).toBe('PROPOSAL');
    s.apply();
    const again = s.say('manda o mesmo de novo para mim', intent.repeat({}, {}, 'PT'))!;
    expect(again.kind).toBe('PROPOSAL');
    expect(again.sentence).toBe('transfer 5 USDC on Base');
    // The note names the earlier proposal it kept values from, and no longer claims the destination was kept.
    expect(again.notes[0]).toMatch(/: rede, token, valor\.$/);
    expect(again.notes.join(' ')).toMatch(/sua carteira conectada/);
  });
  it('a saved address pasted in full is that saved recipient (the model only sees the marker)', () => {
    const s = mainnet('PT'); s.recipients = [saved('Ana', ANA, 'EVM')];
    let sent = '';
    const reply = s.say(`envia 10 USDC na Base para ${ANA}`, request => { sent = JSON.stringify(request.messages); return { ok: true, intent: send({ amount: '10' }) }; })!;
    expect(sent).not.toContain(ANA);
    expect(reply.kind).toBe('PROPOSAL');
    expect(reply.sentence).toContain(ANA);
  });
  it('a network only the model guessed never refuses a saved recipient for its ecosystem: FloFi asks the network instead', () => {
    const s = mainnet('PT'); s.recipients = [saved('Ana', ANA, 'EVM')];
    const reply = s.say('manda 10 USDC para Ana', intent.action(act.transfer({ network: 'SOLANA', asset: 'USDC', amount: '10' }), 'PT'))!;
    expect(reply.kind).toBe('CLARIFICATION');
    expect(reply.text).not.toMatch(/endereço EVM/);
  });
  it('the words of a saved name never choose a network ("Base da Ana" does not mean Base mainnet)', () => {
    const s = mainnet('PT'); s.recipients = [saved('Base da Ana', ANA, 'EVM')];
    const reply = s.say('manda 10 USDC pra Base da Ana', send({ amount: '10' }))!;
    expect(reply.kind).toBe('CLARIFICATION');
    expect(reply.command).toBeUndefined();
  });
  it('a stale "which one?" button (the recipient was removed) prepares nothing and never falls back to another name', () => {
    const two = mainnet('PT'); two.recipients = [saved('Carteira da empresa Base', EVM, 'EVM'), saved('Carteira da empresa Arbitrum', ANA, 'EVM', 'b')];
    two.say('envia 5 USDC na Base para a carteira da empresa', send({ amount: '5' }));
    two.recipients = [saved('Carteira da empresa Base', EVM, 'EVM')];
    const reply = two.say('Carteira da empresa Arbitrum')!;
    expect(reply.kind).toBe('FAILED');
    expect(reply.command).toBeUndefined();
  });
  it('a new operation does not inherit the abandoned request\'s saved recipient', () => {
    const s = mainnet('PT'); s.recipients = [saved('Ana', ANA, 'EVM')];
    s.say('envia USDC na Base para Ana', send({ amount: null }));
    const bridge = s.say('na verdade, faz bridge de 50 USDC da Arbitrum One para a Base',
      intent.action(act.bridge({ sourceNetwork: 'ARBITRUM', destinationNetwork: 'BASE', asset: 'USDC', amount: '50' }), 'PT'))!;
    expect(JSON.stringify(bridge)).not.toContain(ANA);
  });
  it('masking keeps every name it masked once, even when the list is no longer passed (refresh failed, signed out)', () => {
    const two = mainnet('PT'); two.recipients = [saved('Carteira da empresa Base', EVM, 'EVM'), saved('Mariana', ANA, 'EVM', 'b')];
    two.say('envia 5 USDC na Base para a carteira da empresa', send({ amount: '5' }));
    two.recipients = undefined;
    let sent = '';
    two.say('esquece, troca 1 ETH por USDC na Base', request => { sent = JSON.stringify(request.messages);
      return { ok: true, intent: intent.action(act.swap({ network: 'BASE', inputAsset: 'ETH', outputAsset: 'USDC', amount: '1' }), 'PT') }; });
    expect(sent).not.toMatch(/Carteira da empresa/i);
  });
  it('"trocar 1 ethereum por usdc" names the coin, not the Ethereum network: FloFi asks which network', () => {
    const reply = mainnet('PT').say('trocar 1 ethereum por usdc', intent.action(act.swap({ network: 'ETHEREUM', inputAsset: 'ETH', outputAsset: 'USDC', amount: '1' }), 'PT'))!;
    expect(reply.kind).toBe('CLARIFICATION');
    // "na Ethereum" is the network; "1 USDC na Ethereum para USDC" never reads Ethereum as the coin.
    const network = mainnet('PT').say('quero trocar 1 USDC por ETH na Ethereum', intent.action(act.swap({ network: 'ETHEREUM', inputAsset: 'USDC', outputAsset: 'ETH', amount: '1' }), 'PT'))!;
    expect(network.kind).toBe('PROPOSAL');
  });
  it('a step pinned by an edit question never applies to the next, different request', () => {
    const s = new CopilotSession([FIXTURE.baseSwap, FIXTURE.mainnetBridge]); s.walletChainId = 'eip155:8453'; s.interfaceLanguage = 'PT';
    const asked = s.say('muda a rede do passo 1 para arbriturm', intent.edit({ network: 'ARBITRUM' }, { ordinal: 'FIRST' }, 'PT'))!;
    expect(asked.kind).toBe('CLARIFICATION');
    const removal = s.say('não, remove o passo da bridge', intent.remove({ step: 'BRIDGE' }, 'PT'))!;
    expect(JSON.stringify(removal)).toMatch(/bridge/i);
    expect(JSON.stringify(removal)).not.toMatch(/remove[^"]*swap/i);
  });
});
