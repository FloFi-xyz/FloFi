# HOTFIX-FLOFI-PRODUCTION-RECOVERY-001 — history, Aave Supply on Arbitrum One, sign-in

Owner request (2026-11-14): fix three bugs observed in production, nothing else. Base `origin/main` `8a92f1f`. Branch
`claude/peaceful-galileo-7r9j2j`. Nothing in this work signed or sent a transaction, changed production configuration, secrets, the Flight
gate, allowlists, Resend or any provider setting. Read-only RPC reads (`eth_call`, `eth_estimateGas`, `eth_getStorageAt`, `eth_getCode`,
`eth_getLogs`) were the only contact with public networks; the production site was read (`GET /login`, Privy's public app settings) and
received one forged-token call of its own sign-in action, which it refused (`PRIVY_TOKEN_INVALID`, nothing created).

## FIX 1 — "Execution history temporarily unavailable" (`/app/workflows`)

**Root cause.** Since the closed beta (`3fb0f6a`), the API refuses every `/v1/runs` read without the signed-in account's live session and a
wallet that account holds (`backend/app.ts` `wrap`: `betaSessionRefusal` + `accountOwnsAddress`, HTTP 403). The Dashboard's reader
(`src/lib/dashboard/data-service.ts` `cloudGet`) sent the API bearer and the wallet principal but never the beta identity headers that every
other BFF → API caller sends (`betaIdentityHeaders(currentBetaIdentity())`). `withFlightAccess` (`src/app/dashboard-action.ts`) had already
resolved that identity; it was simply not forwarded. Every history read was `403 BETA_SESSION_REQUIRED`, shown as unavailable.

**Fix.** `cloudGet` forwards the identity the Flight boundary resolved for this request (remote API and embedded runtime alike). It never
creates or widens one: with none resolved (open rollout) none is sent. Authorization is unchanged and still decided by the API.

**Tests.** `data-service-routing.test.ts` (index, attempts and detail reads carry the session, EVM and Solana, embedded and remote; none
invented when none resolved). `data-service-beta.pg.test.ts` — real backend over loopback HTTP and disposable PostgreSQL in `beta` mode: the
owner's own history and detail load; without the session the page says unavailable (never an empty history); an expired and a revoked session
stay refused; another signed-in account cannot read a wallet it does not hold, even naming it. Without the fix, the owner tests fail (2/4).

## FIX 2 — `SUPPLY_DEPLOYMENT_MISMATCH` (Aave V3 Supply, Arbitrum One, 5 USDC)

**Root cause (on chain).** Aave governance upgraded the Pool on Ethereum, Base and Arbitrum One to `POOL_REVISION` 12 with new implementations.
FloFi pins the Pool revision and ERC-1967 implementation at every state read (`packages/reference-compiler/src/supply.ts`
`readSupplyState`) and still pinned revision 11 and the address-book snapshot's implementation, so it refused the official Pool (fail-closed,
as designed). Read on 2026-11-14:

| Network | Pin (before) | On chain now | Provider `owner()` = official Governance V3 `EXECUTOR_LVL_1` |
|---|---|---|---|
| Arbitrum One | rev 11, `0xf05fd3cc…2c9a` | rev 12, `0xa6e7d235…8a1e` | `0xff1137…6327` ✓ — upgrade tx `0x6f9dce2a…6936` (block 523,299,579, 2026-11-11 14:15 UTC): provider `PoolUpdated(0xf05f…, 0xa6e7…)` and proxy `Upgraded(0xa6e7…)` in one PayloadsController execution |
| Ethereum | rev 11, `0x728a138a…03cf` | rev 12, `0x4295fe69…2fcb` | `0x5300a1…192a` ✓ |
| Base | `0xa4abc5fc…dfdb` (all reserves but native USDC) | rev 12, `0xf248dd0a…1918` | `0x9390b1…257a` ✓ |

Each new implementation has code, reports revision 12 and the market's official PoolAddressesProvider. Affected: every Aave reserve on
Arbitrum One and Ethereum, and every Base reserve except native USDC (whose verified profile never pinned an implementation). Masking only
the two pins, every other deployment check passed (reserve id, decimals, aToken, provider, oracle, codes). The aave-address-book snapshot
FloFi pins — and its current `main` — still name the previous implementations; that file is generated and was not edited.

**Fix.** `packages/action-registry/src/aave-v3-testnet.ts`: the Arbitrum One and Ethereum market profiles pin the new implementation and
revision 12; `AAVE_V3_POOL_UPGRADES` records each verified upgrade (from the exact snapshot implementation → to, revision, executor, block,
transaction where found) and `aavePoolImplementation()` applies it only when the snapshot still names `from`. The registry consistency
check and every expansion reserve's `pinnedImplementation` use it. Any other implementation or revision still fails closed; nothing else
about a reserve changed (USDC native vs USDC.e identities untouched).

**Evidence (read-only, real state, 2026-11-14).** The real `simulateSupply` (approval `eth_call`, bounded allowance override proof, Supply
`eth_call`, `eth_estimateGas`; no signature, nothing sent) of **5 USDC** passes on **Arbitrum One** (native USDC `0xaf88…5831` → Pool
`0x794a…14ad`, gas 93,342 + 349,455, block 524,039,013), Ethereum (Pool `0x8787…a4e2`) and Base (Pool `0xa238…d1c5`); `readSupplyState` passes for
WETH on Base, Arbitrum and Ethereum and USDC.e on Arbitrum. Before the fix each of these except Base native USDC failed with
`SUPPLY_DEPLOYMENT_MISMATCH`. Tests: `aave-v3-markets.test.ts` (every mainnet reserve pinned to the deployed implementation; an upgrade only
from the exact snapshot implementation), `arbitrum-lending.test.ts` (a 5 USDC Supply simulates against revision 12 without any wallet
request; the pre-upgrade revision and implementation are refused). End-to-end execution with real funds was **not** performed and is not
claimed.

## FIX 3 — "Sign-in did not complete. Try again." (`/login`)

**Root cause (reproduced against production).** The `/login` page hands the completed Privy sign-in to FloFi with a Server Action. A page
loaded before a new deployment keeps the previous deployment's action id; after the deploy, production answers that id with `409` and
`x-nextjs-action-not-found: 1` ("Server Action unavailable."). Observed on 2026-11-14: the id in a `/login` bundle fetched minutes earlier
was refused, the id of the page then current was accepted (a forged token was correctly refused with `PRIVY_TOKEN_INVALID`). Next.js throws
`UnrecognizedActionError`; `sign-in.tsx` turned every failure of that call into `PRIVY_SIGN_IN_FAILED`, and every retry in that tab failed
the same way. Email (waiting for the code) and Web3 Wallet complete inside the page and are exposed; Google returns through a fresh page
load. Production pages carry no deployment id, which indicates Vercel Skew Protection is off. Ruled out: Privy bot protection (Privy reports
`captcha_enabled: false`, so the CSP's missing captcha script is irrelevant), allowed origins (`https://flofi.xyz`; `www` redirects to it),
CSP violations and failed requests on `/login` (none), and the server path (every provider/token error is already coded).

**Fix.** `src/components/account/sign-in-failure.ts` names that case `SIGN_IN_PAGE_OUTDATED`; the page ends the Privy session (as for every
refused sign-in) and loads the current deployment's `/login` with "FloFi was updated while you were signing in. Nothing was signed in. Sign in
again." (PT: "A FloFi foi atualizada enquanto você entrava. Nenhum login foi feito. Entre de novo."), keeping `returnTo` (the page still
applies `safeReturnPath`). The next attempt completes. `privySignIn` now logs the error class only (`account.privy_sign_in_failed`; never
the token, the provider's text or an identity) for a failure without a FloFi code, so production logs name the failing step.

**Tests.** `sign-in-failure.test.ts` (Next.js's real `UnrecognizedActionError` → `SIGN_IN_PAGE_OUTDATED`; anything else stays generic).
Browser (`auth-wallets`, MOCKED loopback Privy): the sign-in action answered exactly as production did (409, `x-nextjs-action-not-found`) →
the reloaded page says why, no FloFi or Privy session remains, and signing in again completes. Without the fix the same test shows "Sign-in
did not complete. Try again." (red, then green).

**Pending external action (owner).** Turn on **Vercel Skew Protection** for the production project (Project → Settings → Advanced): pages
then keep calling the deployment that served them and a sign-in started before a deploy completes without the reload. Not changed here
(no Vercel settings were touched). Google, Email and Web3 Wallet sign-in could not be completed against the real Privy provider from this
environment (no real identity); the server path was exercised in production only with a forged token.

## Specialist review (read-only) and residual risk

- flofi-security (FIX 1, FIX 3): no findings. The identity comes only from the request's own Flight context, is never taken from the browser,
  and the API still rechecks the session and the wallet link; the reload URL is relative and `returnTo` stays sanitized; the log line holds the
  error class only.
- flofi-lending (FIX 2): no change needed in Borrow/Repay/Withdraw estimation or reconciliation; fail-closed kept. Applied: the MOCKED harness
  test is titled as wiring (the harness echoes the pins; revision 12 itself is the on-chain evidence above); stale "revision 11" comments
  updated. Checked read-only on Arbitrum after the upgrade block: the Pool's `Supply`, `Withdraw`, `Borrow` and `Repay` events keep their
  signatures and data sizes (Borrow data 256 hex characters, as the reconciler expects), and the aToken's `getPreviousIndex` still answers.
- **Residual risk (low):** reconciliation reads the deployment at an attempt's own block with today's pins. A lending attempt mined
  *before* the 2026-11-11 upgrade on Arbitrum One, Ethereum or a Base expansion reserve and still not reconciled would now be reported as
  divergent. Already reconciled runs are not re-read, and no attempt could be made after the upgrade (every simulation was refused).
  Owner check: look for non-terminal Aave runs on those markets whose attempt block precedes the upgrade (Arbitrum 523,299,579).

## Not changed

Flight gate, allowlist, beta permissions, authentication and authorization rules, Vercel/Railway/Neon settings, secrets, Resend campaigns,
migrations, workflows that were healthy. The generated aave-address-book snapshot (regenerate once upstream lists the new implementations,
then drop `AAVE_V3_POOL_UPGRADES` entries). Other Server Actions in the product share the same deployment-skew exposure; Skew Protection
covers them all.
