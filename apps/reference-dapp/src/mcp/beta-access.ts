// SPDX-License-Identifier: AGPL-3.0-only
/** MCP consent binds a verified product account session to an MCP account. An OAuth account alone is never beta entitlement. */
import type { Database } from '@defi-workflow-engine/cloud-runtime';
import { createBetaAccessStore, type BetaPrincipal } from '../flight/beta-access.ts';
import type { BetaRequestIdentity } from '../flight/beta-context.ts';
import { flightCalendarFrom } from '../flight/campaign.ts';
export type McpBetaHost = { readonly db: Database; readonly tenantId: string };
type Env = Readonly<Record<string, string | undefined>>;
const MCP_ACCOUNT = /^mcpacct_[a-z2-7]{26}$/;

/** Called only after the actual OAuth APPROVE decision and the product's server session/access check. */
export async function bindMcpBetaAccount(host: McpBetaHost, mcpAccountId: string, identity: BetaRequestIdentity, now: number, env: Env): Promise<string | null> {
  const { calendar } = flightCalendarFrom(env);
  if (!calendar || !MCP_ACCOUNT.test(mcpAccountId)) return 'BETA_ACCESS_DENIED';
  const checked = await createBetaAccessStore(host, calendar).require({ ...identity, now });
  if (!checked.ok) return checked.code;
  const updated = await host.db.query(`INSERT INTO flight_beta_mcp_accounts (tenant_id, mcp_account_id, flofi_account_id, session_id)
    VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id,mcp_account_id) DO UPDATE SET session_id = EXCLUDED.session_id
    WHERE flight_beta_mcp_accounts.flofi_account_id = EXCLUDED.flofi_account_id RETURNING mcp_account_id`,
  [host.tenantId, mcpAccountId, identity.accountId, identity.sessionId]);
  return updated.rowCount === 1 ? null : 'BETA_ACCOUNT_MISMATCH';
}

/** The already authenticated MCP account's durable binding. Session, Flight grant, wallet and calendar are rechecked on every tool request. */
export async function mcpBetaIdentity(host: McpBetaHost, mcpAccountId: string, now: number, env: Env): Promise<BetaRequestIdentity | null> {
  const { calendar } = flightCalendarFrom(env);
  if (!calendar || !MCP_ACCOUNT.test(mcpAccountId)) return null;
  const row = (await host.db.query<{ flofi_account_id: string; session_id: string }>(`SELECT flofi_account_id,session_id FROM flight_beta_mcp_accounts
    WHERE tenant_id = $1 AND mcp_account_id = $2`, [host.tenantId, mcpAccountId])).rows[0];
  if (!row) return null;
  const identity = { accountId: row.flofi_account_id, sessionId: row.session_id };
  const checked = await createBetaAccessStore(host, calendar).require({ ...identity, now });
  return checked.ok ? identity : null;
}

/** Existing MCP wallet proofs can widen reads only within the same beta-bound product account. */
export async function mcpBetaWallets(host: McpBetaHost, identity: BetaRequestIdentity, wallets: readonly BetaPrincipal[], now: number, env: Env): Promise<readonly BetaPrincipal[]> {
  const { calendar } = flightCalendarFrom(env);
  if (!calendar) return [];
  const gate = createBetaAccessStore(host, calendar), allowed: BetaPrincipal[] = [];
  for (const principal of wallets) if ((await gate.require({ ...identity, principal, now })).ok) allowed.push(principal);
  return allowed;
}
