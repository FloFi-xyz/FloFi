// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIFIED-COPILOT-001: Saved Recipients on real PostgreSQL, with migration 0028 applied from its SHA-256-pinned, certified fixture
 * (Release A: the build ships through 0027). Tenant and account isolation, one record per address, one name per account (case, accents and
 * punctuation folded), strict validation, the per-account cap, the cascade on account deletion, and the store staying dark (and never creating
 * its table) on a database without the certified 0028.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CERTIFIED_FORWARD_MIGRATIONS, ensureTenant, loadMigrations, migrate, type Migration } from '@defi-workflow-engine/cloud-runtime';
import { createTestDatabase, type TestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness';
import { SAVED_RECIPIENT_ID, SAVED_RECIPIENT_LIMITS } from '../domain/saved-recipients';
import { createAccountStore, type IdentityClaim } from './account-store';
import { createRecipientStore, SAVED_RECIPIENTS_MIGRATION } from './recipient-store';

const EVM = '0x52908400098527886e0f7030069857d2e4169ee7', EVM_CHECKSUM = '0x52908400098527886E0F7030069857D2E4169EE7';
const SOL = 'GsWtMd3S5133XPhnfeR1CvPLcLxBSknhVhmaW7fHevBq', SOL_2 = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const ana: IdentityClaim = { kind: 'google', subject: '108234567890123456789', label: 'ana@example.com' };
const bruno: IdentityClaim = { kind: 'email', subject: 'bruno@example.com', label: 'bruno@example.com' };
const evmN = (n: number) => '0x' + n.toString(16).padStart(40, '0');

async function certified0028(): Promise<Migration> {
  const identity = CERTIFIED_FORWARD_MIGRATIONS.flatMap(c => c.migrations).find(m => m.name === 'saved_recipients')!;
  const sql = await readFile(new URL('../../../../packages/cloud-runtime/test/fixtures/0028_saved_recipients.sql', import.meta.url), 'utf8');
  expect(createHash('sha256').update(sql).digest('hex')).toBe(identity.sha256);
  return { ...identity, sql };
}
let t: TestDatabase;
const recipients = (tenant = 'default') => createRecipientStore(t.db, tenant);
const accounts = (tenant = 'default') => createAccountStore(t.db, tenant);
beforeAll(async () => {
  t = await createTestDatabase();
  await ensureTenant(t.db, 'other-tenant');
  // Release A applies the certified 0028 on top of the shipped v27 history; from Release B the harness already applied the shipped 0028
  // (the same certified bytes).
  const all = await loadMigrations(), certified = await certified0028();
  if (all.at(-1)!.version === 28) expect(all.at(-1)!.sha256).toBe(certified.sha256);
  else expect(await migrate(t.db, [...all, certified])).toEqual([28]);
});
afterAll(async () => t?.drop());
beforeEach(async () => { await t.db.query('TRUNCATE flofi_accounts CASCADE'); });

describe('Saved Recipients store (PostgreSQL, certified 0028)', () => {
  it('is available only with the exact certified 0028; the identity it requires is the certificate\'s', async () => {
    expect(SAVED_RECIPIENTS_MIGRATION).toEqual(CERTIFIED_FORWARD_MIGRATIONS.flatMap(c => c.migrations).find(m => m.name === 'saved_recipients'));
    expect(await recipients().available()).toBe(true);
  });

  it('creates EVM and Solana recipients, lists them oldest first, renames and removes them; only canonical public data is stored', async () => {
    const { accountId } = await accounts().signIn(ana);
    const first = await recipients().create(accountId, { label: '  Carteira   da empresa ', address: ` ${EVM_CHECKSUM} `, ecosystem: 'EVM' }, new Date('2026-11-15T10:00:00Z'));
    const second = await recipients().create(accountId, { label: 'Minha Solana', address: SOL, ecosystem: 'SOLANA' }, new Date('2026-11-15T11:00:00Z'));
    expect(first).toMatchObject({ created: true, recipient: { label: 'Carteira da empresa', address: EVM, ecosystem: 'EVM', createdAt: '2026-11-15T10:00:00.000Z' } });
    expect(second).toMatchObject({ created: true, recipient: { label: 'Minha Solana', address: SOL, ecosystem: 'SOLANA' } });
    expect(first.recipient.id).toMatch(SAVED_RECIPIENT_ID);
    expect(await recipients().list(accountId)).toEqual([first.recipient, second.recipient]);
    const stored = (await t.db.query(`SELECT * FROM flofi_account_recipients ORDER BY created_at`)).rows;
    expect(stored.map(row => Object.keys(row).sort())).toEqual(Array(2).fill(['account_id', 'address', 'created_at', 'ecosystem', 'label', 'label_key', 'recipient_id',
      'tenant_id', 'updated_at']));
    expect(stored.map(row => row.label_key)).toEqual(['carteira da empresa', 'minha solana']);

    const renamed = await recipients().rename(accountId, second.recipient.id, 'Solana da Família', new Date('2026-11-15T12:00:00Z'));
    expect(renamed).toMatchObject({ id: second.recipient.id, label: 'Solana da Família', address: SOL, updatedAt: '2026-11-15T12:00:00.000Z',
      createdAt: second.recipient.createdAt });
    // Renaming to another spelling of its own name is allowed (the key is its own).
    expect((await recipients().rename(accountId, second.recipient.id, 'SOLANA DA FAMILIA')).label).toBe('SOLANA DA FAMILIA');
    await recipients().remove(accountId, first.recipient.id);
    expect((await recipients().list(accountId)).map(r => r.id)).toEqual([second.recipient.id]);
    await expect(recipients().remove(accountId, first.recipient.id)).rejects.toThrow('RECIPIENT_NOT_FOUND');
  });

  it('the same address again returns the existing record unchanged (no duplicate, no overwrite), also under its EIP-55 spelling and concurrently', async () => {
    const { accountId } = await accounts().signIn(ana);
    const saved = await recipients().create(accountId, { label: 'Maria', address: EVM, ecosystem: 'EVM' });
    for (const address of [EVM, EVM_CHECKSUM, ` ${EVM.toUpperCase().replace('0X', '0x')}`]) {
      const again = await recipients().create(accountId, { label: 'Someone else', address, ecosystem: 'EVM' });
      expect(again).toEqual({ created: false, recipient: saved.recipient });
    }
    const racing = await Promise.all(Array.from({ length: 6 }, (_, i) => recipients().create(accountId, { label: `Race ${i}`, address: SOL, ecosystem: 'SOLANA' })));
    expect(racing.filter(result => result.created)).toHaveLength(1);
    expect(new Set(racing.map(result => result.recipient.id)).size).toBe(1);
    expect((await recipients().list(accountId)).map(r => [r.label, r.address])).toEqual([['Maria', EVM], [racing.find(r => r.created)!.recipient.label, SOL]]);
  });

  it('refuses a name another recipient of the account already uses, ignoring case, accents, punctuation and spacing', async () => {
    const { accountId } = await accounts().signIn(ana);
    await recipients().create(accountId, { label: 'Maria', address: EVM, ecosystem: 'EVM' });
    const other = await recipients().create(accountId, { label: 'João', address: SOL, ecosystem: 'SOLANA' });
    for (const label of ['maria', 'María', 'MARIA!', '  Maria  ', 'Mária.'])
      await expect(recipients().create(accountId, { label, address: evmN(7), ecosystem: 'EVM' })).rejects.toThrow('RECIPIENT_LABEL_TAKEN');
    await expect(recipients().rename(accountId, other.recipient.id, 'MARÍA')).rejects.toThrow('RECIPIENT_LABEL_TAKEN');
    expect((await recipients().list(accountId)).map(r => r.label)).toEqual(['Maria', 'João']);
  });

  it('refuses malformed addresses, an address of the other ecosystem and names that are invalid or could carry an address, a key or hidden text', async () => {
    const { accountId } = await accounts().signIn(ana);
    const bad: Array<[unknown, unknown]> = [['EVM', SOL], ['SOLANA', EVM], ['EVM', '0x52908400098527886E0F7030069857D2E4169Ee7'], ['EVM', evmN(0)],
      ['SOLANA', '11111111111111111111111111111111'], ['SOLANA', SOL.toLowerCase()], ['BITCOIN', EVM], ['EVM', 42], ['EVM', `${EVM}0`], [undefined, EVM]];
    for (const [ecosystem, address] of bad)
      await expect(recipients().create(accountId, { label: 'Valid', address, ecosystem })).rejects.toThrow('RECIPIENT_ADDRESS_INVALID');
    const labels: unknown[] = ['', '   ', 'x'.repeat(41), `Wallet ${SOL}`, '0x52908400098527886e0f7030069857d2e41', '4111 1111 1111 1111', '!!!', '💸💸',
      'Maria\u202eairaM', 'Ma\u200bria', 'Ma\u0085ria', 42, null];
    for (const label of labels)
      await expect(recipients().create(accountId, { label, address: EVM, ecosystem: 'EVM' })).rejects.toThrow('RECIPIENT_LABEL_INVALID');
    const ok = await recipients().create(accountId, { label: 'Valid', address: EVM, ecosystem: 'EVM' });
    await expect(recipients().rename(accountId, ok.recipient.id, 'Line\nbreak '.repeat(5))).rejects.toThrow('RECIPIENT_LABEL_INVALID');
    await expect(recipients().rename(accountId, 'not-an-id', 'Fine')).rejects.toThrow('RECIPIENT_NOT_FOUND');
    expect(await recipients().list(accountId)).toEqual([ok.recipient]);
  });

  it('caps each account at the shared limit; an address already saved still returns its record at the cap', async () => {
    const { accountId } = await accounts().signIn(ana);
    for (let n = 1; n <= SAVED_RECIPIENT_LIMITS.maxPerAccount; n++) await recipients().create(accountId, { label: `Recipient ${n}`, address: evmN(n), ecosystem: 'EVM' });
    await expect(recipients().create(accountId, { label: 'One too many', address: SOL, ecosystem: 'SOLANA' })).rejects.toThrow('RECIPIENT_LIMIT');
    expect(await recipients().create(accountId, { label: 'Again', address: evmN(1), ecosystem: 'EVM' })).toMatchObject({ created: false, recipient: { label: 'Recipient 1' } });
    expect(await recipients().list(accountId)).toHaveLength(SAVED_RECIPIENT_LIMITS.maxPerAccount);
    // Another account is not affected by this account's cap.
    const other = await accounts().signIn(bruno);
    expect((await recipients().create(other.accountId, { label: 'Recipient 1', address: SOL, ecosystem: 'SOLANA' })).created).toBe(true);
  });

  it('isolates accounts and tenants: another account\'s recipient id is not found, and the same address or name may be saved by each', async () => {
    const a = await accounts().signIn(ana), b = await accounts().signIn(bruno);
    const anas = await recipients().create(a.accountId, { label: 'Maria', address: EVM, ecosystem: 'EVM' });
    // Saving an address is not ownership: Bruno may save the same address under the same name.
    const brunos = await recipients().create(b.accountId, { label: 'Maria', address: EVM, ecosystem: 'EVM' });
    expect(brunos.created).toBe(true); expect(brunos.recipient.id).not.toBe(anas.recipient.id);
    expect(await recipients().list(b.accountId)).toEqual([brunos.recipient]);
    await expect(recipients().rename(b.accountId, anas.recipient.id, 'Mine now')).rejects.toThrow('RECIPIENT_NOT_FOUND');
    await expect(recipients().remove(b.accountId, anas.recipient.id)).rejects.toThrow('RECIPIENT_NOT_FOUND');
    // Another tenant sees nothing and cannot reach Ana's account or her recipient (same account id, other tenant).
    expect(await recipients('other-tenant').list(a.accountId)).toEqual([]);
    await expect(recipients('other-tenant').rename(a.accountId, anas.recipient.id, 'Mine now')).rejects.toThrow('RECIPIENT_NOT_FOUND');
    await expect(recipients('other-tenant').remove(a.accountId, anas.recipient.id)).rejects.toThrow('RECIPIENT_NOT_FOUND');
    await expect(recipients('other-tenant').create(a.accountId, { label: 'X', address: SOL_2, ecosystem: 'SOLANA' })).rejects.toThrow('ACCOUNT_NOT_FOUND');
    await expect(recipients().create('acct_' + '0'.repeat(32), { label: 'X', address: SOL_2, ecosystem: 'SOLANA' })).rejects.toThrow('ACCOUNT_NOT_FOUND');
    await expect(recipients().list('not-an-account')).rejects.toThrow('ACCOUNT_NOT_FOUND');
    expect(await recipients().list(a.accountId)).toEqual([anas.recipient]);
  });

  it('deleting the account deletes its saved recipients (foreign-key cascade), and only its own', async () => {
    const a = await accounts().signIn(ana), b = await accounts().signIn(bruno);
    await recipients().create(a.accountId, { label: 'Maria', address: EVM, ecosystem: 'EVM' });
    await recipients().create(a.accountId, { label: 'Minha Solana', address: SOL, ecosystem: 'SOLANA' });
    const kept = await recipients().create(b.accountId, { label: 'Maria', address: EVM, ecosystem: 'EVM' });
    await accounts().deleteAccount(a.accountId);
    expect((await t.db.query(`SELECT account_id FROM flofi_account_recipients`)).rows).toEqual([{ account_id: b.accountId }]);
    expect(await recipients().list(b.accountId)).toEqual([kept.recipient]);
  });
});

describe('Saved Recipients store without the certified 0028 (production until Release B)', () => {
  it('is unavailable on a v27 database and on a ledger whose 0028 is not the certified one; it never creates its table', async () => {
    // Exactly the v27 history (from Release B the harness default would apply the shipped 0028).
    const v27 = await createTestDatabase({ migrated: false });
    try {
      expect(await migrate(v27.db, (await loadMigrations()).slice(0, 27))).toHaveLength(27);
      const { accountId } = await createAccountStore(v27.db, 'default').signIn(ana);
      const store = createRecipientStore(v27.db, 'default');
      expect(await store.available()).toBe(false);
      await expect(store.list(accountId)).rejects.toThrow('RECIPIENTS_UNAVAILABLE');
      await expect(store.create(accountId, { label: 'Maria', address: EVM, ecosystem: 'EVM' })).rejects.toThrow('RECIPIENTS_UNAVAILABLE');
      await expect(store.rename(accountId, 'rcp_' + 'a'.repeat(26), 'Maria')).rejects.toThrow('RECIPIENTS_UNAVAILABLE');
      await expect(store.remove(accountId, 'rcp_' + 'a'.repeat(26))).rejects.toThrow('RECIPIENTS_UNAVAILABLE');
      // A different 0028 in the ledger (another checksum) does not make it available either (a fresh pool: the answer is cached per pool).
      await v27.db.query(`INSERT INTO schema_migrations (version, name, sha256) VALUES (28, 'saved_recipients', $1)`, ['f'.repeat(64)]);
      expect(await createRecipientStore(v27.open(1), 'default').available()).toBe(false);
      expect((await v27.db.query(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tablename = 'flofi_account_recipients'`)).rows).toEqual([{ n: 0 }]);
    } finally { await v27.drop(); }
  });
});
