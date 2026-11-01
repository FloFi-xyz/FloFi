// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Release A for BUILD-FLOFI-PRIVY-UX-001: this (version-18) build runs on schema 19 through its 0019 certificate, including on rows a
 * version-19 build writes (a Privy identity, Privy-managed wallets), exactly as SCHEMA-COMPATIBILITY.md §13 states. The certified fixture
 * is applied on top of the shipped migrations, byte for byte; nothing here ships 0019.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertSchemaCompatible, CERTIFIED_FORWARD_MIGRATIONS, loadMigrations, migrate, SHIPPED_MIGRATIONS } from '@defi-workflow-engine/cloud-runtime';
import { createTestDatabase, type TestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness';
import { createAccountStore } from './account-store';

const FIXTURE = new URL('../../../../packages/cloud-runtime/test/fixtures/0019_privy_accounts.sql', import.meta.url);
const ACCOUNT = 'acct_' + 'b'.repeat(32), PRIVY_EVM = '0x' + '5'.repeat(40), PRIVY_SOLANA = '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV';
let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase({ migrated: false });
  const shipped = await loadMigrations(), sql = await readFile(FIXTURE, 'utf8');
  const certificate = CERTIFIED_FORWARD_MIGRATIONS.find(c => c.base.version === 18)!;
  expect(certificate.migrations).toEqual([{ version: 19, name: 'privy_accounts', sha256: createHash('sha256').update(sql).digest('hex') }]);
  expect(shipped.at(-1)).toMatchObject({ version: 18, name: 'flofi_accounts' });
  await migrate(t.db, shipped);
  await migrate(t.db, [...shipped, { version: 19, name: 'privy_accounts', sql, sha256: certificate.migrations[0]!.sha256 }]);
  // What a version-19 build writes: an account with its Privy user and email identity, and two Privy-managed wallets.
  await t.db.query("INSERT INTO flofi_accounts (tenant_id, account_id) VALUES ('default', $1)", [ACCOUNT]);
  await t.db.query(`INSERT INTO flofi_account_identities (tenant_id, kind, subject, account_id, label) VALUES
    ('default', 'PRIVY', 'did:privy:cm4ab12cd34ef56gh78ij90kl', $1, NULL), ('default', 'EMAIL', 'privy@example.com', $1, 'privy@example.com')`, [ACCOUNT]);
  await t.db.query(`INSERT INTO flofi_account_wallets (tenant_id, account_id, ecosystem, address, origin, provider, provider_name, provider_resource, export, label)
    VALUES ('default', $1, 'EVM', $2, 'GENERATED', 'privy', 'FloFi wallet', 'privywallet12345678', 'PRIVATE_KEY', 'EVM wallet'),
      ('default', $1, 'SOLANA', $3, 'IMPORTED', 'privy', 'FloFi wallet', NULL, 'PRIVATE_KEY', 'Imported')`, [ACCOUNT, PRIVY_EVM, PRIVY_SOLANA]);
});
afterAll(async () => { await t?.drop(); });

describe('Release A: a version-18 build on schema 19 (certificate 0019_privy_accounts)', () => {
  it('starts only through its certificate', async () => {
    expect(await assertSchemaCompatible(t.open(1), SHIPPED_MIGRATIONS)).toMatchObject({ version: 19, application: 18 });
    await expect(assertSchemaCompatible(t.db, SHIPPED_MIGRATIONS, CERTIFIED_FORWARD_MIGRATIONS.filter(c => c.base.version !== 18)))
      .rejects.toThrow('MIGRATION_HISTORY_MISMATCH');
  });

  it('never shows, signs with or gives away a Privy wallet, and keeps signing in the same person', async () => {
    const store = createAccountStore(t.db, 'default');
    // Its strict reader drops Privy wallet rows: they are neither listed nor offered for signing or export by this build (its export grant
    // and its relay look a resource up only for a listed wallet: wallet-service.ts exportGrant, wallet-relay.ts).
    expect(await store.wallets(ACCOUNT)).toEqual([]);
    // Their addresses still belong to that account: another account can never take them.
    expect(await store.walletHolder('evm', PRIVY_EVM)).toBe(ACCOUNT);
    const other = await store.signIn({ kind: 'google', subject: 'release-a-other', label: null });
    await expect(store.saveWallet(other.accountId, { ecosystem: 'evm', address: PRIVY_EVM, origin: 'external', provider: 'io.metamask', providerName: 'MetaMask',
      providerResource: null, label: 'MetaMask' })).rejects.toThrow('ACCOUNT_WALLET_LINKED_ELSEWHERE');
    // The verified email still signs in to the same account; the Privy identity is listed without a sign-in kind (label: its public DID).
    expect((await store.signIn({ kind: 'email', subject: 'privy@example.com', label: 'privy@example.com' })).accountId).toBe(ACCOUNT);
    const account = await store.account(ACCOUNT);
    expect(account?.identities).toEqual(expect.arrayContaining([{ kind: 'email', label: 'privy@example.com' }]));
    expect(account?.identities.find(identity => identity.kind === undefined)?.label).toBe('did:privy:cm4ab12cd34ef56gh78ij90kl');
    expect(account?.wallets).toEqual([]);
  });

  it('writes only rows schema 19 accepts', async () => {
    const store = createAccountStore(t.db, 'default'), ana = await store.signIn({ kind: 'email', subject: 'release-a@example.com', label: 'release-a@example.com' });
    await store.setWalletOrganization(ana.accountId, { provider: 'turnkey', organization: 'org-12345678', user: 'user-12345678', login: 'email' });
    await store.saveWallet(ana.accountId, { ecosystem: 'evm', address: '0x' + '6'.repeat(40), origin: 'generated', provider: 'turnkey', providerName: 'FloFi wallet',
      providerResource: 'wallet-12345678', label: 'EVM wallet' });
    await store.saveWallet(ana.accountId, { ecosystem: 'evm', address: '0x' + '7'.repeat(40), origin: 'external', provider: 'io.metamask', providerName: 'MetaMask',
      providerResource: null, label: 'MetaMask' });
    expect((await store.wallets(ana.accountId)).map(wallet => `${wallet.provider}:${wallet.origin}`)).toEqual(['turnkey:generated', 'io.metamask:external']);
    await store.deleteAccount(ana.accountId);
    expect(await store.account(ana.accountId)).toBeNull();
  });
});
