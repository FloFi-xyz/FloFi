// SPDX-License-Identifier: AGPL-3.0-only
import { networkOfCopilot } from './network-registry';
import { targetAsset, targetKind, targetNetwork, targetValue, type LexiconCode, type LexiconEntry, type LexiconTarget } from './copilot-lexicon';
import type { CopilotLanguage } from './copilot-messages';

/**
 * BUILD-CHAT-LEARNING-001: every sentence the Copilot writes about learned vocabulary and memory, in English and Portuguese (Brazil). Display
 * copy only: whether something is remembered, used or grounded is decided by the engine and the server, never by these strings.
 * BUILD-CHAT-LEARNING-002: no offer to remember and no invitation to teach FloFi or to sign in for memory; privacy controls live in Settings.
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
  // BUILD-CHAT-LEARNING-002: a statement is acknowledged in one sentence; FloFi never asks to remember, never invites the user to teach it.
  understood: (term: string, label: string) => `Got it — in this conversation I'll read “${term}” as ${label}.`,
  understoodSaved: (term: string, label: string) => `Got it — from now on I'll read “${term}” as ${label}.`,
  saved: (term: string, label: string) => `Saved: “${term}” = ${label}. FloFi uses it only for you, and every proposal still shows it for your review.`,
  reserved: (term: string) => `“${term}” already has a fixed meaning in FloFi (a network, token, protocol or command name), so I can’t give it another one.`,
  environment: (term: string, label: string) => `I won’t read “${term}” as ${label}: it could mix a network with real funds and a test network. Use a word that says which one you mean.`,
  unknownTarget: 'I can only use words for networks, tokens and actions FloFi supports.',
  invalidTerm: 'That word is too long or unusual for FloFi to use (2–32 letters or digits, up to 3 words).',
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
  usedAdapted: (term: string, name: string) => `“${term}” read as ${name} — as you chose earlier in this conversation.`,
  usedLearned: (term: string, name: string) => `“${term}” read as ${name} — learned from your earlier choices.`,
  usedGlobal: (term: string, name: string, version: number | null) => `“${term}” read as ${name} — FloFi glossary${version ? ` v${version}` : ''}.`,
  suggestion: (term: string, name: string) => `“${term}” may mean ${name}, which uses real funds — choose it below only if that is what you mean.`,
  suggestionOwn: (term: string, name: string) => `You used “${term}” for ${name} before. It uses real funds, so it is first below — choose it only if that is what you mean.`,
  failed: 'FloFi couldn’t save this right now. Nothing was stored.',
  limited: 'Too many memory changes right now. Try again later; nothing was stored.',
  full: 'Your memory is full. Delete an entry in Privacy settings first; nothing was stored.',
};
const PT: typeof EN = {
  understood: (term, label) => `Entendi — nesta conversa, vou entender “${term}” como ${label}.`,
  understoodSaved: (term, label) => `Entendi — a partir de agora, vou entender “${term}” como ${label}.`,
  saved: (term, label) => `Salvo: “${term}” = ${label}. O FloFi usa isso só para você, e toda proposta continua mostrando para você revisar.`,
  reserved: term => `“${term}” já tem um significado fixo no FloFi (nome de rede, token, protocolo ou comando), então não posso dar outro significado a ele.`,
  environment: (term, label) => `Não vou entender “${term}” como ${label}: isso poderia misturar uma rede com fundos reais e uma rede de teste. Use uma palavra que deixe claro qual você quer.`,
  unknownTarget: 'Só consigo usar palavras para redes, tokens e ações que o FloFi suporta.',
  invalidTerm: 'Essa palavra é longa ou incomum demais para o FloFi usar (2 a 32 letras ou dígitos, até 3 palavras).',
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
  usedAdapted: (term, name) => `“${term}” entendido como ${name} — como você escolheu antes nesta conversa.`,
  usedLearned: (term, name) => `“${term}” entendido como ${name} — aprendido com suas escolhas anteriores.`,
  usedGlobal: (term, name, version) => `“${term}” entendido como ${name} — glossário do FloFi${version ? ` v${version}` : ''}.`,
  suggestion: (term, name) => `“${term}” pode ser ${name}, que usa fundos reais — escolha abaixo só se for isso que você quer.`,
  suggestionOwn: (term, name) => `Você já usou “${term}” para ${name}. Essa rede usa fundos reais, por isso ela aparece primeiro abaixo — escolha só se for isso que você quer.`,
  failed: 'O FloFi não conseguiu salvar agora. Nada foi guardado.',
  limited: 'Muitas alterações de memória agora. Tente mais tarde; nada foi guardado.',
  full: 'Sua memória está cheia. Apague um item em Privacidade primeiro; nada foi guardado.',
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
  switch (entry.source) {
    case 'PRIVATE': return m.usedPrivate(entry.term, name);
    case 'SESSION': return m.usedSession(entry.term, name);
    case 'ADAPTED': return m.usedAdapted(entry.term, name);
    case 'LEARNED': return m.usedLearned(entry.term, name);
    case 'GLOBAL': return m.usedGlobal(entry.term, name, entry.version ?? null);
  }
}
/** Why FloFi offers a real-funds network first: the user's own earlier choice (adapted, learned) or FloFi's glossary. */
export const suggestionNote = (entry: LexiconEntry, language: CopilotLanguage): string =>
  (entry.source === 'GLOBAL' ? learningCopy(language).suggestion : learningCopy(language).suggestionOwn)(entry.term, targetName(entry.target));
/** The confirmation buttons before erasing everything, in either language (a reply in the other language still answers it). */
export const MEMORY_YES = new Set([EN.forgetAllOptions[0], PT.forgetAllOptions[0]].map(label => label.toLowerCase()));
export const MEMORY_NO = new Set([EN.forgetAllOptions[1], PT.forgetAllOptions[1]].map(label => label.toLowerCase()));
