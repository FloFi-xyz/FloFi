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
 *   issue-invites  --count <n>                     invites issued by the FloFi team (origin "creator"), printed once
 *   erase-email    --email <address>               a data subject's request: delete the address from both lists
 *   hide-pass      --pass <flp_…>                  remove a handle from the public departures board
 *   prune                                          delete expired records now (join attempts > 1 day, simulation evidence > 2 hours,
 *                                                  counters > 13 months); the page also does this every few minutes
 *   purge-lists                                    end of the beta: delete every list entry, join attempt and simulation record
 *
 * Environment: DATABASE_URL (the deployment's database). Holding the database credentials is the authorization, as for the other
 * operator CLIs. The tenant is explicit (production/local `--tenant default`, a Vercel Preview `--preview-branch <git branch>`) and must
 * already exist: a mistyped tenant is refused, never created. An exported file holds addresses: keep it only until the email is sent.
 */
import { open } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { assertSchemaCompatible, createDatabase, SHIPPED_MIGRATIONS } from '@defi-workflow-engine/cloud-runtime';
import { deploymentTenant } from '../src/server/deployment.ts';
import { normalizeEmail } from '../src/flight/campaign.ts';
import { createFlightStore, type FlightStore } from '../src/flight/store.ts';

export const FLIGHT_COMMANDS = ['stats', 'create-batch', 'assign-batch', 'export-batch', 'issue-invites', 'erase-email', 'hide-pass', 'prune', 'purge-lists'] as const;
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

export async function runFlightCommand(command: Command, values: Values, store: FlightStore, now: number): Promise<Record<string, unknown>> {
  switch (command) {
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
    case 'issue-invites': return { codes: await store.issueCreatorInvites(integer(values, 'count'), now) };
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
    case 'prune': return { pruned: await store.prune(now) };
    case 'purge-lists': return { deleted: await store.purgeLists() };
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || !(FLIGHT_COMMANDS as readonly string[]).includes(command)) throw new Error(`COMMAND_INVALID: one of ${FLIGHT_COMMANDS.join(', ')}`);
  const { values } = parseArgs({ args: rest, strict: true, allowPositionals: false, options: { tenant: { type: 'string' }, 'preview-branch': { type: 'string' },
    batch: { type: 'string' }, 'opens-at': { type: 'string' }, count: { type: 'string' }, flight: { type: 'string' }, out: { type: 'string' },
    email: { type: 'string' }, pass: { type: 'string' } } });
  const tenantId = tenantOf(values), databaseUrl = process.env.DATABASE_URL ?? '';
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) throw new Error('DATABASE_URL_REQUIRED');
  const db = createDatabase({ connectionString: databaseUrl, maxConnections: 2, applicationName: 'flofi-flight-admin' });
  try {
    await assertSchemaCompatible(db, SHIPPED_MIGRATIONS);
    if (!(await db.query('SELECT 1 FROM tenants WHERE tenant_id = $1', [tenantId])).rowCount) throw new Error('TENANT_UNKNOWN');
    const out = await runFlightCommand(command as Command, values, createFlightStore({ db, tenantId }), Date.now());
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
