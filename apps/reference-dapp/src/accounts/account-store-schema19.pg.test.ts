// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Retained Release A/0019 regression. The released version-18 account model and store are frozen at main
 * d37b6168cd978bbee28b28ec5a4e2330eac86585 under test/fixtures/v18 (only import paths relocated). Both readers run on the
 * same schema-19 rows: rollback hides Privy wallets without releasing their addresses, while Release B understands them.
 * Session id generation/TTL and wallet display sanitization are unchanged shared helpers; no provider is contacted.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertSchemaCompatible, CERTIFIED_FORWARD_MIGRATIONS, loadMigrations, migrate, SHIPPED_MIGRATIONS } from '@defi-workflow-engine/cloud-runtime';
import { createTestDatabase, type TestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness';
import { createAccountStore } from './account-store';
import { createAccountStore as createV18AccountStore } from './test/fixtures/v18/account-store';

const FIXTURE = new URL('../../../../packages/cloud-runtime/test/fixtures/0019_privy_accounts.sql', import.meta.url);
const ACCOUNT = 'acct_' + 'b'.repeat(32), PRIVY_EVM = '0x' + '5'.repeat(40), PRIVY_SOLANA = '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV';
let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase({ migrated: false });
  const shipped = (await loadMigrations()).slice(0, 19), sql = await readFile(FIXTURE, 'utf8');
  const certificate = CERTIFIED_FORWARD_MIGRATIONS.find(c => c.base.version === 18)!;
  expect(certificate.migrations).toEqual([{ version: 19, name: 'privy_accounts', sha256: createHash('sha256').update(sql).digest('hex') }]);
  expect(shipped.at(-1)).toMatchObject({ version: 19, name: 'privy_accounts', sql });
  await migrate(t.db, shipped);
  await t.db.query("INSERT INTO flofi_accounts (tenant_id, account_id) VALUES ('default', $1)", [ACCOUNT]);
  await t.db.query(`INSERT INTO flofi_account_identities (tenant_id, kind, subject, account_id, label) VALUES
    ('default', 'PRIVY', 'did:privy:cm4ab12cd34ef56gh78ij90kl', $1, NULL), ('default', 'EMAIL', 'privy@example.com', $1, 'privy@example.com')`, [ACCOUNT]);
  await t.db.query(`INSERT INTO flofi_account_wallets (tenant_id, account_id, ecosystem, address, origin, provider, provider_name, provider_resource, export, label)
    VALUES ('default', $1, 'EVM', $2, 'GENERATED', 'privy', 'FloFi wallet', 'privywallet12345678', 'PRIVATE_KEY', 'EVM wallet'),
      ('default', $1, 'SOLANA', $3, 'IMPORTED', 'privy', 'FloFi wallet', NULL, 'PRIVATE_KEY', 'Imported')`, [ACCOUNT, PRIVY_EVM, PRIVY_SOLANA]);
});
afterAll(async () => { await t?.drop(); });

describe('Release A rollback and Release B account readers on schema 19', () => {
  it('keeps the actual version-18 reader and model byte-identical to their released sources', async () => {
    for (const [name, digest] of [
      ['account-model', '6da4c43a1e7159650a7edb1498f263961282f0efb6033f54100e65224dca2680'],
      ['account-store', '9f319c648ca49aaa4f0fac7bcab32e46fcc3e42ad2d20468ac5e07b60f47b108'],
    ]) {
      const relocated = await readFile(new URL(`./test/fixtures/v18/${name}.ts`, import.meta.url), 'utf8');
      const released = relocated.replace("'../../../../wallet/wallet-registry'", "'../wallet/wallet-registry'")
        .replace("'../../../account-session.ts'", "'./account-session.ts'");
      expect(createHash('sha256').update(released).digest('hex')).toBe(digest);
    }
  });

  it('allows the version-18 build only through the exact 0019 certificate', async () => {
    const v18 = SHIPPED_MIGRATIONS.slice(0, 18);
    expect(await assertSchemaCompatible(t.open(1), v18)).toMatchObject({ version: 19, application: 18 });
    await expect(assertSchemaCompatible(t.db, v18, CERTIFIED_FORWARD_MIGRATIONS.filter(c => c.base.version !== 18)))
      .rejects.toThrow('MIGRATION_HISTORY_MISMATCH');
  });

  it('hides Privy wallets on rollback, preserves their ownership, and understands them in Release B', async () => {
    const rollback = createV18AccountStore(t.db, 'default'), current = createAccountStore(t.db, 'default');
    expect(await rollback.wallets(ACCOUNT)).toEqual([]);
    for (const [ecosystem, address] of [['evm', PRIVY_EVM], ['solana', PRIVY_SOLANA]] as const) {
      expect(await rollback.walletHolder(ecosystem, address)).toBe(ACCOUNT);
    }
    const other = await rollback.signIn({ kind: 'google', subject: 'release-a-other', label: null });
    await expect(rollback.saveWallet(other.accountId, { ecosystem: 'evm', address: PRIVY_EVM, origin: 'external', provider: 'io.metamask', providerName: 'MetaMask',
      providerResource: null, label: 'MetaMask' })).rejects.toThrow('ACCOUNT_WALLET_LINKED_ELSEWHERE');
    expect((await rollback.signIn({ kind: 'email', subject: 'privy@example.com', label: 'privy@example.com' })).accountId).toBe(ACCOUNT);
    const oldAccount = await rollback.account(ACCOUNT);
    expect(oldAccount?.identities).toEqual(expect.arrayContaining([{ kind: 'email', label: 'privy@example.com' }]));
    expect(oldAccount?.identities.find(identity => identity.kind === undefined)?.label).toBe('did:privy:cm4ab12cd34ef56gh78ij90kl');
    expect(oldAccount?.wallets).toEqual([]);
    expect((await current.wallets(ACCOUNT)).map(wallet => `${wallet.provider}:${wallet.origin}:${wallet.export}`).sort())
      .toEqual(['privy:generated:private-key', 'privy:imported:private-key']);
    expect((await current.account(ACCOUNT))?.identities).toEqual(expect.arrayContaining([
      { kind: 'privy', label: 'did:privy:cm4ab12cd34ef56gh78ij90kl' },
    ]));
    expect(await createV18AccountStore(t.db, 'other-tenant').wallets(ACCOUNT)).toEqual([]);
  });

  it('keeps version-18 writes valid on schema 19 and leaves Privy rows untouched', async () => {
    const rollback = createV18AccountStore(t.db, 'default'), current = createAccountStore(t.db, 'default');
    const before = (await t.db.query('SELECT * FROM flofi_account_wallets WHERE account_id=$1 ORDER BY ecosystem', [ACCOUNT])).rows;
    const ana = await rollback.signIn({ kind: 'email', subject: 'release-a@example.com', label: 'release-a@example.com' });
    await rollback.setWalletOrganization(ana.accountId, { provider: 'turnkey', organization: 'org-12345678', user: 'user-12345678', login: 'email' });
    await rollback.saveWallet(ana.accountId, { ecosystem: 'evm', address: '0x' + '6'.repeat(40), origin: 'generated', provider: 'turnkey', providerName: 'FloFi wallet',
      providerResource: 'wallet-12345678', label: 'EVM wallet' });
    await rollback.saveWallet(ana.accountId, { ecosystem: 'evm', address: '0x' + '7'.repeat(40), origin: 'external', provider: 'io.metamask', providerName: 'MetaMask',
      providerResource: null, label: 'MetaMask' });
    expect((await rollback.wallets(ana.accountId)).map(wallet => `${wallet.provider}:${wallet.origin}`)).toEqual(['turnkey:generated', 'io.metamask:external']);
    expect(await current.wallets(ana.accountId)).toEqual(await rollback.wallets(ana.accountId));
    await rollback.deleteAccount(ana.accountId);
    expect(await current.account(ana.accountId)).toBeNull();
    expect((await t.db.query('SELECT * FROM flofi_account_wallets WHERE account_id=$1 ORDER BY ecosystem', [ACCOUNT])).rows).toEqual(before);
  });
});
