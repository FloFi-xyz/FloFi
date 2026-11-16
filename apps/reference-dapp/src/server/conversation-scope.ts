// SPDX-License-Identifier: AGPL-3.0-only
/**
 * HOTFIX-P1-FLIGHT-ACCESS-AND-CHAT-RECOVERY-001: the scope under which this browser tab keeps the FloFi chat (`domain/conversation-persistence.ts`):
 * an opaque digest of the tenant and the signed-in FloFi account, read from the server-verified account session — never from a wallet address,
 * a browser value or a Privy identifier. It identifies nothing outside this purpose and authorizes nothing; null (no account session, no
 * accounts on this deployment, or any failure) keeps the chat in memory only, as before.
 */
import { createHash } from 'node:crypto';

type Env = Readonly<Record<string, string | undefined>>;
/** Same tenant and account → same scope; any other tenant or account → another scope. */
export function conversationScopeOf(tenantId: string, accountId: string): string {
  return createHash('sha256').update(`flofi.conversation-scope.v1\0${tenantId}\0${accountId}`).digest('base64url').slice(0, 32);
}
export async function currentConversationScope(env: Env = process.env): Promise<string | null> {
  try {
    if (!env.DATABASE_URL) return null;
    const [{ accountHost, currentAccountSession }, { platformStateHost }] = await Promise.all([import('../accounts/account-host.ts'), import('./platform-state-host.ts')]);
    const host = await accountHost(env), session = await currentAccountSession(host, env);
    if (!host || !session) return null;
    return conversationScopeOf((await platformStateHost(env)).tenantId, session.accountId);
  } catch { return null; }
}
