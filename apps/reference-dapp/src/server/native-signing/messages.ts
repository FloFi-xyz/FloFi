// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-NATIVE-CHANNEL-SIGNING-001: what a native signing session tells its conversation, in English and Portuguese: the Review with its one-tap
 * confirmation, that the signed transaction was sent once, or why it ended — and whether anything could have been sent. Plain text written by
 * FloFi; codes never reach the person.
 */
import { userFacingError } from '../../platform/conversation-state.ts';
import { DEEPLINK_WALLETS } from './deeplink/protocol.ts';
import { nativeReviewLines } from './review.ts';
import type { NativeEvent } from './service.ts';
import type { NativeSession } from './session-store.ts';

type Both = { readonly EN: string; readonly PT: string };
export type NativeMessage = { readonly dedupeKey: string; readonly text: Both; readonly link: { readonly label: Both; readonly url: string } | null };

/** Why a session ended, in plain words, and whether anything could have been sent. */
export function nativeEndedText(s: NativeSession, wallet: string = DEEPLINK_WALLETS[s.wallet].name): Both {
  const code = s.outcome?.code ?? 'NATIVE_SESSION_ENDED';
  if (s.outcome?.afterSignature) return { EN: `Your wallet signed, but FloFi could not confirm the sending yet. It never sends it twice: the status of this proposal follows here.`,
    PT: `A sua carteira assinou, mas a FloFi ainda não conseguiu confirmar o envio. Ela nunca envia duas vezes: o status desta proposta segue aqui.` };
  return nativeRefusalText(code, wallet);
}
/** A refusal (a session's end, a start or a confirmation that could not go on) in plain words, never its code. */
export function nativeRefusalText(code: string, wallet: string): Both {
  const known: Record<string, Both> = {
    WALLET_REQUEST_REJECTED: { EN: `You rejected the request in ${wallet}. Nothing was signed or sent.`, PT: `Você recusou o pedido no ${wallet}. Nada foi assinado nem enviado.` },
    NATIVE_SESSION_EXPIRED: { EN: `This ${wallet} request expired before it was answered. Nothing was sent. You can start again from the proposal while it is still open, or ask for a new one.`,
      PT: `Este pedido do ${wallet} expirou antes de ser respondido. Nada foi enviado. Você pode recomeçar pela proposta enquanto ela estiver aberta, ou pedir uma nova.` },
    HANDOFF_ALREADY_CLAIMED: { EN: 'Another wallet already took this proposal. Nothing was sent from this request.', PT: 'Outra carteira já assumiu esta proposta. Nada foi enviado por este pedido.' },
    CHANNEL_INTENDED_WALLET_MISMATCH: { EN: 'This proposal was prepared for another wallet. Connect the wallet it names. Nothing was sent.',
      PT: 'Esta proposta foi preparada para outra carteira. Conecte a carteira indicada nela. Nada foi enviado.' },
    NATIVE_PROOF_EXPIRED: { EN: `The sign-in in ${wallet} came after its five minutes. Nothing was signed or sent. You can start again from the proposal while it is still open, or ask for a new one.`,
      PT: `O login no ${wallet} chegou depois dos cinco minutos dele. Nada foi assinado nem enviado. Você pode recomeçar pela proposta enquanto ela estiver aberta, ou pedir uma nova.` },
    NATIVE_SIGNING_STATUS_NOT_SHARED: { EN: 'This proposal was opened on FloFi without sharing its status with this conversation, so it cannot continue here. Finish it on FloFi, or ask for a new proposal. Nothing was sent from this request.',
      PT: 'Esta proposta foi aberta na FloFi sem compartilhar o status com esta conversa, então não pode continuar aqui. Conclua na FloFi ou peça uma nova proposta. Nada foi enviado por este pedido.' },
    NATIVE_CONFIRMATION_LAPSED: { EN: `This ${wallet} request lapsed before it was signed. If you sign it now, FloFi refuses it and nothing is sent. Start again from the proposal while it is still open.`,
      PT: `Este pedido do ${wallet} venceu antes de ser assinado. Se você assinar agora, a FloFi recusa e nada é enviado. Recomece pela proposta enquanto ela estiver aberta.` },
    NATIVE_SIGNING_ALREADY_SENT: { EN: 'This proposal may already have been sent from your wallet, so FloFi does not ask your wallet for it again. Check its status here.',
      PT: 'Esta proposta pode já ter sido enviada pela sua carteira, então a FloFi não pede de novo à carteira. Confira o status aqui.' },
    NATIVE_SIGNING_WALLET_REQUEST_OPEN: { EN: 'Another wallet request for this proposal is still open. Answer or reject it in your wallet first. Nothing was sent by this one.',
      PT: 'Outro pedido à carteira para esta proposta ainda está aberto. Responda ou recuse na sua carteira primeiro. Nada foi enviado por este.' },
  };
  if (known[code]) return known[code]!;
  if (/^BETA_/.test(code)) return { EN: 'Signing from this conversation is not open to your account in this beta yet. Use the Authorize button to finish in FloFi. Nothing was sent.',
    PT: 'Assinar por esta conversa ainda não está aberto para a sua conta nesta fase beta. Use o botão Autorizar para concluir na FloFi. Nada foi enviado.' };
  const plain = userFacingError(code);
  const sent = /nothing was (?:signed or )?sent/i.test(plain.EN);
  return { EN: `${plain.EN}${sent ? '' : ' Nothing was sent.'}`, PT: `${plain.PT}${sent ? '' : ' Nada foi enviado.'}` };
}

/** The message for one session event (`confirmRef`: the Review's single-use reference), or null when the event says nothing new to the conversation. */
export function nativeMessage(origin: string, s: NativeSession, event: NativeEvent, confirmRef: string | null = null): NativeMessage | null {
  const wallet = DEEPLINK_WALLETS[s.wallet].name;
  if (event === 'PROGRESS') return null;
  if (event === 'REVIEW_READY') {
    if (!s.review || !confirmRef) return null;
    const tail = { EN: `Tap Confirm in ${wallet} and ${wallet} asks you to sign exactly this. If the Review lapses first, FloFi simulates again and only continues when the terms are no worse; otherwise it shows you a new Review here. Signing this way shares this operation's status with this conversation: FloFi posts its status and receipt here.`,
      PT: `Toque em Confirmar no ${wallet} e o ${wallet} pede que você assine exatamente isto. Se a Revisão vencer antes, a FloFi simula de novo e só continua se os termos não forem piores; caso contrário, mostra uma nova Revisão aqui. Assinando assim, o status desta operação é compartilhado com esta conversa: a FloFi publica o status e o recibo aqui.` };
    return { dedupeKey: `native:${s.id}:review:${s.review.runId}`,
      text: { EN: [...nativeReviewLines(s.review, 'EN', { shortOwner: true }), tail.EN].join('\n'), PT: [...nativeReviewLines(s.review, 'PT', { shortOwner: true }), tail.PT].join('\n') },
      link: { label: { EN: `Confirm in ${wallet}`, PT: `Confirmar no ${wallet}` }, url: `${origin}/api/native-signing/${s.handoffId}/${s.id}/confirm/${confirmRef}` } };
  }
  if (event === 'REVIEW_RENEWED') {
    if (!s.review) return null;
    const head = { EN: `FloFi simulated again just before asking ${wallet}. These terms are no worse than the ones you confirmed, and they are what ${wallet} shows you:`,
      PT: `A FloFi simulou de novo logo antes de chamar o ${wallet}. Estes termos não são piores que os que você confirmou, e são os que o ${wallet} mostra:` };
    return { dedupeKey: `native:${s.id}:renewed:${s.review.runId}`, link: null,
      text: { EN: [head.EN, ...nativeReviewLines(s.review, 'EN', { shortOwner: true })].join('\n'), PT: [head.PT, ...nativeReviewLines(s.review, 'PT', { shortOwner: true })].join('\n') } };
  }
  if (event === 'SUBMITTED') return { dedupeKey: `native:${s.id}:submitted`, link: null,
    // A sending whose answer was lost (it may or may not have landed) is never told as a plain success.
    text: s.outcome?.code ? { EN: `Signed in ${wallet}. FloFi handed it to the network once, but its result is not confirmed yet. FloFi never sends it again; it follows the network and posts the verified result here.`,
      PT: `Assinado no ${wallet}. A FloFi entregou à rede uma única vez, mas o resultado ainda não está confirmado. A FloFi nunca envia de novo; ela acompanha a rede e publica o resultado verificado aqui.` }
      : { EN: `Signed in ${wallet} and handed to the network once by FloFi (never again). FloFi now follows the network and posts the verified result here; nothing else needs your wallet.`,
        PT: `Assinado no ${wallet} e entregue à rede uma única vez pela FloFi (nunca de novo). A FloFi acompanha a rede e publica o resultado verificado aqui; nada mais precisa da sua carteira.` } };
  return { dedupeKey: `native:${s.id}:ended`, link: null, text: nativeEndedText(s, wallet) };
}
