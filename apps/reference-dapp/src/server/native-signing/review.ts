// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-NATIVE-CHANNEL-SIGNING-001: the financial Review a conversation shows before the owner's wallet is asked — taken only from the flow's
 * own fresh simulation of this owner's exact transaction (the same record the FloFi signing page reviews), never from a model, a quote or the
 * proposal text. Amounts use FloFi's one display rule (six significant digits, `≈` only on an estimate, a minimum rounded down).
 */
import { formatDisplayTokenAmount } from '../../domain/token-amount-display.ts';
import type { NativeFlow, NativeReview } from './session-store.ts';

type Json = Readonly<Record<string, unknown>>;
const obj = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const fail = (code: string): never => { throw new Error(code); };
const units = (value: unknown): string => typeof value === 'string' && /^(0|[1-9][0-9]{0,30})$/.test(value) ? value : fail('NATIVE_REVIEW_INVALID');
const decimals = (value: unknown): number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 18 ? value : fail('NATIVE_REVIEW_INVALID');
const symbol = (value: unknown): string => typeof value === 'string' && /^[A-Za-z0-9.$_-]{1,24}$/.test(value) ? value : fail('NATIVE_REVIEW_INVALID');
const account = (value: unknown): string => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) ? value : fail('NATIVE_REVIEW_INVALID');
const text = (value: unknown, pattern: RegExp): string => typeof value === 'string' && pattern.test(value) ? value : fail('NATIVE_REVIEW_INVALID');

/** The Review of a simulated run of one of the native flows (`record` as the flow's `simulate` returned it). */
export function nativeReviewOf(flow: NativeFlow, record: unknown): NativeReview {
  const r = obj(record), review = obj(r.review), gas = review.gas ? obj(review.gas) : null, token = gas ? obj(gas.token) : null;
  const base = { flow, runId: text(r.id, /^[a-z]{4,8}-[a-f0-9]{32}$/), commitment: text(review.commitment, /^[A-Za-z0-9:_-]{8,200}$/),
    expiresAt: text(review.expiresAt, /^\d{4}-\d{2}-\d{2}T/), owner: account(review.owner), network: text(review.network ?? 'Solana', /^Solana( Devnet)?$/),
    feeToken: gas && token ? { symbol: symbol(token.symbol), amount: units(gas.amount), decimals: decimals(token.decimals) } : null };
  if (flow === 'jupiter-swap') {
    const input = obj(review.input), output = obj(review.output), quote = obj(review.quote);
    return { ...base, network: 'Solana', action: 'swap', pay: { symbol: symbol(input.symbol), amount: units(review.amount), decimals: decimals(input.decimals) },
      receive: { symbol: symbol(output.symbol), amount: units(quote.outAmount), decimals: decimals(output.decimals), minimum: units(quote.otherAmountThreshold) },
      recipient: null, maximumNetworkCostLamports: gas ? null : units(String(BigInt(units(review.estimatedFeeLamports))
        + BigInt(units(obj(review.simulationResult).accountCreationLamports ?? '0')))) };
  }
  const asset = obj(review.asset);
  return { ...base, action: 'transfer', pay: { symbol: symbol(asset.symbol), amount: units(review.amount), decimals: decimals(asset.decimals) }, receive: null,
    recipient: account(review.recipient), maximumNetworkCostLamports: gas ? null : units(review.maximumNetworkCostLamports) };
}

const WORDS = {
  EN: { title: { transfer: 'Review: transfer on', swap: 'Review: swap on' }, send: 'You send', pay: 'You pay', receive: 'You receive (estimated)', minimum: 'Minimum received',
    to: 'To', from: 'From your wallet', fee: 'Network fee and account deposits, at most', feeToken: 'Network fee, paid in', valid: 'Valid until',
    note: 'Nothing is signed or sent yet. Your wallet shows this exact transaction next; only your approval there sends it.' },
  PT: { title: { transfer: 'Revisão: transferência na', swap: 'Revisão: troca na' }, send: 'Você envia', pay: 'Você paga', receive: 'Você recebe (estimado)', minimum: 'Mínimo recebido',
    to: 'Para', from: 'Da sua carteira', fee: 'Taxa de rede e depósitos de conta, no máximo', feeToken: 'Taxa de rede, paga em', valid: 'Válida até',
    note: 'Nada foi assinado nem enviado ainda. A sua carteira mostra esta transação exata em seguida; só a sua aprovação lá a envia.' },
} as const;
/** The Review as plain-text lines in the conversation's language (no markup: every channel shows them as text). */
export function nativeReviewLines(review: NativeReview, language: 'EN' | 'PT'): string[] {
  const w = WORDS[language], lang = language === 'PT' ? 'PT' as const : 'EN' as const;
  const amount = (value: string, decimalsOf: number, sym: string, rounding: 'nearest' | 'down' | 'up', marker = false) =>
    formatDisplayTokenAmount({ units: value, decimals: decimalsOf }, { rounding, marker, symbol: sym, language: lang });
  const time = new Date(review.expiresAt).toISOString().slice(11, 19) + ' UTC';
  return [`${w.title[review.action]} ${review.network}`,
    `${review.action === 'transfer' ? w.send : w.pay}: ${amount(review.pay.amount, review.pay.decimals, review.pay.symbol, 'nearest')}`,
    ...review.receive ? [`${w.receive}: ${amount(review.receive.amount, review.receive.decimals, review.receive.symbol, 'nearest', true)}`,
      ...review.receive.minimum ? [`${w.minimum}: ${amount(review.receive.minimum, review.receive.decimals, review.receive.symbol, 'down')}`] : []] : [],
    ...review.recipient ? [`${w.to}: ${review.recipient}`] : [], `${w.from}: ${review.owner}`,
    review.feeToken ? `${w.feeToken} ${review.feeToken.symbol}: ${amount(review.feeToken.amount, review.feeToken.decimals, review.feeToken.symbol, 'up')}`
      : review.maximumNetworkCostLamports ? `${w.fee}: ${amount(review.maximumNetworkCostLamports, 9, 'SOL', 'up')}` : '',
    `${w.valid} ${time}`, w.note].filter(Boolean);
}
