// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHANNELS-001: Channel Core's service — the only place where a channel's turn touches durable state and the shared platform.
 *
 *   ingest  authenticated, normalized provider events → content-free event records (deduplicated by keyed digest), the sender's
 *           conversation (keyed digest + encrypted send address), and a transient encrypted payload; a secret is replaced by a marker
 *           BEFORE anything is stored; senders outside the allowlist get a content-free record only
 *   drain   one lease holder per conversation processes its events in provider order: decide the turn (`conversation.ts`), perform it
 *           through the shared platform (canonical strategy, approval handoff, revocation, status, preview), commit state + outbox in
 *           one transaction under the lease, then deliver (`delivery.ts`)
 *
 * The approval link is created by the platform, attached to the outgoing message in memory and never stored or logged. Nothing here
 * signs, submits, claims or authorizes; no message is ever authorization.
 *
 * BUILD-CHAT-LEARNING-001: with a learning service, each turn of an ACTIVE conversation loads the sender's learning context — the sender is a
 * learning identity of its own (channel, business, keyed sender digest), never a wallet and never another channel — adds the bounded glossary to
 * the interpreter request, performs a memory action only after the sender's own statement or click, answers MEMORY commands, records
 * content-free feedback, and erases the sender's learning data on STOP. Learning problems never fail a turn.
 */
import { looksSecret } from '../../domain/copilot-conversation';
import { stepSummary } from '../../domain/copilot-answers';
import type { Command } from '../../domain/commands';
import { PlatformRefusal, previewPlan, simulatePreview } from '../../platform/index.ts';
import { channelRequester, createChannelApproval, revokeChannelApproval, channelApprovalProgress, type ChannelPlatform } from './approval.ts';
import type { ChannelCoreConfig, ChannelLanguage } from './config.ts';
import { decideTurn, parseState, type ChannelInterpreter, type ChannelState, type TurnContent, type TurnDecision, type TurnInterpreter } from './conversation.ts';
import { learningCopy } from '../../domain/copilot-learning-copy.ts';
import type { ChannelLearning, ChannelLearningPrincipal, ChannelLearningSession } from './learning.ts';
import { channelLearningCopy } from './learning-copy.ts';
import { channelCopy, readyText, shorten, type PreviewNote } from './copy.ts';
import { channelRowId, keyedDigest, leaseToken, open, seal, sealContext } from './crypto.ts';
import { addressContext, deliverConversation, newOutboxId, sealReply, type DeliveryContext } from './delivery.ts';
import type { ChannelLogger } from './log.ts';
import { parseStateLanguage } from './state-language.ts';
import { statusReplies } from './status.ts';
import { RETENTION, type ChannelStore, type ConversationRecord, type NewOutbox, type PendingEvent } from './store.ts';
import { SUBSCRIBE_LIMIT, type ChannelSubscriptions } from './subscriber.ts';
import { canonicalStrategy } from './strategy.ts';
import type { ChannelAdapter, ChannelAddress, ChannelReply, ChannelVisualRenderer, DeliveryUpdate, InboundMessage } from './types.ts';

export type ChannelContext = { readonly core: ChannelCoreConfig; readonly store: ChannelStore; readonly platform: ChannelPlatform; readonly adapter: ChannelAdapter;
  readonly interpreter: ChannelInterpreter | null; readonly log: ChannelLogger; readonly now: () => Date; readonly previewTimeoutMs?: number;
  /** Test seams for delivery: the wait between inline approval retries, the jitter source. */
  readonly sleep?: (ms: number) => Promise<void>; readonly random?: () => number;
  /** BUILD-AUTOMATION-001: the subscription hook (linking a chat to an owner's automation notifications); none = not offered. */
  readonly subscriptions?: ChannelSubscriptions | null;
  /** BUILD-WORKFLOW-VISUAL-PRESENTATION-001: the shared workflow renderer; none = proposals are sent as text only. */
  readonly visuals?: ChannelVisualRenderer | null;
  /** BUILD-BASE-001: registers the validated catalogs of the catalog networks a message names (the deployment's own gates); none = pinned assets only. */
  readonly catalogs?: ((text: string, intent?: unknown) => Promise<void>) | null;
  /** BUILD-CHAT-LEARNING-001: learning for this provider's senders (`learning.ts`, implemented by the wiring); none = learning off (turns as before). */
  readonly learning?: ChannelLearning | null };
export const LEASE_SECONDS = 300;
export const LIMITS = Object.freeze({ inbound: [20, 600] as const, model: [30, 3_600] as const, modelDaily: [100, 86_400] as const, preview: [10, 3_600] as const });
const MAX_EVENT_ATTEMPTS = 3;
type Payload = { readonly content: TurnContent; readonly sendTo: ChannelAddress };
const text = (value: string): ChannelReply => ({ text: shorten(value), choices: [], link: null });
const PORTUGUESE_SECRET = /chaves?\s+privad|frases?\s+(?:semente|secreta|de\s+recupera)|palavras\s+secretas/i;

export function createChannelService(ctx: ChannelContext) {
  const { core, store, adapter, log } = ctx, keys = core.keys, tenant = core.tenantId;
  const languageOf = (intent: unknown): 'EN' | 'PT' | null => { const value = (intent as { language?: unknown } | null)?.language; return value === 'EN' || value === 'PT' ? value : null; };
  const stateContext = (conversationId: string) => sealContext(tenant, 'channel_conversations', conversationId, 'state');
  const payloadContext = (digest: Buffer) => sealContext(tenant, 'channel_events', digest.toString('hex'), 'payload');
  const delivery: DeliveryContext = { tenantId: tenant, origin: core.origin, keys, store, adapter, handoffs: ctx.platform.handoffs, log, now: ctx.now,
    ...ctx.sleep ? { sleep: ctx.sleep } : {}, ...ctx.random ? { random: ctx.random } : {}, ...ctx.visuals ? { visuals: ctx.visuals } : {} };
  const subjectKey = (m: InboundMessage) => `${m.channel}:${m.subject.business}:${m.subject.user}`;
  /** Choices the provider cannot show as buttons are listed as numbers (answerable by number), in the reply's language. */
  const fitted = (reply: ChannelReply, language: ChannelLanguage): ChannelReply => !reply.choices.length || adapter.choicesFit(reply.choices) ? reply
    : { ...reply, text: `${reply.text}\n${reply.choices.map((c, i) => `${i + 1}. ${c.label}`).join('\n')}\n${channelCopy(language).choose}` };

  /**
   * BUILD-TELEGRAM-PUBLIC-001: one model call needs this conversation's hourly and daily allowance, then the deployment's global budget
   * (every conversation, channel and instance share it through the store's atomic windows). Spent: COPILOT_BUSY, exact commands still work.
   */
  async function modelAllowed(conversationId: string, now: Date) {
    return await store.allow(`channel:model:${conversationId}`, LIMITS.model[0], LIMITS.model[1], now)
      && await store.allow(`channel:model:day:${conversationId}`, LIMITS.modelDaily[0], LIMITS.modelDaily[1], now)
      && await store.allow('channel:model:global:hour', core.modelBudget.hourly, 3_600, now)
      && await store.allow('channel:model:global:day', core.modelBudget.daily, 86_400, now);
  }
  /** Records authenticated provider events; returns the conversations with new work. Duplicate deliveries record nothing. */
  async function ingest(messages: readonly InboundMessage[], deliveries: readonly DeliveryUpdate[] = []) {
    const now = ctx.now(), touched = new Set<string>();
    let duplicates = 0, ignored = 0;
    for (const m of messages) {
      const eventDigest = keyedDigest(keys.event, `${m.channel}:${m.subject.business}:${m.eventId}`);
      if (!m.allowed) {
        const fresh = await store.recordEvents([{ channel: m.channel, eventDigest, conversationId: null, sentAt: m.sentAt, status: 'IGNORED', payloadSealed: null,
          outcome: 'IGNORED_NOT_ALLOWLISTED' }], now);
        ignored += fresh.length; duplicates += 1 - fresh.length;
        continue;
      }
      const conversation = await store.ensureConversation(m.channel, m.subject.business, keyedDigest(keys.subject, subjectKey(m)), m.sentAt, now, channelRowId('chc'));
      if (conversation.status === 'ACTIVE') await store.storeAddress(conversation.conversationId, seal(keys.seal, JSON.stringify(m.sendTo), addressContext(tenant, conversation.conversationId)));
      // A secret is never stored, not even encrypted: only a marker of its language travels to the turn.
      const content: TurnContent = m.content.kind === 'TEXT' && looksSecret(m.content.text) ? { kind: 'SECRET', language: PORTUGUESE_SECRET.test(m.content.text) ? 'PT' : core.language }
        : m.content;
      const payload: Payload = { content, sendTo: m.sendTo };
      const fresh = await store.recordEvents([{ channel: m.channel, eventDigest, conversationId: conversation.conversationId, sentAt: m.sentAt, status: 'PENDING',
        payloadSealed: seal(keys.seal, JSON.stringify(payload), payloadContext(eventDigest)), outcome: null }], now);
      if (fresh.length) touched.add(conversation.conversationId); else duplicates++;
    }
    let applied = 0;
    for (const d of deliveries) if (await store.applyDelivery(d.correlationId, keyedDigest(keys.provider, d.providerMessageId), d.status, d.errorCode, now)) applied++;
    // Retention without a scheduler: every authenticated delivery erases what has outlived its window (a crashed turn's payload, an
    // unsent body, idle state and addresses, old records). A failure here never blocks the delivery.
    await store.purge(now).catch(() => undefined);
    log.info('channel.ingest', { channel: adapter.channel, events: messages.length, duplicates, ignored, deliveries: applied });
    return { conversations: [...touched], duplicates, ignored };
  }

  /** Processes a conversation's pending events in order while holding its lease, delivering after each turn. */
  async function drain(conversationId: string): Promise<{ readonly processed: number }> {
    // Each provider's service processes only its own conversations.
    if ((await store.conversation(conversationId))?.channel !== adapter.channel) return { processed: 0 };
    const token = leaseToken();
    if (!await store.acquire(conversationId, token, ctx.now(), LEASE_SECONDS)) return { processed: 0 };
    let processed = 0;
    try {
      for (;;) {
        const event = await store.nextEvent(conversationId, token, ctx.now());
        if (!event) { if (await store.release(conversationId, token, ctx.now())) break; continue; }
        const links = new Map<string, string>();
        const { address, language } = await turn(conversationId, token, event, links);
        processed++;
        await deliverConversation(delivery, conversationId, { kinds: ['REPLY', 'APPROVAL', 'NOTIFICATION'], links, address, language });
      }
    } catch (cause) {
      log.warn('channel.drain.stopped', { channel: adapter.channel, conversation: conversationId, code: cause instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(cause.message) ? cause.message : 'CHANNEL_DRAIN_FAILED' });
    }
    return { processed };
  }

  /** One event: decide, perform through the platform, commit under the lease. Returns the in-memory address override (opt-out) and language. */
  async function turn(conversationId: string, token: string, event: PendingEvent, links: Map<string, string>): Promise<{ address: ChannelAddress | null; language: ChannelLanguage }> {
    const now = ctx.now(), started = performance.now();
    const conversation: ConversationRecord | null = await store.conversation(conversationId);
    if (!conversation) return { address: null, language: core.language };
    let payload: Payload | null;
    try { payload = JSON.parse(open(keys.seal, event.payloadSealed, payloadContext(event.eventDigest)) ?? 'null') as Payload | null; } catch { payload = null; }
    let state = parseState(conversation.status === 'ACTIVE' ? open(keys.seal, conversation.stateSealed, stateContext(conversationId)) : null, core.language);
    const commit = async (outcome: string, replies: readonly ChannelReply[], next: ChannelState | null | undefined, extra: { handoffId?: string | null;
      conversationStatus?: 'ACTIVE' | 'OPTED_OUT'; status?: 'DONE' | 'FAILED'; approvalReply?: { reply: ChannelReply; handoffId: string } | null } = {}) => {
      const outbox: NewOutbox[] = [];
      for (const [i, original] of replies.entries()) {
        const outboxId = newOutboxId(), approval = extra.approvalReply?.reply === original, reply = fitted(original, state.language);
        outbox.push({ outboxId, dedupeKey: `reply:${event.eventDigest.toString('hex').slice(0, 32)}:${i}`, kind: approval ? 'APPROVAL' : 'REPLY', sequence: i,
          bodySealed: sealReply(delivery, outboxId, reply), handoffId: approval ? extra.approvalReply!.handoffId : null });
        if (approval && reply.link) links.set(outboxId, reply.link.url);
      }
      const stateSealed = next === undefined ? undefined : next === null ? null : seal(keys.seal, JSON.stringify(next), stateContext(conversationId));
      await store.completeTurn(conversationId, token, { channel: event.channel, eventDigest: event.eventDigest, status: extra.status ?? 'DONE', outcome,
        handoffId: extra.handoffId ?? null, ...stateSealed === undefined ? {} : { stateSealed }, ...extra.conversationStatus ? { conversationStatus: extra.conversationStatus } : {},
        outbox }, now);
      log.info('channel.turn', { channel: adapter.channel, conversation: conversationId, outcome, count: replies.length, duration_ms: Math.round(performance.now() - started) });
    };
    if (!payload) { await commit('PAYLOAD_UNREADABLE', [], undefined, { status: 'FAILED' }); return { address: null, language: state.language }; }
    if (event.attempts > MAX_EVENT_ATTEMPTS) { await commit('EVENT_ATTEMPTS_EXHAUSTED', [], undefined, { status: 'FAILED' }); return { address: null, language: state.language }; }
    const m = channelCopy(state.language), active = conversation.status === 'ACTIVE';
    if (now.getTime() - event.sentAt.getTime() > RETENTION.transientMs) {
      await commit('LATE_MESSAGE', active ? [text(m.late)] : [], undefined); return { address: null, language: state.language };
    }
    if (active && !await store.allow(`channel:inbound:${conversationId}`, LIMITS.inbound[0], LIMITS.inbound[1], now)) {
      const notice = await store.allow(`channel:busy:${conversationId}`, 1, LIMITS.inbound[1], now);
      await commit('RATE_LIMITED', notice ? [text(m.busy)] : [], undefined); return { address: null, language: state.language };
    }
    // BUILD-CHAT-LEARNING-001: the sender's own learning identity and context (only for an ACTIVE conversation; never fails the turn).
    const principal: ChannelLearningPrincipal | null = ctx.learning && conversation.subjectDigest.length === 32
      ? { kind: 'CHANNEL', channel: conversation.channel, business: conversation.businessId, sender: conversation.subjectDigest } : null;
    const session: ChannelLearningSession | null = principal && active ? await ctx.learning!.session(principal) : null;
    const interpret: TurnInterpreter | null = ctx.interpreter && core.copilot ? async (request, hints) => {
      if (!await modelAllowed(conversationId, now)) return { ok: false, code: 'COPILOT_BUSY' };
      const glossary = session ? ctx.learning!.glossary(session, request.messages, hints?.aliases ?? []) : null;
      const result = await ctx.interpreter!(request, glossary?.glossary ? { glossary: glossary.glossary } : undefined);
      if (session && glossary) await ctx.learning!.record([{ kind: 'INTERPRETED', outcome: result.ok ? 'OK' : result.code, language: result.ok ? languageOf(result.intent) : null,
        privateEntries: glossary.privateEntries, globalEntries: glossary.globalEntries, knowledgeVersion: session.learning.globalVersion }], session.subjectId);
      return result;
    } : null;
    const prior = state;
    let decision = await decideTurn({ content: payload.content, state, optedOut: !active, interpret, support: core.supportContact, privacy: core.privacyUrl,
      catalogs: ctx.catalogs ?? null, ...session && session.learning.memory !== 'UNAVAILABLE' ? { learning: session.learning } : {} });
    if (session) decision = await learn(decision, principal!, session);
    state = decision.state;
    const lm = channelCopy(state.language);
    switch (decision.action) {
      case 'IGNORE': await commit(decision.outcome, [], undefined); return { address: null, language: state.language };
      case 'OPT_OUT': {
        // Opting out withdraws the live approval link too: nothing from this conversation stays claimable.
        await revokeChannelApproval(ctx.platform, conversationId, prior.approvalId, now).catch(() => false);
        // BUILD-CHAT-LEARNING-001: ...and erases what FloFi remembers for this sender (memory, settings, contributions).
        if (principal) await ctx.learning!.erase(principal).catch(() => undefined);
        // ...and ends a link to automation notifications (BUILD-AUTOMATION-001).
        await ctx.subscriptions?.unlink(conversationId).catch(() => false);
        await commit(decision.outcome, decision.replies, null, { conversationStatus: 'OPTED_OUT' });
        return { address: payload.sendTo, language: state.language };
      }
      case 'OPT_IN': {
        await commit(decision.outcome, decision.replies, state, { conversationStatus: 'ACTIVE' });
        await store.storeAddress(conversationId, seal(keys.seal, JSON.stringify(payload.sendTo), addressContext(tenant, conversationId)));
        return { address: payload.sendTo, language: state.language };
      }
      case 'STATUS': {
        const found = state.lastApprovalId ? await channelApprovalProgress(ctx.platform, conversationId, state.lastApprovalId, now) : null;
        await commit(decision.outcome, [...decision.replies, ...statusReplies(state.language, found)], state); return { address: null, language: state.language };
      }
      case 'CANCEL': {
        await revokeChannelApproval(ctx.platform, conversationId, prior.approvalId, now);
        await commit(decision.outcome, [...decision.replies, text(prior.pending ? lm.cancelled : lm.noPending)], state);
        return { address: null, language: state.language };
      }
      case 'SUBSCRIBE': {
        // BUILD-AUTOMATION-001: the code goes to the hook only; it is never stored, logged or echoed back.
        let reply = lm.subscribeUnavailable, outcome = 'SUBSCRIBE_UNAVAILABLE';
        if (ctx.subscriptions && decision.subscribeCode) {
          if (!await store.allow(`channel:subscribe:${conversationId}`, SUBSCRIBE_LIMIT[0], SUBSCRIBE_LIMIT[1], now)) { reply = lm.busy; outcome = 'SUBSCRIBE_RATE_LIMITED'; }
          else {
            const linked = await ctx.subscriptions.link({ channel: adapter.channel, conversationId, code: decision.subscribeCode, now })
              .catch(() => ({ ok: false, code: 'SUBSCRIBE_FAILED' }) as const);
            reply = linked.ok ? lm.subscribed(linked.label, linked.days) : lm.subscribeFailed;
            outcome = linked.ok ? 'SUBSCRIBED' : 'SUBSCRIBE_REFUSED';
          }
        }
        await commit(outcome, [...decision.replies, text(reply)], state);
        return { address: null, language: state.language };
      }
      case 'LINK': {
        if (!state.pending) { await commit(decision.outcome, [...decision.replies, text(lm.noPending)], state); return { address: null, language: state.language }; }
        const proposed = await propose(conversationId, state, state.pending, false, [], now);
        await commit(proposed.outcome, [...decision.replies, ...proposed.replies], proposed.state, { handoffId: proposed.handoffId, approvalReply: proposed.approvalReply });
        return { address: null, language: state.language };
      }
      case 'PROPOSE': {
        const proposed = await propose(conversationId, state, decision.command!, decision.aiInterpreted, decision.notes, now);
        await commit(proposed.outcome, [...decision.replies, ...proposed.replies], proposed.state, { handoffId: proposed.handoffId, approvalReply: proposed.approvalReply });
        return { address: null, language: state.language };
      }
      default: await commit(decision.outcome, decision.replies, state); return { address: null, language: state.language };
    }
  }
  /**
   * BUILD-CHAT-LEARNING-001: the learning part of a decided turn — the memory action the sender confirmed (its failure replaces the reply), a
   * MEMORY command's answer, the used saved meanings (retention restarts) and the content-free feedback. Never throws.
   */
  async function learn(decision: TurnDecision, principal: ChannelLearningPrincipal, session: ChannelLearningSession): Promise<TurnDecision> {
    const learning = ctx.learning!, language = decision.state.language;
    let out = decision;
    if (decision.memory) {
      const result = await learning.apply(principal, decision.memory);
      if (!result.ok) {
        const l = learningCopy(language);
        out = { ...out, replies: [text(result.code === 'LEARNING_RATE_LIMITED' ? l.limited : result.code === 'LEARNING_MEMORY_FULL' ? l.full : l.failed)] };
      }
    }
    if (decision.memoryCommand) {
      const m = channelLearningCopy(language);
      let reply = m.unavailable;
      if (session.learning.memory !== 'UNAVAILABLE') {
        try {
          if (decision.memoryCommand === 'SHOW') {
            const status = await learning.status(principal);
            reply = status.entries.length ? m.list(status.entries, status.paused, language) : m.empty;
          } else reply = (await learning.settings(principal, { memory: decision.memoryCommand === 'ON' })).ok ? decision.memoryCommand === 'ON' ? m.resumed : m.paused : m.unavailable;
        } catch { reply = m.unavailable; }
      }
      out = { ...out, replies: [...decision.replies, text(reply)] };
    }
    const used = decision.learning?.used ?? [], own = used.filter(entry => entry.source !== 'GLOBAL'), shared = used.length - own.length;
    await session.used(own).catch(() => undefined);
    // A Copilot turn's outcome, as the web chat reports it (the reply kind); local commands and exact-grammar proposals are not interpretation.
    const copilotOutcome = decision.outcome === 'PROPOSED_INTERPRETED' ? 'PROPOSAL' : /^COPILOT_[A-Z_]+$/.test(decision.outcome) ? decision.outcome.slice('COPILOT_'.length) : null;
    await learning.record([...copilotOutcome ? [{ kind: 'TURN', outcome: copilotOutcome, language, privateEntries: own.length, globalEntries: shared,
      knowledgeVersion: session.learning.globalVersion }] : [], ...(decision.learning?.signals ?? []).map(kind => ({ kind })), ...own.length ? [{ kind: 'MEMORY_USED' as const }] : [],
    ...shared ? [{ kind: 'KNOWLEDGE_USED' as const, knowledgeVersion: session.learning.globalVersion }] : []], session.subjectId).catch(() => undefined);
    return out;
  }

  /**
   * The pending proposal → canonical strategy → (previous link revoked) → a new approval handoff on the shared platform → optional
   * read-only preview → the "strategy ready" reply carrying the link in memory and the canonical workflow's visual (presentation only:
   * the visual's workflow hash is the handoff's own).
   */
  async function propose(conversationId: string, state: ChannelState, command: Command, aiInterpreted: boolean, notes: readonly string[], now: Date) {
    const m = channelCopy(state.language), strategy = canonicalStrategy(command);
    const revoked = await revokeChannelApproval(ctx.platform, conversationId, state.approvalId, now);
    if (!strategy.ok) return { outcome: 'PROPOSAL_NOT_CANONICAL', replies: [text(m.refused(strategy.code))], state: { ...state, pending: null, approvalId: null },
      handoffId: null, approvalReply: null };
    const approval = await createChannelApproval(ctx.platform, channelRequester(adapter, conversationId, strategy.intendedWallet), strategy, now);
    if (!approval.ok) return { outcome: `APPROVAL_REFUSED`, replies: [text([m.refused(approval.code), ...approval.blockers].join('\n'))],
      state: { ...state, pending: strategy.command, approvalId: null }, handoffId: null, approvalReply: null };
    const preview = core.simulation ? await previewOf(conversationId, strategy, now) : { kind: 'DISABLED' } as const;
    const networks = strategy.spec.action === 'bridge' ? [strategy.spec.sourceNetwork, strategy.spec.destinationNetwork] : [(strategy.spec as { network: string }).network];
    const reply: ChannelReply = { text: readyText(state.language, { lines: strategy.steps.map(s => stepSummary(s, state.language)), networks, fundsClass: strategy.fundsClass,
      notes: [...revoked ? [m.replaced] : [], ...notes.slice(0, 2)], preview, intendedWallet: strategy.intendedWallet ? shorten(strategy.intendedWallet.address) : null,
      aiInterpreted, expiresMinutes: Math.round((approval.expiresAt.getTime() - now.getTime()) / 60_000) }),
    choices: [], link: { label: m.linkLabel, url: approval.approvalUrl }, visual: { model: strategy.visual, language: state.language } };
    return { outcome: 'APPROVAL_CREATED', replies: [reply], handoffId: approval.approvalId, approvalReply: { reply, handoffId: approval.approvalId },
      state: { ...state, pending: strategy.command, approvalId: approval.approvalId, lastApprovalId: approval.approvalId } };
  }

  /** The shared platform's read-only preview, when its subject is known from the strategy itself; bounded in time and per conversation. */
  async function previewOf(conversationId: string, strategy: Extract<ReturnType<typeof canonicalStrategy>, { ok: true }>, now: Date): Promise<PreviewNote> {
    const plan = previewPlan(strategy.spec);
    if ('code' in plan) return { kind: 'SKIPPED' };
    const subject = plan.subject === 'NONE' ? 'none' : plan.subject === 'EVM' ? strategy.intendedWallet?.address : undefined;
    if (!subject) return { kind: 'SKIPPED' };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        simulatePreview(ctx.platform.runtime, { strategy: strategy.spec, workflowHash: strategy.workflowHash, simulationSubject: subject },
          { budget: () => store.allow(`channel:preview:${conversationId}`, LIMITS.preview[0], LIMITS.preview[1], now) }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new PlatformRefusal('SIMULATION_TIMEOUT')), ctx.previewTimeoutMs ?? 60_000); }),
      ]);
      return { kind: 'PASSED', provenance: result.view.provenance };
    } catch (cause) {
      const code = cause instanceof PlatformRefusal || (cause instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(cause.message)) ? (cause as Error).message : 'SIMULATION_UNAVAILABLE';
      return code === 'SIMULATION_SUBJECT_INVALID' ? { kind: 'SKIPPED' } : { kind: 'FAILED', code };
    } finally { clearTimeout(timer); }
  }

  /**
   * Delivers a conversation's due messages outside a turn. An approval message found here has lost its link (links live only in the
   * turn that created them), so it is withdrawn and the user is told to send LINK.
   */
  const deliver = async (conversationId: string) => {
    const conversation = await store.conversation(conversationId);
    if (conversation?.channel !== adapter.channel) return null;
    const state = conversation.status === 'ACTIVE' ? open(keys.seal, conversation.stateSealed, stateContext(conversationId)) : null;
    return deliverConversation(delivery, conversationId, { kinds: ['REPLY', 'APPROVAL', 'NOTIFICATION'], language: parseStateLanguage(state, core.language) });
  };
  return { ingest, drain, deliver };
}
export type ChannelService = ReturnType<typeof createChannelService>;
