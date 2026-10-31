# BUILD-FLOFI-AUTH-WALLETS-001 — Authentication, wallet onboarding and secure credentials

Status: implemented on a review branch, **not merged, not deployed**. Live Google, Apple and Turnkey integrations are
**unverified** in this build (no vendor credentials or network access to those services were available); every flow is
implemented against the providers' published interfaces and exercised end to end against MOCKED loopback stand-ins only.

Journey delivered: **Landing → Sign in → Wallet onboarding → Build 0 (`/app`)**, plus **Credentials → My wallets** and a
protected **Export wallet** flow.

> Branch note: the build prompt names `FloFi-xyz/FloFi` and `claude/build-auth-wallets-001`. This session's repository is
> `alrimarleskovar/FloFi` and its designated branch is `claude/wonderful-shannon-nacbbz`; the work is delivered there.

## 1. Inputs reviewed

- Repository rules: `CLAUDE.md`, `AGENTS.md`, `docs/SCOPE_GUARD.md`, `apps/reference-dapp/AGENTS.md`.
  `python3 scripts/agent_guard.py check` → PASS; `impact --base origin/main` → no affected modules before the change.
- Existing modules: `server/wallet-session.ts`, `server/session-principal.ts`, `server/run-ownership.ts`, `app/wallet-session-action.ts`,
  `domain/credentials.ts`, `state/credentials-store.ts`, `wallet/wallet-registry.ts`, `state/wallet-connection.ts`,
  `components/secondary-product-workspace.tsx`, `components/wallet-proof.tsx`, the landing (`components/marketing/*`), the product
  layout, `next.config.ts` (global `connect-src 'self'` CSP), platform state (PostgreSQL migrations, `platformStateHost`).
- Design references: the four owner screenshots (two-column sign-in, account + wallet introduction, create/import, export modal) and
  the brand packages (tokens and logo, "a gota" applications, dark screens, Caio's Create screen). The packages were unzipped into the
  session scratchpad and **read as data only**; none of their scripts was executed. Tokens used: light `#F7F9FC/#FFFFFF/#041B3D/#4B5B73`,
  graphite dark `#0B0D12/#15181F/#1C2029/#2A2F3A/#F4F5F7/#A4ABB8`, luminous blue `#2343D9` (link `#93A6FF` in dark), Outfit + IBM Plex
  Mono, the droplet mascot. No HeyAnon mark, copy, TON, Telegram login or Passkey login appears.

## 2. Provider decision

### 2.1 Evidence

Vendor documentation hosts (`docs.privy.io`, `docs.turnkey.com`, `auth.privy.io`, `api.turnkey.com`) were **not reachable** from this
session. Capabilities were therefore verified from the vendors' **published npm packages** (exact versions, manifests and TypeScript
declarations), and dependency impact by resolving them under this repository's real policies in a scratch worktree.

| | Privy `@privy-io/react-auth@3.51.0` | Turnkey `@turnkey/iframe-stamper@2.11.1` + `@turnkey/indexed-db-stamper@1.3.12` |
| --- | --- | --- |
| License | Apache-2.0 | Apache-2.0 (deps MIT) |
| Lockfile impact | **+709 packages** (WalletConnect/Reown, wagmi, x402, MetaMask SDK, Coinbase SDK, Stripe, styled-components…) | **+8 packages** (iframe stamper has **zero** dependencies) |
| `pnpm audit --audit-level low` (repo CI gate) | **4 high + 3 moderate** new advisories (WalletConnect tree) | no new advisory |
| `strictPeerDependencies` | **fails** (viem, React 19 vs `use-sync-external-store@1.2.0`, `@stripe/stripe-js`, `@tanstack/react-query`) | passes |
| Native build scripts | requires approving `bufferutil`, `keccak`, `utf-8-validate`, `@reown/appkit` | none |
| EVM + Solana embedded wallets | yes | yes (HD wallets, `ADDRESS_FORMAT_ETHEREUM` / `ADDRESS_FORMAT_SOLANA`) |
| Import | `importWallet({ privateKey })`, `importSeedPhrase({ mnemonic })`: **the app collects the raw secret in its own JS** | `INIT_IMPORT_PRIVATE_KEY` → key typed into the provider's **own iframe** (`import.turnkey.com`), encrypted to the enclave; the page only relays ciphertext |
| Export | provider modal on a separate origin (good) | `EXPORT_WALLET` / `EXPORT_WALLET_ACCOUNT` / `EXPORT_PRIVATE_KEY` encrypted to the **export iframe's** key; shown only inside `export.turnkey.com` |
| Recovery phrase export | yes for HD wallets | yes for HD wallets; imported keys export as private key only |
| Social / email sign-in | built in | email OTP built in; OIDC tokens accepted (`OAUTH_LOGIN`) — Google/Apple OAuth is run by FloFi |
| Server verification without SDK | ES256 token + verification key | parent API stamp (ECDSA P-256), mirrored with `node:crypto` exactly as Turnkey's own `nodecrypto` stamper |

Also considered: Dynamic (`@dynamic-labs/sdk-react-core@5.14.0`, 29 direct dependencies including MPC wallet clients), Web3Auth
(`@web3auth/modal@11.4.3`, no license field in its manifest, wide peer set). Neither offered an advantage that justified its footprint.

### 2.2 Decision

**Turnkey** as the embedded-wallet provider (non-custodial sub-organizations, isolated import and export iframes), with **FloFi as the
identity relying party**: Google and Apple through standard OpenID Connect verified by FloFi's server, email one-time codes delivered
and verified by Turnkey, Web3 Wallet sign-in through FloFi's existing EIP-4361 / Sign-In With Solana proofs.

Privy was rejected for this build because (a) it cannot meet the import constraint — its import APIs take the raw key or phrase from
application code — and (b) adding it would break three existing repository security gates (audit, strict peers, build-script
approval). Using Privy would require the owner to waive those gates and to accept FloFi-hosted raw-key input; neither was done.

**Pricing** could not be verified (vendor sites unreachable). The owner must confirm the Turnkey plan for sub-organizations, wallet
creation, exports and email OTP volume before enabling it in production.

## 3. Architecture

```
Browser                                   FloFi server (Next.js)                          Providers
───────                                   ─────────────────────                           ─────────
/login ── Google/Apple ─► startSocialSignIn ── sealed OIDC flow cookie ──► accounts.google.com / appleid.apple.com
          (nonce = sha256(session key))   /auth/callback/{google,apple}: verify ID token (JWKS, iss, aud, exp, iat, nonce)
       ── Email ─────────► startEmailSignIn ── INIT_OTP (parent stamp) ───────────────► Turnkey (sends the email)
                           completeEmailSignIn ─ VERIFY_OTP (bound to session key) ──► Turnkey
       ── Web3 Wallet ──► existing SIWE/SIWS proof (fresh ≤ 10 min) → walletAccountSignIn
                          ▼
                     account store (PostgreSQL 0018) → sealed HttpOnly account cookie + server session record
                          ▼ (Google/Apple/Email only)
                     provider organization: find or create sub-org (person = only root user) → OAUTH_LOGIN / OTP_LOGIN
                     for the browser's own session key (non-extractable WebCrypto key in IndexedDB)
/onboarding/wallets
   create ─ stamped by session key ─► /api/account/provider/* relay (session, allowlist, org pin) ─► Turnkey CREATE_WALLET
   import ─ key typed in import.turnkey.com iframe → ciphertext ─► relay ─► INIT_IMPORT / IMPORT_PRIVATE_KEY
   Save   ─► saveManagedWallets(ids) ─ server asks Turnkey (parent read) that each address is in this person's org ─► store
Credentials → My wallets → Export
   authorizeWalletExport (fresh sign-in, owned managed wallet, supported kind)
   export iframe key ─► relay (fresh sign-in + ownership re-checked) ─► EXPORT_* encrypted to the iframe ─► shown only in export.turnkey.com
```

New modules (`apps/reference-dapp/src/accounts/`): `account-model.ts` (shared strict model), `account-session.ts` (sealed cookies),
`account-store.ts` (PostgreSQL, tenant/account isolation), `oidc.ts` (relying party), `turnkey-server.ts` (parent-key client),
`account-service.ts` (orchestration), `account-host.ts` (request context), `oidc-callback.ts`, `provider-relay.ts`,
`turnkey-browser.ts` (browser provider client), `account-theme.ts`. Server actions: `app/account-action.ts`. Routes: `/login`,
`/onboarding`, `/onboarding/wallets`, `/auth/callback/google`, `/auth/callback/apple`, `/api/account/provider/[...path]`.
UI: `components/account/*`. Credentials gains **My wallets**; the Settings menu gains Sign in / My account / Sign out (only on
deployments with accounts); landing and docs "Launch" links go to `/login`.

## 4. Identity model

- One canonical account per person: `acct_<128-bit hex>`. Identities: `GOOGLE`/`APPLE` (OIDC `sub`), `EMAIL` (provider-verified, lower
  case), `EIP155` / `SOLANA` (proven address). Primary key `(tenant, kind, subject)`: **an identity belongs to at most one account**.
- First sign-in with an unknown identity creates an account; a known identity signs into its account. Concurrent first sign-ins
  converge on one account (tested).
- Linking (explicit, signed-in, **sign-in from the last 10 minutes**): an identity already held by another account fails closed with
  `ACCOUNT_IDENTITY_LINKED_ELSEWHERE` — **nothing is ever merged or moved**. Linking a wallet requires a fresh wallet signature.
- **Run access is unchanged.** Workflow runs, approvals, history and `/approve` still use the wallet session and
  `assertRunOwnership`. An account session is never consulted for run ownership, so a Google sign-in cannot reach any wallet's
  execution history. MCP OAuth accounts (`/connections`), channels and universal signing links are untouched.

## 5. Sessions

- `flofi_account_session`: HttpOnly, `SameSite=Lax`, `Secure` on HTTPS, host-bound, HMAC-sealed with a key derived (HKDF, own label)
  from the existing session secret. 12-hour lifetime.
- **Server-side verification on every request**: the sealed claims must match an unrevoked, unexpired `flofi_account_sessions` row
  (account, method and sign-in time). Sign-out revokes the row; "sign out everywhere" exists in the store. A tampered, expired,
  revoked, foreign-host or foreign-tenant cookie is rejected (unit, PostgreSQL and browser tests).
- Sensitive actions (export, linking) require a sign-in from the last 10 minutes; the UI offers "Sign in again".
- Flow cookies (OIDC state/nonce/PKCE verifier; email OTP id) are sealed, single-use and expire in 10 minutes. They never hold an
  OTP code, OIDC token or key. The Apple flow cookie is `SameSite=None; Secure` because Apple returns with a cross-site form POST.
- The existing wallet sessions keep their own cookies, lifetimes and meaning.

## 6. Sign-in methods

| Method | Mechanism | Server-side verification |
| --- | --- | --- |
| Google | authorization code + PKCE (S256), `prompt=select_account` | code exchanged server-to-server with the client secret; ID token RS256 against Google JWKS; `iss`, `aud`, `azp`, `exp`, `iat` (≤ 15 min, ±2 min skew), `nonce` |
| Apple | `code id_token`, `response_mode=form_post`, scope `email` | ID token RS256 against Apple JWKS; same claim checks; the code is not exchanged (no Apple signing key needed) |
| Email | Turnkey email OTP (`INIT_OTP_V2`, `VERIFY_OTP`, then `OTP_LOGIN`) | FloFi's authenticated call to Turnkey verifies the code; the verification token is bound to the browser's session key |
| Web3 Wallet | existing EIP-4361 (`personal_sign`) / Sign-In With Solana | existing signature verification; FloFi additionally requires the wallet session to be **≤ 10 minutes** old |

When a method is not configured the button is disabled and says so; nothing is simulated. Without `DATABASE_URL` the whole sign-in
screen states that accounts are unavailable and offers the builder without an account.

## 7. Managed wallets

- **Organization**: on the first Google/Apple/email sign-in (when Turnkey is configured) FloFi creates the person's Turnkey
  sub-organization with **one root user — the person** (their email or OIDC identity), quorum 1, **no FloFi API key, no
  authenticator, no policy, no delegated signer**. FloFi's parent key can create sub-organizations, start sign-ins and read public
  metadata; per Turnkey's model it is not a member of the sub-organization and cannot sign with or export its keys.
- **Provider session**: the OIDC `nonce` is `sha256(session public key)` and the OTP verification is bound to the same key, so the
  provider session is opened only for the browser's own non-extractable key. FloFi's server never holds a key that can stamp for the
  person.
- **Create**: `CREATE_WALLET` (HD, 12 words) with one account — EVM `m/44'/60'/0'/0/0` or Solana `m/44'/501'/0'/0'`.
- **Import**: `INIT_IMPORT_PRIVATE_KEY` → the provider's import iframe → ciphertext → `IMPORT_PRIVATE_KEY` (hex for EVM, base58 for
  Solana). FloFi renders **no private-key input** (asserted in the browser test).
- **Save wallets** is disabled until at least one wallet was really created or imported; saving sends only `<ecosystem>:<address>`
  ids and the server stores a wallet only after the provider confirms it is in this person's organization
  (`ACCOUNT_WALLET_NOT_OWNED` otherwise). Stored fields: address, ecosystem, origin (generated/imported/external), provider name,
  the provider's non-secret resource id, export capability, label.
- **Same-origin relay**: FloFi keeps `connect-src 'self'`. The browser's stamped requests go to `/api/account/provider/*`, which
  requires the account session, allowlists exactly create/import/export/get-activity, pins the organization (and user for import),
  and for any export re-checks the 10-minute sign-in and wallet ownership. It forwards bytes verbatim (a changed byte breaks the
  stamp) and logs nothing. Signing, policy, delegation and session-signer activities are **not** relayed.
- **Export**: only for managed wallets. Generated HD wallets: *Copy private key* (`EXPORT_WALLET_ACCOUNT`) and *Copy recovery phrase*
  (`EXPORT_WALLET`); imported keys: *Copy private key* only — no phrase is ever derived. Explicit confirmation checkbox, recent sign-in,
  then the provider decrypts and shows the secret inside its own frame; FloFi never reads it, never writes the clipboard, and stores
  nothing. External wallets (MetaMask, Phantom, Solflare…) never show Export.
- **Removal** removes FloFi's association only; the copy says the wallet still exists at Turnkey and funds are unchanged.
- **Not in this build**: using a managed wallet to sign FloFi transactions. No managed-wallet signing adapter was added; Build,
  Simulate and Execute continue to use the connected browser wallet with the same review, Strategy Manifest and wallet signature.
  Managed wallets can be exported to a wallet app today. A signing adapter is a separate, security-reviewed build.

**Recovery model**: the FloFi account is recovered by signing in again with the same Google, Apple or email identity (the wallet list
is server-side and restores on any device). Managed wallets are unlocked by the identity that created their provider organization;
the screen explains this when another method is used. Loss of that identity means loss of access through FloFi; exporting the
recovery phrase is the person's independent backup. FloFi cannot recover keys.

## 8. Security boundaries and invariants

1. No private key, seed phrase, OTP code, OIDC token or export bundle is stored by FloFi (database CHECK constraints, strict readers
   that drop records with extra fields, browser test scanning storage and every account row).
2. No raw-key input in FloFi; import and export happen in the provider's frames on other origins.
3. A login session is identity only: no transaction, approval, permission, delegated signer, session signer or policy is created by
   sign-in, onboarding, saving, linking or export. The relay cannot reach signing activities.
4. Run ownership, Strategy Manifest acceptance, wallet signatures, execution, fees, quotes, recovery, reconciliation and evidence are
   unchanged (no file of those paths changed).
5. Tenant + account scoping on every statement; wallets and identities are unique per tenant; cross-account reads, saves, renames,
   removals and exports are refused (PostgreSQL and browser tests).
6. Test-only seams fail closed on hosted deployments: the loopback identity provider (`FLOFI_AUTH_E2E_IDP=MOCKED_LOOPBACK_ONLY`) and the
   loopback wallet provider (`FLOFI_TURNKEY_E2E=MOCKED_LOOPBACK_ONLY`) are refused when `VERCEL`/Railway/`FLOFI_DEPLOYMENT=hosted` is set
   and accept only `http://127.0.0.1|localhost` origins; otherwise only `https://*.turnkey.com` provider hosts are accepted.
7. Open-redirect protection: post-sign-in destinations are limited to `/app…` and `/onboarding…`.

Residual risks for owner review:
- FloFi's server sees the Google/Apple ID token and (with `VERIFY_OTP` v1) the six-digit code. Both are bound to the browser's session
  key for provider use. Turnkey's newer `INIT_OTP_V3`/`VERIFY_OTP_V2` encrypt the code to the enclave in the browser; adopting them
  needs `@turnkey/crypto` (HPKE) and is a recommended follow-up once live behaviour can be verified.
- The parent API private key is a high-value deployment secret (it can create organizations and initiate email OTPs to users). Store it
  only in the deployment secret manager; rotate on exposure.
- Activity versions (`INIT_OTP_V2`, `VERIFY_OTP`, `OTP_LOGIN`, `OAUTH_LOGIN`, `CREATE_SUB_ORGANIZATION_V8`) and result field names were
  taken from `@turnkey/http@6.7.0` declarations and are **unverified live**.

## 9. Database and migration impact

Migration `0018_flofi_accounts` (four new tables, nothing else). A forward-compatibility certificate (base 0017 → 0018) and its
assessment (`docs/deploy/SCHEMA-COMPATIBILITY.md#12-certificate-0018_flofi_accounts`) are included. Release order remains
certificate first: a reviewed certificate-bearing version-17 release, then the migration-bearing release. No production migration was
run.

## 10. Dependency and gate changes (owner review required)

- `apps/reference-dapp/package.json`: `@turnkey/iframe-stamper@2.11.1`, `@turnkey/indexed-db-stamper@1.3.12` (exact pins, both older
  than the 7-day release-age gate).
- `scripts/bootstrap-ci.py`: new exact direct pins (`BUILDAUTHWALLETS001_DIRECT_VERSIONS`), lock-importer check, registry count
  263 → 271 and the new lockfile baseline hash. `scripts/test_ci_optimization.py` and `.circleci/scripts/ci-sbom.sh` follow the count.
  `python3 scripts/bootstrap-ci.py --verify-dependencies` passes (271 entries, integrity, licenses, release age).
- Pre-existing, unrelated: `pnpm audit --audit-level low` already fails on `main` with one moderate advisory (GHSA-g3hv-75wg-m249,
  `minimatch` via `eslint`). This build adds no advisory and does not mask that one.

## 11. External setup checklist (nothing below was configured by this build)

1. `DATABASE_URL` (PostgreSQL platform state) and the certificate-first release of migration 0018.
2. `FLOFI_PUBLIC_ORIGIN` = the exact public origin (e.g. `https://flofi.xyz`); `FLOFI_SESSION_SECRET` (≥ 32 chars) or the existing
   `API_AUTH_TOKEN` derivation.
3. Google: OAuth 2.0 Web client; authorized redirect URI `https://<origin>/auth/callback/google`; consent screen (scopes `openid email`);
   set `FLOFI_GOOGLE_CLIENT_ID`, `FLOFI_GOOGLE_CLIENT_SECRET` (secret store).
4. Apple: Services ID with Sign in with Apple, domain verification for the origin, return URL `https://<origin>/auth/callback/apple`;
   set `FLOFI_APPLE_CLIENT_ID` (the Services ID). No Apple private key is needed.
5. Turnkey: parent organization; an API key pair (P-256) for the parent with the minimum permissions required to create
   sub-organizations, run email OTP / OTP login / OAuth login and read sub-organization wallets; email OTP enabled with FloFi branding;
   any OIDC issuer/audience allowlisting Turnkey requires for Google and Apple tokens. Set `FLOFI_TURNKEY_ORGANIZATION_ID`,
   `FLOFI_TURNKEY_API_PUBLIC_KEY`, `FLOFI_TURNKEY_API_PRIVATE_KEY` (secret store). Optional overrides must stay on `*.turnkey.com`.
6. Verify on a non-production Turnkey organization with disposable identities: sign-in (all three), create EVM + Solana, import with a
   disposable test key, export (phrase and key), session expiry, re-authentication, and that the parent key cannot export or sign.
7. Confirm pricing/limits with Turnkey; confirm privacy-policy text for Google/Apple/email data (email address and OIDC subject are stored).

## 12. Verified vs unverified

| Capability | Status |
| --- | --- |
| Account store, sessions, revocation, isolation, identity uniqueness | **Verified** (unit + real PostgreSQL 16 + browser) |
| OIDC verification logic (RS256/JWKS, claims, nonce, PKCE, state, form_post) | **Verified** against test keys and the loopback IdP |
| Web3 Wallet sign-in (real EIP-4361 signature by a disposable in-memory test wallet) | **Verified** in the browser on loopback |
| Turnkey request stamping (format equals the vendor's Node stamper; verified with `node:crypto`) | **Verified** offline |
| UI flows, routing, PT/EN, light/dark, desktop/mobile, reduced motion, keyboard basics | **Verified** in the browser on loopback |
| Live Google sign-in, live Apple sign-in | **Unverified** — needs client registration and a real browser round trip |
| Live Turnkey email OTP, sub-organization creation, OAuth/OTP login, create, import iframe, export iframe | **Unverified** — needs a Turnkey test organization; shapes from `@turnkey/http@6.7.0` declarations |
| Turnkey security properties (parent key cannot sign/export; session binding) | **Unverified** in this build — vendor model as documented in its SDK; must be confirmed with Turnkey |

## 13. Test evidence

See the PR description for the exact commands and results of this build's runs (unit, PostgreSQL, browser, typecheck, lint, build,
governance, agent guard, dependency verification). Browser screenshots are produced by `e2e/auth-wallets.spec.ts`
(`playwright.auth-wallets.config.ts`) into the Playwright output directory: sign-in desktop (dark/light), sign-in mobile (EN/PT),
wallet introduction, create/import, Credentials → My wallets, export modal (no secret; MOCKED provider frame) in dark and light.

## 14. Follow-ups

- Live verification on a Turnkey test organization and real Google/Apple clients (§11.6).
- `INIT_OTP_V3` / `VERIFY_OTP_V2` with browser-side HPKE.
- A reviewed managed-wallet signing adapter that keeps FloFi's explicit Review → Manifest → wallet confirmation path.
- Account-level "sign out everywhere" and identity management UI; discovery of provider wallets created but not saved.
- A page-specific CSP for `/login` and `/onboarding/*` (`frame-src` limited to the provider frame origins).
