# BUILD-FLOFI-PRIVY-UX-001 — Full Privy migration and end-user wallet UX

Owner decision: Privy permanently replaces Turnkey as FloFi's authentication and embedded-wallet provider, in this one build, for real
end users. Base: `main` at `d37b6168` (PRs #142, #143 and #144 merged). One branch, one PR. Production is unchanged until the owner releases it
([RELEASE-PRIVY-0019.md](../deploy/RELEASE-PRIVY-0019.md)).

## 1. What changed for people

| Before (BUILD-FLOFI-AUTH-WALLETS-001) | Now |
| --- | --- |
| FloFi-run Google/Apple OIDC and Turnkey email codes on `/login`; Web3 sign-in through FloFi's own SIWE | Google, email code and Web3 wallet, all through Privy (Apple once configured) |
| Wallets created or imported in "FloFi Wallet", a separate window on `wallet.flofi.xyz` that had to be unlocked again (email code or a second Google sign-in) | **Create wallet** creates a Privy embedded wallet in one click, in the session the person just signed in with; no second Google sign-in, no unlock screen, no pop-up |
| Import inside Turnkey's frame in FloFi Wallet | **Import key** opens a dedicated FloFi screen (Wallet name, Private key, Import wallet); the key passes through that page's code to Privy's frame and never reaches FloFi's servers (3.) |
| An informational "Your wallets open in FloFi Wallet" card on Add your wallets | Removed. EVM and Solana cards, each with Create wallet and Import key, addresses shown in their card, Continue once a wallet exists |
| Disconnect cleared the wallet connection only | Disconnect revokes the FloFi session, logs out of Privy, closes wallet connections and lands on `/login` (`https://flofi.xyz/login` in production); Back cannot restore signed-in pages |
| Signing in the FloFi Wallet pop-up | Signing with Privy's own confirmation screen, which now states FloFi's server summary of the reviewed attempt |

## 2. Architecture

```
Browser (flofi.xyz)                                   FloFi server                               Privy
 /login, /onboarding/wallets[/import/*]  ─ access token ─▶ privySignIn / savePrivyWallet ─ verify (SDK, ES256, JWKS) ─▶ api.privy.io
   useFloFiPrivy() ─ @privy-io/react-auth ─────────────────────────────────────────────── frame ─▶ auth.privy.io (keys)
 /app wallet providers (EIP-1193, Wallet Standard)
   send ─▶ floFiSigningGate (Review → attempt → claim) ─▶ Privy confirmation (showWalletUIs, FloFi summary) ─▶ signed bytes
        ─▶ floFiEvmBroadcast / the flow's own submit (re-checked, once) ─▶ reconcile
```

- `src/accounts/privy-server.ts`: the official `@privy-io/node` SDK verifies each access token (ES256, issuer `privy.io`, audience = app
  id, unexpired) and reads the user from Privy's API with the app secret. FloFi trusts only that answer: verified Google/Apple subjects, the
  verified email, external wallets proven by SIWE/SIWS, and embedded wallets (`wallet_client_type: privy`, `connector_type: embedded`).
- `src/accounts/privy-client.tsx`: `useFloFiPrivy()`, FloFi's one interface to Privy (sign in, embedded wallets, create, import, export,
  sign, log out), implemented with `@privy-io/react-auth` hooks. Configuration choices are security properties and are unit-tested:
  `createOnLogin: 'off'` (wallets only on an explicit click), `showWalletUIs: true` on every signature, WalletConnect off, no session
  signers/delegation, the four EVM mainnets (Base default, Ethereum, Arbitrum One, Robinhood Chain) and Solana mainnet. The interface
  type, its context and the error-code mapping live in `src/accounts/privy-context.tsx`, which imports no Privy SDK and no server action,
  so Authorize, Disconnect and the top bar depend only on that light module.
- `src/accounts/account-store.ts` `signInPrivy`: one transaction decides the account (§4).
- `src/wallet/flofi-privy-signer.ts`: what FloFi's EIP-1193 provider and Wallet Standard wallet ask when a Privy wallet must sign.
- The legacy FloFi Wallet origin remains for export of pre-Privy wallets only (§7).

## 3. Security properties

1. **Server-verified identity only.** Every sign-in and wallet save re-verifies a Privy access token server-side and reads the user from
   Privy's API; nothing the browser claims (address, method, identity) is trusted. Tokens are never stored or logged. A sign-in uses a token
   issued in the last 10 minutes, once (its digest is consumed): a copied or replayed token never opens another FloFi session. It must also
   come from a login the person completed at Privy in those 10 minutes (Privy's last verification of a sign-in method): a silently
   refreshed token of an older Privy session opens nothing (`PRIVY_SIGN_IN_STALE`), and a session's recent-sign-in time is that verification.
2. **No custody, no server signing.** FloFi's server holds the Privy app secret (API reads) and no authorization key, session signer or
   wallet key. Creating or importing a wallet authorizes nothing and delegates nothing.
3. **Private keys never reach FloFi's servers** — but an imported key does pass through FloFi's page. Privy's React SDK (3.51.0) offers
   no provider-hosted import input: `useImportWallet().importWallet({ privateKey })` takes the key as a string from the page, and the SDK
   posts it to Privy's frame on `auth.privy.io`. So the key is typed into FloFi's own import screen; the screen reads it once from an
   uncontrolled field (no React state, no `name`, no form action), clears the field and hands it straight to that call. Where the browser
   can mask a text field (`-webkit-text-security`) the field is a masked text field from the server render on (never first a password
   field), so the browser's password manager is not offered the key; elsewhere it is a password field with autocomplete off (live runbook
   step 5). Trade-off: unlike a password field, a masked text field can be copied, may be echoed by a screen reader, and on some mobile
   keyboards may feed suggestions (autocorrect, spell-check and writing-assistant extensions are turned off; runbook step 5). No server
   action, form submission, URL, log, analytics event or storage carries it; the browser suite proves no request to FloFi's origin, no
   browser storage and no database row contains it. Its exposure is FloFi's own page code only: the import screen is an account page under
   the signer pages' script policy (6.), with no workflow/Copilot/MCP code and no third-party script (not even the bot-check loader, which
   only `/login` may load); browser extensions with page access can still read it, as they can any page field. A key pasted into the Wallet name field
   is refused before anything is sent (`ACCOUNT_WALLET_LABEL_KEY_SHAPED`, also enforced by the server for every wallet name it writes). The
   UI says exactly this ("passes briefly through this page's code … never sent to FloFi's servers"). A provider-isolated input is the
   follow-up as soon as Privy offers one.
4. **Reviewed-attempt binding preserved.** A transaction reaches Privy only after `floFiSigningGate` resolved its `{flow, runId}` to the
   PREPARED/SUBMITTING attempt of one of the account's Privy wallets, carrying exactly these bytes, on a mainnet, and claimed its single
   signature. Privy then shows its confirmation; FloFi alone broadcasts after re-checking the signed bytes (`floFiEvmBroadcast`; Solana: the
   flow's own submit). Error contract unchanged: cancel = 4001 (nothing signed), refusal before Privy = 4100, anything after Privy = unknown
   and reconciled. Messages: only FloFi's own sign-in message for this host and wallet, exactly as the server writes it and unexpired
   (`floFiMessageGate`). Before the gate, the page must be able to sign with that very wallet (`canSign`: listed by Privy for this person and,
   for Solana, loaded); otherwise the request is refused before any claim (`FLOFI_WALLET_ACCOUNT_MISMATCH` / `FLOFI_WALLET_NOT_READY`). An
   EVM attempt is claimed only while its Review has at least 20 s left (`FLOFI_WALLET_REVIEW_EXPIRING`), the time to confirm in Privy.
5. **No merges, no takeovers** (§4), **no automatic reconnection** (§6).
6. **No untrusted script where the signer lives.** Privy's session and wallet frame trust the whole product origin and Privy's
   confirmation is drawn by the page, so any script running there could ask Privy to sign without FloFi's gate. The signer mounts only in
   a document that was loaded with the policy of the page it shows — account pages (`/login`, `/onboarding*`) and product pages (`/app*`,
   `/approve`, `/connections`, `/mcp/approve`, `/__engineering`) — and each is served by the proxy with a per-request nonce policy
   (src/accounts/account-csp.ts): `script-src 'self' 'nonce-…' 'unsafe-eval'` and no other host, no `'strict-dynamic'` (a script inserted
   at runtime must still come from FloFi), `script-src-attr 'none'`, `object-src`/`base-uri 'none'`, network only to FloFi and Privy.
   Privy's bot-check loader (`FLOFI_PRIVY_BOT_PROTECTION`) is allowed on `/login` only, never on the import screen or the product. The
   signer pages fall in three policy classes (`/login`, other account pages, product pages; src/accounts/signer-pages.ts): a page loaded
   directly renders Privy from the server render on (never remounted), and a client-side navigation into a signer page from a page of
   another class or without that policy (`/`, `/docs`, `/privacy`) reloads it once, so the signer never runs under another class's policy
   (`FloFiPrivyProvider`, `signerDocument`). Where the browser does not report how the document was loaded, Privy stays unmounted. No nonce is handed to Privy:
   Privy 3.51.0 has no such option, so what it loads must match the policy's hosts. Framing: `/approve`, `/connections` and
   `/app/credentials` are never framed; `/mcp/approve` keeps its MCP host allowlist; every other product page may be framed only by FloFi
   itself (`frame-ancestors 'self'`). `nosniff` everywhere, so no same-origin non-JavaScript response runs as a script. Third-party payment
   code never runs on the product origin: Mercado Pago's Secure Fields SDK moved to the card origin (`FLOFI_CARD_ORIGIN`,
   src/server/card-origin.ts), whose page refuses any other host and loads the SDK only when framed. Add card frames it sandboxed (scripts,
   own origin, forms and the provider's popups; no top navigation) and receives only the one-time token and the email by checked
   `postMessage`. `'unsafe-eval'` stays for the Ajv validators (it lets running FloFi code evaluate strings, loads nothing new).

## 4. Accounts: preserved, never merged

`signInPrivy` (PostgreSQL, one transaction, row locks on the matched identities):
1. The account already linked to this Privy user (identity kind `PRIVY`, subject = Privy DID), else
2. the single existing account holding any identity Privy verified for this user — **same kind and subject only** (Google `sub`, verified
   email, external wallet address), so every pre-Privy account is found again — else
3. a new account.

Refused, with nothing written: identities matching two accounts (`ACCOUNT_IDENTITY_CONFLICT`); an account already linked to another Privy
user (`ACCOUNT_PRIVY_USER_MISMATCH`). An identity another account holds stays with it. Embedded wallets are never sign-in identities.
Concurrent first sign-ins of one Privy user produce one account; concurrent first sign-ins of two Privy users reaching one existing account
through different identities are serialized on the account row, so the second is refused (`ACCOUNT_PRIVY_USER_MISMATCH`). Session methods stay within 0018's set (the most recently verified
method), so a version-18 build never sees a `PRIVY` session. Tests: `account-service.pg.test.ts` (15).

## 5. Wallets: one click, recoverable, never replaced

- Create: Privy `createWallet` (EVM / Solana) → `savePrivyWallet`: the server re-verifies the token, requires the token's user to be the
  account's own Privy user, and saves the address only if it is one of that user's embedded wallets (provider `privy`, the Privy wallet id
  as public metadata, export capability private key). The button is disabled while running; a wallet Privy already holds is saved instead of
  creating another; a 60 s ceiling shows "Check again" instead of spinning.
- Recovery: on Add your wallets and at every sign-in, `syncPrivyWallets` saves any embedded wallet the account does not list yet.
- Never replaced or moved: an address another account holds is refused (`ACCOUNT_WALLET_LINKED_ELSEWHERE`); an address this account already
  lists keeps its record, except the person's own legacy migration (§7).
- Kept: a Privy or legacy wallet is never removed from the account (My wallets offers Remove for external wallets only; the store refuses
  `ACCOUNT_WALLET_MANAGED_KEPT`), because a Privy wallet belongs to the account's Privy user and would come back at the next sync, and a
  legacy record is the only way to export it. An account's own FloFi wallet is never linked again as an external wallet or a sign-in
  identity (`ACCOUNT_WALLET_IS_FLOFI_WALLET`).

## 6. Disconnect and sign-out

`src/accounts/disconnect.ts` (Disconnect, Sign out, the drawer's Logout, wherever accounts exist): close the page's wallet connection and mark
it disconnected (no silent reconnect), `accountSignOut` first (server revokes this browser's session record, clears the account cookie and
the EIP-4361/SIWS wallet-session cookies), then Privy `logout()` (each browser step bounded to 4 s, so a stuck step never keeps the FloFi
session alive), then `location.replace(<FLOFI_PUBLIC_ORIGIN>/login)`. Account pages and Credentials send
`Cache-Control: no-store`, and a page restored from the back/forward cache reloads (`SessionGuard`). `/login` ends any Privy session it did
not just complete itself. Nothing about the account, wallets, keys, assets or history is deleted. On a deployment without accounts,
Disconnect keeps its wallet-only behaviour (there is no sign-in to return to).

## 7. Turnkey: retired for new work, legacy wallets preserved

- New accounts, sign-in, wallet creation/import and signing never use Turnkey. The product-origin OIDC callbacks (`/auth/callback/*`) and the
  Turnkey email sign-in were removed.
- Existing Turnkey records are unchanged (0019 only widens constraints). Legacy wallets are listed as "Legacy FloFi Wallet", export-only,
  with their addresses. FloFi Wallet (`wallet.flofi.xyz`) keeps unlock and export for accounts that already have a Turnkey organization; its
  relay forwards only export activities; it never creates an organization, saves or signs. Migration path for owners: export there, then
  Import key with Privy. When Privy then lists that same address as the person's imported wallet, that explicit import (never a background
  sync) turns the legacy record into the Privy wallet, same address and name, so it signs through Privy (`adoptLegacyWallet`). FloFi never
  exports a key server-side, moves funds or replaces an address.
- Production was not inspected in this session: the read-only SQL in RELEASE-PRIVY-0019.md decides whether the legacy path and the
  `@turnkey/*` dependencies can be removed later.

## 8. Dependencies (owner review)

- Direct, exact: `@privy-io/react-auth` 3.51.0, `@privy-io/node` 0.36.0 (Apache-2.0), `@solana/kit` 8.5.0, `@solana-program/memo`
  0.16.0, `@solana-program/system` 0.16.0, `@solana-program/token` 0.18.0 (Privy's Solana peers). Registry graph 295 → 505.
- **Removed from Privy's tree** (pnpm-workspace.yaml overrides; next.config.ts resolves their lazy imports to a module that refuses to run):
  - `@walletconnect/ethereum-provider`, `@walletconnect/universal-provider`: WalletConnect Community License (proprietary; requires the Reown
    network, notices, and a paid commercial licence above 500 MAU / 2.5M RPC per month). Also disabled in FloFi's Privy configuration;
    FloFi never offered WalletConnect.
  - `x402` (Privy's `useX402Fetch`, unused): it pulled wagmi connectors and the MetaMask SDK (ConsenSys non-commercial licence).
  - `@stripe/crypto` (card onramp, unused).
- `zod` 4.6.6 for `@privy-io/api-base@1.12.0` (GHSA-mrhx-c7xc-m3w5, high; no fixed 3.x exists), mirroring the MCP SDK's override; api-base
  builds one schema with APIs zod 4 keeps.
- Exact-identity licence exceptions: `@privy-io/api-base@1.12.0` (no licence field; ships Apache-2.0 text), `fast-sha256@1.3.0` (Unlicense),
  `lru-cache@11.5.3` (BlueOak-1.0.0). Release age: all 210 new packages ≥ 7 days, no waiver. No new install script. THIRD_PARTY_NOTICES.md
  updated. `scripts/bootstrap-ci.py --verify-dependencies`, `pnpm audit --audit-level low`, the SBOM validator, governance-lite and the CI
  unit tests pass.
- TypeScript: Privy's published declarations do not type-check under `skipLibCheck: false` (they reference packages they do not install),
  so the app sets `skipLibCheck: true` (FloFi's own code, including every call into Privy's types, stays fully checked), and the app's
  `typecheck` gives `tsc` a 4 GB heap (it needs ~2.4 GB with Privy's types).

## 9. Data: migration 0019 (additive)

Widens `flofi_account_identities` kind/subject checks (kind `PRIVY`, `did:privy:…`) and two `flofi_account_wallets` checks (provider `privy`,
private-key export, optional wallet id). No row, table or column changes; Turnkey rules unchanged. Certificate {18 → 19},
SCHEMA-COMPATIBILITY.md §13, `privy-accounts-migration.pg.test.ts` (3). Release order: certificate first (RELEASE-PRIVY-0019.md).

## 10. Evidence (MOCKED and offline unless stated)

| Gate | Result |
| --- | --- |
| `pnpm typecheck`, `pnpm lint`, `pnpm schemas:check` | pass |
| `pnpm test` (unit) | 498 files, 6079 tests pass (2 files skipped by their own environment conditions, unchanged by this build) |
| Accounts + migrations on PostgreSQL 16 (`src/accounts`, 0018/0019 migration tests) | 16 files, 119 tests pass |
| Browser `auth-wallets` (guarded runner, loopback Privy stand-in) | 13 / 13, twice in a row after the review fixes |
| Critical browser tier (guarded runner, 6 profiles incl. review-execute-recovery-components 39 tests) | pass |
| Dependency verification, audit, SBOM, governance-lite, CI unit tests | pass |

The browser suite's Privy stand-in (e2e/privy-emulator.ts, e2e/privy-emulator-client.js) issues real ES256 tokens that FloFi's server
verifies with the official SDK, serves Privy's user API, and signs with disposable keys; FloFi uses it only in loopback test mode
(`FLOFI_PRIVY_E2E=MOCKED_LOOPBACK_ONLY`, refused on hosted deployments) with a driver the test injects. FloFi itself contains no emulator.

## 11. Genuine provider limitations

1. **Live Privy is not proven here.** No Privy app id exists for this session and `docs.privy.io` / `auth.privy.io` are outside its network;
   the official SDK's verification ran against a local key. [LIVE-VERIFICATION-PRIVY.md](../deploy/LIVE-VERIFICATION-PRIVY.md) is the owner's check.
2. **Privy's wallet trusts the product origin.** Keys stay in Privy's frame, but any script running on the origin can drive Privy (its
   confirmation is drawn by the page). Mitigated in this build (§3.6): the signer runs only in documents loaded on signer pages, each of
   which runs only FloFi's own scripts, and no third-party script runs on the product origin (card entry moved to the card origin). The
   boundary is still the origin, not the path: other same-origin HTML (`/`, `/docs`, `/privacy`, `/admin`, error pages) keeps the policy
   without `script-src`. Those pages render no user content and load no third-party script, but a script that did run there could open or
   frame a signer page (same origin) and drive it, so they are inside the boundary too. A default-deny nonce policy for all HTML on the
   product host is the follow-up. Code FloFi itself ships (reviewed, in the bundle) and browser extensions with page access are inside the
   boundary. A cryptographic gate (Privy wallet policies or a FloFi co-signer key quorum) would remove the reliance on page integrity; it was
   not adopted because it cannot be verified offline and adds a FloFi-held authorization key.
3. EVM import: Privy allows one imported EVM key per user (its SDK refuses a second). FloFi offers one generated wallet per ecosystem.
4. Privy exports a private key, not a recovery phrase, for its wallets.
5. Apple: Privy's default Apple client gives a different `sub` than FloFi's earlier Apple sign-in; Apple stays off until Privy uses FloFi's
   Apple Services ID (`FLOFI_PRIVY_APPLE_LOGIN=enabled`), so existing Apple accounts are not duplicated.
6. A cancel in Privy's confirmation spends that reviewed attempt (the claim precedes Privy, and a browser-reported cancel cannot be
   verified); the person simulates again.
7. WalletConnect (mobile QR wallets) is unavailable unless the owner accepts the WalletConnect Community License.
8. Export step-up: FloFi opens Privy's export screen without its own re-authentication (Privy holds the key; FloFi cannot gate its frame).
   The owner should require MFA or re-authentication for export in the Privy dashboard (ENVIRONMENT.md §5j); the live runbook records it.
9. A signed EVM transaction can still outlive its Review if the person waits more than the 20 s margin in Privy's confirmation: FloFi then
   refuses to broadcast it and the attempt is UNKNOWN until reconciled (fail-closed; nothing is sent).
10. Not introduced here, still open: "Sign in again" for `ACCOUNT_REAUTHENTICATION_REQUIRED` (delete account, link a wallet) returns to the
    same page while the session is valid; Disconnect, then sign in, is the working path.
11. The card origin is on the same site as the product (`cards.flofi.xyz` / `flofi.xyz`). Mercado Pago's script there cannot frame,
    navigate or script the product, but a same-site script could set `Domain=flofi.xyz` cookies that shadow `flofi_account_session`
    (sealed, so it could plant only a valid session of its own or push the person's out) and send requests that carry SameSite cookies
    (server actions check Origin). Strictly better than before, when that SDK ran on the product origin itself. Follow-up: `__Host-`
    cookie names and Origin checks on state-changing route handlers, or a card origin on its own registrable domain.
12. Sign-in freshness relies on Privy updating a sign-in method's `latest_verified_at` at every login (verified only against the
    stand-in; live runbook step 7a is a NO-GO check). It is the newest verification across the Privy user's identities: it proves a login
    at Privy in the last 10 minutes, not in this browser; the browser-side logout of leftover sessions and the single-use token cover that.
13. `/mcp/approve` inside an MCP host's frame mounts Privy but can never authorize there: the account cookie (`SameSite=Lax`) is not sent in
    a cross-site frame, so the signing gate refuses (fails closed). The page keeps the nonce policy.
14. Escape inside Mercado Pago's own card-number, expiry and security-code fields does not close Add card (they are cross-origin frames
    within the card page); Cancel, Close and the backdrop do. The card frame has a fixed height (470 px, 560 px on narrow screens), so very
    large text or a short landscape screen scrolls inside it.
15. Privy's own screens show FloFi's English header and button texts ("Sign in to FloFi", "Sign"): Privy's configuration is not localized.

## 11a. Specialist review (CLAUDE.md procedure)

`agent_guard.py impact --base origin/main` selected, among others, flofi-security, flofi-wallet-execution and flofi-data-privacy; those
three reviewed the diff read-only (they were run as general agents following `.claude/agents/*.md`, because the twins were added to `main`
after this session started). Findings and disposition:

| Finding (severity) | Disposition |
| --- | --- |
| Wallet not usable in the page spent the attempt as UNKNOWN (medium) | Fixed: `canSign` before the gate and in Authorize; test |
| EVM Review could expire while confirming in Privy (medium) | Mitigated: 20 s minimum at claim; test; residual case in §11.9 |
| Legacy → Privy migration left the wallet export-only (medium) | Fixed: explicit import adopts the legacy record; pg test |
| Removing a Privy wallet was undone by the next sync (medium) | Fixed: managed wallets are kept; Remove only for external; pg test |
| Message gate weaker than the removed parser (low) | Fixed: exact server message, nonce, times, unexpired; tests |
| Two Privy users could link to one account in a race (low) | Fixed: account row lock; pg test that fails without it |
| Privy sign-in token reusable (low) | Fixed: 10-minute freshness and single use; pg test |
| Embedded wallet linkable as sign-in identity (low) | Fixed: refused (`ACCOUNT_WALLET_IS_FLOFI_WALLET`); pg test |
| Export without recent sign-in (low) | Documented (§11.8), dashboard MFA recommended |
| Cited `privy-zod` test missing (low) | Added `privy-zod.test.ts` (api-base under zod 4.6.6) |
| Account-deletion test weakened (low) | Restored: all four tables empty, Privy identity and wallet included |
| Privacy notice did not name Privy (low) | `/privacy` (EN, PT) names Privy and what it processes; legal review is the owner's |
| Preview origins on the production Privy app (doc) | ENVIRONMENT.md: production app allows `https://flofi.xyz` only |
| Password managers may offer to save the key (unverified) | Live runbook step 5 records it per browser |
| "Sign in again" loop (pre-existing on main) | §11.10 |
| Browser run: a new email code typed while the request ran was erased (found by `auth-wallets`, intermittent) | Fixed: the old code is cleared when the new one is requested |

`agent_guard.py review --base origin/main` reports all 19 domains as selected (the dependency, lockfile and CI changes select every
domain) and every `flofi-*` specialist as not invoked: the hook ledger saw the three reviews above as `general-purpose` agents. The other 16
domains had no specialist review in this session; their regression suites ran in the unit, critical browser and CircleCI gates.

## 11b. Real specialist reviews (`.claude/agents/flofi-*.md`, recorded by the hook ledger)

The `flofi-*` specialists ran read-only, at most three at once, each given the base (`origin/main` d37b6168), the diff, the changed
paths and its `agent_guard.py domain` report. Their final reports reached main as plain text: the repository hook refuses `SubagentHandback`
to reviewers (recorded as guard denials), which the ledger counts while still recording each review's `FLOFI_REVIEW_RESULT`.

| Round | Specialist | Result (ledger) | Disposition |
| --- | --- | --- | --- |
| 1 | flofi-security | 5 findings, highest medium | Privy blocked on `/approve` and `/connections` (medium): fixed, Privy hosts in the product policy, one CSP header per route measured. Silently refreshed token passing the recent-sign-in check: fixed (Privy verification time; later also refused at sign-in). Disconnect order: fixed (FloFi session revoked first, each step bounded). Leftover Privy session reused via `privy_oauth_*`: fixed (login events buffered; browser test). Apple accepted while off: fixed |
| 1 | flofi-wallet-execution | 3, medium | Nothing checked Privy's signed EVM bytes (medium): fixed, strict RLP decode and nine-field comparison before broadcast. Solana routed to an external wallet with the same address: fixed (`isPrivyWallet`). Browser suite lost signing checks: restored |
| 1 | flofi-data-privacy | 5, medium | Key-shaped wallet names stored (medium): refused in the browser and by the server. Account deletion and privacy notice vs the Privy user (medium): `/privacy` names Privy and what deletion leaves at Privy; delete dialog says so. Email challenges cleanup: restored at sign-in. 0019 check3 admitted a Privy wallet claiming a recovery phrase: fixed (new SHA-256, Release A corrected). Rollback docs: completed |
| 2 | flofi-security | 8, highest "high if confirmed" | Encoded path aliases (high if confirmed): measured, every alias is 404 (not exploitable); the card page also checks its host. Framing: workspace `frame-ancestors 'self'`, card frame sandboxed. Solana filter: tested. Bot-check loader: `/login` only; `scriptNonce` removed (not a Privy option). Stale Privy login: refused at sign-in. Key field: masked text field. Half-linked external wallet name: fixed. Docs: boundary stated as the origin |
| 2 | flofi-wallet-execution | 2, low | Solana filter test added; RLP list-end check added with the reviewer's vector |
| 2 | flofi-payments-billing | 4, medium | Invalid email left Add card stuck (medium): checked in the frame first. Blank dialog if the frame never loads: 20 s timeout to "unavailable". Escape: posts cancel. Test gaps: spoofed `postMessage`, status branches, card-origin routing tests added |
| 3 | flofi-security | 7, medium | Key field first rendered as a password field (medium): masked text from the server render. Provider remounted every signer page (medium): stable tree, policy classes. Returning-login dependency on Privy (medium, verification gap): runbook step 7a NO-GO. Policy classes: implemented. Same-site card origin: §11.11. Masked-field trade-offs: §3.3, runbook. Stale comment: fixed |
| 3 | flofi-mcp | 2, medium | Remount could drop the in-chat handoff capability (medium): fixed by the stable tree (no remount). Privy mounted in MCP host frames: §11.13. No MCP schema, OAuth, handoff or approval contract changed; `/mcp/approve` headers now pinned by test |
| 3 | flofi-frontend-ux | 10, medium | Remount and false "not configured" flash (medium) and key field (medium): fixed as above, browser test for the login page. Card frame `lang`, loading status, focus to Close, PT wording, default wallet name in PT: fixed. Escape inside Mercado Pago's fields and fixed frame height: §11.14. Privy texts not localized: §11.15 |
| 4 | flofi-security | 0 | Session/proof cookies are `__Host-` on HTTPS with no unprefixed auth fallback; embedded MCP proofs are gated by the proxy's `x-flofi-pathname`; every product-origin HTML page carries a nonce script policy; Privy sign-in proofs are keyed on the signed JWT input (not malleable signature bytes); Admin Sign out waits for hydration (CircleCI `admin-console` on `bd897457`). Release B keeps the schema-19 reader suite with frozen v18 fixtures |
| 4 | flofi-wallet-execution | 0 | Host-prefixed wallet/Solana proofs, embedded path isolation and the pre-sign future/overlong message gate match the mapped unit suites; signing-gate comments only |
| 4 | flofi-mcp | 0 | Moving embedded wallet cookies to `Path=/` does not change MCP OAuth, handoff or `/mcp/approve` frame-ancestors; authority stays on the proxy-verified pathname |

CircleCI on `bd897457`: governance, certification-checks and certification-browser-1 passed; certification-browser-2 failed only on `admin-console` Sign out (click before the client handler was ready). Fixed by disabling the button until hydration.

## 12. GO / NO-GO

- Code: ready for owner review.
- Merge / production: **NO-GO until** (1) Release A (certificate 0019) is live on every database consumer; (2) the owner provisions the
  Privy apps and variables; (3) the live runbook passes on an isolated Preview; (4) the legacy SQL check is recorded and the Turnkey legacy
  settings are kept or removed accordingly.
