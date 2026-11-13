// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-FLIGHT-001: the operator CLI for the Flight FloFi campaign (/board), run directly by Node 24's TypeScript support:
 *
 *   node apps/reference-dapp/backend/flight-admin.ts <command> (--tenant <id> | --preview-branch <branch>) [options]
 *
 *   stats                                          counters, lists by boarding group, invites and the daily funnel (no address)
 *   create-batch   --batch <n> --opens-at <ISO>    create or move boarding group n (e.g. 2026-11-19T09:00:00-03:00)
 *   assign-batch   --batch <n> --count <k>         put the k earliest beta-list entries without a group into group n
 *   export-batch   [--batch <n>] [--flight NEXT] [--out <path>]
 *                                                  the addresses of a group (no --batch: entries without a group), for the team's
 *                                                  "your group boards" email; written to a new mode-0600 file when --out is given
 *   issue-invites  --count <n>                     invites issued by the FloFi team; --out writes codes to a new private CSV
 *   erase-email    --email <address>               a data subject's request: delete the address from both lists
 *   hide-pass      --pass <flp_…>                  remove a handle from the public departures board
 *   prune                                          delete expired records now (join attempts > 1 day, simulation evidence > 2 hours,
 *                                                  counters > 13 months); the page also does this every few minutes
 *   purge-lists                                    end of the beta: delete every list entry, join attempt and simulation record
 *
 * BUILD-FLOFI-FLIGHT-LAUNCH-001 (email through Resend, access links, public cards). No command prints an email address in full:
 *   email-status                                   reservations today/this month against the limits, emails by template and state, held batches
 *   email-attention [--count <n>]                  held, unknown and failed emails (masked recipient, reason, batch)
 *   email-release  (--email-id <fem_…> | --batch <key> | --reason <CODE>) [--max <n>]
 *                                                  the team's decision to send held emails (quota raised, next day); --max sends only
 *                                                  the oldest n of a batch (an explicit partial send). UNRESOLVED_OUTCOME only by --email-id
 *   email-cancel   (--email-id <fem_…> | --batch <key> | --template <T>)  withdraw pending or held emails (sent ones are never touched)
 *   email-pause    [--reason <text>]                stop campaign email at once (access emails a person asks for still go out)
 *   email-resume                                   resume campaign email
 *   email-unblock                                  clear a provider block (quota reset confirmed, key fixed)
 *   email-mark-delivered --email-id <fem_…> --provider-id <id>   an unknown outcome confirmed delivered in the Resend log
 *   email-backfill-confirmations                   Email 1 once for beta-list entries that never got it (before the list closes)
 *   email-send-due                                 one delivery cycle now (Plan B when no worker runs; needs the worker's settings)
 *   creator-invite --email <address> [--language PT] [--send-at <ISO>]   one creator invite and its Email 6 (once per address)
 *   creator-invites --file <csv: email,language> [--send-at <ISO>] [--apply --out <private.csv>]
 *                                                  dry-run by default; apply queues Email 6 and writes email/language/code/state to mode-0600 CSV
 *   creator-supersede-templates [--max <n>] [--apply]
 *                                                  dry-run by default; replace unsent TEMPLATE_VERSION_REVIEW creator rows with the current version,
 *                                                  preserving invite codes. Never touches SENT/UNKNOWN. Inspect Resend before apply.
 *   email-launch-upgrade [--max <n>] [--include-released] [--apply --confirm-worker-deployed]
 *                                                  13/11 launch, dry-run by default: unsent Email 3 v2 rows → v3 and unsent 3/4a/4b/5/6 rows → PT,
 *                                                  in place (same email id, dedupe key, recipient, not_before, links). Only PENDING rows never
 *                                                  attempted, reserved or leased. Apply needs `email-pause` first and the worker already on this
 *                                                  release. Prints counts before/after, the ids changed, what was skipped and guest/waitlist overlaps.
 *                                                  A pending row a release/retry moved is listed (releasedPendingIds) and changed only with
 *                                                  --include-released, after its id was checked in the Resend log.
 *   creator-requeue-missing [--max <n>] [--include-operator-cancelled] [--apply]  13/11 launch, dry-run by default: Email 6 (current version, PT) for active creator invites
 *                                                  with no Email 6 queued, in flight or sent, reusing their codes; enqueued HELD in batch
 *                                                  creators-v<version>, sent only after `email-release --batch creators-v<version>`. Never for an
 *                                                  invite whose Email 6 failed or was stopped; operator-cancelled ones only with the flag.
 *   import-google-forms --file <csv> [--apply]      dry-run by default; columns email,submitted_at,language,consent; ISO timestamp with explicit offset,
 *                                                  consent true/false is required; language EN/PT may be blank. Preserves original signup order.
 *   email-early-list [--send-at <ISO>] [--apply]    separately reserve Email 0 once for eligible consented imports; never sends directly
 *   remove-card    --card <id | flp_…>             take a public card page down (the person's request or moderation)
 *   revoke-access  --email <address>               void every unused access link and code of an address
 *
 * Environment: DATABASE_URL (the deployment's database). Holding the database credentials is the authorization, as for the other
 * operator CLIs. The tenant is explicit (production/local `--tenant default`, a Vercel Preview `--preview-branch <git branch>`) and must
 * already exist: a mistyped tenant is refused, never created. An exported file holds addresses and possibly invite codes: deliver only through the team’s secure channel; never attach it to a public artifact or commit.
 */
import { open } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { assertSchemaCompatible, createDatabase, SHIPPED_MIGRATIONS } from '@defi-workflow-engine/cloud-runtime';
import { deploymentTenant } from '../src/server/deployment.ts';
import { createLogger } from '@defi-workflow-engine/cloud-runtime';
import { readFile } from 'node:fs/promises';
import { accessSecret } from '../src/flight/access.ts';
import { createAccessStore } from '../src/flight/access-store.ts';
import { flightCalendarFrom, normalizeEmail } from '../src/flight/campaign.ts';
import { createEmailOutbox, emailLimitsFrom, type EmailOutbox } from '../src/flight/email/outbox.ts';
import type { EmailTemplate } from '../src/flight/email/templates.ts';
import { createFlightStore, type FlightStore } from '../src/flight/store.ts';

export const FLIGHT_COMMANDS = ['stats', 'create-batch', 'assign-batch', 'export-batch', 'issue-invites', 'erase-email', 'hide-pass', 'prune', 'purge-lists',
  'email-status', 'email-attention', 'email-release', 'email-cancel', 'email-pause', 'email-resume', 'email-unblock', 'email-mark-delivered',
  'email-backfill-confirmations', 'email-send-due', 'creator-invite', 'creator-invites', 'creator-supersede-templates', 'email-launch-upgrade', 'creator-requeue-missing',
  'import-google-forms', 'email-early-list', 'remove-card', 'revoke-access'] as const;
const TEMPLATES: readonly EmailTemplate[] = ['EARLY_LIST', 'LIST_CONFIRMATION', 'EVE', 'GROUP_BOARDING', 'ACCESS_REQUESTED', 'CARD_FOUNDING', 'CARD_PASSENGER', 'NEXT_FLIGHT', 'CREATOR_INVITE'];
/** What the email and access commands need besides the store; `sendDue` runs one delivery cycle (absent: not configured). */
export type FlightAdminContext = { readonly outbox: EmailOutbox; readonly entryOf: (email: string) => Promise<string | null>;
  readonly revoke: ((entryId: string, now: number) => Promise<number>) | null; readonly pruneAccess?: ((now: number) => Promise<unknown>) | null; readonly sendDue: (() => Promise<unknown>) | { readonly disabled: string } };
/** One CSV cell; a value a spreadsheet would read as a formula (=, +, -, @) is written as text. */
export const csvCell = (value: string) => /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
type Command = (typeof FLIGHT_COMMANDS)[number];
type Values = Record<string, string | boolean | undefined>;

function tenantOf(values: Values): string {
  if (Boolean(values.tenant) === Boolean(values['preview-branch'])) throw new Error('TENANT_REQUIRED: pass exactly one of --tenant or --preview-branch');
  return values.tenant ? deploymentTenant({ TENANT_ID: values.tenant as string })
    : deploymentTenant({ VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: values['preview-branch'] as string });
}
const flag = (values: Values, name: string) => typeof values[name] === 'string' ? values[name] as string : undefined;
const required = (values: Values, name: string) => { const value = flag(values, name); if (!value) throw new Error(`ARGUMENT_REQUIRED: --${name}`); return value; };
const integer = (values: Values, name: string) => {
  const value = Number(required(values, name));
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`ARGUMENT_INVALID: --${name}`);
  return value;
};

const emailId = (values: Values) => { const id = flag(values, 'email-id'); if (id && !/^fem_[0-9a-f]{32}$/.test(id)) throw new Error('ARGUMENT_INVALID: --email-id'); return id; };
const instantOf = (values: Values, name: string, fallback: number) => {
  const raw = flag(values, name);
  if (!raw) return fallback;
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(raw) || !Number.isFinite(Date.parse(raw))) throw new Error(`ARGUMENT_INVALID: --${name} (ISO 8601 with an offset)`);
  return Date.parse(raw);
};
const languageOf = (value: string | undefined): 'EN' | 'PT' => { const language = (value ?? 'EN').trim().toUpperCase(); if (language !== 'EN' && language !== 'PT') throw new Error('ARGUMENT_INVALID: language'); return language; };

/** RFC 4180-style CSV; quoted commas, escaped quotes and embedded newlines are preserved. No address is included in errors. */
export function parseFlightCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false, closed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } }
      else cell += c;
    } else if (c === '"' && !cell && !closed) quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; closed = false; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); if (row.some(v => v.trim())) rows.push(row); row = []; cell = ''; closed = false; }
    else { if (closed && c.trim()) throw new Error('CSV_INVALID'); cell += c; }
  }
  if (quoted) throw new Error('CSV_INVALID');
  row.push(cell); if (row.some(v => v.trim())) rows.push(row);
  return rows;
}
export function parseGoogleFormsCsv(text: string): { readonly email: string; readonly signedUpAt: number; readonly language: 'EN' | 'PT' | null; readonly consent: boolean }[] {
  const [header, ...rows] = parseFlightCsv(text.replace(/^\uFEFF/, ''));
  if (!header || header.map(v => v.trim().toLowerCase()).join(',') !== 'email,submitted_at,language,consent') throw new Error('CSV_HEADER_REQUIRED');
  return rows.map((row, index) => {
    const [email = '', timestamp = '', language = '', consent = ''] = row;
    // An explicit offset is mandatory: never replace an unknown Forms timezone with the import time or server timezone.
    const signedUpAt = Date.parse(timestamp);
    const datePart = timestamp.slice(0, 10), [year, month, day] = datePart.split('-').map(Number);
    const maxDay = month && month <= 12 ? new Date(Date.UTC(year!, month, 0)).getUTCDate() : 0;
    if (row.length !== 4 || !normalizeEmail(email) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp)
      || !Number.isFinite(signedUpAt) || !day || day > maxDay || Number(timestamp.slice(11, 13)) > 23 || Number(timestamp.slice(14, 16)) > 59 || Number(timestamp.slice(17, 19)) > 59
      || !['', 'EN', 'PT'].includes(language.trim().toUpperCase()) || !['true', 'false'].includes(consent.trim().toLowerCase()))
      throw new Error(`CSV_ROW_INVALID: line ${index + 2}`);
    return { email, signedUpAt, language: language.trim() ? languageOf(language) : null, consent: consent.trim().toLowerCase() === 'true' };
  });
}
const csvLine = (values: readonly string[]) => values.map(value => `"${csvCell(value).replace(/"/g, '""')}"`).join(',') + '\n';
const newPrivateFile = (path: string) => open(path, 'wx', 0o600).catch((error: { code?: string }) => { throw new Error(error.code === 'EEXIST' ? 'OUT_FILE_EXISTS' : 'OUT_FILE_UNWRITABLE'); });

export async function runFlightCommand(command: Command, values: Values, store: FlightStore, now: number, context?: FlightAdminContext): Promise<Record<string, unknown>> {
  const ctx = () => { if (!context) throw new Error('CONTEXT_REQUIRED'); return context; };
  switch (command) {
    case 'email-status': return ctx().outbox.status(now);
    case 'email-attention': return { emails: await ctx().outbox.listAttention(flag(values, 'count') ? integer(values, 'count') : 50) };
    case 'email-release': {
      const max = flag(values, 'max') ? integer(values, 'max') : undefined, reason = flag(values, 'reason');
      if (reason && !/^[A-Z0-9_]{1,60}$/.test(reason)) throw new Error('ARGUMENT_INVALID: --reason');
      const id = emailId(values), batchKey = flag(values, 'batch');
      return { released: await ctx().outbox.release({ ...id ? { emailId: id } : {}, ...batchKey ? { batchKey } : {}, ...reason ? { reason } : {}, ...max ? { max } : {} }, now) };
    }
    case 'email-cancel': {
      const template = flag(values, 'template') as EmailTemplate | undefined;
      if (template && !TEMPLATES.includes(template)) throw new Error('ARGUMENT_INVALID: --template');
      const id = emailId(values), batchKey = flag(values, 'batch');
      return { cancelled: await ctx().outbox.cancel({ ...id ? { emailId: id } : {}, ...batchKey ? { batchKey } : {}, ...template ? { template } : {} }) };
    }
    case 'email-pause': await ctx().outbox.setPaused(true, (flag(values, 'reason') ?? 'operator').replace(/[^A-Za-z0-9_ .:-]/g, '').slice(0, 120) || 'operator'); return { paused: true };
    case 'email-resume': await ctx().outbox.setPaused(false, null); return { paused: false };
    case 'email-unblock': await ctx().outbox.clearBlock(); return { unblocked: true };
    case 'email-mark-delivered': return { marked: await ctx().outbox.markDelivered(emailId(values) ?? required(values, 'email-id'), required(values, 'provider-id'), now) };
    case 'email-backfill-confirmations': return { enqueued: await ctx().outbox.backfillConfirmations(now, store.calendar.listClosesAt) };
    case 'email-send-due': {
      const send = ctx().sendDue;
      if (typeof send !== 'function') throw new Error(`EMAIL_NOT_CONFIGURED: ${send.disabled}`);
      return { cycle: await send() };
    }
    case 'creator-invite': {
      const email = normalizeEmail(required(values, 'email'));
      if (!email) throw new Error('ARGUMENT_INVALID: --email');
      const invite = await store.inviteCreator({ email, language: languageOf(flag(values, 'language')), sendAt: instantOf(values, 'send-at', now), now });
      const out = flag(values, 'out');
      if (out) { const file = await newPrivateFile(out); try { await file.writeFile(csvLine(['email', 'language', 'code', 'state']) + csvLine([email, languageOf(flag(values, 'language')), invite.code, invite.state]), 'utf8'); } finally { await file.close(); } }
      return { created: invite.created, state: invite.state, ...out ? { out } : {} };
    }
    case 'creator-supersede-templates': {
      const max = flag(values, 'max') ? integer(values, 'max') : undefined;
      return ctx().outbox.supersedeCreatorTemplates(now, { ...max ? { max } : {}, apply: values.apply === true });
    }
    case 'email-launch-upgrade': {
      const max = flag(values, 'max') ? integer(values, 'max') : undefined;
      return ctx().outbox.upgradeLaunchPending(now, { ...max ? { max } : {}, apply: values.apply === true, workerDeployed: values['confirm-worker-deployed'] === true,
        includeReleased: values['include-released'] === true });
    }
    case 'creator-requeue-missing': {
      const max = flag(values, 'max') ? integer(values, 'max') : undefined;
      return ctx().outbox.enqueueMissingCreatorInvites(now, { ...max ? { max } : {}, apply: values.apply === true,
        includeOperatorCancelled: values['include-operator-cancelled'] === true });
    }
    case 'creator-invites': {
      const text = await readFile(required(values, 'file'), 'utf8').catch(() => { throw new Error('FILE_UNREADABLE'); });
      const parsed = parseFlightCsv(text), rows = parsed[0]?.[0]?.trim().toLowerCase() === 'email' ? parsed.slice(1) : parsed;
      const recipients = rows.map((row, index) => {
        const email = normalizeEmail((row[0] ?? '').replace(/^'/, ''));
        if (!email || row.length > 2) throw new Error(`CSV_ROW_INVALID: line ${index + 1}`);
        return { email, language: languageOf(row[1]) };
      });
      if (!values.apply) return { dryRun: true, recipients: recipients.length };
      const sendAt = instantOf(values, 'send-at', now), out = required(values, 'out'), file = await newPrivateFile(out);
      let invited = 0;
      try {
        await file.writeFile(csvLine(['email', 'language', 'code', 'state']), 'utf8');
        for (const recipient of recipients) {
          const invite = await store.inviteCreator({ ...recipient, sendAt, now });
          if (invite.created) invited++;
          await file.writeFile(csvLine([recipient.email, recipient.language, invite.code, invite.state]), 'utf8');
        }
      } finally { await file.close(); }
      return { invited, alreadyInvited: recipients.length - invited, out };
    }
    case 'import-google-forms': {
      const text = await readFile(required(values, 'file'), 'utf8').catch(() => { throw new Error('FILE_UNREADABLE'); });
      const entries = parseGoogleFormsCsv(text);
      if (entries.some(entry => entry.signedUpAt > Math.min(now, store.calendar.listClosesAt))) throw new Error('FLIGHT_IMPORT_INVALID');
      if (!values.apply) return { dryRun: true, entries: entries.length, consented: entries.filter(e => e.consent).length };
      return store.importGoogleForms(entries, now);
    }
    case 'email-early-list': {
      const sendAt = instantOf(values, 'send-at', now);
      if (!values.apply) return { dryRun: true, template: 'EARLY_LIST', sendAt: new Date(sendAt).toISOString() };
      return { enqueued: await ctx().outbox.scheduleEarlyList(now, sendAt, store.calendar.boardingOpensAt) };
    }
    case 'remove-card': {
      const card = required(values, 'card');
      if (!/^(flp_[0-9a-f]{32}|[a-z2-7]{12})$/.test(card)) throw new Error('ARGUMENT_INVALID: --card');
      return { removed: await store.removeCard(card, now) };
    }
    case 'revoke-access': {
      const email = normalizeEmail(required(values, 'email'));
      if (!email) throw new Error('ARGUMENT_INVALID: --email');
      const entryId = await ctx().entryOf(email), revoke = ctx().revoke;
      if (!revoke) throw new Error('FLOFI_FLIGHT_ACCESS_SECRET_MISSING');
      return { revoked: entryId ? await revoke(entryId, now) : 0 };
    }
    case 'stats': return store.stats();
    case 'create-batch': {
      const opensAt = Date.parse(required(values, 'opens-at'));
      if (!Number.isFinite(opensAt)) throw new Error('ARGUMENT_INVALID: --opens-at');
      const batch = integer(values, 'batch');
      await store.createBatch(batch, opensAt);
      return { batch, opensAt: new Date(opensAt).toISOString() };
    }
    case 'assign-batch': return { batch: integer(values, 'batch'), assigned: await store.assignBatch(integer(values, 'batch'), integer(values, 'count')) };
    case 'export-batch': {
      const flight = flag(values, 'flight') === 'NEXT' ? 'NEXT' : 'FIRST', batch = flag(values, 'batch') ? integer(values, 'batch') : null;
      const entries = await store.exportBatch(batch, flight), out = flag(values, 'out');
      if (!out) return { flight, batch, entries };
      const file = await open(out, 'wx', 0o600).catch((error: { code?: string }) => { throw new Error(error.code === 'EEXIST' ? 'OUT_FILE_EXISTS' : 'OUT_FILE_UNWRITABLE'); });
      try { await file.writeFile(entries.map(entry => `${csvCell(entry.email)},${csvCell(entry.language)}`).join('\n') + '\n', 'utf8'); } finally { await file.close(); }
      return { flight, batch, exported: entries.length, out };
    }
    case 'issue-invites': {
      const out = required(values, 'out'), file = await newPrivateFile(out);
      try { const codes = await store.issueCreatorInvites(integer(values, 'count'), now); await file.writeFile(csvLine(['code', 'state']) + codes.map(code => csvLine([code, 'AVAILABLE'])).join(''), 'utf8'); return { issued: codes.length, out }; }
      finally { await file.close(); }
    }
    case 'erase-email': {
      const email = normalizeEmail(required(values, 'email'));
      if (!email) throw new Error('ARGUMENT_INVALID: --email');
      return { erased: await store.eraseEmail(email) };
    }
    case 'hide-pass': {
      const pass = required(values, 'pass');
      if (!/^flp_[0-9a-f]{32}$/.test(pass)) throw new Error('ARGUMENT_INVALID: --pass');
      return { hidden: await store.hidePass(pass) };
    }
    case 'prune': return { pruned: await store.prune(now), emails: context ? await context.outbox.prune(now) : null, access: context?.pruneAccess ? await context.pruneAccess(now) : null };
    case 'purge-lists': return { deleted: await store.purgeLists() };
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || !(FLIGHT_COMMANDS as readonly string[]).includes(command)) throw new Error(`COMMAND_INVALID: one of ${FLIGHT_COMMANDS.join(', ')}`);
  const { values } = parseArgs({ args: rest, strict: true, allowPositionals: false, options: { tenant: { type: 'string' }, 'preview-branch': { type: 'string' },
    batch: { type: 'string' }, 'opens-at': { type: 'string' }, count: { type: 'string' }, flight: { type: 'string' }, out: { type: 'string' },
    email: { type: 'string' }, pass: { type: 'string' }, 'email-id': { type: 'string' }, max: { type: 'string' }, reason: { type: 'string' },
    template: { type: 'string' }, 'provider-id': { type: 'string' }, language: { type: 'string' }, 'send-at': { type: 'string' }, file: { type: 'string' },
    card: { type: 'string' }, apply: { type: 'boolean', default: false }, 'confirm-worker-deployed': { type: 'boolean', default: false },
    'include-released': { type: 'boolean', default: false }, 'include-operator-cancelled': { type: 'boolean', default: false } } });
  const tenantId = tenantOf(values), databaseUrl = process.env.DATABASE_URL ?? '';
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) throw new Error('DATABASE_URL_REQUIRED');
  const db = createDatabase({ connectionString: databaseUrl, maxConnections: 2, applicationName: 'flofi-flight-admin' });
  try {
    await assertSchemaCompatible(db, SHIPPED_MIGRATIONS);
    if (!(await db.query('SELECT 1 FROM tenants WHERE tenant_id = $1', [tenantId])).rowCount) throw new Error('TENANT_UNKNOWN');
    // The deployment's own campaign calendar (the same variables the web and the worker read); a refused value stops here.
    const { calendar } = flightCalendarFrom(process.env);
    if (!calendar) throw new Error('FLIGHT_CALENDAR_INVALID');
    const host = { db, tenantId }, secret = accessSecret(process.env);
    let limits;
    try { limits = emailLimitsFrom(process.env); } catch { throw new Error('FLOFI_EMAIL_LIMIT_INVALID'); }
    const context: FlightAdminContext = {
      outbox: createEmailOutbox(host, limits),
      entryOf: async email => (await db.query<{ entry_id: string }>('SELECT entry_id FROM flight_list_entries WHERE tenant_id = $1 AND email = $2', [tenantId, email])).rows[0]?.entry_id ?? null,
      revoke: secret ? (entryId, at) => createAccessStore(host, secret).revokeEntryTokens(entryId, at) : null,
      pruneAccess: secret ? at => createAccessStore(host, secret).prune(at) : null,
      sendDue: command === 'email-send-due' ? await import('../src/flight/email/runtime.ts').then(m => {
        const runtime = m.flightEmailRuntime(process.env, db, tenantId, createLogger({ service: 'flofi-flight-admin' }));
        return 'disabled' in runtime ? runtime : () => runtime.delivery.cycle();
      }) : { disabled: 'NOT_REQUESTED' },
    };
    const out = await runFlightCommand(command as Command, values, createFlightStore(host, calendar), Date.now(), context);
    process.stdout.write(JSON.stringify({ tenantId, ...out }, null, 2) + '\n');
  } finally { await db.close(); }
}

// Imported by tests for `runFlightCommand`; run only as the entry point.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].startsWith('/') ? '' : process.cwd() + '/'}${process.argv[1]}`).href) {
  main().catch(error => {
    // A fixed code (and the argument it names), never a stack, a connection string or an address.
    const code = (error as { code?: unknown }).code;
    const message = typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS') ? 'ARGUMENTS_INVALID'
      : error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}(: [^\n]{0,200})?$/.test(error.message) ? error.message : 'FLIGHT_ADMIN_FAILED';
    process.stderr.write(message + '\n');
    process.exitCode = 1;
  });
}
