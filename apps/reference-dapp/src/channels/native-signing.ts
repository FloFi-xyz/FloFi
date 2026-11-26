// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-NATIVE-CHANNEL-SIGNING-001: what FloFi's native signing service says to the conversation that asked for it — its Review with the one-tap
 * confirmation, that the wallet's answer was sent, or why it ended — through the conversation's own provider and outbox (deduplicated by key, so a
 * repeated event never posts twice). Then the approval's existing status notifications follow (claimed, run states, the verified receipt). Text
 * only, written by FloFi; this module decides nothing about the operation and runs none of its steps.
 */
import type { EngineRuntime } from '../platform/index.ts';
import { channelLogger } from './core/log.ts';
import { open, sealContext } from './core/crypto.ts';
import { deliverConversation, newOutboxId, sealReply } from './core/delivery.ts';
import { notifyChannelHandoff } from './core/notify.ts';
import { parseStateLanguage } from './core/state-language.ts';
import type { ChannelLanguage } from './core/config.ts';
import { channelProviders, type ProviderSeams } from './providers.ts';
import { readChannelDeployment } from './registry.ts';
import { channelHost, channelRuntime, type ChannelHost } from './runtime.ts';

type Env = Readonly<Record<string, string | undefined>>;
export type NativeNotice = { readonly conversationId: string; readonly handoffId: string; readonly dedupeKey: string;
  readonly text: Readonly<Record<ChannelLanguage, string>>; readonly link: { readonly label: Readonly<Record<ChannelLanguage, string>>; readonly url: string } | null };
export type NativeNoticeOptions = { readonly host?: ChannelHost; readonly runtime?: EngineRuntime; readonly seams?: ProviderSeams; readonly now?: () => Date };

/** Posts one native signing notice to its conversation (in the conversation's language) and then the approval's due status notifications. */
export async function deliverNativeNotice(env: Env, notice: NativeNotice, options: NativeNoticeOptions = {}): Promise<boolean> {
  const deployment = readChannelDeployment(env);
  if (!deployment.ok) return false;
  const { core } = deployment.deployment, now = options.now ?? (() => new Date()), log = channelLogger(null);
  const host = await channelHost(env, core, options.host);
  if ('code' in host) return false;
  const { store, platform } = channelRuntime(env, core, host, options.runtime);
  const conversation = await store.conversation(notice.conversationId);
  const adapters = channelProviders(deployment.deployment, options.seams).adapters, adapter = conversation ? adapters.get(conversation.channel) : undefined;
  if (!conversation || conversation.status !== 'ACTIVE' || !adapter) return false;
  const state = open(core.keys.seal, conversation.stateSealed, sealContext(core.tenantId, 'channel_conversations', conversation.conversationId, 'state'));
  const language = parseStateLanguage(state, core.language);
  const delivery = { tenantId: core.tenantId, origin: core.origin, keys: core.keys, store, adapter, handoffs: platform.handoffs, log, now };
  const outboxId = newOutboxId(), reply = { text: notice.text[language], choices: [], link: notice.link ? { label: notice.link.label[language], url: notice.link.url } : null };
  const inserted = await store.enqueue(conversation.conversationId, [{ outboxId, dedupeKey: notice.dedupeKey, kind: 'NOTIFICATION', sequence: 0,
    bodySealed: sealReply(delivery, outboxId, reply, core.origin), handoffId: notice.handoffId }], now());
  if (inserted.length) await deliverConversation(delivery, conversation.conversationId, { kinds: ['REPLY', 'NOTIFICATION'], language });
  // The approval's own status notifications (claimed for the owner, each run state, the verified receipt) follow as for every approval.
  const handoff = await platform.handoffs.forRequester(notice.handoffId, { kind: 'CHANNEL_CONVERSATION', ref: notice.conversationId }, now());
  if (handoff) await notifyChannelHandoff({ core, store, log, now, platform, adapters }, handoff).catch(() => undefined);
  return inserted.length > 0;
}
