// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-NATIVE-CHANNEL-SIGNING-001: what FloFi's native signing service says to the conversation that asked for it — its Review with the one-tap
 * confirmation, that the wallet's answer was sent, or why it ended — through the conversation's own provider and outbox (deduplicated by key, so a
 * repeated event never posts twice). Once the wallet's answer is in, the approval's existing status notifications follow (the run's states and the
 * verified receipt; `status.ts` leaves out the "open FloFi" steps of a natively signed approval). Text only, written by FloFi; this module decides
 * nothing about the operation and runs none of its steps.
 */
import type { EngineRuntime } from '../platform/index.ts';
import { channelLogger, type ChannelLogSink } from './core/log.ts';
import { open, sealContext } from './core/crypto.ts';
import { deliverConversation, newOutboxId, sealReply } from './core/delivery.ts';
import { notifyChannelHandoff } from './core/notify.ts';
import { parseStateLanguage } from './core/state-language.ts';
import type { ChannelLanguage } from './core/config.ts';
import { channelProviders, type ProviderSeams } from './providers.ts';
import { readChannelDeployment } from './registry.ts';
import { channelRouteLogger } from './route-logger.ts';
import { channelHost, channelRuntime, type ChannelHost } from './runtime.ts';

type Env = Readonly<Record<string, string | undefined>>;
/** `followStatus`: the approval's own status notifications follow this notice (after the wallet's answer: sent, or ended). */
export type NativeNotice = { readonly conversationId: string; readonly handoffId: string; readonly dedupeKey: string; readonly followStatus?: boolean;
  readonly text: Readonly<Record<ChannelLanguage, string>>; readonly link: { readonly label: Readonly<Record<ChannelLanguage, string>>; readonly url: string } | null };
export type NativeNoticeOptions = { readonly host?: ChannelHost; readonly runtime?: EngineRuntime; readonly seams?: ProviderSeams; readonly now?: () => Date;
  readonly logger?: ChannelLogSink | null };

/** Posts one native signing notice to its conversation (in the conversation's language) and then the approval's due status notifications. */
export async function deliverNativeNotice(env: Env, notice: NativeNotice, options: NativeNoticeOptions = {}): Promise<boolean> {
  const deployment = readChannelDeployment(env);
  if (!deployment.ok) return false;
  const { core } = deployment.deployment, now = options.now ?? (() => new Date());
  const log = channelLogger(options.logger !== undefined ? options.logger : await channelRouteLogger().catch(() => null));
  const host = await channelHost(env, core, options.host);
  if ('code' in host) return false;
  const { store, platform } = channelRuntime(env, core, host, options.runtime);
  const conversation = await store.conversation(notice.conversationId);
  const adapters = channelProviders(deployment.deployment, options.seams).adapters, adapter = conversation ? adapters.get(conversation.channel) : undefined;
  if (!conversation || conversation.status !== 'ACTIVE' || !adapter) {
    // Never silent: the session itself is unchanged (its status stays readable), but this conversation was not told.
    log.info('channel.native.skipped', { conversation: notice.conversationId, code: !conversation ? 'NOT_FOUND' : conversation.status !== 'ACTIVE' ? 'NOT_ACTIVE' : 'NO_ADAPTER' });
    return false;
  }
  const state = open(core.keys.seal, conversation.stateSealed, sealContext(core.tenantId, 'channel_conversations', conversation.conversationId, 'state'));
  const language = parseStateLanguage(state, core.language);
  const delivery = { tenantId: core.tenantId, origin: core.origin, keys: core.keys, store, adapter, handoffs: platform.handoffs, log, now };
  const outboxId = newOutboxId(), reply = { text: notice.text[language], choices: [], link: notice.link ? { label: notice.link.label[language], url: notice.link.url } : null };
  const inserted = await store.enqueue(conversation.conversationId, [{ outboxId, dedupeKey: notice.dedupeKey, kind: 'NOTIFICATION', sequence: 0,
    bodySealed: sealReply(delivery, outboxId, reply, core.origin), handoffId: notice.handoffId }], now());
  if (inserted.length) await deliverConversation(delivery, conversation.conversationId, { kinds: ['REPLY', 'NOTIFICATION'], language });
  if (!inserted.length) log.info('channel.native.duplicate', { conversation: conversation.conversationId });
  // The approval's own status notifications (each run state, the verified receipt) follow once the wallet answered, as for every approval.
  if (notice.followStatus) {
    const handoff = await platform.handoffs.forRequester(notice.handoffId, { kind: 'CHANNEL_CONVERSATION', ref: notice.conversationId }, now());
    if (handoff) await notifyChannelHandoff({ core, store, log, now, platform, adapters }, handoff).catch(() => undefined);
  }
  return inserted.length > 0;
}

/**
 * After a native broadcast, the run's status may have changed: the approval's own status notifications (each run state, the verified receipt), as
 * for every approval, deduplicated by key. Returns how many were sent.
 */
export async function notifyNativeStatus(env: Env, target: { readonly conversationId: string; readonly handoffId: string }, options: NativeNoticeOptions = {}): Promise<number> {
  const deployment = readChannelDeployment(env);
  if (!deployment.ok) return 0;
  const { core } = deployment.deployment, now = options.now ?? (() => new Date());
  const log = channelLogger(options.logger !== undefined ? options.logger : await channelRouteLogger().catch(() => null));
  const host = await channelHost(env, core, options.host);
  if ('code' in host) return 0;
  const { store, platform } = channelRuntime(env, core, host, options.runtime);
  const adapters = channelProviders(deployment.deployment, options.seams).adapters;
  const handoff = await platform.handoffs.forRequester(target.handoffId, { kind: 'CHANNEL_CONVERSATION', ref: target.conversationId }, now());
  if (!handoff) return 0;
  return (await notifyChannelHandoff({ core, store, log, now, platform, adapters }, handoff).catch(() => ({ notified: 0 }))).notified;
}

/**
 * The conversation behind a "Sign with …" button, if it can still be answered there: its language. Null when the conversation is gone, stopped or
 * erased, or its channel is not enabled (the button then starts nothing).
 */
export async function nativeStartConversation(env: Env, conversationId: string, options: Pick<NativeNoticeOptions, 'host' | 'runtime' | 'seams'> = {}):
  Promise<{ readonly language: ChannelLanguage } | null> {
  const deployment = readChannelDeployment(env);
  if (!deployment.ok) return null;
  const { core } = deployment.deployment;
  const host = await channelHost(env, core, options.host);
  if ('code' in host) return null;
  const { store } = channelRuntime(env, core, host, options.runtime);
  const conversation = await store.conversation(conversationId);
  if (!conversation || conversation.status !== 'ACTIVE' || !channelProviders(deployment.deployment, options.seams).adapters.has(conversation.channel)) return null;
  const state = open(core.keys.seal, conversation.stateSealed, sealContext(core.tenantId, 'channel_conversations', conversation.conversationId, 'state'));
  return { language: parseStateLanguage(state, core.language) };
}
