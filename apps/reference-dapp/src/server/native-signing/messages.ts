// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-NATIVE-CHANNEL-SIGNING-001: what a native signing session tells its conversation, in English and Portuguese: the Review with its one-tap
 * confirmation, that the signed transaction was sent once, or why it ended — and whether anything could have been sent. Plain text written by
 * FloFi; codes never reach the person.
 */
import { userFacingError } from '../../platform/conversation-state.ts';
import { DEEPLINK_WALLETS } from '../../wallet/deeplink/protocol.ts';
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
  const known: Record<string, Both> = {
    WALLET_REQUEST_REJECTED: { EN: `You rejected the request in ${wallet}. Nothing was signed or sent.`, PT: `Você recusou o pedido no ${wallet}. Nada foi assinado nem enviado.` },
    NATIVE_SESSION_EXPIRED: { EN: `This ${wallet} request expired before it was answered. Nothing was sent. Tap Sign with ${wallet} again to start over.`,
      PT: `Este pedido do ${wallet} expirou antes de ser respondido. Nada foi enviado. Toque em Assinar com ${wallet} de novo para recomeçar.` },
    HANDOFF_ALREADY_CLAIMED: { EN: 'Another wallet already took this proposal. Nothing was sent from this request.', PT: 'Outra carteira já assumiu esta proposta. Nada foi enviado por este pedido.' },
    CHANNEL_INTENDED_WALLET_MISMATCH: { EN: 'This proposal was prepared for another wallet. Connect the wallet it names. Nothing was sent.',
      PT: 'Esta proposta foi preparada para outra carteira. Conecte a carteira indicada nela. Nada foi enviado.' },
  };
  if (known[code]) return known[code]!;
  if (/^BETA_/.test(code)) return { EN: 'Signing from this conversation is not open to your account in this beta yet. Use the Authorize button to finish in FloFi. Nothing was sent.',
    PT: 'Assinar por esta conversa ainda não está aberto para a sua conta nesta fase beta. Use o botão Autorizar para concluir na FloFi. Nada foi enviado.' };
  const plain = userFacingError(code);
  const sent = /nothing was (?:signed or )?sent/i.test(plain.EN);
  return { EN: `${plain.EN}${sent ? '' : ' Nothing was sent.'}`, PT: `${plain.PT}${sent ? '' : ' Nada foi enviado.'}` };
}

/** The message for one session event, or null when the event says nothing new to the conversation. */
export function nativeMessage(origin: string, s: NativeSession, event: NativeEvent): NativeMessage | null {
  const wallet = DEEPLINK_WALLETS[s.wallet].name;
  if (event === 'REVIEW_READY') {
    if (!s.review || !s.confirmTag) return null;
    const tail = { EN: `Tap Confirm in ${wallet} and ${wallet} asks you to sign exactly this. If the Review lapses first, FloFi simulates again and only continues when the terms are no worse; otherwise it shows you a new Review here.`,
      PT: `Toque em Confirmar no ${wallet} e o ${wallet} pede que você assine exatamente isto. Se a Revisão vencer antes, a FloFi simula de novo e só continua se os termos não forem piores; caso contrário, mostra uma nova Revisão aqui.` };
    return { dedupeKey: `native:${s.id}:review:${s.review.runId}`,
      text: { EN: [...nativeReviewLines(s.review, 'EN'), tail.EN].join('\n'), PT: [...nativeReviewLines(s.review, 'PT'), tail.PT].join('\n') },
      link: { label: { EN: `Confirm in ${wallet}`, PT: `Confirmar no ${wallet}` }, url: `${origin}/api/native-signing/${s.handoffId}/${s.id}/confirm/${s.confirmTag}` } };
  }
  if (event === 'SUBMITTED') return { dedupeKey: `native:${s.id}:submitted`, link: null,
    text: { EN: `Signed in ${wallet} and sent once by FloFi. FloFi now follows the network and posts the verified receipt here; nothing else needs your wallet.`,
      PT: `Assinado no ${wallet} e enviado uma única vez pela FloFi. A FloFi acompanha a rede e publica o recibo verificado aqui; nada mais precisa da sua carteira.` } };
  return { dedupeKey: `native:${s.id}:ended`, link: null, text: nativeEndedText(s, wallet) };
}
