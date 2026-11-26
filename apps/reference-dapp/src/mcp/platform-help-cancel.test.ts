// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 (P2): the external review's exact question, "Can I cancel a request before signing, and what if a
 * transaction has already been sent?", returned PLATFORM_TOPIC_UNKNOWN. Over the real
 * gateway, the question and common EN/PT equivalents reach one deterministic answer that keeps apart withdrawing a request, rejecting in the wallet, a
 * sent or pending transaction, an unknown outcome and a confirmed one, never calls a sent transaction cancelled, and claims only chain behaviour that
 * FloFi has; earlier topics keep their questions.
 */
import { describe, expect, it } from 'vitest';
import { matchPlatformTopic, platformAnswer } from '../domain/intelligence/platform-guide';
import { credential, gatewayEnv, session } from './gateway.test-harness.ts';

const alice = { principal: 'dev-alice', token: credential() };
const env = gatewayEnv([alice], { FLOFI_NETWORK_SCOPE: '' });
const QUESTIONS: readonly [string, 'EN' | 'PT'][] = [
  ['Can I cancel a request before signing, and what if a transaction has already been sent?', 'EN'],
  ['Can I cancel a request before I sign it?', 'EN'], ['What if my transaction was already sent?', 'EN'], ['How do I cancel a pending transaction?', 'EN'],
  ['Can I reject it in my wallet?', 'EN'], ['How can I speed up a transaction?', 'EN'], ['What if the transaction is stuck?', 'EN'],
  ['Posso cancelar um pedido antes de assinar? E se a transação já foi enviada?', 'PT'], ['Como cancelo uma solicitação antes de assinar?', 'PT'],
  ['E se a transação já foi enviada?', 'PT'], ['Posso cancelar uma transação pendente?', 'PT'], ['Como rejeito o pedido na minha carteira?', 'PT'],
  ['Como desfaço uma transação enviada?', 'PT'], ['E se a transação estiver presa?', 'PT']];

describe('BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 P2: cancelling a request and transactions already sent', () => {
  it('the exact external question and its EN/PT equivalents resolve to the request and transaction lifecycle answer', async () => {
    for (const [question] of QUESTIONS) expect([question, matchPlatformTopic(question)]).toEqual([question, 'CANCEL_AND_SENT_TRANSACTIONS']);
    const client = session({ env, token: alice.token });
    for (const [question, language] of QUESTIONS) {
      const result = await client.callTool('get_platform_help', { question, language });
      expect(result.output, question).toMatchObject({ ok: true, topic: 'CANCEL_AND_SENT_TRANSACTIONS', resolvedFrom: 'QUESTION', language,
        link: { path: '/connections' } });
    }
    expect((await client.callTool('get_platform_help', { topic: 'CANCEL_AND_SENT_TRANSACTIONS' })).output).toMatchObject({ ok: true, resolvedFrom: 'TOPIC' });
  });

  it('keeps every case apart and never calls a sent transaction cancelled', () => {
    const en = platformAnswer('CANCEL_AND_SENT_TRANSACTIONS', 'EN', 'MCP').text, pt = platformAnswer('CANCEL_AND_SENT_TRANSACTIONS', 'PT', 'MCP').text;
    // Pending approval withdrawal, and its three real places.
    expect(en).toMatch(/withdraw an approval request that has not reached your FloFi signing flow/);
    expect(en).toMatch(/Cancel request in Telegram/);
    expect(en).toMatch(/Connections page/);
    // Wallet rejection.
    expect(en).toMatch(/reject the request in your wallet: nothing is sent while you have not signed/);
    // Submitted: withdrawing never undoes it.
    expect(en).toMatch(/Once a transaction has been sent, FloFi cannot cancel it, and withdrawing the approval does not undo it/);
    // Pending confirmation and the chain-specific behaviour FloFi actually has.
    expect(en).toMatch(/speed up or cancel a pending transaction by replacing it at the same nonce; FloFi never does that for you/);
    expect(en).toMatch(/A Solana transaction cannot be cancelled: it either lands or expires/);
    // Unknown outcome: never resent.
    expect(en).toMatch(/its status is unknown and FloFi never sends it again on its own/);
    // Confirmed: final.
    expect(en).toMatch(/A confirmed transaction is final/);
    expect(en).not.toMatch(/(?:was|is|has been) cancelled because/i);
    // PT says the same, with the PT labels the product uses (Telegram "Cancelar pedido", "Ligações").
    expect(pt).toMatch(/Cancelar pedido no Telegram/);
    expect(pt).toMatch(/Ligações/);
    expect(pt).toMatch(/retirar a aprovação não a desfaz/);
    expect(pt).toMatch(/Uma transação na Solana não pode ser cancelada/);
    expect(pt).toMatch(/nunca a envia de novo por conta própria/);
    expect(platformAnswer('CANCEL_AND_SENT_TRANSACTIONS', 'EN', 'TELEGRAM').modes).not.toContain('APPLY_CHANGE');
  });

  it('earlier and later topics keep their own questions', () => {
    const kept: [string, string | null][] = [['Como revogo uma autorização?', 'AUTHORIZATIONS'], ['How do I revoke an approval?', 'AUTHORIZATIONS'],
      ['Não quero mais receber essas notificações.', 'NOTIFICATIONS'], ['qual o status da transação?', 'EXECUTION_STATUS'],
      ['Como vejo as transações anteriores?', 'HISTORY'], ['how do I delete my account?', 'DELETE_ACCOUNT'],
      ['Can I collect my fees from Telegram?', 'LIQUIDITY_POSITIONS'], ['Como uso a FloFi pelo ChatGPT?', 'AI_AGENTS'],
      // Notifications and status questions keep their topics (flofi-mcp review); "cancel an approval" stays token approvals (unchanged).
      ['Como cancelo o envio de notificações?', 'NOTIFICATIONS'], ['How do I cancel notifications sent by FloFi?', 'NOTIFICATIONS'],
      ['Como interrompo o envio de alertas?', 'NOTIFICATIONS'], ['qual o status da transação pendente?', 'EXECUTION_STATUS'], ['Can I cancel an approval?', 'AUTHORIZATIONS'],
      // A request with an amount or an address is never a help question.
      ['cancel the transfer of 5 USDC', null], ['envia 10 USDC para 0x1111111111111111111111111111111111111111', null]];
    for (const [text, topic] of kept) expect([text, matchPlatformTopic(text)]).toEqual([text, topic]);
  });
});
