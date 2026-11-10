// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-FLIGHT-LAUNCH-001: one delivery cycle of the Flight FloFi outbox — schedule (Email 2 at its time, Email 3 when a group opens),
 * lease within the quota, render each email from the database AT SEND TIME (a card removed, an address unsubscribed or a person already on
 * board is re-checked here), send through Resend with the email id as idempotency key, and settle the outcome. Runs on the Railway worker
 * (`FLOFI_FLIGHT_EMAIL=enabled`, backend/flight-email-worker.ts) and from the operator CLI (`flight-admin.ts email-send-due`).
 *
 * Fail-closed: no email is sent while the sending domain is not verified on the Resend account (or explicitly attested by an operator),
 * while the provider has blocked sending (quota, key), or for campaign email while the operator paused it. Logs carry codes, never an address.
 */
import type { Database, Logger } from '@defi-workflow-engine/cloud-runtime';
import type { FlightCalendar } from '../campaign.ts';
import { ACCESS_LINK_MS, addressHash, EMAIL_CODE_MS, REQUESTED_CODE_MS, unsubscribeTokenFor } from '../access.ts';
import type { AccessStore } from '../access-store.ts';
import type { FlightStore } from '../store.ts';
import type { EmailOutbox, EmailRow, Settlement } from './outbox.ts';
import type { OutgoingEmail, ResendClient, SendOutcome } from './resend.ts';
import { renderEmail, type CardView, type TemplateInput } from './templates.ts';

export const FLIGHT_EMAIL_FROM = 'FloFi <hello@flofi.xyz>';
export const FLIGHT_EMAIL_REPLY_TO = 'flofi.xyz@gmail.com';
export const FLIGHT_EMAIL_DOMAIN = 'flofi.xyz';
/** The creator brief linked from Email 6 (the artifact's "Open the creator brief"). */
export const FLIGHT_CREATOR_BRIEF_URL = 'https://cooked-goat-9ec.notion.site/Flight-FloFi-Brief-do-criador-4147b5d0a5fd81afb15ffdeb090a6450';
const DOMAIN_CHECK_MS = 10 * 60_000;

export type DeliveryDeps = {
  readonly db: Database; readonly tenantId: string; readonly calendar: Required<FlightCalendar>; readonly secret: string; readonly origin: string;
  readonly provider: Pick<ResendClient, 'send' | 'domainStatus'>; readonly outbox: EmailOutbox; readonly store: Pick<FlightStore, 'cardForEmail' | 'foundingOpen'>;
  readonly access: Pick<AccessStore, 'issueToken' | 'prune'>; readonly logger: Logger; readonly briefUrl?: string;
  /** The operator attested in the Resend dashboard that the domain is verified (for a sending-only key, which cannot list domains). */
  readonly domainAttested?: boolean; readonly perSecond?: number; readonly batchSize?: number;
  readonly now?: () => number; readonly sleep?: (ms: number) => Promise<void>;
};
export type CycleReport = { readonly scheduled: number; readonly leased: number; readonly sent: number; readonly unknown: number; readonly held: number;
  readonly failed: number; readonly cancelled: number; readonly retried: number; readonly skipped: string | null };

type Rendered = { readonly kind: 'SEND'; readonly email: OutgoingEmail } | { readonly kind: 'CANCEL'; readonly code: string };
const nextUtcDay = (ms: number) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); };
const nextUtcMonth = (ms: number) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); };

export function createEmailDelivery(deps: DeliveryDeps) {
  const now = deps.now ?? Date.now, sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const origin = deps.origin.replace(/\/$/, ''), perSecond = Math.max(0.1, deps.perSecond ?? 2), batchSize = deps.batchSize ?? 20;
  let domain: { at: number; ok: boolean } = { at: 0, ok: false }, prunedAt = 0;

  async function domainReady(at: number): Promise<boolean> {
    if (deps.domainAttested) return true;
    if (at - domain.at < DOMAIN_CHECK_MS) return domain.ok;
    const status = await deps.provider.domainStatus(FLIGHT_EMAIL_DOMAIN);
    domain = { at, ok: status === 'VERIFIED' };
    if (!domain.ok) deps.logger.warn('flight.email.domain_not_ready', { status });
    return domain.ok;
  }

  async function entryOf(entryId: string | null) {
    if (!entryId) return null;
    return (await deps.db.query<{ email: string; flight: 'FIRST' | 'NEXT'; batch_no: number | null; boarded_at: Date | null }>(`SELECT email, flight, batch_no, boarded_at
      FROM flight_list_entries WHERE tenant_id = $1 AND entry_id = $2`, [deps.tenantId, entryId])).rows[0] ?? null;
  }
  const cardView = (pass: { foundingSeat: number | null; seat: string; handle: string | null; route: { from: string; to: string; stepCount: number; networkCount: number };
    departedAt: string; publicId: string | null }): CardView | null => pass.publicId ? {
    founding: pass.foundingSeat !== null, seat: pass.seat, handle: pass.handle, from: pass.route.from, to: pass.route.to, stepCount: pass.route.stepCount,
    networkCount: pass.route.networkCount, departedAt: pass.departedAt, publicUrl: `${origin}/card/${pass.publicId}`, imageUrl: `${origin}/card/${pass.publicId}/image`,
    downloadUrl: `${origin}/card/${pass.publicId}/image?download=1` } : null;

  /** The email as it should be sent now, or why it must not be sent any more. */
  async function render(row: EmailRow, at: number): Promise<Rendered> {
    if (row.template === 'CREATOR_INVITE' && row.templateVersion !== 2) throw new Error('TEMPLATE_VERSION_REVIEW');
    if (row.category === 'CAMPAIGN' && await deps.outbox.isSuppressed(addressHash(row.recipient))) return { kind: 'CANCEL', code: 'UNSUBSCRIBED' };
    let input: TemplateInput, attachments: OutgoingEmail['attachments'];
    switch (row.template) {
      case 'EARLY_LIST': case 'LIST_CONFIRMATION': case 'EVE': case 'NEXT_FLIGHT': {
        const entry = await entryOf(row.entryId);
        if (!entry) return { kind: 'CANCEL', code: 'ENTRY_GONE' };
        if (row.template === 'EARLY_LIST') {
          const source = (await deps.db.query<{ campaign_consent: boolean }>('SELECT campaign_consent FROM flight_early_list_imports WHERE tenant_id = $1 AND entry_id = $2', [deps.tenantId, row.entryId])).rows[0];
          if (!source?.campaign_consent || entry.flight !== 'FIRST') return { kind: 'CANCEL', code: 'NOT_ELIGIBLE' };
        }
        if (row.template === 'EVE' && entry.boarded_at) return { kind: 'CANCEL', code: 'BOARDED' };
        input = { template: row.template };
        break;
      }
      case 'GROUP_BOARDING': case 'ACCESS_REQUESTED': {
        const entry = await entryOf(row.entryId);
        if (!entry || entry.flight !== 'FIRST') return { kind: 'CANCEL', code: 'ENTRY_GONE' };
        if (entry.boarded_at) return { kind: 'CANCEL', code: 'BOARDED' };
        const token = await deps.access.issueToken({ emailId: row.emailId, entryId: row.entryId!, now: at,
          codeMs: row.template === 'ACCESS_REQUESTED' ? REQUESTED_CODE_MS : EMAIL_CODE_MS });
        input = { template: row.template, accessUrl: `${origin}/board/access?l=${row.language.toLowerCase()}#t=${token.link}`, code: token.code, codeMinutes: token.codeMinutes,
          linkHours: token.linkHours || ACCESS_LINK_MS / 3_600_000, foundingOpen: await deps.store.foundingOpen(), group: entry.batch_no };
        break;
      }
      case 'CARD_FOUNDING': case 'CARD_PASSENGER': {
        const card = row.passId ? await deps.store.cardForEmail(row.passId) : null;
        const view = card ? cardView(card.pass) : null;
        if (!card || !view) return { kind: 'CANCEL', code: 'CARD_GONE' };
        const seatNo = card.pass.foundingSeat ? String(card.pass.foundingSeat).padStart(3, '0') : card.pass.seat.toLowerCase();
        attachments = [{ filename: `flofi-boarding-card-${seatNo}.png`, path: view.downloadUrl }];
        input = row.template === 'CARD_FOUNDING' ? { template: 'CARD_FOUNDING', card: view, invites: card.invites, invitesUrl: `${origin}/board#invites` }
          : { template: 'CARD_PASSENGER', card: view };
        break;
      }
      case 'CREATOR_INVITE': {
        const invite = row.inviteCode ? (await deps.db.query<{ redeemed_at: Date | null }>('SELECT redeemed_at FROM flight_invites WHERE tenant_id = $1 AND code = $2',
          [deps.tenantId, row.inviteCode])).rows[0] : undefined;
        if (!invite) return { kind: 'CANCEL', code: 'INVITE_GONE' };
        input = { template: 'CREATOR_INVITE', code: row.inviteCode!, briefUrl: deps.briefUrl ?? FLIGHT_CREATOR_BRIEF_URL };
        break;
      }
    }
    const unsubscribe = unsubscribeTokenFor(deps.secret, row.emailId, row.recipient);
    const rendered = renderEmail(input, { language: row.language, recipient: row.recipient, origin, calendar: deps.calendar,
      unsubscribeUrl: `${origin}/board/unsubscribe?l=${row.language.toLowerCase()}&t=${unsubscribe}` });
    return { kind: 'SEND', email: { idempotencyKey: row.emailId, to: row.recipient, subject: rendered.subject, html: rendered.html, text: rendered.text,
      headers: { 'List-Unsubscribe': `<${origin}/api/board/unsubscribe?t=${unsubscribe}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      ...attachments ? { attachments } : {}, tags: [{ name: 'template', value: row.template.toLowerCase() }, { name: 'campaign', value: 'flight-flofi' }] } };
  }

  function settlementOf(outcome: SendOutcome): Settlement {
    switch (outcome.kind) {
      case 'SENT': return { kind: 'SENT', providerId: outcome.providerId };
      case 'RETRY': return { kind: 'RETRY', code: outcome.code, delayMs: outcome.retryAfterMs };
      case 'UNKNOWN': return { kind: 'UNKNOWN', code: outcome.code };
      case 'QUOTA': case 'CONFIG': case 'CONFLICT': return { kind: 'HELD', code: outcome.code };
      case 'REJECTED': return { kind: 'FAILED', code: outcome.code };
    }
  }

  /** One cycle. Safe to run concurrently on several workers (leases and the quota lock serialize what must be). */
  async function cycle(): Promise<CycleReport> {
    const report = { scheduled: 0, leased: 0, sent: 0, unknown: 0, held: 0, failed: 0, cancelled: 0, retried: 0, skipped: null as string | null };
    const start = now();
    await deps.outbox.housekeeping(start);
    // Retention holds whether or not /board gets visits: settled emails after 90 days, access records on their schedule (hourly at most).
    if (start - prunedAt > 3_600_000) { prunedAt = start; await Promise.all([deps.outbox.prune(start), deps.access.prune(start)]); }
    report.scheduled += await deps.outbox.scheduleEve(start, deps.calendar.eveEmailAt, deps.calendar.boardingOpensAt);
    report.scheduled += await deps.outbox.scheduleBoarding(start, deps.calendar.boardingOpensAt);
    const control = await deps.outbox.control();
    if (control.blockedUntil && Date.parse(control.blockedUntil) > start) return { ...report, skipped: control.blockedReason ?? 'BLOCKED' };
    if (!await domainReady(start)) return { ...report, skipped: 'DOMAIN_NOT_VERIFIED' };
    const rows = await deps.outbox.lease(start, { max: batchSize, campaign: !control.paused });
    report.leased = rows.length;
    let stop: string | null = null;
    for (const [index, row] of rows.entries()) {
      const at = now();
      // An email whose earlier outcome is unknown stays UNKNOWN (retried with its key only inside the provider's window, then held).
      const wasUnknown = row.previousState === 'UNKNOWN';
      if (stop) { await deps.outbox.settle(row, wasUnknown ? { kind: 'UNKNOWN', code: stop } : { kind: 'RETRY', code: stop, delayMs: 60_000 }, at); report.retried++; continue; }
      let rendered: Rendered;
      try { rendered = await render(row, at); }
      catch (error) {
        deps.logger.warn('flight.email.render_failed', { template: row.template, error_code: error instanceof Error ? error.message.slice(0, 60) : 'UNKNOWN' });
        await deps.outbox.settle(row, { kind: 'HELD', code: error instanceof Error && error.message === 'TEMPLATE_VERSION_REVIEW' ? 'TEMPLATE_VERSION_REVIEW' : 'RENDER_FAILED' }, at); report.held++; continue;
      }
      if (rendered.kind === 'CANCEL') { await deps.outbox.settle(row, { kind: 'CANCELLED', code: rendered.code }, at); report.cancelled++; continue; }
      if (index > 0) await sleep(Math.ceil(1000 / perSecond));
      const outcome = await deps.provider.send(rendered.email);
      const settled = settlementOf(outcome);
      const settlement: Settlement = wasUnknown && settled.kind === 'RETRY' ? { kind: 'UNKNOWN', code: settled.code } : settled;
      await deps.outbox.settle(row, settlement, now());
      deps.logger.info('flight.email.attempt', { template: row.template, outcome: outcome.kind, code: 'code' in outcome ? outcome.code : undefined, attempt: row.attempts });
      if (settlement.kind === 'SENT') report.sent++; else if (settlement.kind === 'UNKNOWN') report.unknown++; else if (settlement.kind === 'HELD') report.held++;
      else if (settlement.kind === 'FAILED') report.failed++; else if (settlement.kind === 'RETRY') report.retried++;
      if (outcome.kind === 'QUOTA') {
        // The provider says its quota is spent: nothing more is sent until it resets — and nothing is upgraded.
        await deps.outbox.block(outcome.code === 'PROVIDER_QUOTA_DAILY' ? nextUtcDay(at) : nextUtcMonth(at), outcome.code);
        stop = outcome.code;
      } else if (outcome.kind === 'CONFIG') { await deps.outbox.block(null, outcome.code); stop = outcome.code; }
      else if (outcome.kind === 'RETRY') stop = outcome.code; // Rate limited: the rest of this batch waits a minute.
    }
    if (report.leased || report.scheduled) deps.logger.info('flight.email.cycle', { ...report, skipped: report.skipped ?? undefined });
    return report;
  }
  return { cycle, render };
}
export type EmailDelivery = ReturnType<typeof createEmailDelivery>;
