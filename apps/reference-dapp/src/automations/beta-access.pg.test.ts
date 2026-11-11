// SPDX-License-Identifier: AGPL-3.0-only
/** New proposal/worker admission on disposable PostgreSQL; no provider calls, signer or public transaction. */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { WorkHandler } from '@defi-workflow-engine/cloud-runtime';
import { createTestDatabase, type TestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness';
import { createBetaAccessStore } from '../flight/beta-access';
import { automationHarness, OWNER_A, weeklyDca } from './automation.test-harness';
import { automationHandlers, automationWorkRuntime } from './runtime';
import { delegationRuntime } from '../delegation/runtime';
import type { DelegationConfig } from '../delegation/config';
let t: TestDatabase;
beforeAll(async () => { t = await createTestDatabase(); });
afterAll(async () => { await t?.drop(); });
const hex = (n: number) => randomBytes(n).toString('hex');
async function grantOwner(now: Date) {
  const accountId = 'acct_' + hex(16), entryId = 'fle_' + hex(16);
  await t.db.query(`INSERT INTO flofi_accounts (tenant_id,account_id) VALUES ('default',$1)`, [accountId]);
  await t.db.query(`INSERT INTO flofi_account_wallets (tenant_id,account_id,ecosystem,address,origin,provider,provider_name,export,label)
    VALUES ('default',$1,'EVM',$2,'EXTERNAL','fixture','Fixture','NONE','Fixture')`, [accountId, OWNER_A.address]);
  await t.db.query(`INSERT INTO flight_list_entries (tenant_id,entry_id,email,language,flight,notice,joined_at)
    VALUES ('default',$1,$2,'EN','FIRST','2026-11-09','2026-11-09T00:00:00Z')`, [entryId, hex(8) + '@example.test']);
  await t.db.query(`INSERT INTO flight_access_claims (tenant_id,entry_id,account_id) VALUES ('default',$1,$2)`, [entryId, accountId]);
  expect(await createBetaAccessStore({ db: t.db, tenantId: 'default' }).grant(accountId, now.getTime())).toEqual({ ok: true, accountId });
  return accountId;
}
it('holds due automation proposals before evaluating an unbound/revoked wallet, and allows the same slot after valid admission', async () => {
  const h = automationHarness(t.db, { start: new Date('2026-11-13T10:00:00Z') });
  const rule = await h.service().create(OWNER_A, weeklyDca()); h.set('2026-11-16T09:00:40Z');
  const env: Record<string, string | undefined> = { FLOFI_BETA_ACCESS: 'beta' };
  const rt = automationWorkRuntime(env, h.config, { db: t.db, tenantId: 'default' }, h.log, h.now, { price: h.prices.source });
  const handler = automationHandlers(rt)['automation.evaluate'];
  const item = { payload: { ruleId: rule.ruleId } } as unknown as Parameters<WorkHandler>[0];
  const outcomes: unknown[] = [], settle = async (value: unknown) => { outcomes.push(value); return true; };
  await handler(item, settle, {} as Parameters<WorkHandler>[2]);
  expect(outcomes.at(-1)).toMatchObject({ outcome: 'RETRY', reason: 'BETA_WALLET_NOT_LINKED' });
  expect((await t.db.query('SELECT 1 FROM automation_occurrences WHERE rule_id=$1', [rule.ruleId])).rowCount).toBe(0);
  const account = await grantOwner(h.now()); await handler(item, settle, {} as Parameters<WorkHandler>[2]);
  expect(outcomes.at(-1)).toEqual({ outcome: 'DONE' });
  expect((await t.db.query('SELECT 1 FROM automation_occurrences WHERE rule_id=$1', [rule.ruleId])).rowCount).toBe(1);
  await createBetaAccessStore({ db: t.db, tenantId: 'default' }).revoke(account, h.now().getTime());
  h.set('2026-11-23T09:00:40Z'); await handler(item, settle, {} as Parameters<WorkHandler>[2]);
  expect(outcomes.at(-1)).toMatchObject({ outcome: 'RETRY', reason: 'BETA_ACCESS_REVOKED' });
  expect((await t.db.query('SELECT 1 FROM automation_occurrences WHERE rule_id=$1', [rule.ruleId])).rowCount).toBe(1);
  expect(automationHandlers(rt)['automation.notify']).toBeTypeOf('function');
});
it('rechecks cached delegated-runtime admission dynamically without granting any signer or financial authority', async () => {
  const env: Record<string, string | undefined> = { FLOFI_BETA_ACCESS: 'closed' };
  const config = { enabled: true, tenantId: 'default', mode: 'MOCKED_HARNESS', harnessUrl: 'http://127.0.0.1:1', rpc: {},
    passkeyOrigin: 'http://localhost:3999', mainnetChains: [], signer: { kind: 'none' }, executor: false, hosted: false } as DelegationConfig;
  const rt = delegationRuntime(config, { db: t.db, tenantId: 'default' }, { now: () => new Date('2026-11-11T12:00:00Z') }, env);
  expect(await rt.authorizeBeta(OWNER_A)).toBe('BETA_ACCESS_CLOSED');
  env.FLOFI_BETA_ACCESS = 'beta'; expect(await rt.authorizeBeta(OWNER_A)).toBe('BETA_NOT_OPEN');
  env.FLOFI_BETA_ACCESS = 'open'; expect(await rt.authorizeBeta(OWNER_A)).toBeNull();
});
it('the actual delegated state machine refuses revoked beta access before new simulation/signing and releases unused reservation', async () => {
  const { delegationHarness } = await import('../delegation/delegation.test-harness');
  const { executeOccurrence } = await import('../delegation/executor');
  const h = await delegationHarness(t.db);
  const passkey = await h.registerPasskey(); await h.enrollEvm(passkey);
  const { created } = await h.authorize(h.multichainInput({}, false));
  const result = await h.trigger(created.ruleId);
  expect(result.kind).toBe('COMMITTED');
  if (result.kind !== 'COMMITTED' || !result.occurrence || 'code' in h.deps) throw new Error('FIXTURE_NOT_READY');
  const executed = await executeOccurrence({ ...h.deps, authorizeBeta: async () => 'BETA_ACCESS_REVOKED' }, result.occurrence.occurrenceId, created.authorizationId);
  expect(executed).toMatchObject({ state: 'BLOCKED', code: 'BETA_ACCESS_REVOKED' });
  expect(h.evm.control.sends()).toBe(0);
  const steps = await h.store.steps(executed.executionId!);
  expect(steps[0]).toMatchObject({ state: 'BLOCKED', submission: null, plan: null });
  expect((await h.store.budget(created.authorizationId)).every(row => row.state === 'RELEASED')).toBe(true);
});

it('shares temporary wallet admission across proposal, delegated and user-funded runtimes without granting signing authority', async () => {
  const early = Date.parse('2026-11-12T11:59:59Z'), time = vi.spyOn(Date, 'now').mockReturnValue(early);
  try {
    // Separate wallet from other cases, no Flight data or grant.
    const owner = { namespace: 'eip155' as const, address: `0x${hex(20)}` }, accountId = 'acct_' + hex(16);
    await t.db.query(`INSERT INTO flofi_accounts (tenant_id,account_id) VALUES ('default',$1)`, [accountId]);
    await t.db.query(`INSERT INTO flofi_account_wallets (tenant_id,account_id,ecosystem,address,origin,provider,provider_name,export,label)
      VALUES ('default',$1,'EVM',$2,'EXTERNAL','fixture','Fixture','NONE','Fixture')`, [accountId, owner.address]);
    await t.db.query(`INSERT INTO flofi_account_sessions (tenant_id,account_id,session_id,method,authenticated_at,expires_at)
      VALUES ('default',$1,$2,'EIP155',$3,$4)`, [accountId, hex(16), new Date(early - 1000), new Date(early + 3600_000)]);
    const env = { FLOFI_BETA_ACCESS: 'beta', FLOFI_BETA_EARLY_ACCESS_ACCOUNTS: accountId, FLOFI_BETA_EARLY_ACCESS_TENANT: 'default',
      FLOFI_USER_FUNDED_EXECUTION: 'enabled', FLOFI_USER_FUNDED_CHAINS: 'eip155:8453', FLOFI_USER_FUNDED_RPC_8453: 'https://rpc.example.test' };
    const host = { db: t.db, tenantId: 'default' }, h = automationHarness(t.db, { start: new Date(early) });
    const automation = automationWorkRuntime(env, h.config, host, h.log, h.now, { price: h.prices.source });
    const config = { enabled: true, tenantId: 'default', mode: 'MOCKED_HARNESS', harnessUrl: 'http://127.0.0.1:1', rpc: {},
      passkeyOrigin: 'http://localhost:3999', mainnetChains: [], signer: { kind: 'none' }, executor: false, hosted: false } as DelegationConfig;
    const delegated = delegationRuntime(config, host, { now: () => new Date(early) }, env);
    const { userFundedRuntime } = await import('../user-funded/runtime');
    const transport = vi.fn<typeof fetch>();
    const funded = userFundedRuntime(env, transport, host);
    expect(await automation.authorizeBeta!(owner)).toBeNull();
    expect(await delegated.authorizeBeta(owner)).toBeNull();
    expect(await funded.deps!.submissionRefusal!(owner)).toBeNull();
    expect(await funded.deps!.submissionRefusal!(OWNER_A, owner)).toBe('BETA_WALLET_NOT_LINKED');
    expect(await automation.authorizeBeta!(OWNER_A)).not.toBeNull();
    expect(transport).not.toHaveBeenCalled();
    time.mockReturnValue(Date.parse('2026-11-12T12:00:00Z'));
    expect(await automation.authorizeBeta!(owner)).not.toBeNull();
    expect(await delegated.authorizeBeta(owner)).not.toBeNull();
    expect(await funded.deps!.submissionRefusal!(owner)).not.toBeNull();
    expect(transport).not.toHaveBeenCalled();
  } finally { time.mockRestore(); }
});
