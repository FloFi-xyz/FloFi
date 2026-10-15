// SPDX-License-Identifier: AGPL-3.0-only
import { networkOfCopilot } from './network-registry';
import { targetAsset, targetKind, targetNetwork, targetValue, type LexiconCode, type LexiconEntry, type LexiconTarget } from './copilot-lexicon';
import type { CopilotLanguage } from './copilot-messages';

/**
 * BUILD-CHAT-LEARNING-001: every sentence the Copilot writes about learned vocabulary and memory, in English and Portuguese (Brazil). Display
 * copy only: whether something is remembered, used or grounded is decided by the engine and the server, never by these strings.
 */
const OPERATION_LABEL: Readonly<Record<CopilotLanguage, Readonly<Record<string, string>>>> = {
  EN: { SWAP: 'a swap', BRIDGE: 'a bridge (cross-chain move)', SUPPLY: 'an Aave supply', BORROW: 'an Aave borrow', REPAY: 'an Aave repayment', WITHDRAW: 'an Aave withdrawal',
    LIQUIDITY: 'adding liquidity', TRANSFER: 'a send' },
  PT: { SWAP: 'um swap (troca)', BRIDGE: 'uma bridge (movimento entre redes)', SUPPLY: 'um depósito (supply) no Aave', BORROW: 'um empréstimo (borrow) no Aave',
    REPAY: 'um pagamento (repay) no Aave', WITHDRAW: 'um saque (withdraw) no Aave', LIQUIDITY: 'adicionar liquidez', TRANSFER: 'um envio' },
};
/** "Arbitrum One (real funds)", "Arbitrum Sepolia (test network)", "USDC", "a bridge (cross-chain move)". */
export function targetLabel(target: LexiconTarget, language: CopilotLanguage): string {
  const network = targetNetwork(target);
  if (network) {
    const identity = networkOfCopilot(network);
    const tag = identity.environment === 'MAINNET' ? (language === 'PT' ? 'fundos reais' : 'real funds') : (language === 'PT' ? 'rede de teste' : 'test network');
    return `${identity.name} (${tag})`;
  }
  const asset = targetAsset(target);
  if (asset) return asset === 'DEVUSDC' ? 'devUSDC' : asset;
  return targetKind(target) === 'operation' ? OPERATION_LABEL[language][targetValue(target)] ?? targetValue(target) : targetValue(target);
}
/** The short name a proposal note uses ("Arbitrum One", "USDC"). */
export const targetName = (target: LexiconTarget): string => { const network = targetNetwork(target); return network ? networkOfCopilot(network).name
  : targetAsset(target) === 'DEVUSDC' ? 'devUSDC' : targetValue(target); };

const EN = {
  sessionAlias: (term: string, label: string) => `In this conversation, I'll read “${term}” as ${label}.`,
  offer: (owner: string) => `Remember this for ${owner} in future sessions? Only you see it, and you can view or delete it any time in Memory.`,
  replaces: (previous: string) => `This replaces your saved meaning (${previous}).`,
  options: ['Remember', 'Not now'] as readonly [string, string],
  saved: (term: string, label: string) => `Saved: “${term}” = ${label}. FloFi uses it only for you, and every proposal still shows it for your review.`,
  notSaved: (term: string, label: string) => `Not saved. In this conversation I'll still read “${term}” as ${label}.`,
  signIn: 'Prove your wallet (sign in) and FloFi can remember it in future sessions.',
  paused: 'Your memory is paused, so this stays in this conversation only. Turn memory on in Memory to keep it.',
  unavailable: 'FloFi can’t save preferences right now; this stays in this conversation only.',
  reserved: (term: string) => `“${term}” already has a fixed meaning in FloFi (a network, token, protocol or command name), so I can’t give it another one.`,
  environment: (term: string, label: string) => `I won’t save “${term}” as ${label}: it could mix a network with real funds and a test network. Use a word that says which one you mean.`,
  unknownTarget: 'I can only remember words for networks, tokens and actions FloFi supports — for example “whenever I say arb, I mean Arbitrum”.',
  invalidTerm: 'I can remember a short word or abbreviation (2–32 letters or digits, up to 3 words).',
  forgotten: (term: string) => `Forgotten: “${term}”.`,
  notKnown: (term: string) => `There was no saved meaning for “${term}”.`,
  forgetAllOffer: 'Delete everything FloFi remembers for you? This cannot be undone.',
  forgetAllOptions: ['Delete all', 'Keep'] as readonly [string, string],
  deletedAll: 'Deleted. FloFi no longer remembers anything for you.',
  kept: 'Nothing was deleted.',
  nothingToDelete: 'FloFi does not remember anything for you.',
  language: (language: CopilotLanguage): string => language === 'PT' ? 'From now on I’ll reply in Portuguese.' : 'From now on I’ll reply in English.',
  languageSaved: (language: CopilotLanguage): string => language === 'PT' ? 'Saved: FloFi will reply in Portuguese.' : 'Saved: FloFi will reply in English.',
  usedPrivate: (term: string, name: string) => `“${term}” read as ${name} — your saved meaning.`,
  usedSession: (term: string, name: string) => `“${term}” read as ${name} — as you said in this conversation.`,
  usedGlobal: (term: string, name: string, version: number | null) => `“${term}” read as ${name} — FloFi glossary${version ? ` v${version}` : ''}.`,
  suggestion: (term: string, name: string) => `“${term}” may mean ${name}, which uses real funds — choose it below only if that is what you mean.`,
  failed: 'FloFi couldn’t save this right now. Nothing was stored.',
  limited: 'Too many memory changes right now. Try again later; nothing was stored.',
  full: 'Your memory is full. Delete an entry in Memory first; nothing was stored.',
};
const PT: typeof EN = {
  sessionAlias: (term, label) => `Nesta conversa, vou entender “${term}” como ${label}.`,
  offer: owner => `Quer que eu lembre disso para ${owner} nas próximas sessões? Só você vê, e pode ver ou apagar quando quiser em Memória.`,
  replaces: previous => `Isso substitui o significado que você tinha salvo (${previous}).`,
  options: ['Lembrar', 'Agora não'],
  saved: (term, label) => `Salvo: “${term}” = ${label}. O FloFi usa isso só para você, e toda proposta continua mostrando para você revisar.`,
  notSaved: (term, label) => `Não salvei. Nesta conversa, continuo entendendo “${term}” como ${label}.`,
  signIn: 'Comprove sua carteira (entre) e o FloFi poderá lembrar disso nas próximas sessões.',
  paused: 'Sua memória está pausada, então isso vale só nesta conversa. Ative a memória em Memória para guardar.',
  unavailable: 'O FloFi não consegue salvar preferências agora; isso vale só nesta conversa.',
  reserved: term => `“${term}” já tem um significado fixo no FloFi (nome de rede, token, protocolo ou comando), então não posso dar outro significado a ele.`,
  environment: (term, label) => `Não vou salvar “${term}” como ${label}: isso poderia misturar uma rede com fundos reais e uma rede de teste. Use uma palavra que deixe claro qual você quer.`,
  unknownTarget: 'Só consigo lembrar palavras para redes, tokens e ações que o FloFi suporta — por exemplo “sempre que eu disser arb, quero dizer Arbitrum”.',
  invalidTerm: 'Consigo lembrar uma palavra curta ou abreviação (2 a 32 letras ou dígitos, até 3 palavras).',
  forgotten: term => `Esquecido: “${term}”.`,
  notKnown: term => `Não havia significado salvo para “${term}”.`,
  forgetAllOffer: 'Apagar tudo o que o FloFi lembra sobre você? Isso não pode ser desfeito.',
  forgetAllOptions: ['Apagar tudo', 'Manter'],
  deletedAll: 'Apagado. O FloFi não lembra mais de nada sobre você.',
  kept: 'Nada foi apagado.',
  nothingToDelete: 'O FloFi não lembra nada sobre você.',
  language: language => language === 'PT' ? 'A partir de agora, respondo em português.' : 'A partir de agora, respondo em inglês.',
  languageSaved: language => language === 'PT' ? 'Salvo: o FloFi vai responder em português.' : 'Salvo: o FloFi vai responder em inglês.',
  usedPrivate: (term, name) => `“${term}” entendido como ${name} — significado salvo por você.`,
  usedSession: (term, name) => `“${term}” entendido como ${name} — como você disse nesta conversa.`,
  usedGlobal: (term, name, version) => `“${term}” entendido como ${name} — glossário do FloFi${version ? ` v${version}` : ''}.`,
  suggestion: (term, name) => `“${term}” pode ser ${name}, que usa fundos reais — escolha abaixo só se for isso que você quer.`,
  failed: 'O FloFi não conseguiu salvar agora. Nada foi guardado.',
  limited: 'Muitas alterações de memória agora. Tente mais tarde; nada foi guardado.',
  full: 'Sua memória está cheia. Apague um item em Memória primeiro; nada foi guardado.',
};
export type LearningCopy = typeof EN;
export const learningCopy = (language: CopilotLanguage): LearningCopy => language === 'PT' ? PT : EN;
/** The refusal for an invalid memory statement. */
export function refusalFor(code: LexiconCode, term: string, target: LexiconTarget | null, language: CopilotLanguage): string {
  const m = learningCopy(language);
  if (code === 'LEARNING_TERM_RESERVED') return m.reserved(term);
  if (code === 'LEARNING_ENVIRONMENT_CONFLICT' && target) return m.environment(term, targetLabel(target, language));
  if (code === 'LEARNING_TARGET_INVALID') return m.unknownTarget;
  return m.invalidTerm;
}
/** The provenance note of one entry FloFi used to read the user's words. */
export function usedNote(entry: LexiconEntry, language: CopilotLanguage): string {
  const m = learningCopy(language), name = targetName(entry.target);
  return entry.source === 'PRIVATE' ? m.usedPrivate(entry.term, name) : entry.source === 'SESSION' ? m.usedSession(entry.term, name) : m.usedGlobal(entry.term, name, entry.version ?? null);
}
/** Every memory-offer button label in either language (a reply in the other language still answers the offer). */
export const MEMORY_YES = new Set([EN.options[0], PT.options[0], EN.forgetAllOptions[0], PT.forgetAllOptions[0]].map(label => label.toLowerCase()));
export const MEMORY_NO = new Set([EN.options[1], PT.options[1], EN.forgetAllOptions[1], PT.forgetAllOptions[1]].map(label => label.toLowerCase()));
