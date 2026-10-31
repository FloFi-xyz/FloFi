# FloFi: release of BUILD-FLOFI-PRIVY-UX-001 (Privy, migration 0019)

Status: preparation only. Nothing here was run against a production or shared database, and no production configuration was changed.
The owner separately authorizes every deployment, migration and configuration change below; this document authorizes none of them.

## Identities

| | Version | Name | SHA-256 |
| --- | --- | --- | --- |
| Base (current `main`) | 18 | `flofi_accounts` | `0919a57a5af80a1376ada213bb00ac5db79c434ab7a9ff0ebea50e6a9664ae75` |
| This PR | 19 | `privy_accounts` | `f73a0944731486ce0853ec69d349f65bdf37b8ff81ec73b02e0221542eb01145` |

Assessment: [SCHEMA-COMPATIBILITY.md §13](./SCHEMA-COMPATIBILITY.md#13-certificate-0019_privy_accounts). 0019 only widens four CHECK
constraints of two 0018 tables (no table, column, row, function or trigger changes) and is atomic.

## Before authorization

1. Production's ledger is exactly versions 1–18 with the shipped SHA-256s (`SELECT version, name, sha256 FROM schema_migrations ORDER BY
   version`, read-only). If 0018 is not applied yet, finish [RELEASE-AUTH-WALLETS-0018.md](./RELEASE-AUTH-WALLETS-0018.md) first.
2. **Legacy check (read-only).** Run on the production database, as an operator, and record the counts in the release notes:

   ```sql
   SELECT count(*) AS turnkey_wallets, count(DISTINCT account_id) AS accounts FROM flofi_account_wallets WHERE provider = 'turnkey';
   SELECT count(*) AS turnkey_organizations FROM flofi_accounts WHERE wallet_provider = 'turnkey';
   ```

   - Both zero: no FloFi Wallet (Turnkey) wallet exists; the legacy export path can stay unconfigured (no `FLOFI_TURNKEY_*`,
     `FLOFI_WALLET_ORIGIN`), and a later change may delete the legacy code and the `@turnkey/*` dependencies.
   - Otherwise: keep the Turnkey settings and `wallet.flofi.xyz` configured until every listed owner has exported (My wallets shows those
     wallets as "Legacy FloFi Wallet", export-only, and their addresses never change). FloFi never moves their funds or exports their keys
     server-side; owners export in FloFi Wallet and may import the key into Privy (Add wallets → Import key).
3. All CircleCI contexts green on the exact final commit, including the dependency audit and both browser jobs.
4. Privy app provisioned by the owner (production and a separate preview app): allowed origins, login methods, embedded wallets without
   automatic creation, Google configured; `NEXT_PUBLIC_PRIVY_APP_ID`, `PRIVY_APP_SECRET` (secret) and optionally `PRIVY_VERIFICATION_KEY`
   set on Vercel (Preview first). See [ENVIRONMENT.md §5j](./ENVIRONMENT.md#5j-flofi-accounts-and-wallets--privy-build-flofi-privy-ux-001-login-onboardingwallets-credentials--my-wallets).
5. Live verification on a Preview with its own Privy app and a dedicated empty database, following
   [LIVE-VERIFICATION-PRIVY.md](./LIVE-VERIFICATION-PRIVY.md). Signing on mainnet moves real funds: a trivial amount, on the owner's explicit
   decision only.

## Release A: certificate only (no migration)

Build from the commit production runs today (version 18), adding only:

1. In `packages/cloud-runtime/src/migrations.ts`, the certificate entry exactly as on this branch:

   ```ts
   { base: { version: 18, name: 'flofi_accounts', sha256: '0919a57a5af80a1376ada213bb00ac5db79c434ab7a9ff0ebea50e6a9664ae75' },
     migrations: [{ version: 19, name: 'privy_accounts', sha256: 'f73a0944731486ce0853ec69d349f65bdf37b8ff81ec73b02e0221542eb01145' }],
     assessment: 'docs/deploy/SCHEMA-COMPATIBILITY.md#13-certificate-0019_privy_accounts' },
   ```

2. `packages/cloud-runtime/test/fixtures/0019_privy_accounts.sql` from this branch, byte for byte (`sha256sum` must print the value above).
3. `docs/deploy/SCHEMA-COMPATIBILITY.md` §13 from this branch.

Run the normal CI on Release A, then deploy it to **every** consumer of the production database (Railway API and worker, every embedded
backend/operator process, the Vercel Production artifact). Its `migrate` pre-deploy is a no-op on schema 18.

## Release B: this PR

1. **Railway API first.** Its pre-deploy applies 0019 once, inside one transaction under the migration advisory lock; a failure rolls back
   to 18 and the deployment stops. Verify the ledger (19 rows, the SHA-256 above) and `/readyz`.
2. Worker and other backends next, then **Vercel Production** last.
3. What goes live once the Privy variables are set: `/login` signs in through Privy (Google, email code, Web3 wallet); Add your wallets
   creates and imports Privy wallets; FloFi wallets sign through Privy with Privy's confirmation after FloFi's Review; Disconnect lands on
   `https://flofi.xyz/login`. Without the Privy variables, `/login` says sign-in is not configured and `/app` keeps working without an account.
4. Existing accounts keep their identities, sessions (until they expire) and wallet records. Their next Privy sign-in with the same Google
   account, verified email or wallet reaches the same account (account-store.ts `signInPrivy`); a sign-in matching two accounts is refused,
   never merged.

## Rollback

A version-18 build carrying the Release A certificate runs on schema 19, including rows written by version 19 (SCHEMA-COMPATIBILITY.md §13):
Privy wallets are not shown or signed with by an old build, and nothing is lost. Do not reverse 0019 by dropping constraints or rows.
