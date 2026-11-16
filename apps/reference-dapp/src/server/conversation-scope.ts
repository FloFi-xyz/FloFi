// SPDX-License-Identifier: AGPL-3.0-only
/**
 * HOTFIX-P1-FLIGHT-ACCESS-AND-CHAT-RECOVERY-001: the scope under which this browser tab keeps the FloFi chat (`domain/conversation-persistence.ts`):
 * a keyed digest (HMAC, a key derived from the deployment's session secret) of the tenant and the signed-in FloFi account, read from the
 * server-verified account session — never from a wallet address, a browser value or a Privy identifier. Without the server's key it cannot be
 * linked to an account; it identifies nothing outside this purpose and authorizes nothing. Null (no account session, no accounts on this
 * deployment, or any failure) keeps the chat in memory only, as before.
 */
import { createHmac, hkdfSync } from 'node:crypto';
import { walletSessionKey } from './wallet-session.ts';

type Env = Readonly<Record<string, string | undefined>>;
/** The digest key: derived from the same deployment secret as the account session cookie, for this purpose only. */
export const conversationScopeKey = (env: Env): Buffer => Buffer.from(hkdfSync('sha256', walletSessionKey(env), 'flofi', 'flofi/conversation-scope/v1', 32));
/** Same key, tenant and account → same scope; any other tenant, account or deployment key → another scope. */
export function conversationScopeOf(key: Uint8Array, tenantId: string, accountId: string): string {
  return createHmac('sha256', key).update(`flofi.conversation-scope.v1\0${tenantId}\0${accountId}`).digest('base64url').slice(0, 32);
}
export async function currentConversationScope(env: Env = process.env): Promise<string | null> {
  try {
    if (!env.DATABASE_URL) return null;
    const [{ accountHost, currentAccountSession }, { platformStateHost }] = await Promise.all([import('../accounts/account-host.ts'), import('./platform-state-host.ts')]);
    const host = await accountHost(env), session = await currentAccountSession(host, env);
    if (!host || !session) return null;
    return conversationScopeOf(conversationScopeKey(env), (await platformStateHost(env)).tenantId, session.accountId);
  } catch { return null; }
}
