# FloFi: release of BUILD-FLOFI-PRIVY-UX-001 (Privy, migration 0019)

Status: preparation only. Nothing here was run against a production or shared database, and no production configuration was changed.
The owner separately authorizes every deployment, migration and configuration change below; this document authorizes none of them.

## Identities

| | Version | Name | SHA-256 |
| --- | --- | --- | --- |
| Base (current `main`) | 18 | `flofi_accounts` | `0919a57a5af80a1376ada213bb00ac5db79c434ab7a9ff0ebea50e6a9664ae75` |
| This PR | 19 | `privy_accounts` | `aea36e602ba918a195d4bd110fda3b29459816fb76c25e0ddfdd29099847cab6` |

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
     server-side; owners export in FloFi Wallet and may import the key into Privy (Add wallets → Import key), which turns that same record
     into their Privy wallet.

   **Recorded (owner-verified on the production database, 2026-11-01):**

   | Check | Result |
   | --- | --- |
   | Current schema | **18** |
   | Turnkey wallets (`flofi_account_wallets.provider = 'turnkey'`) | **0** |
   | Turnkey organizations (`flofi_accounts.wallet_provider = 'turnkey'`) | **0** |

   So no person holds a FloFi Wallet (Turnkey) wallet: the legacy export path is not needed in production and its settings
   (`FLOFI_TURNKEY_*`, `FLOFI_WALLET_ORIGIN`) can stay unconfigured; removing the legacy code and the `@turnkey/*` dependencies is a later,
   separate change. The counts were run by the owner, not from this engineering session, which never had production database access.
3. All CircleCI contexts green on the exact final commit, including the dependency audit and both browser jobs.
4. Privy app provisioned by the owner (production and a separate preview app): allowed origins (production: `https://flofi.xyz` only),
   login methods, embedded wallets without automatic creation, Google configured, MFA or re-authentication for export recommended;
   `NEXT_PUBLIC_PRIVY_APP_ID`, `PRIVY_APP_SECRET` (secret) and optionally `PRIVY_VERIFICATION_KEY` set on Vercel (Preview first). If Privy's
   bot protection is on, `FLOFI_PRIVY_BOT_PROTECTION` names it (`turnstile` or `hcaptcha`), otherwise its loader is blocked by the CSP.
   Card entry: the card origin `https://cards.flofi.xyz` added to the Vercel project (DNS + domain) and `FLOFI_CARD_ORIGIN` set; without it
   Add card stays unavailable (Mercado Pago's SDK never runs on `flofi.xyz`, which hosts the Privy signer). See [ENVIRONMENT.md §5j](./ENVIRONMENT.md#5j-flofi-accounts-and-wallets--privy-build-flofi-privy-ux-001-login-onboardingwallets-credentials--my-wallets).
5. Live verification on a Preview with its own Privy app and a dedicated empty database, following
   [LIVE-VERIFICATION-PRIVY.md](./LIVE-VERIFICATION-PRIVY.md). Signing on mainnet moves real funds: a trivial amount, on the owner's explicit
   decision only.

## Release A: certificate only (no migration)

Prepared as FloFi-xyz/FloFi#147 (`release/schema-0019-compat`, from `main`), exactly the three items below plus a PostgreSQL test of the
version-18 account store on schema 19.

Build from the commit production runs today (version 18), adding only:

1. In `packages/cloud-runtime/src/migrations.ts`, the certificate entry exactly as on this branch:

   ```ts
   { base: { version: 18, name: 'flofi_accounts', sha256: '0919a57a5af80a1376ada213bb00ac5db79c434ab7a9ff0ebea50e6a9664ae75' },
     migrations: [{ version: 19, name: 'privy_accounts', sha256: 'aea36e602ba918a195d4bd110fda3b29459816fb76c25e0ddfdd29099847cab6' }],
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
nothing is lost, but while it runs:
- Privy wallets are hidden (an old build lists, signs with and exports only Turnkey and external wallets): owners cannot see, use or export
  them in FloFi until version 19 is back (the keys stay with Privy; nothing on-chain changes);
- sign-in works only through version 18's own methods, so keep `FLOFI_GOOGLE_CLIENT_*`, `FLOFI_APPLE_CLIENT_ID` and the Turnkey email
  settings it uses configured until the rollback window closes (ENVIRONMENT.md §5j);
- a tab still open from version 19 that signed with Privy is refused at broadcast by version 18 and stays UNKNOWN until reconciled
  (fail closed; nothing is sent).
Do not reverse 0019 by dropping constraints or rows.
