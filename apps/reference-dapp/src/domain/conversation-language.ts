// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (A09): the language of the person's conversation. FloFi answers in the language the person writes in,
 * whatever language the interface shows, unless they explicitly ask for another one. The interface language is only the fallback for a message
 * that tells nothing ("ok", "0,2", "Base", a token symbol). Pure; no model.
 *
 *   detectLanguage(text)     EN or PT when the message is clearly written in it, else null
 *   languageRequest(text)    an explicit "reply in English" / "responda em português", else null
 *   replyLanguage(...)       the language FloFi answers this message in
 */
export type ReplyLanguage = 'EN' | 'PT';

const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
/**
 * Words only one of the two languages uses (folded: no accents). Loanwords both use in FloFi's chat (swap, bridge, supply, workflow, status, review
 * in a button label) and words both spell alike ("a", "no", "do", "me", "as", "execute") are not evidence.
 */
const PT_WORDS: ReadonlySet<string> = new Set(['que', 'qual', 'quais', 'quanto', 'quantos', 'quanta', 'quantas', 'como', 'onde', 'quando', 'porque', 'por', 'para', 'pra', 'pro',
  'com', 'sem', 'uma', 'um', 'umas', 'uns', 'os', 'da', 'das', 'dos', 'na', 'nas', 'nos', 'ao', 'aos', 'de', 'e', 'esta', 'estao', 'sao', 'foi', 'ser', 'ter', 'tem',
  'nao', 'sim', 'meu', 'minha', 'meus', 'minhas', 'seu', 'sua', 'isso', 'isto', 'esse', 'essa', 'este', 'aquele', 'tambem', 'mais', 'muito', 'agora', 'depois', 'entao',
  'ja', 'ainda', 'vou', 'vai', 'posso', 'pode', 'quero', 'preciso', 'faca', 'faz', 'fazer', 'altere', 'alterar', 'altera', 'mude', 'mudar', 'muda', 'troque', 'trocar',
  'troca', 'coloque', 'colocar', 'coloca', 'envie', 'enviar', 'envia', 'manda', 'mandar', 'remova', 'remover', 'adicione', 'adicionar', 'ajuste', 'ajustar', 'defina',
  'etapa', 'etapas', 'passo', 'passos', 'fluxo', 'valor', 'taxa', 'taxas', 'custo', 'custos', 'custa', 'compensa', 'vale', 'pena', 'significa', 'receber', 'recebo',
  'recebi', 'simulacao', 'cotacao', 'obrigado', 'obrigada', 'ola', 'oi', 'voce', 'eu', 'primeira', 'primeiro', 'segunda', 'segundo', 'terceira', 'terceiro', 'ultimo',
  'ultima', 'deposito', 'pagamento', 'ponte', 'revisar', 'confirmo', 'confirmar', 'executar', 'desfazer', 'descartar', 'aplicar', 'cancelar', 'continuar', 'explique',
  'explica', 'entendi', 'ajuda', 'favor', 'deu', 'certo', 'tudo', 'assinar', 'novamente', 'chegou', 'terminou', 'funcionou', 'outra', 'outro', 'acao', 'caro',
  'barato', 'sentido', 'responda', 'responder', 'fale', 'portugues', 'ingles', 'quer', 'dizer', 'serve', 'mostra', 'mostre', 'diga', 'resultado', 'saldo']);
const EN_WORDS: ReadonlySet<string> = new Set(['the', 'what', 'which', 'how', 'is', 'are', 'does', 'did', 'mean', 'means', 'meaning', 'my', 'your', 'to', 'of', 'in', 'it', 'on',
  'this', 'that', 'these', 'those', 'and', 'or', 'with', 'for', 'from', 'into', 'please', 'can', 'could', 'should', 'would', 'will', 'why', 'when', 'where', 'who', 'much',
  'many', 'cost', 'costs', 'fee', 'fees', 'worth', 'change', 'set', 'update', 'make', 'edit', 'step', 'steps', 'first', 'second', 'third', 'last', 'previous', 'yes',
  'thanks', 'thank', 'you', 'i', 'want', 'need', 'show', 'tell', 'explain', 'get', 'receive', 'quote', 'expire', 'expires', 'valid', 'still', 'amount', 'hello', 'hi',
  'hey', 'undo', 'discard', 'apply', 'confirm', 'review', 'add', 'another', 'action', 'cheap', 'expensive', 'sense', 'reply', 'answer', 'speak', 'english', 'portuguese',
  'work', 'done', 'sign', 'again', 'there', 'any', 'be', 'result']);
const ACCENTED = /[ãõçâêôáéíóúà]/i;

/**
 * The language a message is clearly written in (more words of one language than of the other), or null when it tells nothing. Only whole words
 * count: a token with a digit (an address, a hash, an amount like "0x5aAe…", "2USDC") is never split into letters ("e", "a") that read as words.
 */
export function detectLanguage(text: string): ReplyLanguage | null {
  if (typeof text !== 'string') return null;
  const words = fold(text.slice(0, 600)).split(/[\s,.;:!?¿¡()[\]{}"'“”‘’«»/]+/).filter(word => /^[a-z]+(?:-[a-z]+)*$/.test(word)).flatMap(word => word.split('-'));
  const en = words.filter(word => EN_WORDS.has(word)).length, pt = words.filter(word => PT_WORDS.has(word)).length + (ACCENTED.test(text) ? 1 : 0);
  return pt > en ? 'PT' : en > pt ? 'EN' : null;
}

const REQUESTS: readonly RegExp[] = [
  /^(?:please\s+)?(?:(?:can|could|would)\s+you\s+(?:please\s+)?)?(?:always\s+)?(?:reply|answer|respond|talk|speak|write)(?:\s+to\s+me)?\s+in\s+(english|portuguese)\b/,
  /^(?:please\s+)?(?:switch|change)\s+(?:the\s+)?(?:language\s+)?to\s+(english|portuguese)\b/,
  /^(?:in\s+)?(english|portuguese)(?:\s+please)?$/,
  /^(?:por\s+favor\s+)?(?:(?:voce\s+)?(?:pode|poderia)\s+)?(?:sempre\s+)?(?:responder|responda|responde|falar|fale|fala|escrever|escreva|escreve)(?:\s+comigo)?\s+em\s+(portugues|ingles)\b/,
  /^(?:por\s+favor\s+)?(?:mude|muda|mudar|troque|troca|trocar)\s+(?:o\s+)?(?:idioma|a\s+lingua)\s+(?:para|pra)\s+(?:o\s+)?(portugues|ingles)\b/,
  /^(?:em\s+)(portugues|ingles)(?:\s+por\s+favor)?$/,
];
/** An explicit request for the reply language ("Reply in English", "responda em português", "em inglês, por favor"), or null. */
export function languageRequest(text: string): ReplyLanguage | null {
  if (typeof text !== 'string' || text.length > 160) return null;
  const folded = fold(text).replace(/[,.!?¿¡]+/g, ' ').replace(/\s+/g, ' ').trim();
  for (const pattern of REQUESTS) {
    const match = pattern.exec(folded);
    if (match) return /^p/.test(match[1]!) ? 'PT' : 'EN';
  }
  return null;
}

/** The conversation's language so far: the last language the person wrote in, or the one they explicitly chose (which then holds). */
export type ConversationLanguageState = { readonly language: ReplyLanguage; readonly chosen: boolean } | null;
/**
 * The language FloFi answers `text` in, and the conversation's language after it: an explicit choice holds; otherwise the message's own language,
 * else the language the person was already writing in, else the interface language.
 */
export function replyLanguage(text: string, interfaceLanguage: ReplyLanguage, state: ConversationLanguageState,
  /**
   * The message is one of FloFi's exact commands ("swap 10 USDC to WETH on Base"): that grammar is English by design, so it tells nothing about the
   * person's language and the conversation keeps its own (else the interface's).
   */
  exactCommand = false): { readonly language: ReplyLanguage; readonly state: ConversationLanguageState } {
  const requested = exactCommand ? null : languageRequest(text);
  if (requested) return { language: requested, state: { language: requested, chosen: true } };
  if (state?.chosen) return { language: state.language, state };
  const detected = exactCommand ? null : detectLanguage(text);
  if (detected) return { language: detected, state: { language: detected, chosen: false } };
  return { language: state?.language ?? interfaceLanguage, state };
}
