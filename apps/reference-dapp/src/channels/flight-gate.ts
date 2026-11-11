// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Closed-beta gate wiring for conversational channels (HTTP/dispatch only — not Channel Core). Reuses the existing Telegram↔wallet
 * automation notification link as binding proof, then re-checks the linked wallet's Flight grant server-side. The link alone never
 * grants beta access or financial authority.
 *
 * WhatsApp keeps provider controls and has no automation wallet link in this release: private authoring stays closed under beta/closed
 * while HELP/STOP/privacy and delivery/status/reconciliation remain available through Channel Core.
 */
import { ownerOfConversation } from '../automations/subscriptions.ts';
import { betaAccessMode, createBetaAccessStore } from '../flight/beta-access.ts';
import { flightCalendarFrom } from '../flight/campaign.ts';
import type { ChannelPrivateAuthorizer } from './core/service.ts';
import type { ChannelId } from './core/types.ts';
import type { ChannelHost } from './runtime.ts';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * `null` while the rollout is open (no channel Flight gate). Otherwise every private turn re-resolves the conversation's live
 * Telegram automation link and the linked wallet's Flight grant at drain time.
 */
export function channelPrivateAuthorizer(env: Env, host: ChannelHost, channel: ChannelId): ChannelPrivateAuthorizer | null {
  const mode = betaAccessMode(env);
  if (mode === 'open') return null;
  return async (conversationId, now) => {
    if (mode !== 'beta') return { ok: false, code: 'BETA_ACCESS_CLOSED' };
    if (channel !== 'TELEGRAM') return { ok: false, code: 'BETA_CHANNEL_ACCESS_CLOSED' };
    const { calendar } = flightCalendarFrom(env);
    if (!calendar) return { ok: false, code: 'BETA_CONFIGURATION_INVALID' };
    const owner = await ownerOfConversation(host.db, host.tenantId, conversationId, now);
    if (!owner) return { ok: false, code: 'BETA_CHANNEL_NOT_LINKED' };
    const result = await createBetaAccessStore(host, calendar).requireWallet(owner, now.getTime());
    return result.ok ? { ok: true } : { ok: false, code: result.code };
  };
}
