// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (A04): what FloFi's own operation names mean ("O que significa supply?" → depositing tokens into a lending
 * protocol). One short, FloFi-authored definition per operation in English and Portuguese, read before the broader DeFi concept catalog
 * (`intelligence/concepts.ts`), whose related concept keeps the follow-ups ("me dá um exemplo"). General knowledge only: no live value, and answering
 * never proposes or changes anything.
 */
import type { ConceptId } from './intelligence/concepts';

export type OperationTerm = 'SUPPLY' | 'BORROW' | 'REPAY' | 'WITHDRAW' | 'SWAP' | 'TRANSFER' | 'BATCH_PAYMENT';
const TERMS: Readonly<Record<OperationTerm, { readonly aliases: string; readonly concept: ConceptId | null; readonly EN: string; readonly PT: string }>> = {
  SUPPLY: { aliases: 'supply|fornecer|fornecimento|fazer supply|dar supply', concept: 'LENDING_BORROWING',
    EN: 'Supply means depositing your tokens into a lending protocol, such as Aave, so they earn interest. You can withdraw them later, and they can back a loan as collateral.',
    PT: 'Supply é depositar seus tokens em um protocolo de empréstimo, como a Aave, para render juros. Você pode sacá-los depois, e eles podem servir de colateral para um empréstimo.' },
  BORROW: { aliases: 'borrow|fazer borrow', concept: 'LENDING_BORROWING',
    EN: 'Borrow means taking tokens from a lending protocol against collateral you deposited there. You pay interest until you repay.',
    PT: 'Borrow é pegar tokens emprestados de um protocolo de empréstimo, usando como garantia o colateral que você depositou nele. Você paga juros até devolver.' },
  REPAY: { aliases: 'repay|fazer repay', concept: 'LENDING_BORROWING',
    EN: 'Repay means paying back tokens you borrowed from a lending protocol, which reduces your debt.',
    PT: 'Repay é devolver tokens que você pegou emprestado em um protocolo de empréstimo, reduzindo sua dívida.' },
  WITHDRAW: { aliases: 'withdraw|fazer withdraw', concept: 'LENDING_BORROWING',
    EN: 'Withdraw means taking tokens you supplied to a lending protocol back to your wallet.',
    PT: 'Withdraw é sacar de volta para a sua carteira os tokens que você depositou em um protocolo de empréstimo.' },
  SWAP: { aliases: 'swap|fazer swap|fazer um swap', concept: 'LIQUIDITY_POOL',
    EN: 'A swap exchanges one token for another on the same network, at the price the pool or route quotes.',
    PT: 'Swap é trocar um token por outro na mesma rede, pelo preço que o pool ou a rota cotam.' },
  TRANSFER: { aliases: 'transfer|send|transferencia|envio', concept: null,
    EN: 'A transfer sends tokens from your wallet to another address on the same network.',
    PT: 'Uma transferência envia tokens da sua carteira para outro endereço na mesma rede.' },
  BATCH_PAYMENT: { aliases: 'batch payment|pagamento em lote|pagamentos em lote', concept: null,
    EN: 'A Batch Payment pays several recipients at once, with one authorization of your wallet: either every payment goes through or none does.',
    PT: 'Um pagamento em lote paga vários destinatários de uma vez, com uma única autorização da sua carteira: ou todos os pagamentos acontecem, ou nenhum.' },
};
const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[?!.,;:¿¡"“”]+/g, ' ').replace(/\s+/g, ' ').trim();
const ARTICLE = '(?:(?:a|o|um|uma|an?|the)\\s+)?';
const patterns = (aliases: string): readonly RegExp[] => [
  new RegExp(`^(?:o que|oq|oque|que)\\s+(?:e|significa|quer dizer|seria)\\s+${ARTICLE}(?:${aliases})$`),
  new RegExp(`^(?:me explica|explica|explique|define|explain|what is|what s|whats|define)\\s+${ARTICLE}(?:${aliases})$`),
  new RegExp(`^what does\\s+${ARTICLE}(?:${aliases})\\s+mean$`),
  new RegExp(`^(?:${aliases})\\s+(?:significa o que|e o que|quer dizer o que)$`),
];
/** The FloFi operation a message asks the meaning of ("o que significa supply?", "what does borrow mean?"), or null. */
export function termQuestion(text: string): OperationTerm | null {
  if (typeof text !== 'string' || text.length > 120 || /\d/.test(text)) return null;
  const folded = fold(text);
  return (Object.keys(TERMS) as OperationTerm[]).find(term => patterns(TERMS[term].aliases).some(pattern => pattern.test(folded))) ?? null;
}
/** The definition, and the concept whose follow-ups apply after it (null: none). */
export const termAnswer = (term: OperationTerm, language: 'EN' | 'PT'): { readonly text: string; readonly concept: ConceptId | null } =>
  ({ text: TERMS[term][language], concept: TERMS[term].concept });
