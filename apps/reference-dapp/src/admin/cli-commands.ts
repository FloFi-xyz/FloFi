// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-ADMIN-001: the operator CLI's commands (`backend/admin-cli.ts`), importable by tests without starting the process. */
import type { Database } from '@defi-workflow-engine/cloud-runtime';
import { createAdminStore, type AdminRole } from './store.ts';

export const ADMIN_COMMANDS = ['grant', 'revoke', 'list', 'end-sessions', 'audit'] as const;
export type AdminCommand = (typeof ADMIN_COMMANDS)[number];

const required = (value: string | undefined, flag: string) => { if (!value) throw new Error(`ARGUMENT_REQUIRED: --${flag}`); return value; };
export const limitOf = (value: string | undefined, fallback: number, max: number) => {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new Error('LIMIT_INVALID');
  return n;
};

export async function runAdminCommand(command: AdminCommand, values: Readonly<Record<string, string | boolean | undefined>>, db: Database,
  tenantId: string): Promise<Record<string, unknown>> {
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
  }
}
