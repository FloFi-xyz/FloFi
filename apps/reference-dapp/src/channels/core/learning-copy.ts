// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-LEARNING-001: what a channel says about its sender's memory (EN/PT), written by FloFi. The memory belongs to this channel account
 * only — never to a wallet or another channel — and never authorizes anything.
 */
import { targetLabel } from '../../domain/copilot-learning-copy.ts';
import { isLexiconTarget } from '../../domain/copilot-lexicon.ts';
import type { ChannelLanguage } from './config.ts';

const label = (target: string, language: ChannelLanguage) => isLexiconTarget(target) ? targetLabel(target, language) : target;
const EN = {
  list: (entries: readonly { readonly term: string; readonly target: string }[], paused: boolean, language: ChannelLanguage) =>
    `FloFi remembers for this chat account:\n${entries.map(e => `• ${e.term} → ${label(e.target, language)}`).join('\n')}${paused ? '\nMemory is paused (send “memory on” to use it again).' : ''}\nSend “forget arb” to remove one, “forget everything” to delete all, “memory off” to pause.`,
  empty: 'FloFi does not remember anything for this chat account yet. Tell me, for example: “whenever I say arb, I mean Arbitrum”.',
  paused: 'Memory paused. FloFi keeps your saved meanings but will not use them until you send “memory on”.',
  resumed: 'Memory on. FloFi uses your saved meanings again (only for this chat account).',
  unavailable: 'Memory is unavailable right now. Everything else works as usual.',
  help: 'MEMORY shows what FloFi remembers for you here; “forget everything” deletes it.',
};
const PT: typeof EN = {
  list: (entries, paused, language) =>
    `O FloFi lembra para esta conta do chat:\n${entries.map(e => `• ${e.term} → ${label(e.target, language)}`).join('\n')}${paused ? '\nA memória está pausada (envie “ativar memória” para voltar a usar).' : ''}\nEnvie “esqueça arb” para remover um, “esqueça tudo” para apagar todos, “pausar memória” para pausar.`,
  empty: 'O FloFi ainda não lembra nada para esta conta do chat. Diga, por exemplo: “sempre que eu disser arb, quero dizer Arbitrum”.',
  paused: 'Memória pausada. O FloFi guarda seus significados salvos, mas não vai usá-los até você enviar “ativar memória”.',
  resumed: 'Memória ativada. O FloFi volta a usar seus significados salvos (só para esta conta do chat).',
  unavailable: 'A memória está indisponível agora. Todo o resto funciona normalmente.',
  help: 'MEMÓRIA mostra o que o FloFi lembra para você aqui; “esqueça tudo” apaga.',
};
export const channelLearningCopy = (language: ChannelLanguage) => language === 'PT' ? PT : EN;
