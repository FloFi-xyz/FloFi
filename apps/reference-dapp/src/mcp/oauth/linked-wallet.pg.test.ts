// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-POST-257-HOTFIX-001 (P1-5): linked-wallet resolution through the real `/api/mcp` gateway, OAuth grants and link store on a disposable
 * loopback PostgreSQL. A supply goal whose beneficiary the person left out returns the account's own linked EVM wallets as the options to confirm
 * (FloFi never chooses one: the wallet that signs later may differ); a grant without `flofi.runs` (which may not read the account's wallets) never
 * loads them; another account's links never appear; an unavailable link store fails closed. No balance is read and nothing is stored.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../../../packages/cloud-runtime/test/pg-harness.ts';
import { session } from '../gateway.test-harness.ts';
import { oauthClient, oauthEnv, signIn } from './oauth-test-harness.ts';
import { createPgOAuthStore } from './pg-store.ts';
import { stateOf, type McpState } from './state.ts';

let t: TestDatabase;
beforeAll(async () => { t = await createTestDatabase(); });
afterAll(async () => { await t?.drop(); });
const env = () => ({ FLOFI_MCP: 'enabled', ...oauthEnv() });
const state = () => stateOf({ db: t.db, tenantId: 'default' });
const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20);
const GOAL = { goal: { sourceNetwork: 'base', sourceAsset: 'USDC', amount: '10', targetNetwork: 'base', use: 'SUPPLY' } };

/** A fresh FloFi account signed in with `scope`, its linked wallets, and a client for it. */
async function account(scope: string, wallets: readonly string[], options: { readonly state?: McpState } = {}) {
  const tokens = await signIn(oauthClient({ env: env(), store: createPgOAuthStore(t.db, 'default') }), { scope });
  const { account_id: accountId } = (await t.db.query<{ account_id: string }>('SELECT account_id FROM mcp_oauth_grants ORDER BY created_at DESC LIMIT 1')).rows[0]!;
  for (const address of wallets) expect((await state().links.link(accountId, { namespace: 'eip155', address }, new Date())).ok).toBe(true);
  return session({ env: env(), token: tokens.access_token, state: options.state ?? state() });
}

describe('BUILD-FLOFI-POST-257-HOTFIX-001: plan_strategy resolves the person\'s own linked wallet through the gateway', () => {
  it('offers the one linked EVM wallet to confirm, never fills it in', async () => {
    const client = await account('flofi.strategy flofi.runs', [A]);
    expect((await client.callTool('plan_strategy', GOAL)).output).toMatchObject({ ok: true, kind: 'NEEDS', field: 'beneficiary', options: [A],
      optionsSource: 'LINKED_WALLETS' });
    // Once the person confirms it, the plan uses exactly that wallet.
    expect((await client.callTool('plan_strategy', { goal: { ...GOAL.goal, beneficiary: A } })).output).toMatchObject({ ok: true, kind: 'PLAN',
      strategy: { action: 'supply', network: 'base', asset: 'USDC', beneficiary: A } });
  });

  it('offers every linked EVM wallet of this account, and only this account\'s', async () => {
    const mine = await account('flofi.strategy flofi.runs', [A, B]);
    const planned = (await mine.callTool('plan_strategy', GOAL)).output as { options: string[] };
    expect(planned).toMatchObject({ ok: true, kind: 'NEEDS', field: 'beneficiary' });
    expect([...planned.options].sort()).toEqual([A, B].sort());
    // Another account with no link of its own never sees them (links are bound to the token's account and tenant).
    const other = await account('flofi.strategy flofi.runs', []);
    expect((await other.callTool('plan_strategy', GOAL)).output).toMatchObject({ kind: 'NEEDS', field: 'beneficiary', options: [] });
  });

  it('keeps what the person gave, and loads no wallet for a goal with no supply step', async () => {
    const client = await account('flofi.strategy flofi.runs', [A]);
    expect((await client.callTool('plan_strategy', { goal: { ...GOAL.goal, beneficiary: B } })).output).toMatchObject({ kind: 'PLAN', strategy: { beneficiary: B } });
    const bridge = (await client.callTool('plan_strategy', { goal: { sourceNetwork: 'base', sourceAsset: 'ETH', amount: '0.0003', targetNetwork: 'arbitrum-one', targetAsset: 'USDC',
      use: 'HOLD' } })).output;
    expect(bridge).toMatchObject({ kind: 'PLAN', stepCount: 1, strategy: { action: 'bridge', outputAsset: 'USDC' } });
    expect(bridge).not.toHaveProperty('optionsSource');
  });

  it('a grant without flofi.runs never reads the account\'s wallets: the field is asked for, with no options', async () => {
    const client = await account('flofi.strategy', [A]);
    expect((await client.callTool('plan_strategy', GOAL)).output).toMatchObject({ ok: true, kind: 'NEEDS', field: 'beneficiary', options: [] });
  });

  it('fails closed when the link store is unavailable: asked for, never guessed', async () => {
    const base = state();
    const broken: McpState = { ...base, links: { ...base.links, active: async () => { throw new Error('STORE_DOWN'); } } };
    const client = await account('flofi.strategy flofi.runs', [A], { state: broken });
    expect((await client.callTool('plan_strategy', GOAL)).output).toMatchObject({ ok: true, kind: 'NEEDS', field: 'beneficiary', options: [] });
  });
});
