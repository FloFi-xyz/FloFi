// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIFIED-COPILOT-001: the deterministic conversational aids of the Copilot engine (`copilot-conversation.ts`), shared by the web
 * chat and Channel Core. Pure: no IO, no model, no wallet.
 *
 *   resumeRequest(text)          "ok, vamos continuar", "agora continua o swap" — re-shows FloFi's open question; never approves anything
 *   correctTypos(text)           "arbriturm" → "arbitrum", "etheruem" → "ethereum": only an unambiguous nearest spelling of a network or coin
 *                                name; the engine always says how it read a corrected word before it proposes anything (a typo never
 *                                becomes a proposal in the same turn — learning corpus M03–M06)
 *   recipientOfferAnswer(text)   the user's answer to FloFi's optional "save this address?" offer (saving is never required)
 *   ASSIST_COPY                  the EN/PT copy of these aids
 */
import { foldText } from './intelligence/concepts';
import type { CopilotLanguage } from './copilot-messages';
import { COPILOT_NETWORK_IDS, networkOfCopilot } from './network-registry';

// ── Resume ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const RESUME = /^(?:(?:ok|okay|certo|beleza|blz|ta|show|perfeito|otimo|entendi|got it|great|alright|all right|sure|then|entao|agora|now|bom)\s+)*(?:(?:vamos|pode|podemos|let s|lets|please|por favor|can we|we can)\s+)?(?:continuar|continua|continue|continuing|seguir|segue|siga|prosseguir|prossegue|proceed|go on|carry on|resume|retomar|retoma|voltar|volta|back to)(?:\s+(?:com|with|to|para|pra|ao|a|o|the|my|meu|minha|nosso|nossa|daqui|de onde parou|where we left off|o pedido|o fluxo|isso|it|that))*(?:\s+(?:swap|troca|bridge|ponte|pedido|request|fluxo|workflow|operacao|operation|transferencia|transfer|envio|send|liquidez|liquidity|automacao|automation|supply|emprestimo|borrow))?(?:\s+(?:por favor|please))?$/;
/** A message that only asks to go back to the open request (no new value, no approval). */
export const resumeRequest = (text: string): boolean => { const folded = foldText(text); return folded.length > 0 && folded.length <= 80 && RESUME.test(folded); };

// ── Typos ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
type Term = { readonly word: string; readonly label: string; readonly network: boolean };
/** Words of network names that name no network on their own ("Base netwrok" is not Arbitrum One's "network"): never typo targets. */
const GENERIC: ReadonlySet<string> = new Set(['network', 'mainnet', 'testnet', 'devnet', 'chain', 'sepolia', 'layer', 'rollup']);
/** Network names (and their words) from the network registry, and coin names people write instead of a ticker. Only words of 5+ letters. */
const TERMS: readonly Term[] = (() => {
  const out = new Map<string, Term>();
  for (const id of COPILOT_NETWORK_IDS) {
    const identity = networkOfCopilot(id);
    for (const label of [identity.name, ...identity.aliases]) for (const word of foldText(label).split(' '))
      if (/^[a-z]{5,}$/.test(word) && !GENERIC.has(word) && !out.has(word)) out.set(word, { word, label: identity.name, network: true });
  }
  for (const [word, label] of [['ethereum', 'Ethereum'], ['ether', 'Ether'], ['solana', 'Solana'], ['tether', 'Tether'], ['bitcoin', 'Bitcoin']] as const)
    if (!out.has(word)) out.set(word, { word, label, network: false });
  return [...out.values()];
})();
const KNOWN = new Set(TERMS.map(term => term.word));
/** Everyday words that sit close to a network name and must never be "corrected" (PT/EN). */
const STOP = new Set(['arbitro', 'arbitra', 'arbitrar', 'arbitrage', 'arbitragem', 'solano', 'solar', 'solares', 'saldo', 'ethers', 'others', 'either', 'neither',
  'bases', 'basear', 'baseado', 'baseada', 'robinho', 'robin', 'sepolia', 'seguir', 'mainnet', 'testnet', 'devnet', 'ethics', 'ethiopia', 'other', 'outro', 'outra']);
function distance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j), before: number[] = [];
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      let value = Math.min(previous[j]! + 1, row[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, before[j - 2]! + 1);
      row.push(value);
    }
    before = previous; previous = row;
    if (Math.min(...row) > limit) return limit + 1;
  }
  return previous[b.length]!;
}
export type TypoCorrection = { readonly written: string; readonly corrected: string; readonly label: string; readonly network: boolean };
/** The single nearest term for one written word: same first letter, within 1 edit (5–6 letters) or 2 edits (7+), and no tie. */
function nearest(word: string): Term | null {
  if (word.length < 5 || KNOWN.has(word) || STOP.has(word) || !/^[a-z]+$/.test(word)) return null;
  const limit = word.length >= 7 ? 2 : 1;
  const scored = TERMS.filter(term => term.word[0] === word[0]).map(term => ({ term, d: distance(word, term.word, limit) })).filter(entry => entry.d <= limit)
    .sort((a, b) => a.d - b.d);
  return scored.length && (scored.length === 1 || scored[0]!.d < scored[1]!.d) ? scored[0]!.term : null;
}
/** The text with unambiguous typos of network and coin names corrected (letters only; everything else unchanged), and what was corrected. */
/**
 * The language of a short question FloFi answers itself ("O que é colateral?", "how do I connect Phantom?") when the interface gave none and the
 * function-word detector is undecided: its opening question words. Null when they do not decide it.
 */
const PT_OPENERS = /^(?:o que|oque|que e|como|qual|quais|onde|por que|porque|pq|me explica|explica|explique|nao entendi|me da|me de|da um|e na|e no|e em|e como|quero|posso|preciso|tem como|da pra|minhas?|meus?)(?:\s|$)/;
const EN_OPENERS = /^(?:what|whats|how|which|where|why|explain|tell me|i don t|i dont|give me|and on|and in|how about|what about|can i|do i|is there|i want|show me|my)(?:\s|$)/;
export function questionLanguage(text: string): CopilotLanguage | null {
  const folded = foldText(text).replace(/^(?:hey|hi|hello|ola|oi|ok|okay|e ai)[,\s]+/, '');
  return PT_OPENERS.test(folded) ? 'PT' : EN_OPENERS.test(folded) ? 'EN' : null;
}

export function correctTypos(text: string): { readonly text: string; readonly corrections: readonly TypoCorrection[] } {
  const corrections: TypoCorrection[] = [];
  const out = text.replace(/[\p{L}]{5,}/gu, written => {
    const folded = foldText(written);
    const term = folded === written.toLowerCase() ? nearest(folded) : null;
    if (!term) return written;
    if (!corrections.some(item => item.written === folded)) corrections.push({ written: folded, corrected: term.word, label: term.label, network: term.network });
    return term.word;
  });
  return { text: out, corrections };
}

// ── Saving a recipient (optional, never required) ───────────────────────────────────────────────────────────────────────────────────────
const ACCEPT = /^(?:(?:sim|yes|ok|claro|pode|quero)\s+)*(?:salva|salvar|salve|salvo|guarda|guardar|guarde|save|save it|keep it|adiciona|adicionar|add)(?:\s+(?:o|esse|este|a|essa|esta|it|this|that|the|endereco|address|destinatario|recipient|carteira|wallet|contato|contact|no credentials|in credentials|nos credentials|sim|please|por favor))*(?:\s+(?:como|as|com o nome|com nome|com o nome de|named|called|chamado|chamada)\s+(.+))?$/;
const DECLINE = /^(?:(?:nao|no|nope|agora nao|not now|depois|later|skip|pular|dispensa|nao precisa|no thanks|nao obrigado|nao obrigada|sem salvar|dont save|do not save|nao salva|nao salvar|cancel|cancela|cancelar|cancele|esquece|esqueca|deixa|deixa pra la|deixa para la|never mind|nevermind|forget it|forget about it|stop|para)\s*)+$/;
/** A message that is a new request or an address, never a name for the address being saved (it drops the offer and is read as itself). */
const REQUEST_VERB = /^(?:swap|bridge|send|transfer|buy|sell|supply|deposit|borrow|repay|withdraw|add|remove|troca|trocar|manda|mandar|envia|enviar|transfere|transferir|compra|comprar|vende|vender|deposita|depositar|empresta|emprestar|saca|sacar|fornece|fornecer|faz|fazer|quero|i want|please|por favor)(?:\s|$)/;
export const requestLikeName = (text: string): boolean => {
  const folded = foldText(text);
  return REQUEST_VERB.test(folded) || /0x[0-9a-f]{6}/i.test(text) || /[1-9A-HJ-NP-Za-km-z]{32,}/.test(text) || /\d+(?:[.,]\d+)?\s*(?:usdc|usdt|eth|weth|sol|wbtc|btc|arb|dai)\b/i.test(text);
};
export type RecipientOfferAnswer = { readonly kind: 'ACCEPT'; readonly label: string | null } | { readonly kind: 'DECLINE' };
/** The user's answer to FloFi's offer to save a typed address: accept (with an optional name written after "como"/"as"), or decline. */
export function recipientOfferAnswer(text: string): RecipientOfferAnswer | null {
  const folded = foldText(text);
  if (!folded || folded.length > 120) return null;
  if (DECLINE.test(folded)) return { kind: 'DECLINE' };
  const accepted = ACCEPT.exec(folded);
  if (!accepted) return null;
  if (!accepted[1]) return { kind: 'ACCEPT', label: null };
  // The name as the user wrote it (case and accents kept): the text after the last naming word.
  const raw = /(?:\s(?:como|as|com o nome de|com o nome|com nome|named|called|chamad[oa]))\s+(.+)$/i.exec(text.trim())?.[1] ?? null;
  return { kind: 'ACCEPT', label: raw ? raw.replace(/^["'“‘]+|["'”’.!]+$/g, '').trim() : null };
}

// ── Copy ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const join = (items: readonly string[], and: string) => items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} ${and} ${items.at(-1)}`;
export const ASSIST_COPY = {
  EN: {
    stillOpen: (question: string) => `Your request is still open — ${question}`,
    resumeOption: 'Continue my request',
    resumed: (question: string) => `Let's continue. ${question}`,
    readAs: (items: readonly TypoCorrection[]) => `I read ${join(items.map(item => `“${item.written}” as ${item.label}`), 'and')}.`,
    confirmReading: (items: readonly TypoCorrection[], sentence: string) => `I read ${join(items.map(item => `“${item.written}” as ${item.label}`), 'and')}. Shall I prepare: ${sentence}?`,
    confirmOption: 'Yes, prepare it',
    conceptMenu: (names: readonly string[]) => `I can explain DeFi concepts such as ${join(names, 'and')}. Which one?`,
    explained: (name: string, level: string) => `Flofi explained a DeFi concept (${name}${level === 'STANDARD' ? '' : `, ${level.toLowerCase()}`}).`,
    automationProposal: 'Review this automation proposal. Nothing is created until you choose Create automation, and creating it never authorizes spending.',
    automationUpdated: 'I updated the proposal with the new schedule. Review it: nothing is created until you choose Create automation.',
    manage: { LIST: 'Here are your saved automations.', STATUS: 'Here is the state of that automation.', EXPLAIN: 'Here is what that automation does.',
      WHY_NOT_RUN: 'Here is what FloFi recorded for that automation.', PAUSE: 'Ready to pause it. Nothing changes until you confirm.',
      RESUME: 'Ready to resume it. Nothing changes until you confirm.', ARCHIVE: 'Ready to delete (archive) it. Nothing changes until you confirm.',
      RESCHEDULE: 'Ready to change its schedule. A saved automation cannot be edited in place: it is replaced by a new one and the old one is archived, only after you confirm.' },
    recipientOffer: (short: string) => `Want to save ${short} in Credentials to reuse it? A saved name is only a label for a public address: it is not proof the wallet is yours and authorizes nothing.`,
    recipientSaveOption: 'Save recipient', recipientNotNowOption: 'Not now',
    recipientName: (suggestion: string | null) => `What name should I save it under?${suggestion ? ` For example: “${suggestion}”.` : ''}`,
    recipientSaving: (label: string) => `Saving “${label}” in Credentials…`,
    recipientDeclined: 'OK, not saved. Your request is unchanged.',
    recipientLabelInvalid: 'That name cannot be used (at most 40 characters, no addresses or numbers that look like keys or cards, and not a network, a token or “my wallet”). Try another name.',
    recipientLabelTaken: (label: string) => `You already have a saved recipient called “${label}”. Choose another name.`,
    recipientNamed: (label: string, ecosystem: string, address: string) => `Saved recipient “${label}” (${ecosystem}): ${address}. A saved name is not proof the wallet is yours; check the full address at Review.`,
    recipientChoose: (names: readonly string[]) => `Which saved recipient do you mean: ${join(names.map(name => `“${name}”`), 'or')}?`,
    recipientWrongEcosystem: (label: string, ecosystem: string, network: string, bridge: boolean) => `“${label}” is ${ecosystem === 'EVM' ? 'an' : 'a'} ${ecosystem} address, and ${network} needs a${ecosystem === 'Solana' ? 'n EVM' : ' Solana'} address.${bridge ? '' : ` To send to ${ecosystem === 'Solana' ? 'Solana' : 'an EVM network'} from ${network}, ask for a bridge instead.`}`,
    recipientsUnavailable: 'Saved recipients are only available in the FloFi app, signed in to your account.',
    recipientStale: 'That saved recipient is no longer in your list (it was renamed, removed or belongs to another account). Nothing was prepared; tell me the request again.',
    recipientNotUsed: (label: string) => `“${label}” is a saved recipient; a saved name is used only as the destination of a send or a bridge, so it was not used here.`,
    recipientSaved: (label: string) => `Saved as “${label}” in Credentials → Saved recipients. It is only a name for that public address; your request is unchanged.`,
    recipientExists: (label: string) => `That address is already saved as “${label}”. Nothing was changed.`,
    recipientSaveFailed: 'FloFi could not save it right now. Nothing was changed; you can save it later in Credentials.',
  },
  PT: {
    stillOpen: (question: string) => `Seu pedido continua aberto — ${question}`,
    resumeOption: 'Continuar meu pedido',
    resumed: (question: string) => `Vamos continuar. ${question}`,
    readAs: (items: readonly TypoCorrection[]) => `Entendi ${join(items.map(item => `“${item.written}” como ${item.label}`), 'e')}.`,
    confirmReading: (items: readonly TypoCorrection[], sentence: string) => `Entendi ${join(items.map(item => `“${item.written}” como ${item.label}`), 'e')}. Posso preparar: ${sentence}?`,
    confirmOption: 'Sim, pode preparar',
    conceptMenu: (names: readonly string[]) => `Posso explicar conceitos de DeFi como ${join(names, 'e')}. Qual deles?`,
    explained: (name: string, level: string) => `Flofi explained a DeFi concept (${name}${level === 'STANDARD' ? '' : `, ${level.toLowerCase()}`}).`,
    automationProposal: 'Revise esta proposta de automação. Nada é criado até você escolher Criar automação, e criar nunca autoriza gastos.',
    automationUpdated: 'Atualizei a proposta com o novo horário. Revise: nada é criado até você escolher Criar automação.',
    manage: { LIST: 'Estas são suas automações salvas.', STATUS: 'Este é o estado dessa automação.', EXPLAIN: 'Isto é o que essa automação faz.',
      WHY_NOT_RUN: 'Isto é o que a FloFi registrou para essa automação.', PAUSE: 'Pronto para pausar. Nada muda até você confirmar.',
      RESUME: 'Pronto para retomar. Nada muda até você confirmar.', ARCHIVE: 'Pronto para excluir (arquivar). Nada muda até você confirmar.',
      RESCHEDULE: 'Pronto para mudar o horário. Uma automação salva não pode ser editada: ela é substituída por uma nova e a antiga é arquivada, só depois que você confirmar.' },
    recipientOffer: (short: string) => `Quer salvar ${short} em Credenciais para usar de novo? Um nome salvo é só um rótulo para um endereço público: não prova que a carteira é sua e não autoriza nada.`,
    recipientSaveOption: 'Salvar destinatário', recipientNotNowOption: 'Agora não',
    recipientName: (suggestion: string | null) => `Com que nome eu salvo?${suggestion ? ` Por exemplo: “${suggestion}”.` : ''}`,
    recipientSaving: (label: string) => `Salvando “${label}” em Credenciais…`,
    recipientDeclined: 'Certo, não salvei. Seu pedido continua igual.',
    recipientLabelInvalid: 'Esse nome não pode ser usado (até 40 caracteres, sem endereços nem números que pareçam chaves ou cartões, e não pode ser uma rede, um token ou “minha carteira”). Tente outro nome.',
    recipientLabelTaken: (label: string) => `Você já tem um destinatário salvo chamado “${label}”. Escolha outro nome.`,
    recipientNamed: (label: string, ecosystem: string, address: string) => `Destinatário salvo “${label}” (${ecosystem}): ${address}. Um nome salvo não prova que a carteira é sua; confira o endereço completo na Review.`,
    recipientChoose: (names: readonly string[]) => `Qual destinatário salvo você quer usar: ${join(names.map(name => `“${name}”`), 'ou')}?`,
    recipientWrongEcosystem: (label: string, ecosystem: string, network: string, bridge: boolean) => `“${label}” é um endereço ${ecosystem}, e a ${network} precisa de um endereço ${ecosystem === 'Solana' ? 'EVM' : 'Solana'}.${bridge ? '' : ` Para enviar ${ecosystem === 'Solana' ? 'para a Solana' : 'para uma rede EVM'} a partir da ${network}, peça uma bridge.`}`,
    recipientsUnavailable: 'Destinatários salvos só estão disponíveis no app FloFi, com sua conta conectada.',
    recipientStale: 'Esse destinatário salvo não está mais na sua lista (foi renomeado, removido ou é de outra conta). Nada foi preparado; me diga o pedido de novo.',
    recipientNotUsed: (label: string) => `“${label}” é um destinatário salvo; um nome salvo só é usado como destino de um envio ou de uma bridge, então não foi usado aqui.`,
    recipientSaved: (label: string) => `Salvo como “${label}” em Credenciais → Destinatários salvos. É só um nome para esse endereço público; seu pedido continua igual.`,
    recipientExists: (label: string) => `Esse endereço já está salvo como “${label}”. Nada foi alterado.`,
    recipientSaveFailed: 'A FloFi não conseguiu salvar agora. Nada foi alterado; você pode salvar depois em Credenciais.',
  },
} as const satisfies Record<CopilotLanguage, Record<string, unknown>>;
export type AssistCopy = (typeof ASSIST_COPY)[CopilotLanguage];
