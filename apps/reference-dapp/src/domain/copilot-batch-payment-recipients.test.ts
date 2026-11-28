// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (R09–R12, P1 §6): a Batch Payment authored and edited in the chat with the account's Saved Recipients,
 * always on the SAME Batch Payment card. Driven through the real conversation engine, exact grammar, editor and the committed official catalog
 * fixtures with scripted model answers (no model, provider, wallet or network is reached; nothing is simulated, signed or executed).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BATCH_PAYMENT_ACTION } from '@defi-workflow-engine/workflow-contracts';
import { CopilotSession, act, intent } from './copilot-session.test-harness';
import { setActiveNetworkScope } from './network-scope';
import { registerFixtureCatalogs, resetNetworkCatalogs } from './intelligence/intelligence.test-harness';
import type { SavedRecipient } from './saved-recipients';
import type { CopilotRequestV2, CopilotResultV2 } from './copilot-conversation';

beforeAll(registerFixtureCatalogs);
afterAll(() => { resetNetworkCatalogs(); setActiveNetworkScope(null); });
beforeEach(() => setActiveNetworkScope('PUBLIC_MAINNET'));

const CAIO = '0x52908400098527886e0f7030069857d2e4169ee7', DAYANE = '0x3333333333333333333333333333333333333333';
const PEDRO = '0x4444444444444444444444444444444444444444', TYPED = '0x5555555555555555555555555555555555555555';
const SOL = 'GsWtMd3S5133XPhnfeR1CvPLcLxBSknhVhmaW7fHevBq', UNSAVED_SOL = '2CERLkG39Jq8zc8FaVkmHjkpsptwQVFMwzvWQgdtmCzb';
const saved = (label: string, address: string, ecosystem: 'EVM' | 'SOLANA', id: string): SavedRecipient =>
  ({ id: `rcp_${id.padEnd(26, 'a')}`, label, address, ecosystem, createdAt: '2026-11-15T12:00:00.000Z', updatedAt: '2026-11-15T12:00:00.000Z' });
const BOOK = [saved('Caio', CAIO, 'EVM', 'b'), saved('Dayane', DAYANE, 'EVM', 'c'), saved('Pedro', PEDRO, 'EVM', 'd')];
const session = (language: 'EN' | 'PT' = 'PT', recipients: readonly SavedRecipient[] = BOOK) => {
  const s = new CopilotSession(); s.walletChainId = 'eip155:8453'; s.interfaceLanguage = language; s.recipients = recipients; return s;
};
const base = (amount: string, recipient: string | null = null, network: string | null = 'BASE', asset = 'USDC') => act.transfer({ network, asset, amount, recipient });
/** The scripted model: records what left for it, answers `answer`. */
function model(answer: Record<string, unknown>, sent: string[]): (request: CopilotRequestV2) => CopilotResultV2 {
  return request => { sent.push(JSON.stringify(request)); return { ok: true, intent: answer }; };
}
const batchOf = (s: CopilotSession) => s.workflow.nodes.filter(node => node.actionType === BATCH_PAYMENT_ACTION);

describe('R09–R12 journey: one Batch Payment card built and edited in the chat with saved recipients', () => {
  it('"Envie 20 USDC para Caio e 30 USDC para Dayane pela Base." then "Adicione mais 10 USDC para Pedro." — the same card, 3 recipients, 60 USDC', () => {
    const s = session(), sent: string[] = [];
    const created = s.say('Envie 20 USDC para Caio e 30 USDC para Dayane pela Base.', model(intent.composition([base('20'), base('30')], 'PT'), sent))!;
    expect(created).toMatchObject({ kind: 'PROPOSAL', command: { type: 'ADD_BATCH_PAYMENT', input: { network: 'Base', asset: 'USDC',
      payments: [{ recipient: CAIO, amount: '20' }, { recipient: DAYANE, amount: '30' }] } } });
    // Neither a saved name nor its address ever left for the model.
    expect(sent.join(' ')).not.toMatch(/Caio|Dayane|0x5290|0x3333/i);
    expect(created.text).toContain(`1. 20 USDC → Caio · ${CAIO}`);
    s.apply();
    expect(batchOf(s)).toHaveLength(1);
    const card = batchOf(s)[0]!.nodeId;
    // The addition is resolved locally (no model call: the harness throws on one) and edits the SAME card.
    const added = s.say('Adicione mais 10 USDC para Pedro.')!;
    expect(added).toMatchObject({ kind: 'PROPOSAL', command: { type: 'SET_BATCH_PAYMENT', nodeId: card, input: { network: 'Base', asset: 'USDC',
      payments: [{ recipient: CAIO, amount: '20' }, { recipient: DAYANE, amount: '30' }, { recipient: PEDRO, amount: '10' }] } } });
    expect(added.text).toMatch(/^Pedro foi adicionado\. Agora são 3 destinatários e um total de 60 USDC\./);
    s.apply();
    expect(batchOf(s)).toHaveLength(1);
    expect(batchOf(s)[0]!.nodeId).toBe(card);
  });
});

/** A saved two-payment batch (Caio 20, Dayane 30 on Base), applied: the card later edits target. */
function withBatch(language: 'EN' | 'PT' = 'PT', recipients: readonly SavedRecipient[] = BOOK) {
  const s = session(language, recipients);
  s.say(language === 'PT' ? 'Envie 20 USDC para Caio e 30 USDC para Dayane pela Base.' : 'Send 20 USDC to Caio and 30 USDC to Dayane on Base',
    model(intent.composition([base('20'), base('30')], language), []));
  s.apply();
  return { s, card: batchOf(s)[0]!.nodeId };
}
const payments = (reply: { command?: unknown } | null) => (reply?.command as { input: { payments: unknown } } | undefined)?.input.payments;

describe('R09–R12: creating one Batch Payment from saved names and addresses', () => {
  it('one amount for several recipients ("10 USDC para Caio e Pedro"): one payment each, whether the interpretation read one send or two', () => {
    for (const sends of [[base('10'), base('10')]]) {
      const s = session();
      const reply = s.say('Envie 10 USDC para Caio e Pedro na Base', model(intent.composition(sends, 'PT'), []))!;
      expect(reply, JSON.stringify(sends)).toMatchObject({ kind: 'PROPOSAL', command: { type: 'ADD_BATCH_PAYMENT' } });
      expect(payments(reply)).toEqual([{ recipient: CAIO, amount: '10' }, { recipient: PEDRO, amount: '10' }]);
    }
    // The interpretation's single action (not a composition) is the same request.
    const single = session().say('Envie 10 USDC para Caio e Pedro na Base', model(intent.action(base('10'), 'PT'), []))!;
    expect(payments(single)).toEqual([{ recipient: CAIO, amount: '10' }, { recipient: PEDRO, amount: '10' }]);
  });
  it('explicit addresses mix with saved names, each in the person\'s order; English works the same way', () => {
    const reply = session().say(`Envie 20 USDC para Caio e 30 USDC para ${TYPED} na Base`, model(intent.composition([base('20'), base('30', TYPED)], 'PT'), []))!;
    expect(payments(reply)).toEqual([{ recipient: CAIO, amount: '20' }, { recipient: TYPED, amount: '30' }]);
    const en = session('EN').say(`Send 5 USDC to Dayane, 7 USDC to ${TYPED} and 9 USDC to Pedro on Base`,
      model(intent.composition([base('5'), base('7', TYPED), base('9')]), []))!;
    expect(payments(en)).toEqual([{ recipient: DAYANE, amount: '5' }, { recipient: TYPED, amount: '7' }, { recipient: PEDRO, amount: '9' }]);
    expect(en.text).toContain(`1. 5 USDC → Dayane · ${DAYANE} 2. 7 USDC → ${TYPED} 3. 9 USDC → Pedro · ${PEDRO}`);
  });
  it('never invents an address: a recipient the interpretation wrote for a name, or a swapped amount, prepares nothing and FloFi asks', () => {
    for (const sends of [[base('20', '0x9999999999999999999999999999999999999999'), base('30')], [base('30'), base('20')]]) {
      const s = session();
      const reply = s.say('Envie 20 USDC para Caio e 30 USDC para Dayane pela Base.', model(intent.composition(sends, 'PT'), []))!;
      expect(reply.kind, JSON.stringify(sends)).toBe('CLARIFICATION');
      expect(reply.command).toBeUndefined(); expect(s.pending).toBeNull();
      expect(reply.text).toContain('Sua mensagem associa: 1. 20 USDC → Caio; 2. 30 USDC → Dayane.');
    }
  });
  it('several saved matches ask which one (the existing buttons, sent verbatim); the answer prepares the batch without the model', () => {
    const company = [...BOOK, saved('Carteira da empresa Base', TYPED, 'EVM', 'e'), saved('Carteira da empresa Arbitrum', '0x6666666666666666666666666666666666666666', 'EVM', 'f')];
    const s = session('PT', company);
    const asked = s.say('Envie 20 USDC para Caio e 30 USDC para carteira da empresa na Base', model(intent.composition([base('20'), base('30')], 'PT'), []))!;
    expect(asked).toMatchObject({ kind: 'CLARIFICATION', options: ['Carteira da empresa Base', 'Carteira da empresa Arbitrum'], verbatimOptions: true });
    expect(asked.text).toBe('Qual destinatário salvo você quer usar: “Carteira da empresa Base” ou “Carteira da empresa Arbitrum”?');
    const picked = s.say('Carteira da empresa Base')!;
    expect(picked).toMatchObject({ kind: 'PROPOSAL', command: { type: 'ADD_BATCH_PAYMENT' } });
    expect(payments(picked)).toEqual([{ recipient: CAIO, amount: '20' }, { recipient: TYPED, amount: '30' }]);
  });
  it('a name that is not saved asks for a valid address; an invalid one is asked again ("Informe um endereço válido."), a valid one completes the batch', () => {
    const s = session();
    const asked = s.say('Envie 20 USDC para Caio e 30 USDC para Joana na Base', model(intent.composition([base('20'), base('30')], 'PT'), []))!;
    expect(asked).toMatchObject({ kind: 'CLARIFICATION', text: 'Não encontrei “Joana” nos seus destinatários salvos. Informe o endereço completo de Joana.' });
    expect(asked.command).toBeUndefined();
    expect(s.say('0x123')).toMatchObject({ kind: 'CLARIFICATION', text: 'Informe um endereço válido.' });
    const done = s.say(TYPED)!;
    expect(done).toMatchObject({ kind: 'PROPOSAL', command: { type: 'ADD_BATCH_PAYMENT' } });
    expect(payments(done)).toEqual([{ recipient: CAIO, amount: '20' }, { recipient: TYPED, amount: '30' }]);
  });
  it('network-compatible resolution: a saved Solana address in a Base batch is refused with the reason (nothing prepared)', () => {
    const s = session('PT', [...BOOK, saved('Minha Solana', SOL, 'SOLANA', 'g')]);
    const reply = s.say('Envie 20 USDC para Caio e 5 USDC para Minha Solana na Base', model(intent.composition([base('20'), base('5')], 'PT'), []))!;
    expect(reply.kind).toBe('UNSUPPORTED'); expect(s.pending).toBeNull();
    expect(reply.text).toMatch(/^“Minha Solana” é um endereço Solana, e a Base precisa de um endereço EVM\./);
  });
  it('an amount with two readings ("1.000") is asked about before anything is paired', () => {
    const s = session();
    const asked = s.say('Envie 1.000 USDC para Caio e 20 USDC para Dayane na Base', model(intent.composition([base('1000'), base('20')], 'PT'), []))!;
    expect(asked).toMatchObject({ kind: 'CLARIFICATION', options: ['1', '1000'] });
    expect(payments(s.say('1000'))).toEqual([{ recipient: CAIO, amount: '1000' }, { recipient: DAYANE, amount: '20' }]);
  });
  it('a saved name written twice is refused, never merged', () => {
    const reply = session().say('Envie 20 USDC para Caio e 30 USDC para Caio na Base', model(intent.composition([base('20'), base('30')], 'PT'), []))!;
    expect(reply.kind).toBe('UNSUPPORTED');
    expect(reply.text).toMatch(/^Caio aparece mais de uma vez\./);
  });
});

describe('R09–R12: editing the same Batch Payment card in the chat (no model call: the harness throws on one)', () => {
  it('changes one recipient\'s amount: "mude o Caio para 25" (before → after, the new total)', () => {
    const { s, card } = withBatch();
    const reply = s.say('mude o Caio para 25')!;
    expect(reply).toMatchObject({ kind: 'PROPOSAL', command: { type: 'SET_BATCH_PAYMENT', nodeId: card } });
    expect(payments(reply)).toEqual([{ recipient: CAIO, amount: '25' }, { recipient: DAYANE, amount: '30' }]);
    expect(reply.text).toMatch(/^Caio: 20 → 25 USDC\. Agora são 2 destinatários e um total de 55 USDC\./);
    const en = withBatch('EN');
    expect(en.s.say('change Dayane\'s amount to 12.5 USDC')!.text).toMatch(/^Dayane: 30 → 12\.5 USDC\. Now there are 2 recipients and a total of 32\.5 USDC\./);
  });
  it('removes and replaces a recipient on the same card', () => {
    const { s, card } = withBatch();
    s.say('Adicione mais 10 USDC para Pedro.'); s.apply();
    const removed = s.say('remova a Dayane')!;
    expect(removed).toMatchObject({ kind: 'PROPOSAL', command: { type: 'SET_BATCH_PAYMENT', nodeId: card } });
    expect(payments(removed)).toEqual([{ recipient: CAIO, amount: '20' }, { recipient: PEDRO, amount: '10' }]);
    expect(removed.text).toMatch(/^Removi Dayane do pagamento\. Agora são 2 destinatários e um total de 30 USDC\./);
    s.dismiss();
    const replaced = s.say(`troque Dayane por ${TYPED}`)!;
    expect(payments(replaced)).toEqual([{ recipient: CAIO, amount: '20' }, { recipient: TYPED, amount: '30' }, { recipient: PEDRO, amount: '10' }]);
    expect(replaced.text).toMatch(/^Troquei Dayane por 0x5555…5555\./);
  });
  it('one amount for several recipients, several saved names and an address in one addition', () => {
    const { s } = withBatch('EN');
    const reply = s.say(`add 4 USDC for Pedro and ${TYPED}`)!;
    expect(payments(reply)).toEqual([{ recipient: CAIO, amount: '20' }, { recipient: DAYANE, amount: '30' }, { recipient: PEDRO, amount: '4' }, { recipient: TYPED, amount: '4' }]);
    expect(reply.text).toMatch(/^Pedro and 0x5555…5555 were added\. Now there are 4 recipients and a total of 58 USDC\./);
  });
  it('asks which saved recipient, or for the address of a name that is not saved, then edits the card', () => {
    const company = [...BOOK, saved('Carteira da empresa Base', TYPED, 'EVM', 'e'), saved('Carteira da empresa Arbitrum', '0x6666666666666666666666666666666666666666', 'EVM', 'f')];
    const { s, card } = withBatch('PT', company);
    const asked = s.say('adicione 10 USDC para carteira da empresa')!;
    expect(asked).toMatchObject({ kind: 'CLARIFICATION', options: ['Carteira da empresa Base', 'Carteira da empresa Arbitrum'], verbatimOptions: true });
    const picked = s.say('Carteira da empresa Base')!;
    expect(picked).toMatchObject({ kind: 'PROPOSAL', command: { type: 'SET_BATCH_PAYMENT', nodeId: card } });
    expect(payments(picked)).toEqual([{ recipient: CAIO, amount: '20' }, { recipient: DAYANE, amount: '30' }, { recipient: TYPED, amount: '10' }]);
    s.dismiss();
    expect(s.say('adicione 3 USDC para Joana')).toMatchObject({ kind: 'CLARIFICATION', text: 'Não encontrei “Joana” nos seus destinatários salvos. Informe o endereço completo de Joana.' });
    expect(s.say('0xabc')).toMatchObject({ kind: 'CLARIFICATION', text: 'Informe um endereço válido.' });
    const typed = s.say('0x7777777777777777777777777777777777777777')!;
    expect(payments(typed)).toEqual([{ recipient: CAIO, amount: '20' }, { recipient: DAYANE, amount: '30' }, { recipient: '0x7777777777777777777777777777777777777777', amount: '3' }]);
  });
  it('refuses what a Batch Payment cannot do, with the reason: another asset or network, a recipient already in it, a Solana address, the person\'s own wallet', () => {
    const { s } = withBatch('PT', [...BOOK, saved('Minha Solana', SOL, 'SOLANA', 'g')]);
    const cases: readonly (readonly [string, RegExp])[] = [
      ['adicione 10 ETH para Pedro', /^Este pagamento em lote paga USDC: todos os destinatários recebem o mesmo ativo\. Nada mudou\./],
      ['adicione 10 USDC para Pedro na Arbitrum', /^Este pagamento em lote está na Base: todos os pagamentos usam a mesma rede\. Nada mudou\./],
      ['adicione 10 USDC para Caio', /^Caio já está neste pagamento\./],
      ['adicione 10 USDC para Minha Solana', /^“Minha Solana” é um endereço Solana, e a Base precisa de um endereço EVM\./],
      ['adicione 10 USDC para mim', /^Um pagamento em lote precisa do endereço de cada destinatário/],
      [`adicione 10 USDC para ${UNSAVED_SOL}`, /^Informe um endereço válido\./],
    ];
    for (const [request, message] of cases) {
      const reply = s.say(request)!;
      expect(reply.kind, request).toBe('UNSUPPORTED');
      expect(reply.text, request).toMatch(message);
      expect(s.pending, request).toBeNull();
    }
    // Removing all but one recipient is the card's own refusal (a Batch Payment pays at least two).
    expect(s.say('remova a Dayane')!.text).toMatch(/pelo menos 2 destinatários/);
  });
  it('words that are not this payment\'s recipients are read as before (the interpretation decides)', () => {
    const { s } = withBatch();
    for (const request of ['remova o segundo passo', 'troque 1 ETH por USDC na Base', 'mude o valor do swap para 25']) expect(() => s.say(request), request).toThrow('unexpected model call');
    // Without a Batch Payment in the workflow an "add" is not an edit either.
    expect(() => session().say('Adicione mais 10 USDC para Pedro.')).toThrow('unexpected model call');
  });
  it('saved names and addresses never leave for the model in a later turn (FloFi\'s own messages included)', () => {
    const { s } = withBatch();
    s.say('Adicione mais 10 USDC para Pedro.'); s.apply();
    s.say('mude o Caio para 25'); s.apply();
    const sent: string[] = [];
    s.say('o que esse fluxo faz?', model(intent.question('WORKFLOW_OVERVIEW', null, 'PT'), sent));
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toMatch(/Caio|Dayane|Pedro|0x5290|0x3333|0x4444/i);
  });
});
