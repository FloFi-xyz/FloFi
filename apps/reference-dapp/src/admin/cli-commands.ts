// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-ADMIN-001: the operator CLI's commands (`backend/admin-cli.ts`), importable by tests without starting the process. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { CERTIFIED_FORWARD_MIGRATIONS, loadMigrations, migrate, type Database } from '@defi-workflow-engine/cloud-runtime';
import { indexRunFacts } from './analytics/indexer.ts';
import { historicalReconciliation } from './support/historical-reconciliation.ts';
import { supportPrivacyConfig } from './support/privacy.ts';
import { createAdminStore, type AdminRole } from './store.ts';
import { activateRetention, applyRetention, completePrivacyRequest, decidePrivacyRequest, openPrivacyRequest, placeLegalHold, privacyAccess, privacyErase,
  releaseLegalHold, REQUEST_KINDS, RETENTION_POLICIES, retentionReport, revokeRetention, walletSubject, type RequestKind, type RetentionPolicy } from './privacy-ops.ts';

/**
 * BUILD-FLOFI-RECONCILIATION-PRIVACY-UX-001: privacy procedures (retention, legal holds, data-subject requests). A wallet is read from standard
 * input (never an argument: it would reach shell history and process lists); commands that need the admin key derive it from
 * FLOFI_ADMIN_SESSION_SECRET in the operator's environment and never print it.
 */
export const ADMIN_COMMANDS = ['grant', 'revoke', 'list', 'end-sessions', 'audit', 'index', 'retention-report', 'retention-activate', 'retention-revoke', 'retention-apply',
  'legal-hold', 'legal-hold-release', 'privacy-request', 'privacy-decide', 'privacy-access', 'privacy-erase', 'privacy-complete', 'finops-migrate', 'finops-sync-migrate', 'position-purge-migrate',
  'single-step-runs-migrate', 'workflow-run-purge-migrate', 'reconcile-history'] as const;
/** What the privacy commands need from the process, injected so tests never touch stdin or the environment. */
export type AdminCommandIo = { readonly env: Readonly<Record<string, string | undefined>>; readonly adminKey: () => Buffer; readonly wallet: () => Promise<string>;
  readonly now: () => Date };
export type AdminCommand = (typeof ADMIN_COMMANDS)[number];

const required = (value: string | undefined, flag: string) => { if (!value) throw new Error(`ARGUMENT_REQUIRED: --${flag}`); return value; };
export const limitOf = (value: string | undefined, fallback: number, max: number) => {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error('LIMIT_INVALID');
  return n;
};

const policyOf = (value: string | undefined): RetentionPolicy => {
  if (!RETENTION_POLICIES.includes(value as RetentionPolicy)) throw new Error(`ARGUMENT_REQUIRED: --policy ${RETENTION_POLICIES.join('|')}`);
  return value as RetentionPolicy;
};
const unavailableIo: AdminCommandIo = { env: {}, adminKey: () => { throw new Error('ADMIN_KEY_REQUIRED'); }, wallet: async () => { throw new Error('PRIVACY_WALLET_REQUIRED'); },
  now: () => new Date() };

export async function runAdminCommand(command: AdminCommand, values: Readonly<Record<string, string | boolean | undefined>>, db: Database,
  tenantId: string, io: AdminCommandIo = unavailableIo): Promise<Record<string, unknown>> {
  const flag = (name: string) => typeof values[name] === 'string' ? values[name] as string : undefined;
  const store = createAdminStore(db, tenantId);
  switch (command) {
    case 'grant': {
      const role = required(flag('role'), 'role');
      if (role !== 'VIEWER' && role !== 'OPERATOR') throw new Error('ADMIN_ROLE_INVALID: VIEWER or OPERATOR');
      return { principal: await store.grant({ account: required(flag('wallet'), 'wallet').toLowerCase(), role: role as AdminRole, label: flag('label') ?? null }) };
    }
    case 'revoke': return { principal: await store.revoke(required(flag('principal'), 'principal')) };
    case 'list': return { principals: await store.listPrincipals() };
    case 'end-sessions': return { sessionsEnded: await store.endAllSessions() };
    case 'audit': return { events: await store.recentAudit(limitOf(flag('limit'), 50, 200)) };
    // Reads run logs and writes only the derived analytics cache; never touches an execution.
    case 'index': return { index: await indexRunFacts(db, tenantId, { limit: limitOf(flag('limit'), 2_000, 50_000), budgetMs: 10 * 60_000 }) };
    case 'finops-migrate':
    case 'finops-sync-migrate':
    case 'position-purge-migrate':
    case 'single-step-runs-migrate':
    case 'workflow-run-purge-migrate': {
      const activateSync = command === 'finops-sync-migrate', positionPurge = command === 'position-purge-migrate', singleStep = command === 'single-step-runs-migrate';
      const runPurge = command === 'workflow-run-purge-migrate';
      const count = runPurge ? 5 : singleStep ? 4 : positionPurge ? 3 : activateSync ? 2 : 1;
      const target = await db.query<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1');
      if (activateSync && (target.rows[0]?.version ?? 0) < 29) throw new Error('FINOPS_LEDGER_NOT_MIGRATED');
      // BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: 0031 follows the optional FinOps 0029/0030, which keep their own owner-run procedures; this
      // command never applies them implicitly. On exact schema 30 it applies only the certified 0031; on 31 a rerun applies nothing.
      if (positionPurge && (target.rows[0]?.version ?? 0) < 30) throw new Error('POSITION_PURGE_REQUIRES_SCHEMA_30');
      // BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001: 0032 follows 0029–0031, each activated by its own owner-run procedure; this command never
      // applies them implicitly. On exact schema 31 it applies only the certified 0032; on 32 a rerun applies nothing.
      if (singleStep && (target.rows[0]?.version ?? 0) < 31) throw new Error('SINGLE_STEP_RUNS_REQUIRES_SCHEMA_31');
      // BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001 (History deletion): 0033 follows 0029–0032, each activated by its own owner-run procedure;
      // this command never applies them implicitly. On exact schema 32 it applies only the certified 0033; on 33 a rerun applies nothing.
      if (runPurge && (target.rows[0]?.version ?? 0) < 32) throw new Error('WORKFLOW_RUN_PURGE_REQUIRES_SCHEMA_32');
      const migrations = await loadMigrations();
      // A command whose last migration is already applied verifies a newer certified schema against the shipped history (and the base-28
      // certificate) and leaves it alone: e.g. `finops-sync-migrate` on schema 31, or `single-step-runs-migrate` on schema 33.
      if ((target.rows[0]?.version ?? 0) > 28 + count) return { applied: await migrate(db, migrations) };
      const identities = CERTIFIED_FORWARD_MIGRATIONS.find(item => item.base.version === 28)?.migrations.slice(0, count);
      if (identities?.length !== count || (singleStep && identities[3]?.name !== 'single_step_runs') || (runPurge && identities[4]?.name !== 'workflow_run_purge'))
        throw new Error(runPurge ? 'WORKFLOW_RUN_PURGE_MIGRATION_NOT_CERTIFIED' : singleStep ? 'SINGLE_STEP_RUNS_MIGRATION_NOT_CERTIFIED'
          : positionPurge ? 'POSITION_PURGE_MIGRATION_NOT_CERTIFIED' : 'FINOPS_MIGRATION_NOT_CERTIFIED');
      // A later release that ships 0029/0030 in its own migration list applies them as ordinary migrations; never twice.
      const migrationsToApply = await Promise.all(identities.filter(identity => !migrations.some(shipped => shipped.version === identity.version)).map(async identity => {
        const filename = String(identity.version).padStart(4, '0') + '_' + identity.name + '.sql';
        const sql = await readFile(new URL('../../../../packages/cloud-runtime/test/fixtures/' + filename, import.meta.url), 'utf8');
        if (createHash('sha256').update(sql).digest('hex') !== identity.sha256)
          throw new Error(identity.version === 33 ? 'WORKFLOW_RUN_PURGE_MIGRATION_DIGEST_MISMATCH' : identity.version === 32 ? 'SINGLE_STEP_RUNS_MIGRATION_DIGEST_MISMATCH'
            : identity.version === 31 ? 'POSITION_PURGE_MIGRATION_DIGEST_MISMATCH' : 'FINOPS_MIGRATION_DIGEST_MISMATCH');
        return { ...identity, sql };
      }));
      return { applied: await migrate(db, [...migrations, ...migrationsToApply]) };
    }
    // BUILD-FLOFI-FINOPS-AUTOMATED-SYNC-002 P0: dry run unless --apply; then only the audited, read-only resume-observation recovery per run.
    case 'reconcile-history': {
      const apply = values.apply === true;
      return { reconciliation: await historicalReconciliation({ db, tenantId }, { flow: flag('flow') ?? 'crosschain-universal',
        ...flag('code') ? { codes: flag('code')!.split(',').map(code => code.trim()) } : {}, limit: limitOf(flag('limit'), 100, 500), now: io.now(),
        ...apply ? { apply: { approvalRef: required(flag('approval-ref'), 'approval-ref'), reason: required(flag('reason'), 'reason'), actor: 'cli',
          textRetentionDays: supportPrivacyConfig(io.env).textRetentionDays } } : {} }) };
    }
    // Read-only dry run: nothing is deleted.
    case 'retention-report': return { report: await retentionReport(db, tenantId, io.env, io.now()) };
    case 'retention-activate': return { activation: await activateRetention(db, tenantId, policyOf(flag('policy')), Number(required(flag('days'), 'days')),
      required(flag('approval-ref'), 'approval-ref')) };
    case 'retention-revoke': return { revocation: await revokeRetention(db, tenantId, policyOf(flag('policy'))) };
    case 'retention-apply': return { applied: await applyRetention(db, tenantId, policyOf(flag('policy')), io.now(), limitOf(flag('limit'), 5_000, 50_000)) };
    case 'legal-hold': return { hold: await placeLegalHold(db, tenantId, { scope: required(flag('scope'), 'scope'), value: flag('value') ?? null,
      reasonCode: required(flag('reason-code'), 'reason-code'), approvalRef: required(flag('approval-ref'), 'approval-ref') }) };
    case 'legal-hold-release': return { hold: await releaseLegalHold(db, tenantId, required(flag('hold'), 'hold'), required(flag('approval-ref'), 'approval-ref')) };
    case 'privacy-request': {
      const kind = required(flag('kind'), 'kind') as RequestKind, subjectKind = required(flag('subject-kind'), 'subject-kind');
      if (!REQUEST_KINDS.includes(kind)) throw new Error(`ARGUMENT_REQUIRED: --kind ${REQUEST_KINDS.join('|')}`);
      if (subjectKind === 'WALLET') return { request: await openPrivacyRequest(db, tenantId, kind, { kind: 'WALLET', ref: walletSubject(io.adminKey(), await io.wallet()).ref }) };
      if (subjectKind === 'ADMIN_PRINCIPAL') return { request: await openPrivacyRequest(db, tenantId, kind, { kind: 'ADMIN_PRINCIPAL', ref: required(flag('principal'), 'principal') }) };
      throw new Error('ARGUMENT_REQUIRED: --subject-kind WALLET|ADMIN_PRINCIPAL');
    }
    case 'privacy-decide': {
      const decision = required(flag('decision'), 'decision');
      if (decision !== 'APPROVED' && decision !== 'REJECTED') throw new Error('ARGUMENT_REQUIRED: --decision APPROVED|REJECTED');
      return { request: await decidePrivacyRequest(db, tenantId, required(flag('request'), 'request'), decision, required(flag('code'), 'code'), required(flag('approval-ref'), 'approval-ref')) };
    }
    case 'privacy-access': return { access: await privacyAccess(db, tenantId, required(flag('request'), 'request'), values['wallet-stdin'] ? io.adminKey() : null,
      values['wallet-stdin'] ? await io.wallet() : null, values['include-text'] === true) };
    case 'privacy-erase': return { erasure: await privacyErase(db, tenantId, required(flag('request'), 'request'), values['wallet-stdin'] ? io.adminKey() : null,
      values['wallet-stdin'] ? await io.wallet() : null) };
    case 'privacy-complete': return { request: await completePrivacyRequest(db, tenantId, required(flag('request'), 'request'), required(flag('code'), 'code')) };
  }
}
