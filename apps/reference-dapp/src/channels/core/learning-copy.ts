// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-LEARNING-001: what a channel says about its sender's memory (EN/PT), written by FloFi. The memory belongs to this channel account
 * only — never to a wallet or another channel — and never authorizes anything. BUILD-CHAT-LEARNING-002: these are the channel's privacy controls;
 * nothing here invites the sender to teach FloFi.
 */
import { targetLabel } from '../../domain/copilot-learning-copy.ts';
import { isLexiconTarget } from '../../domain/copilot-lexicon.ts';
import type { ChannelLanguage } from './config.ts';

const label = (target: string, language: ChannelLanguage) => isLexiconTarget(target) ? targetLabel(target, language) : target;
const EN = {
  list: (entries: readonly { readonly term: string; readonly target: string }[], paused: boolean, language: ChannelLanguage) =>
    `FloFi remembers for this chat account:\n${entries.map(e => `• ${e.term} → ${label(e.target, language)}`).join('\n')}${paused ? '\nMemory is paused (send “memory on” to use it again).' : ''}\nSend “forget arb” to remove one, “forget everything” to delete all, “memory off” to pause.`,
  empty: 'FloFi keeps nothing for this chat account.',
  paused: 'Memory off. FloFi will not use or learn anything from this chat account until you send “memory on”; what it learned automatically was deleted.',
  resumed: 'Memory on. FloFi uses what it keeps for this chat account (only here). Send “memory off” to stop at any time.',
  unavailable: 'Memory is unavailable right now. Everything else works as usual.',
  help: 'MEMORY shows what FloFi remembers for you here; “forget everything” deletes it.',
};
const PT: typeof EN = {
  list: (entries, paused, language) =>
    `O FloFi lembra para esta conta do chat:\n${entries.map(e => `• ${e.term} → ${label(e.target, language)}`).join('\n')}${paused ? '\nA memória está pausada (envie “ativar memória” para voltar a usar).' : ''}\nEnvie “esqueça arb” para remover um, “esqueça tudo” para apagar todos, “pausar memória” para pausar.`,
  empty: 'O FloFi não guarda nada para esta conta do chat.',
  paused: 'Memória desligada. O FloFi não vai usar nem aprender nada desta conta do chat até você enviar “ativar memória”; o que ele aprendeu automaticamente foi apagado.',
  resumed: 'Memória ativada. O FloFi usa o que guarda para esta conta do chat (só aqui). Envie “pausar memória” para parar quando quiser.',
  unavailable: 'A memória está indisponível agora. Todo o resto funciona normalmente.',
  help: 'MEMÓRIA mostra o que o FloFi lembra para você aqui; “esqueça tudo” apaga.',
};
export const channelLearningCopy = (language: ChannelLanguage) => language === 'PT' ? PT : EN;
