// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ADMIN-001: the operator CLI for the private FloFi Admin console, run directly by Node 24's TypeScript support. It is the only
 * way to grant or revoke administrator access: the console itself cannot create or elevate an administrator.
 *
 *   node apps/reference-dapp/backend/admin-cli.ts <command> (--tenant <id> | --preview-branch <branch>) [options]
 *
 *   grant         --wallet <0x…> --role VIEWER|OPERATOR [--label <name>]   a new ACTIVE grant for an EVM wallet (one per wallet)
 *   revoke        --principal <adm_…>                                     revokes the grant and ends its open sessions at once
 *   list                                                                  every grant (ids, wallet, role, state)
 *   end-sessions                                                          ends every open admin session (grants stay)
 *   audit         [--limit 50]                                            the latest admin audit events (closed codes and ids only)
 *   index         [--limit 2000]                                          fills the analytics facts cache from executed runs' records (read-only on runs)
 *   finops-migrate / finops-sync-migrate                                applies certified 0029 or 0030 after certificate rollout
 *   position-purge-migrate                                                applies certified 0031 on exact schema 30 (never 0029/0030)
 *   single-step-runs-migrate                                              applies certified 0032 on exact schema 31 (never 0029–0031)
 *   workflow-run-purge-migrate                                            applies certified 0033 on exact schema 32 (never 0029–0032)
 *   developer-projects-migrate                                          applies certified 0034 on exact schema 33
 *   studio-migrate                                                      applies certified 0035 on exact schema 34
 *   studio-certification-migrate                                        applies certified 0036 on exact schema 35
 *   studio-queue  [--limit 50]                                            reads pending Studio submissions for the selected tenant
 *   reconcile-history [--flow crosschain-universal] [--code A,B] [--limit 100] [--apply --approval-ref REF --reason TEXT]
 *                                                                         dry run by default; --apply queues read-only re-observation (no transaction)
 *
 * BUILD-FLOFI-RECONCILIATION-PRIVACY-UX-001 — privacy procedures (docs/deploy/ADMIN.md#privacy-and-retention). Nothing is deleted without an
 * approval reference; a wallet is read from standard input (`--wallet-stdin`), never from an argument.
 *   retention-report                                                       dry run: what each policy would remove now (deletes nothing)
 *   retention-activate --policy SUPPORT_TEXT|LOOKUP_KEYS --days N --approval-ref <ref>
 *   retention-revoke   --policy …          retention-apply --policy … [--limit 5000]
 *   legal-hold         --scope TENANT|RUN|LOOKUP_PERIOD [--value <run id|2026-Q4>] --reason-code <CODE> --approval-ref <ref>
 *   legal-hold-release --hold <lgh_…> --approval-ref <ref>
 *   privacy-request    --kind ACCESS|CORRECTION|ERASURE|OBJECTION|RESTRICTION --subject-kind WALLET (--wallet-stdin) | ADMIN_PRINCIPAL --principal <adm_…>
 *   privacy-decide     --request <dsr_…> --decision APPROVED|REJECTED --code <CODE> --approval-ref <ref>
 *   privacy-access     --request <dsr_…> [--wallet-stdin] [--include-text]      privacy-erase --request <dsr_…> [--wallet-stdin]
 *   privacy-complete   --request <dsr_…> --code <CODE>                          (correction, objection, restriction)
 *
 * Environment: DATABASE_ADMIN_OPERATIONS_URL, or DATABASE_MIGRATION_URL for migration commands. The tenant is explicit: production/local `--tenant default`, a Vercel Preview
 * `--preview-branch <git branch>`. No secret is printed; only the privacy commands that need the admin key read FLOFI_ADMIN_SESSION_SECRET. Like `main.ts`, it runs on plain Node: every module it reaches imports
 * with explicit extensions (`backend/admin-cli.test.ts`).
 */
import { parseArgs } from 'node:util';
import { assertSchemaCompatible, createDatabase, ensureTenant, SHIPPED_MIGRATIONS } from '@defi-workflow-engine/cloud-runtime';
import { deploymentEnvironment, deploymentTenant } from '../src/server/deployment.ts';
import { ADMIN_COMMANDS, runAdminCommand, type AdminCommand } from '../src/admin/cli-commands.ts';
import { adminConfig } from '../src/admin/config.ts';
import { assertDedicatedPreviewDatabase } from './preview-migration.ts';

/** The wallet of a data-subject request: the first line of standard input (so it never reaches shell history or the process list). */
async function readWallet(): Promise<string> {
  if (process.stdin.isTTY) process.stderr.write('Wallet address (not echoed to logs): ');
  let text = '';
  for await (const chunk of process.stdin) { text += String(chunk); if (text.includes('\n') || text.length > 200) break; }
  return text.split('\n')[0]!.trim();
}
/** The admin key, from the operator's FLOFI_ADMIN_SESSION_SECRET exactly as the console derives it. Never printed. */
function adminKey(): Buffer {
  const config = adminConfig({ ...process.env, FLOFI_ADMIN: 'enabled' });
  if (!config.enabled) throw new Error('ADMIN_KEY_REQUIRED: set FLOFI_ADMIN_SESSION_SECRET in this shell');
  return config.key;
}

function tenantOf(values: { tenant?: string | undefined; 'preview-branch'?: string | undefined }): string {
  if (Boolean(values.tenant) === Boolean(values['preview-branch'])) throw new Error('TENANT_REQUIRED: pass exactly one of --tenant or --preview-branch');
  return values.tenant ? deploymentTenant({ TENANT_ID: values.tenant }) : deploymentTenant({ VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: values['preview-branch'] });
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || !(ADMIN_COMMANDS as readonly string[]).includes(command)) throw new Error(`COMMAND_INVALID: one of the ${ADMIN_COMMANDS.length} commands listed at the top of backend/admin-cli.ts`);
  const { values } = parseArgs({ args: rest, strict: true, allowPositionals: false, options: { tenant: { type: 'string' }, 'preview-branch': { type: 'string' },
    wallet: { type: 'string' }, role: { type: 'string' }, label: { type: 'string' }, principal: { type: 'string' }, limit: { type: 'string' },
    policy: { type: 'string' }, days: { type: 'string' }, 'approval-ref': { type: 'string' }, scope: { type: 'string' }, value: { type: 'string' },
    'reason-code': { type: 'string' }, hold: { type: 'string' }, kind: { type: 'string' }, 'subject-kind': { type: 'string' }, request: { type: 'string' },
    decision: { type: 'string' }, code: { type: 'string' }, 'include-text': { type: 'boolean' }, 'wallet-stdin': { type: 'boolean' },
    flow: { type: 'string' }, reason: { type: 'string' }, apply: { type: 'boolean' } } });
  const migration = command === 'finops-migrate' || command === 'finops-sync-migrate' || command === 'position-purge-migrate'
    || command === 'single-step-runs-migrate' || command === 'workflow-run-purge-migrate' || command === 'developer-projects-migrate'
    || command === 'studio-migrate' || command === 'studio-certification-migrate';
  const connection = migration ? 'DATABASE_MIGRATION_URL' : 'DATABASE_ADMIN_OPERATIONS_URL';
  const tenantId = tenantOf(values), databaseUrl = process.env[connection] ?? '';
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) throw new Error(`${connection}_REQUIRED`);
  const db = createDatabase({ connectionString: databaseUrl, maxConnections: 2, applicationName: 'flofi-admin-cli' });
  try {
    if (migration && (values['preview-branch'] || deploymentEnvironment(process.env) === 'preview')) {
      await assertDedicatedPreviewDatabase(db);
    }
    await assertSchemaCompatible(db, SHIPPED_MIGRATIONS);
    await ensureTenant(db, tenantId);
    const out = await runAdminCommand(command as AdminCommand, values, db, tenantId, { env: process.env, adminKey, wallet: readWallet, now: () => new Date() });
    process.stdout.write(JSON.stringify({ tenantId, ...out }, null, 2) + '\n');
  } finally { await db.close(); }
}

main().catch(error => {
  // A fixed code (and the argument it names), never a stack, a connection string or a secret.
  const code = (error as { code?: unknown }).code;
  const message = typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS') ? 'ARGUMENTS_INVALID'
    : error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}(: [^\n]{0,200})?$/.test(error.message) ? error.message : 'ADMIN_CLI_FAILED';
  process.stderr.write(message + '\n');
  process.exitCode = 1;
});
