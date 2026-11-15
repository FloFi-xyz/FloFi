// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-ADMIN-001: the operator CLI's commands (`backend/admin-cli.ts`), importable by tests without starting the process. */
import type { Database } from '@defi-workflow-engine/cloud-runtime';
import { indexRunFacts } from './analytics/indexer.ts';
import { createAdminStore, type AdminRole } from './store.ts';
import { activateRetention, applyRetention, completePrivacyRequest, decidePrivacyRequest, openPrivacyRequest, placeLegalHold, privacyAccess, privacyErase,
  releaseLegalHold, REQUEST_KINDS, RETENTION_POLICIES, retentionReport, revokeRetention, walletSubject, type RequestKind, type RetentionPolicy } from './privacy-ops.ts';

/**
 * BUILD-FLOFI-RECONCILIATION-PRIVACY-UX-001: privacy procedures (retention, legal holds, data-subject requests). A wallet is read from standard
 * input (never an argument: it would reach shell history and process lists); commands that need the admin key derive it from
 * FLOFI_ADMIN_SESSION_SECRET in the operator's environment and never print it.
 */
export const ADMIN_COMMANDS = ['grant', 'revoke', 'list', 'end-sessions', 'audit', 'index', 'retention-report', 'retention-activate', 'retention-revoke', 'retention-apply',
  'legal-hold', 'legal-hold-release', 'privacy-request', 'privacy-decide', 'privacy-access', 'privacy-erase', 'privacy-complete'] as const;
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
