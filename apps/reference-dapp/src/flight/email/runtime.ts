// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-FLIGHT-LAUNCH-001: assembles Flight FloFi email delivery from a process's environment (the Railway worker, the operator CLI).
 * Fail-closed and explicit: every missing or invalid setting is a fixed code, and nothing is sent without all of them.
 *
 * Server-only settings (never `NEXT_PUBLIC_`):
 * - `RESEND_API_KEY` — the Resend key (only on the process that sends).
 * - `FLOFI_FLIGHT_ACCESS_SECRET` — at least 32 characters; derives access links, codes and unsubscribe signatures. Same value on Vercel.
 * - `FLOFI_EMAIL_FROM` (default `FloFi <hello@flofi.xyz>`), `FLOFI_EMAIL_REPLY_TO` (default `flofi.xyz@gmail.com`).
 * - `FLOFI_PUBLIC_ORIGIN` (default https://flofi.xyz) — where links and images in emails point.
 * - `FLOFI_EMAIL_DAILY_LIMIT` / `FLOFI_EMAIL_MONTHLY_LIMIT` (default 100 / 3000) and `FLOFI_EMAIL_EXTERNAL_*_RESERVE` (room for email sent outside FloFi).
 * - `FLOFI_RESEND_DOMAIN_ATTESTED=flofi.xyz` — only for a sending-only key that cannot list domains: the operator attests the domain shows
 *   "Verified" in the Resend dashboard. Without it, the worker checks the domain through the API and sends nothing until it is verified.
 * - `FLOFI_EMAIL_PER_SECOND` (default 2) — pacing under the provider's request rate limit.
 * - The campaign calendar (`FLOFI_FLIGHT_*_AT`, see campaign.ts).
 */
import type { Database, Logger } from '@defi-workflow-engine/cloud-runtime';
import { accessSecret } from '../access.ts';
import { createAccessStore } from '../access-store.ts';
import { flightCalendarFrom } from '../campaign.ts';
import { createFlightStore } from '../store.ts';
import { createEmailDelivery, FLIGHT_EMAIL_DOMAIN, FLIGHT_EMAIL_FROM, FLIGHT_EMAIL_REPLY_TO, type EmailDelivery } from './delivery.ts';
import { createEmailOutbox, emailLimitsFrom, type EmailOutbox } from './outbox.ts';
import { createResendClient, type ResendClient } from './resend.ts';

type Env = Readonly<Record<string, string | undefined>>;
export const FLIGHT_PUBLIC_ORIGIN = 'https://flofi.xyz';
const ADDRESS = /^[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+$/;
const SENDER = /^[A-Za-z0-9 .'-]{1,60} <[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+>$/;

export type FlightEmailRuntime = { readonly delivery: EmailDelivery; readonly outbox: EmailOutbox; readonly provider: ResendClient; readonly from: string };
export type RuntimeResult = FlightEmailRuntime | { readonly disabled: string };

export function flightEmailRuntime(env: Env, db: Database, tenantId: string, logger: Logger, options: { readonly fetch?: typeof fetch } = {}): RuntimeResult {
  const apiKey = env.RESEND_API_KEY?.trim();
  if (!apiKey || !/^re_[A-Za-z0-9_]{8,200}$/.test(apiKey)) return { disabled: 'RESEND_API_KEY_MISSING' };
  const secret = accessSecret(env);
  if (!secret) return { disabled: 'FLOFI_FLIGHT_ACCESS_SECRET_MISSING' };
  const { calendar } = flightCalendarFrom(env);
  if (!calendar) return { disabled: 'FLIGHT_CALENDAR_INVALID' };
  const from = env.FLOFI_EMAIL_FROM?.trim() || FLIGHT_EMAIL_FROM, replyTo = env.FLOFI_EMAIL_REPLY_TO?.trim() || FLIGHT_EMAIL_REPLY_TO;
  if (!SENDER.test(from) || !from.toLowerCase().endsWith(`@${FLIGHT_EMAIL_DOMAIN}>`)) return { disabled: 'FLOFI_EMAIL_FROM_INVALID' };
  if (!ADDRESS.test(replyTo)) return { disabled: 'FLOFI_EMAIL_REPLY_TO_INVALID' };
  const origin = env.FLOFI_PUBLIC_ORIGIN?.trim() || FLIGHT_PUBLIC_ORIGIN;
  if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?$/.test(origin)) return { disabled: 'FLOFI_PUBLIC_ORIGIN_INVALID' };
  let limits;
  try { limits = emailLimitsFrom(env); } catch { return { disabled: 'FLOFI_EMAIL_LIMIT_INVALID' }; }
  const perSecond = Number(env.FLOFI_EMAIL_PER_SECOND ?? 2);
  if (!Number.isFinite(perSecond) || perSecond <= 0 || perSecond > 50) return { disabled: 'FLOFI_EMAIL_PER_SECOND_INVALID' };
  const host = { db, tenantId };
  const provider = createResendClient({ apiKey, from, replyTo, ...options.fetch ? { fetch: options.fetch } : {} });
  const outbox = createEmailOutbox(host, limits), store = createFlightStore(host, calendar), access = createAccessStore(host, secret);
  const delivery = createEmailDelivery({ db, tenantId, calendar, secret, origin, provider, outbox, store, access, logger, perSecond,
    domainAttested: env.FLOFI_RESEND_DOMAIN_ATTESTED?.trim() === FLIGHT_EMAIL_DOMAIN });
  return { delivery, outbox, provider, from };
}
