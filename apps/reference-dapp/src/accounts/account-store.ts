// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-AUTH-WALLETS-001: durable FloFi accounts (PostgreSQL, migrations 0018 and, for Privy, 0019).
 *
 * Every statement is scoped by the deployment tenant and, after sign-in, by the verified account id: a guessed account,
 * session or wallet id from another account is never sufficient. Identities are unique per tenant and are never merged or moved
 * implicitly — linking an identity that already belongs to another account fails closed. The store holds no secret: only
 * identity subjects, session records and public wallet metadata (see the migration's CHECK constraints).
 */
import type { Database, Queryable } from '@defi-workflow-engine/cloud-runtime';
import { accountWalletId, ACCOUNT_ID, canonicalAddress, exportOf, isManagedProvider, LEGACY_MANAGED_PROVIDER, MANAGED_PROVIDER, MANAGED_PROVIDER_NAME, PRIVY_USER_ID,
  readAccountWallet, validProvider,
  walletLabel, type AccountIdentity, type AccountWallet, type IdentityKind, type ManagedLogin, type Onboarding, type SessionMethod, type WalletExport,
  type WalletOrigin } from './account-model.ts';
import { ACCOUNT_SESSION_TTL_SECONDS, newAccountId, newSessionId, type AccountSessionToken } from './account-session.ts';
import type { WalletEcosystem } from '../wallet/wallet-registry';

export type IdentityClaim = { readonly kind: IdentityKind; readonly subject: string; readonly label: string | null };
export type WalletOrganization = { readonly provider: 'turnkey'; readonly organization: string; readonly user: string; readonly login: ManagedLogin };
export type AccountRecord = { readonly accountId: string; readonly onboarding: Onboarding; readonly identities: readonly AccountIdentity[];
  readonly wallets: readonly AccountWallet[]; readonly organization: WalletOrganization | null; readonly createdAt: string };
export type NewWallet = { readonly ecosystem: WalletEcosystem; readonly address: string; readonly origin: WalletOrigin; readonly provider: string;
  readonly providerName: string; readonly providerResource: string | null; readonly label: string };

const KIND_SQL: Readonly<Record<IdentityKind, string>> = Object.freeze({ google: 'GOOGLE', apple: 'APPLE', email: 'EMAIL', eip155: 'EIP155', solana: 'SOLANA',
  privy: 'PRIVY' });
const KIND_OF: Readonly<Record<string, IdentityKind>> = Object.freeze({ GOOGLE: 'google', APPLE: 'apple', EMAIL: 'email', EIP155: 'eip155', SOLANA: 'solana',
  PRIVY: 'privy' });
const ORIGIN_SQL: Readonly<Record<WalletOrigin, string>> = Object.freeze({ generated: 'GENERATED', imported: 'IMPORTED', external: 'EXTERNAL' });
const EXPORT_SQL: Readonly<Record<WalletExport, string>> = Object.freeze({ none: 'NONE', 'recovery-phrase': 'RECOVERY_PHRASE', 'private-key': 'PRIVATE_KEY' });
const PROVIDER_RESOURCE = /^[A-Za-z0-9-]{8,64}$/, ORGANIZATION = /^[A-Za-z0-9-]{8,64}$/;
const EMAIL_CHALLENGE = /^[A-Za-z0-9-]{8,128}$/, BINDING = /^0[23][0-9a-f]{64}$/;
const SUBJECT: Readonly<Record<IdentityKind, RegExp>> = Object.freeze({
  google: /^[A-Za-z0-9._-]{1,255}$/, apple: /^[A-Za-z0-9._-]{1,255}$/, email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  eip155: /^0x[0-9a-f]{40}$/, solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, privy: PRIVY_USER_ID,
});
const fail = (code: string): never => { throw new Error(code); };
const iso = (value: unknown) => (value instanceof Date ? value : new Date(String(value))).toISOString();
export function validIdentity(claim: IdentityClaim): boolean {
  return SUBJECT[claim.kind]?.test(claim.subject) === true && (claim.kind !== 'email' || claim.subject === claim.subject.toLowerCase() && claim.subject.length <= 254)
    && (claim.label === null || (typeof claim.label === 'string' && claim.label.length >= 1 && claim.label.length <= 254));
}

type WalletRow = { ecosystem: string; address: string; origin: string; provider: string; provider_name: string; export: string; label: string; created_at: Date };
const EXPORT_FROM_SQL: Readonly<Record<string, WalletExport>> = Object.freeze({ NONE: 'none', RECOVERY_PHRASE: 'recovery-phrase', PRIVATE_KEY: 'private-key' });
function walletOf(row: WalletRow): AccountWallet | null {
  const ecosystem = row.ecosystem === 'EVM' ? 'evm' : 'solana', origin = (row.origin.toLowerCase()) as WalletOrigin;
  // The stored export capability must be exactly the one this origin and provider carry (readAccountWallet refuses anything else).
  return readAccountWallet({ id: accountWalletId(ecosystem, row.address), ecosystem, address: row.address, origin, provider: row.provider,
    providerName: row.provider_name, export: EXPORT_FROM_SQL[row.export] ?? 'invalid', label: row.label, addedAt: iso(row.created_at) });
}
/** What a verified Privy sign-in claims: the Privy user, plus the Google/Apple/email/external-wallet identities Privy verified for it. */
export type PrivySignIn = { readonly privyUser: string; readonly identities: readonly IdentityClaim[]; readonly method: SessionMethod };

export function createAccountStore(db: Database, tenantId: string) {
  async function sessionRow(tx: Queryable, accountId: string, method: SessionMethod, now: Date): Promise<AccountSessionToken> {
    const sessionId = newSessionId(), authenticatedAt = Math.floor(now.getTime() / 1000), expiresAt = authenticatedAt + ACCOUNT_SESSION_TTL_SECONDS;
    // Expired records are pruned on each sign-in (this account's at once; any account's after a 30-day grace), so dormant sessions
    // do not accumulate. Revoked ones remain until they expire.
    await tx.query('DELETE FROM flofi_account_sessions WHERE tenant_id=$1 AND account_id=$2 AND expires_at <= $3', [tenantId, accountId, now]);
    await tx.query("DELETE FROM flofi_account_sessions WHERE tenant_id=$1 AND expires_at <= $2::timestamptz - interval '30 days'", [tenantId, now]);
    await tx.query(`INSERT INTO flofi_account_sessions (tenant_id, session_id, account_id, method, authenticated_at, expires_at)
      VALUES ($1,$2,$3,$4,to_timestamp($5),to_timestamp($6))`, [tenantId, sessionId, accountId, KIND_SQL[method], authenticatedAt, expiresAt]);
    return { accountId, sessionId, method, authenticatedAt, expiresAt };
  }
  const store = {
    /**
     * Signs in with a verified identity: the account that already holds it, or a new account created for it. Returns a fresh
     * server-side session record. The identity must already be verified by the caller (OIDC token, provider OTP, wallet proof).
     */
    async signIn(identity: IdentityClaim, now = new Date()): Promise<AccountSessionToken & { readonly created: boolean }> {
      if (!validIdentity(identity) || identity.kind === 'privy') fail('ACCOUNT_IDENTITY_INVALID');
      const method = identity.kind as SessionMethod;
      return db.transaction(async tx => {
        const existing = (await tx.query<{ account_id: string }>(`UPDATE flofi_account_identities SET last_used_at=$4, label=COALESCE($5, label)
          WHERE tenant_id=$1 AND kind=$2 AND subject=$3 RETURNING account_id`, [tenantId, KIND_SQL[identity.kind], identity.subject, now, identity.label])).rows[0];
        if (existing) return { ...await sessionRow(tx, existing.account_id, method, now), created: false };
        const accountId = newAccountId();
        // One clock for every identity row (here and in linkIdentity): the identity an account was created with is always its oldest,
        // which is what FloFi Wallet treats as the account's primary identity (wallet-service.ts).
        await tx.query('INSERT INTO flofi_accounts (tenant_id, account_id, created_at, updated_at) VALUES ($1,$2,$3,$3)', [tenantId, accountId, now]);
        const inserted = await tx.query(`INSERT INTO flofi_account_identities (tenant_id, kind, subject, account_id, label, created_at, last_used_at) VALUES ($1,$2,$3,$4,$5,$6,$6)
          ON CONFLICT DO NOTHING RETURNING account_id`, [tenantId, KIND_SQL[identity.kind], identity.subject, accountId, identity.label, now]);
        // A concurrent first sign-in with the same identity won the race: retry as a returning sign-in (this transaction rolls back).
        if (!inserted.rowCount) fail('ACCOUNT_SIGN_IN_RACE');
        return { ...await sessionRow(tx, accountId, method, now), created: true };
      }).catch(async (error: unknown) => {
        if (error instanceof Error && error.message === 'ACCOUNT_SIGN_IN_RACE') return store.signIn(identity, now);
        throw error;
      });
    },
    /**
     * BUILD-FLOFI-PRIVY-UX-001: signs in with a verified Privy user. The account is, in order: the one already linked to this Privy user;
     * else the single existing account that holds any identity Privy verified for it (Google subject, verified email, external wallet:
     * same kind and subject only, never across kinds), which preserves every pre-Privy account; else a new account. Identities are never
     * merged or moved: two different accounts matching is refused (`ACCOUNT_IDENTITY_CONFLICT`), an account already linked to another
     * Privy user is refused (`ACCOUNT_PRIVY_USER_MISMATCH`), and a verified identity that another account holds is left with it.
     */
    async signInPrivy(input: PrivySignIn, now = new Date()): Promise<AccountSessionToken & { readonly created: boolean; readonly skipped: number }> {
      const privy: IdentityClaim = { kind: 'privy', subject: input.privyUser, label: null };
      const others = input.identities.filter(identity => identity.kind !== 'privy');
      if (!validIdentity(privy) || !others.every(validIdentity) || others.length > 32) fail('ACCOUNT_IDENTITY_INVALID');
      return db.transaction(async tx => {
        const holders = async (claims: readonly IdentityClaim[]) => claims.length ? (await tx.query<{ kind: string; subject: string; account_id: string }>(
          `SELECT kind, subject, account_id FROM flofi_account_identities WHERE tenant_id=$1 AND (kind, subject) IN (SELECT * FROM unnest($2::text[], $3::text[]))
           FOR UPDATE`, [tenantId, claims.map(claim => KIND_SQL[claim.kind]), claims.map(claim => claim.subject)])).rows : [];
        const linked = (await holders([privy]))[0]?.account_id ?? null;
        const matched = await holders(others);
        let accountId = linked, created = false;
        if (!accountId) {
          const accounts = [...new Set(matched.map(row => row.account_id))];
          if (accounts.length > 1) fail('ACCOUNT_IDENTITY_CONFLICT');
          accountId = accounts[0] ?? null;
          if (accountId) {
            // Serializes first Privy sign-ins that reach this account through different identities (two Privy users, one with the email,
            // one with the Google account): the second waits here and then sees the first one's Privy link, so it is refused, never added.
            await tx.query('SELECT 1 FROM flofi_accounts WHERE tenant_id=$1 AND account_id=$2 FOR UPDATE', [tenantId, accountId]);
            const other = (await tx.query<{ subject: string }>("SELECT subject FROM flofi_account_identities WHERE tenant_id=$1 AND account_id=$2 AND kind='PRIVY'",
              [tenantId, accountId])).rows[0];
            if (other && other.subject !== input.privyUser) fail('ACCOUNT_PRIVY_USER_MISMATCH');
          } else {
            accountId = newAccountId(); created = true;
            await tx.query('INSERT INTO flofi_accounts (tenant_id, account_id, created_at, updated_at) VALUES ($1,$2,$3,$3)', [tenantId, accountId, now]);
          }
          const inserted = await tx.query(`INSERT INTO flofi_account_identities (tenant_id, kind, subject, account_id, label, created_at, last_used_at)
            VALUES ($1,'PRIVY',$2,$3,NULL,$4,$4) ON CONFLICT DO NOTHING RETURNING account_id`, [tenantId, input.privyUser, accountId, now]);
          // A concurrent first sign-in of the same Privy user won the race: retry as a returning sign-in (this transaction rolls back).
          if (!inserted.rowCount) fail('ACCOUNT_SIGN_IN_RACE');
        }
        let skipped = 0;
        for (const claim of others) {
          const holder = matched.find(row => row.kind === KIND_SQL[claim.kind] && row.subject === claim.subject)?.account_id;
          if (holder && holder !== accountId) { skipped++; continue; }
          const row = (await tx.query<{ account_id: string }>(`INSERT INTO flofi_account_identities (tenant_id, kind, subject, account_id, label, created_at, last_used_at)
            VALUES ($1,$2,$3,$4,$5,$6,$6) ON CONFLICT (tenant_id, kind, subject) DO UPDATE SET last_used_at=EXCLUDED.last_used_at,
            label=COALESCE(EXCLUDED.label, flofi_account_identities.label) WHERE flofi_account_identities.account_id=EXCLUDED.account_id RETURNING account_id`,
          [tenantId, KIND_SQL[claim.kind], claim.subject, accountId, claim.label, now])).rows[0];
          if (!row) skipped++;
        }
        await tx.query("UPDATE flofi_account_identities SET last_used_at=$3 WHERE tenant_id=$1 AND kind='PRIVY' AND subject=$2", [tenantId, input.privyUser, now]);
        return { ...await sessionRow(tx, accountId!, input.method, now), created, skipped };
      }).catch(async (error: unknown) => {
        if (error instanceof Error && error.message === 'ACCOUNT_SIGN_IN_RACE') return store.signInPrivy(input, now);
        throw error;
      });
    },
    /** The Privy user linked to this account, or null (an account that has not signed in through Privy yet). */
    async privyUser(accountId: string): Promise<string | null> {
      return store.identitySubject(accountId, 'privy');
    },
    /** The session record behind a sealed cookie, when it still exists, belongs to that account, is unrevoked and unexpired. */
    async verifySession(token: AccountSessionToken, now = new Date()): Promise<boolean> {
      if (!ACCOUNT_ID.test(token.accountId)) return false;
      const { rows } = await db.query<{ ok: boolean }>(`SELECT true AS ok FROM flofi_account_sessions WHERE tenant_id=$1 AND session_id=$2 AND account_id=$3
        AND revoked_at IS NULL AND expires_at > $4 AND method=$5 AND authenticated_at = to_timestamp($6)`,
      [tenantId, token.sessionId, token.accountId, now, KIND_SQL[token.method], token.authenticatedAt]);
      return rows.length === 1;
    },
    async revokeSession(token: Pick<AccountSessionToken, 'accountId' | 'sessionId'>, now = new Date()): Promise<void> {
      await db.query('UPDATE flofi_account_sessions SET revoked_at=$4 WHERE tenant_id=$1 AND account_id=$2 AND session_id=$3 AND revoked_at IS NULL',
        [tenantId, token.accountId, token.sessionId, now]);
    },
    /**
     * Records one email code challenge, refusing when this address (or this deployment overall) asked for too many codes recently.
     * The code is never stored; the provider sends and verifies it.
     */
    async startEmailChallenge(input: { email: string; providerChallenge: string; browserBinding: string }, now = new Date()): Promise<string> {
      if (!EMAIL_CHALLENGE.test(input.providerChallenge) || !BINDING.test(input.browserBinding)) fail('EMAIL_CHALLENGE_INVALID');
      const challengeId = newSessionId();
      await db.query(`INSERT INTO flofi_account_email_challenges (tenant_id, challenge_id, email, provider_challenge, browser_binding, created_at, expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$6::timestamptz + interval '10 minutes')`, [tenantId, challengeId, input.email, input.providerChallenge, input.browserBinding, now]);
      return challengeId;
    },
    /** Whether another code may be sent: at most 5 per address per hour and 300 per deployment per 10 minutes. */
    async emailChallengeAllowed(email: string, now = new Date()): Promise<boolean> {
      await db.query("DELETE FROM flofi_account_email_challenges WHERE tenant_id=$1 AND created_at < $2::timestamptz - interval '1 day'", [tenantId, now]);
      const { rows } = await db.query<{ address: number; recent: number }>(`SELECT
          count(*) FILTER (WHERE email=$2 AND created_at > $3::timestamptz - interval '1 hour')::int AS address,
          count(*) FILTER (WHERE created_at > $3::timestamptz - interval '10 minutes')::int AS recent
        FROM flofi_account_email_challenges WHERE tenant_id=$1 AND created_at > $3::timestamptz - interval '1 hour'`, [tenantId, email, now]);
      return (rows[0]?.address ?? 0) < 5 && (rows[0]?.recent ?? 0) < 300;
    },
    /** Spends one of at most 5 verification attempts of a live challenge; null when it is unknown, used, expired or exhausted. */
    async attemptEmailChallenge(challengeId: string, now = new Date()): Promise<{ email: string; providerChallenge: string; browserBinding: string } | null> {
      if (!/^[0-9a-f]{32}$/.test(challengeId)) return null;
      const row = (await db.query<{ email: string; provider_challenge: string; browser_binding: string }>(`UPDATE flofi_account_email_challenges SET attempts=attempts+1
        WHERE tenant_id=$1 AND challenge_id=$2 AND consumed_at IS NULL AND expires_at > $3 AND attempts < 5 RETURNING email, provider_challenge, browser_binding`,
      [tenantId, challengeId, now])).rows[0];
      return row ? { email: row.email, providerChallenge: row.provider_challenge, browserBinding: row.browser_binding } : null;
    },
    async consumeEmailChallenge(challengeId: string, now = new Date()): Promise<void> {
      await db.query('UPDATE flofi_account_email_challenges SET consumed_at=$3 WHERE tenant_id=$1 AND challenge_id=$2 AND consumed_at IS NULL', [tenantId, challengeId, now]);
    },
    /** Marks a sign-in proof (an ID token digest) as used; false when it was already used. */
    async consumeProof(digest: string, expiresAt: Date, now = new Date()): Promise<boolean> {
      if (!/^[0-9a-f]{64}$/.test(digest)) fail('ACCOUNT_PROOF_INVALID');
      await db.query('DELETE FROM flofi_account_used_proofs WHERE tenant_id=$1 AND expires_at <= $2', [tenantId, now]);
      return (await db.query('INSERT INTO flofi_account_used_proofs (tenant_id, digest, expires_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [tenantId, digest, expiresAt > now ? expiresAt : new Date(now.getTime() + 60_000)])).rowCount === 1;
    },
    /** Releases a single-use proof again. Only for a claim whose use provably never happened (see `releaseAttempt`). */
    async releaseProof(digest: string): Promise<void> {
      if (!/^[0-9a-f]{64}$/.test(digest)) fail('ACCOUNT_PROOF_INVALID');
      await db.query('DELETE FROM flofi_account_used_proofs WHERE tenant_id=$1 AND digest=$2', [tenantId, digest]);
    },
    /**
     * Deletes the account and, through the foreign keys, its identities, sessions and saved wallet metadata. Wallets at the provider
     * and on-chain assets are untouched: FloFi cannot delete or move them.
     */
    async deleteAccount(accountId: string): Promise<void> {
      const deleted = await db.query('DELETE FROM flofi_accounts WHERE tenant_id=$1 AND account_id=$2', [tenantId, accountId]);
      if (!deleted.rowCount) fail('ACCOUNT_NOT_FOUND');
    },
    async revokeAllSessions(accountId: string, now = new Date()): Promise<number> {
      return (await db.query('UPDATE flofi_account_sessions SET revoked_at=$3 WHERE tenant_id=$1 AND account_id=$2 AND revoked_at IS NULL AND expires_at > $3',
        [tenantId, accountId, now])).rowCount;
    },
    /** Adds a verified identity to this account. An identity held by another account is never moved or merged. */
    async linkIdentity(accountId: string, identity: IdentityClaim, now = new Date()): Promise<void> {
      // A Privy user is linked only by `signInPrivy`, from a verified access token.
      if (!validIdentity(identity) || identity.kind === 'privy') fail('ACCOUNT_IDENTITY_INVALID');
      const holder = (await db.query<{ account_id: string }>(`INSERT INTO flofi_account_identities (tenant_id, kind, subject, account_id, label, created_at, last_used_at)
        SELECT $1,$2,$3,$4,$5,$6,$6 WHERE EXISTS (SELECT 1 FROM flofi_accounts WHERE tenant_id=$1 AND account_id=$4)
        ON CONFLICT (tenant_id, kind, subject) DO UPDATE SET last_used_at=EXCLUDED.last_used_at WHERE flofi_account_identities.account_id=EXCLUDED.account_id
        RETURNING account_id`, [tenantId, KIND_SQL[identity.kind], identity.subject, accountId, identity.label, now])).rows[0];
      if (!holder) fail('ACCOUNT_IDENTITY_LINKED_ELSEWHERE');
    },
    async account(accountId: string): Promise<AccountRecord | null> {
      const account = (await db.query<{ onboarding: string; wallet_provider: string | null; wallet_organization: string | null; wallet_user: string | null;
        wallet_login: string | null; created_at: Date }>('SELECT * FROM flofi_accounts WHERE tenant_id=$1 AND account_id=$2', [tenantId, accountId])).rows[0];
      if (!account) return null;
      const identities = (await db.query<{ kind: string; subject: string; label: string | null }>(`SELECT kind, subject, label FROM flofi_account_identities
        WHERE tenant_id=$1 AND account_id=$2 ORDER BY created_at, kind`, [tenantId, accountId])).rows
        .map(row => ({ kind: KIND_OF[row.kind]!, label: row.label ?? row.subject }));
      return { accountId, onboarding: account.onboarding.toLowerCase() as Onboarding, identities, wallets: await store.wallets(accountId), createdAt: iso(account.created_at),
        organization: account.wallet_provider === LEGACY_MANAGED_PROVIDER && account.wallet_organization && account.wallet_user && account.wallet_login
          ? { provider: 'turnkey', organization: account.wallet_organization, user: account.wallet_user, login: account.wallet_login.toLowerCase() as ManagedLogin } : null };
    },
    async identitySubject(accountId: string, kind: IdentityKind): Promise<string | null> {
      return (await db.query<{ subject: string }>('SELECT subject FROM flofi_account_identities WHERE tenant_id=$1 AND account_id=$2 AND kind=$3 ORDER BY created_at LIMIT 1',
        [tenantId, accountId, KIND_SQL[kind]])).rows[0]?.subject ?? null;
    },
    async setOnboarding(accountId: string, onboarding: Exclude<Onboarding, 'pending'>, now = new Date()): Promise<void> {
      const updated = await db.query(`UPDATE flofi_accounts SET onboarding=$3, updated_at=$4 WHERE tenant_id=$1 AND account_id=$2`,
        [tenantId, accountId, onboarding.toUpperCase(), now]);
      if (!updated.rowCount) fail('ACCOUNT_NOT_FOUND');
    },
    /** Records the person's provider organization once. An existing, different organization is never replaced. */
    async setWalletOrganization(accountId: string, organization: WalletOrganization, now = new Date()): Promise<WalletOrganization> {
      if (!ORGANIZATION.test(organization.organization) || !ORGANIZATION.test(organization.user)) fail('ACCOUNT_WALLET_ORGANIZATION_INVALID');
      await db.query(`UPDATE flofi_accounts SET wallet_provider='turnkey', wallet_organization=$3, wallet_user=$4, wallet_login=$5, updated_at=$6
        WHERE tenant_id=$1 AND account_id=$2 AND wallet_organization IS NULL`,
      [tenantId, accountId, organization.organization, organization.user, organization.login.toUpperCase(), now]);
      const current = (await store.account(accountId))?.organization;
      if (!current || current.organization !== organization.organization || current.user !== organization.user) return fail('ACCOUNT_WALLET_ORGANIZATION_CONFLICT');
      return current;
    },
    /** The account that holds a wallet address in this tenant, or null. */
    async walletHolder(ecosystem: WalletEcosystem, address: string): Promise<string | null> {
      return (await db.query<{ account_id: string }>('SELECT account_id FROM flofi_account_wallets WHERE tenant_id=$1 AND ecosystem=$2 AND address=$3',
        [tenantId, ecosystem === 'evm' ? 'EVM' : 'SOLANA', address])).rows[0]?.account_id ?? null;
    },
    async wallets(accountId: string): Promise<AccountWallet[]> {
      const { rows } = await db.query<WalletRow>(`SELECT ecosystem, address, origin, provider, provider_name, export, label, created_at FROM flofi_account_wallets
        WHERE tenant_id=$1 AND account_id=$2 ORDER BY created_at, ecosystem, address`, [tenantId, accountId]);
      return rows.map(walletOf).filter((wallet): wallet is AccountWallet => wallet !== null);
    },
    /** The provider resource of one of this account's managed wallets (for export), or null. */
    async managedResource(accountId: string, ecosystem: WalletEcosystem, address: string): Promise<{ origin: WalletOrigin; resource: string } | null> {
      const row = (await db.query<{ origin: string; provider_resource: string | null }>(`SELECT origin, provider_resource FROM flofi_account_wallets
        WHERE tenant_id=$1 AND account_id=$2 AND ecosystem=$3 AND address=$4 AND origin <> 'EXTERNAL'`,
      [tenantId, accountId, ecosystem === 'evm' ? 'EVM' : 'SOLANA', address])).rows[0];
      return row?.provider_resource ? { origin: row.origin.toLowerCase() as WalletOrigin, resource: row.provider_resource } : null;
    },
    /**
     * Saves one wallet's public metadata. The caller has already verified ownership (provider organization or a fresh wallet proof).
     * The same wallet saved again by the same account is idempotent; a wallet held by another account fails closed.
     */
    async saveWallet(accountId: string, wallet: NewWallet, now = new Date()): Promise<AccountWallet> {
      const address = canonicalAddress(wallet.ecosystem, wallet.address), label = walletLabel(wallet.label), providerName = walletLabel(wallet.providerName);
      if (!address || !label || !providerName || !validProvider(wallet.provider)) fail('ACCOUNT_WALLET_INVALID');
      const managed = wallet.origin !== 'external';
      // External wallets carry no resource; a legacy Turnkey wallet always has one; a Privy wallet id is optional public metadata.
      if (managed !== isManagedProvider(wallet.provider) || (!managed && wallet.providerResource !== null)
        || (wallet.provider === LEGACY_MANAGED_PROVIDER && wallet.providerResource === null)
        || (wallet.providerResource !== null && !PROVIDER_RESOURCE.test(wallet.providerResource))) fail('ACCOUNT_WALLET_INVALID');
      const row = (await db.query<WalletRow & { account_id: string }>(`INSERT INTO flofi_account_wallets (tenant_id, ecosystem, address, account_id, origin, provider, provider_name,
          provider_resource, export, label, created_at, updated_at)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11 WHERE EXISTS (SELECT 1 FROM flofi_accounts WHERE tenant_id=$1 AND account_id=$4)
        ON CONFLICT (tenant_id, ecosystem, address) DO UPDATE SET updated_at=EXCLUDED.updated_at WHERE flofi_account_wallets.account_id=EXCLUDED.account_id
        RETURNING *`, [tenantId, wallet.ecosystem === 'evm' ? 'EVM' : 'SOLANA', address, accountId, ORIGIN_SQL[wallet.origin], wallet.provider, providerName,
        wallet.providerResource, EXPORT_SQL[exportOf(wallet.origin, wallet.provider)], label, now])).rows[0];
      if (!row) fail('ACCOUNT_WALLET_LINKED_ELSEWHERE');
      return walletOf(row!) ?? fail('ACCOUNT_WALLET_INVALID');
    },
    /**
     * BUILD-FLOFI-PRIVY-UX-001, the person's own legacy migration: the key of a legacy FloFi Wallet (Turnkey) was exported and imported into
     * this account's Privy user, which now lists the same address as an imported embedded wallet. The record keeps its address and name and
     * becomes that Privy wallet (signable through Privy; exported from Privy). Only a legacy record of this same account changes; nothing else
     * is replaced, and nothing at Turnkey or on-chain changes.
     */
    async adoptLegacyWallet(accountId: string, ecosystem: WalletEcosystem, address: string, privyWalletId: string | null, now = new Date()): Promise<AccountWallet | null> {
      if (privyWalletId !== null && !PROVIDER_RESOURCE.test(privyWalletId)) fail('ACCOUNT_WALLET_INVALID');
      const row = (await db.query<WalletRow>(`UPDATE flofi_account_wallets SET origin=$5, provider=$6, provider_name=$7, provider_resource=$8, export=$9, updated_at=$10
          WHERE tenant_id=$1 AND account_id=$2 AND ecosystem=$3 AND address=$4 AND provider=$11 RETURNING *`,
        [tenantId, accountId, ecosystem === 'evm' ? 'EVM' : 'SOLANA', address, ORIGIN_SQL.imported, MANAGED_PROVIDER, MANAGED_PROVIDER_NAME, privyWalletId,
          EXPORT_SQL[exportOf('imported', MANAGED_PROVIDER)], now, LEGACY_MANAGED_PROVIDER])).rows[0];
      return row ? walletOf(row) : null;
    },
    async renameWallet(accountId: string, ecosystem: WalletEcosystem, address: string, label: unknown, now = new Date()): Promise<void> {
      const next = walletLabel(label);
      if (!next) fail('ACCOUNT_WALLET_LABEL_INVALID');
      const updated = await db.query(`UPDATE flofi_account_wallets SET label=$5, updated_at=$6 WHERE tenant_id=$1 AND account_id=$2 AND ecosystem=$3 AND address=$4`,
        [tenantId, accountId, ecosystem === 'evm' ? 'EVM' : 'SOLANA', address, next, now]);
      if (!updated.rowCount) fail('ACCOUNT_WALLET_NOT_FOUND');
    },
    /**
     * Removes FloFi's association with a wallet. Nothing on-chain or at the provider changes. A wallet that is also a sign-in identity
     * of this account stops being one too, unless it is the account's only way to sign in.
     */
    async removeWallet(accountId: string, ecosystem: WalletEcosystem, address: string): Promise<void> {
      await db.transaction(async tx => {
        // BUILD-FLOFI-PRIVY-UX-001: a wallet FloFi's provider keeps for this person (Privy, or a legacy FloFi Wallet that stays exportable)
        // is never removed: a Privy wallet belongs to the account's Privy user and would come back at the next sync, and a legacy record is
        // the person's only way to export it. Only external wallets can be removed.
        const held = await tx.query<{ provider: string }>(`SELECT provider FROM flofi_account_wallets WHERE tenant_id=$1 AND account_id=$2 AND ecosystem=$3
          AND address=$4 FOR UPDATE`, [tenantId, accountId, ecosystem === 'evm' ? 'EVM' : 'SOLANA', address]);
        if (!held.rows[0]) fail('ACCOUNT_WALLET_NOT_FOUND');
        if (isManagedProvider(held.rows[0]!.provider)) fail('ACCOUNT_WALLET_MANAGED_KEPT');
        const removed = await tx.query('DELETE FROM flofi_account_wallets WHERE tenant_id=$1 AND account_id=$2 AND ecosystem=$3 AND address=$4',
          [tenantId, accountId, ecosystem === 'evm' ? 'EVM' : 'SOLANA', address]);
        if (!removed.rowCount) fail('ACCOUNT_WALLET_NOT_FOUND');
        await tx.query(`DELETE FROM flofi_account_identities WHERE tenant_id=$1 AND account_id=$2 AND kind=$3 AND subject=$4
          AND (SELECT count(*) FROM flofi_account_identities WHERE tenant_id=$1 AND account_id=$2) > 1`,
        [tenantId, accountId, ecosystem === 'evm' ? 'EIP155' : 'SOLANA', address]);
      });
    },
  };
  return store;
}
export type AccountStore = ReturnType<typeof createAccountStore>;
