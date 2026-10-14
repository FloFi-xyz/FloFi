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
 *
 * Environment: DATABASE_URL (the deployment's database). The tenant is explicit: production/local `--tenant default`, a Vercel Preview
 * `--preview-branch <git branch>`. No secret is read or printed. Like `main.ts`, it runs on plain Node: every module it reaches imports
 * with explicit extensions (`backend/admin-cli.test.ts`).
 */
import { parseArgs } from 'node:util';
import { assertSchemaCurrent, createDatabase, ensureTenant, SHIPPED_MIGRATIONS } from '@defi-workflow-engine/cloud-runtime';
import { deploymentTenant } from '../src/server/deployment.ts';
import { ADMIN_COMMANDS, runAdminCommand, type AdminCommand } from '../src/admin/cli-commands.ts';

function tenantOf(values: { tenant?: string | undefined; 'preview-branch'?: string | undefined }): string {
  if (Boolean(values.tenant) === Boolean(values['preview-branch'])) throw new Error('TENANT_REQUIRED: pass exactly one of --tenant or --preview-branch');
  return values.tenant ? deploymentTenant({ TENANT_ID: values.tenant }) : deploymentTenant({ VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: values['preview-branch'] });
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || !(ADMIN_COMMANDS as readonly string[]).includes(command)) throw new Error(`COMMAND_INVALID: one of ${ADMIN_COMMANDS.join(', ')}`);
  const { values } = parseArgs({ args: rest, strict: true, allowPositionals: false, options: { tenant: { type: 'string' }, 'preview-branch': { type: 'string' },
    wallet: { type: 'string' }, role: { type: 'string' }, label: { type: 'string' }, principal: { type: 'string' }, limit: { type: 'string' } } });
  const tenantId = tenantOf(values), databaseUrl = process.env.DATABASE_URL ?? '';
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) throw new Error('DATABASE_URL_REQUIRED');
  const db = createDatabase({ connectionString: databaseUrl, maxConnections: 2, applicationName: 'flofi-admin-cli' });
  try {
    await assertSchemaCurrent(db, SHIPPED_MIGRATIONS);
    await ensureTenant(db, tenantId);
    const out = await runAdminCommand(command as AdminCommand, values, db, tenantId);
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
