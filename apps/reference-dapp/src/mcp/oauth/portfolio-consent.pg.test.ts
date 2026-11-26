// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 (P0): the external report showed `get_account` listing a linked wallet with `balancesReadable: false`
 * while `get_portfolio` answered PORTFOLIO_RELINK_REQUIRED, and re-linking did not help. Through the real `/api/mcp` gateway, OAuth grants and link
 * store on a disposable loopback PostgreSQL:
 *   - a deployment without FLOFI_MCP_PORTFOLIO_LINKS_FROM (the production state found by this build) says so, never "link again", and a re-link
 *     through the real store changes nothing (an operator setting); account and portfolio states agree;
 *   - with a consent instant configured, a link made before it is not read and is renewed by a real re-link (a new link row, `created_at` now);
 *     afterwards the wallet is read, and only exactly that wallet's balances are read;
 *   - another account never reads the linked wallet's portfolio; nothing is ever shown as a zero balance; no consent is backdated.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../../../packages/cloud-runtime/test/pg-harness.ts';
import type { WalletPortfolio } from '../../domain/wallet-portfolio';
import type { McpWalletOwner } from '../config';
import { session } from '../gateway.test-harness.ts';
import { oauthClient, oauthEnv, signIn } from './oauth-test-harness.ts';
import { createPgOAuthStore } from './pg-store.ts';
import { stateOf } from './state.ts';

let t: TestDatabase;
beforeAll(async () => { t = await createTestDatabase(); });
afterAll(async () => { await t?.drop(); });
const SCOPES = 'flofi.strategy flofi.runs';
const A = '0x' + 'a7'.repeat(20), B = '0x' + 'b8'.repeat(20);
const state = () => stateOf({ db: t.db, tenantId: 'default' });
const reads: McpWalletOwner[] = [];
const portfolio = { balances: async (wallet: McpWalletOwner): Promise<WalletPortfolio> => {
  reads.push(wallet);
  return { format: 'flofi.wallet-portfolio.v2', observedAt: '2026-11-26T12:00:00.000Z', accounts: [{ ecosystem: 'evm', address: wallet.address }],
    networks: [{ id: 'base', name: 'Base', chain: 'eip155:8453', chainId: 8453, ecosystem: 'evm', status: 'READ', provenance: 'PUBLIC_MAINNET',
      observedAt: '2026-11-26T12:00:00.000Z', block: '1', slot: null, tokens: 'ALL', uncheckedTokens: 0, code: null }],
    holdings: [{ networkId: 'base', network: 'Base', chain: 'eip155:8453', symbol: 'USDC', name: 'USD Coin', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6,
      units: '2500000', displayUnits: '2500000', displayBasis: 'RAW', unavailableCode: null, native: false, provenance: 'PUBLIC_MAINNET', price: null, valueUsd: '2.50', logo: null }],
    pricedTotalUsd: '2.50', unpricedCount: 0, unlisted: [], priceSource: 'TEST' } as unknown as WalletPortfolio;
} };

/** A fresh FloFi account with its access token. */
async function account(env: Record<string, string>) {
  const tokens = await signIn(oauthClient({ env, store: createPgOAuthStore(t.db, 'default') }), { scope: SCOPES });
  const { account_id: accountId } = (await t.db.query<{ account_id: string }>('SELECT account_id FROM mcp_oauth_grants ORDER BY created_at DESC LIMIT 1')).rows[0]!;
  return { accountId, token: tokens.access_token };
}
const linkAt = async (accountId: string, address: string, at: Date) => expect((await state().links.link(accountId, { namespace: 'eip155', address }, at)).ok).toBe(true);
const client = (env: Record<string, string>, token: string, now?: Date) => session({ env, token, state: state(), portfolio, ...now ? { now: () => now } : {} });
const wallets = async (c: ReturnType<typeof client>) => ((await c.callTool('get_account', {})).output.wallets as Record<string, unknown>[]);

describe('BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 P0: portfolio consent over the real link store', () => {
  it('a deployment that reads no balances says so; a real re-link does not change it; account and portfolio agree', async () => {
    const env = { FLOFI_MCP: 'enabled', ...oauthEnv() };
    const { accountId, token } = await account(env);
    await linkAt(accountId, A, new Date());
    const c = client(env, token);
    expect(await wallets(c)).toEqual([expect.objectContaining({ address: A, balancesReadable: false, balancesUnreadableReason: 'DEPLOYMENT_PORTFOLIO_READS_NOT_ENABLED' })]);
    const before = (await c.callTool('get_portfolio', {})).output;
    expect(before).toMatchObject({ ok: false, code: 'PORTFOLIO_READS_NOT_ENABLED', deployment: 'NOT_ENABLED', relinkHelps: false });
    // The person re-links (the real store revokes the old row and inserts a new one): the answer stays the same, honestly.
    await linkAt(accountId, A, new Date());
    const rows = (await t.db.query<{ n: number }>('SELECT count(*)::int AS n FROM mcp_wallet_links WHERE account_id = $1', [accountId])).rows[0]!.n;
    expect(rows).toBe(2);
    expect((await c.callTool('get_portfolio', {})).output).toMatchObject({ code: 'PORTFOLIO_READS_NOT_ENABLED', relinkHelps: false });
    expect((await c.callTool('get_account', {})).output).toMatchObject({ portfolioReads: { status: 'NOT_ENABLED' } });
    expect(reads).toEqual([]);
  });

  it('with a consent instant, an earlier link is not read until a real re-link renews it; then exactly that wallet is read', async () => {
    const cutoff = new Date(Date.now() - 60_000), env = { FLOFI_MCP: 'enabled', ...oauthEnv(), FLOFI_MCP_PORTFOLIO_LINKS_FROM: cutoff.toISOString().replace(/\.\d{3}Z$/, 'Z') };
    const { accountId, token } = await account(env);
    // Linked an hour before the consent text was live (never backdated by FloFi: the test writes the earlier link itself).
    await linkAt(accountId, A, new Date(cutoff.getTime() - 3_600_000));
    const c = client(env, token);
    expect(await wallets(c)).toEqual([expect.objectContaining({ address: A, balancesReadable: false, balancesUnreadableReason: 'LINK_PREDATES_PORTFOLIO_CONSENT' })]);
    expect((await c.callTool('get_portfolio', {})).output).toMatchObject({ ok: false, code: 'PORTFOLIO_RELINK_REQUIRED', relinkHelps: true });
    expect(reads).toEqual([]);
    // A second wallet linked now is read; the earlier one is named as needing a re-link, never shown as zero or left out silently.
    await linkAt(accountId, B, new Date());
    const partial = (await c.callTool('get_portfolio', {})).output as { complete: boolean; wallets: { wallet: { address: string } }[]; relinkRequired: { wallets: { address: string }[] } };
    expect(partial.complete).toBe(false);
    expect(partial.wallets.map(w => w.wallet.address)).toEqual([B]);
    expect(partial.relinkRequired.wallets.map(w => w.address)).toEqual([A]);
    expect(reads.map(r => r.address)).toEqual([B]);
    // The person re-links A: the new link renews consent and A is read.
    await linkAt(accountId, A, new Date());
    expect((await wallets(c)).map(w => [w.address, w.balancesReadable])).toEqual(expect.arrayContaining([[A, true], [B, true]]));
    const full = (await c.callTool('get_portfolio', {})).output as { complete: boolean; wallets: { wallet: { address: string } }[] };
    expect(full).not.toHaveProperty('relinkRequired');
    expect(full.wallets.map(w => w.wallet.address).sort()).toEqual([A, B].sort());
  });

  it('another account never reads the linked wallet; a consent instant still in the future renews nothing yet', async () => {
    const env = { FLOFI_MCP: 'enabled', ...oauthEnv(), FLOFI_MCP_PORTFOLIO_LINKS_FROM: '2026-11-24T05:00:00Z' };
    const owner = await account(env), other = await account(env);
    await linkAt(owner.accountId, A, new Date());
    reads.length = 0;
    const theirs = client(env, other.token);
    expect((await theirs.callTool('get_account', {})).output).toMatchObject({ walletCount: 0, wallets: [] });
    expect((await theirs.callTool('get_portfolio', {})).output).toMatchObject({ ok: false, code: 'MCP_WALLET_LINK_REQUIRED' });
    expect(reads).toEqual([]);
    // The same link, under a consent instant that has not come yet (the gateway's clock is before it): not read, and re-linking is not offered as a fix.
    const future = { ...env, FLOFI_MCP_PORTFOLIO_LINKS_FROM: '2999-01-01T00:00:00Z' };
    expect((await client(future, owner.token).callTool('get_portfolio', {})).output).toMatchObject({ code: 'PORTFOLIO_READS_NOT_ENABLED', deployment: 'NOT_YET_EFFECTIVE',
      consentSince: '2999-01-01T00:00:00.000Z', relinkHelps: false });
    expect(reads).toEqual([]);
  });
});
