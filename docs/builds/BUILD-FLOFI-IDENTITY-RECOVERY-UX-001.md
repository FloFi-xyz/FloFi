# BUILD-FLOFI-IDENTITY-RECOVERY-UX-001 — one account across sign-in methods, boarding recovery, and three UX items

**Scope:** the owner's request of November 17, 2026: P0 account identity linking, duplicate-account prevention and recovery for people who already
boarded (including the owner's own case), plus UX-01 (Departures Board threshold), UX-02 (25/50/75/Max in the chat) and UX-03 (login illustration),
in the same PR as the floating-rail follow-up of BUILD UX POLISH 004. Branch `claude/zealous-heisenberg-szphcc`, from `main` at `63755e0`.

**No migration, schema, dependency, environment variable or infrastructure change.** Everything runs on the existing tables
(`flofi_account_used_proofs` for single-use markers and tombstones, `admin_audit_events` for the append-only retirement record, `flight_emails` with
the existing `ACCESS_REQUESTED` template and a new trigger). No production record was read or changed from this session; the owner's accounts were
not touched (see §F). No transaction was signed, submitted or simulated against a public network.

Evidence levels: **CODE** unit tests; **PG** real disposable PostgreSQL (loopback); **BROWSER** the production build in headless Chromium on loopback
with the MOCKED Privy emulator; **OWNER** acceptance that needs the owner's real Google/Privy/wallet credentials (not run here).

## A. P0 — the incident

The owner (Founding Member #001) boarded with an external Web3 wallet: account **A** (identities `PRIVY did:A` + `EIP155`), holding the list claim,
the beta grant and the pass. On Nov 13 a Google sign-in (same address) created Privy user **did:B** and FloFi account **B** (`PRIVY did:B` + `GOOGLE`),
because a sign-in reaches an account only through the same kind and subject. On Nov 17 Google reached B → `/app` refused (no grant) → `/board` "Not on
the list. Yet." → "Send me a link and a code" found no entry with `boarded_at IS NULL` → silent OK, nothing sent. A dead end.

## B. P0 — what changed (the security model)

**B1. FloFi decides which methods open an account.** Privy links a method with nothing more than a Privy session, so a method linked at Privy outside
FloFi (anyone holding a live Privy session could) must never open the account:
- A returning account (one already linked to the Privy user) signs in only with a method it has confirmed — an identity it holds
  (`ACCOUNT_SIGN_IN_METHOD_UNCONFIRMED` otherwise), and new identities are no longer adopted on that path (`account-store.ts signInPrivy`).
- **No lockout of existing accounts:** a method Privy first verified before `METHOD_CONFIRMATION_SINCE` (2026-11-17 12:00 UTC) is still adopted as
  before (e.g. a sign-in wallet removed from Credentials earlier). Removing an external wallet of a Privy account keeps its sign-in identity.
- **One FloFi sign-in per Privy session** (`flofi-privy-session:<sid>` marker): a refreshed token of a session that already signed in — or that only
  linked a method, which refreshes Privy's verification time — never opens another FloFi session. Real sign-ins always start a new Privy session
  (`/login` ends any leftover one).

**B2. Linking (Sign-in methods page, `/account/sign-in-methods`).** Lists the account's methods (masked). "Link Google" / "Link email" need a recent
sign-in (≤10 min; else "Confirm it's you" → `/login?reauth=1`, which only re-confirms the SAME account). `linkReadiness` checks that the browser's
Privy session is this account's own Privy user and opens a 15-minute window bound to that Privy session (it starts at the first readiness and is
never moved); `syncSignInMethods` then adopts only methods Privy first verified inside that window (one minute of clock skew), never one linked at
Privy before FloFi asked (`unconfirmed`, reported on the page) and never an identity another account holds (`heldElsewhere`). In the browser exactly one headless OAuth completer runs per
document — login on `/login`, link on this page — and the link completer runs only for the Privy user checked before the redirect; any other return
is stripped and the Privy session ended (Privy otherwise finishes any return as a link when a session exists, or a sign-up when none does). Privy's
account-transfer flow is never invoked; `linked_to_another_user` / `account_transfer_required` map to `FLOFI_SIGN_IN_METHOD_HELD_ELSEWHERE`.

**B3. Duplicate prevention at sign-in.** Before CREATING an account, if another account of this deployment already verified one of the person's
verified addresses — an email-code identity, a Google sign-in on gmail.com/googlemail.com (on both sides), or a Flight list address it claimed — FloFi creates
nothing, releases the proofs and asks: "Add this sign-in to that account" (B4), "Use another sign-in method" or "Create a separate account". Only the
other account's method KINDS are shown, to a person who just proved control of that address. Nothing is merged.

**B4. Explicit retirement of an EMPTY duplicate, with proof of both accounts.** Started signed in to the duplicate (recent sign-in), confirmed signed
in to the account that keeps everything (recent sign-in), through an HttpOnly SameSite=Strict sealed intent (15 min, single use, ended by any other
sign-in or sign-out, kept by the keeper's own step-up). `/login?move=1` takes its mode from the URL (a Google return is a cross-site navigation that
never carries the Strict cookie); the sign-in server action, which does carry it, requires the intent. A step-up or a move sign-in never creates an
account (`existingOnly`); an account created by "Add this sign-in to that account" that cannot start the move is discarded while it holds nothing. The duplicate must hold nothing but its sign-in methods — no wallet (saved or sign-in), legacy wallet, recipients, pass,
invite, list claim, beta grant (even revoked), MCP binding, simulation or Editor history — and its Privy user only Google/Apple/email, no wallet of any
kind, no MFA. At completion: freeze the Privy user (no login, sessions revoked) → re-check at Privy → under a row lock re-check FloFi, delete the
duplicate, write a tombstone (no sign-in of that Privy user meanwhile: `ACCOUNT_MOVE_IN_PROGRESS`) and an `admin_audit_events` row
`ACCOUNT_DUPLICATE_RETIRED` (opaque ids only) → verify no account in ANY tenant holds that Privy user → delete it at Privy. Any refusal unfreezes;
a provider outage answers `ACCOUNT_MOVE_PRIVY_PENDING` and the same intent resumes. The freeze itself is inside that recovery path, and an
unfreeze that fails is recorded (`ACCOUNT_DUPLICATE_PRIVY_RETIRED` FAILED `ACCOUNT_MOVE_UNFREEZE_FAILED`), as is every Privy deletion (OK, or FAILED
`ACCOUNT_MOVE_PRIVY_PENDING`) — append-only, opaque ids only. **Nothing moves** to the kept account: no grant, pass, claim,
wallet, recipient or identity. Its method is then linked through Privy (B2). A pg test fails if any table with a foreign key to the account is missing
from the retirement checks.

**B5. Boarding recovery email (the dead end).** "Send me a link and a code" from an address that already boarded or that an account claimed
(`entryHolder`, shared with B3 and B6) now emails which sign-in method opens the account that holds it (masked; Founding seat if any) — never a link,
code or token, never a claim (a boarded entry stays unclaimable; `boarded_at IS NULL` was not removed). Essential mail the person asked for, but it
honours every suppression, goes out at most once per address per UTC day, at most twice per sender per hour, has its own cap (3/day, below the
essential reserve of 5; reaching it is logged) separate from access emails (30/day), its own copy version (`ACCESS_REQUESTED` v100, trigger
`access_recovery`, frozen by hash) and is never re-rendered after an unknown provider outcome (held as `UNRESOLVED_OUTCOME`, kept held). A worker of
the previous release that meets a recovery row of a claimed-but-not-boarded address would mint an unused token digest and hold the row
(`RENDER_FAILED`); nothing is sent, and no row is created before this release is deployed.
Paused campaigns are untouched. The public answer is byte-identical for unknown, listed, claimed and boarded addresses (BROWSER).

**B6. /board hint.** A signed-in person whose strongly verified address is held by another account sees "You boarded with another sign-in." (never
"Not on the list") with "Bring this sign-in to my boarded account" (→ B4). Any signed-in not-listed person also gets a quiet link to it. Computed
for the signed-in person only, never in the anonymous state.

**Adversarial design review** (three independent reviewers: security, Privy SDK, data/policy) found a step-up bypass through Privy-side linking, a
Privy-deletion lockout window, a broken re-auth return path, a shared email cap, wallet sign-in retirement, an orphan Privy user after B3, recovery
email abuse and a lockout of existing accounts; every finding was fixed as described above before implementation was finished. **Implementation
review** (flofi-security, flofi-data-privacy, flofi-chat specialists, read-only) then found: link sync adopting a method linked at Privy before the
window (HIGH, fixed with the window start), the move intent lost on a Google return or a step-up, freeze outside the recovery path, a single sender
exhausting the recovery cap, the Google-domain rule on the other account, durable hold after an unknown outcome, step-up/move sign-ins creating
accounts, audit rows for the Privy step, and for UX-02 a late pick answering a changed question, unreadable Token-2022 balances, model-only
network/asset, shortcuts beside the reading question, a contract-named token shown as zero and locale figures; all fixed with tests.

## C. UX-01 — Departures Board threshold · CODE + PG + BROWSER

`store.departures()` returns no rows until MORE than 10 passengers chose to be public and are not taken down (one statement; bounded `EXISTS … OFFSET
10 LIMIT 1`; never a count). The page data and the anonymous `/api/board/state` therefore carry nothing at 0–10; the section (heading, timestamp,
table, list) renders only with rows, and the existing 30 s refresh shows it once the 11th passenger opts in. No fabricated activity.

## D. UX-02 — 25% · 50% · 75% · Max · CODE + BROWSER

Offered only under FloFi's own STRUCTURED amount question (`awaitingAmount`: a single swap/bridge/transfer/Aave-supply step whose network and spent
asset the person stated (or FloFi carried) — never a value only the model wrote, since the planners ask for the amount before checking those —
nothing else missing; an Aave supply only of a reserve that market lists; never beside "which reading?" buttons, a goal cap, composition, liquidity
deposit, Borrow/Repay/Withdraw, or a model-written question) and only while
the engine still waits for exactly that (workflow, proposal and wallets unchanged). The balance is the authoritative portfolio read of the wallet that
would sign, raw base units of the exact asset (native ≠ WETH); unknown, partial, scaled or unreadable (Token-2022 confidential, rule read failed) balances,
and tokens named by contract that the read does not list, disable the buttons with the reason. Integer
math, rounded down, ≤6 decimals for percentages, exact token Max; a native Max keeps a fee reserve (Ethereum 0.01 ETH, L2s 0.0005 ETH, Solana 0.01
SOL); no shortcut when a workflow step already spends or delivers that asset there (future outputs). A pick re-reads a balance observed more than 30 s earlier
(the server may answer from its own snapshot of ≤30 s, so at most about a minute) and sends nothing if the amount changed or FloFi no longer waits
for exactly that amount; figures are shown in the interface language's separators (a cut Max is marked "…", the exact amount is in the
accessible name) while the answer sent stays canonical; it only writes the amount as the person's answer (same path as typing) — never signs, approves, submits,
executes or skips Simulate/Review. Channels (Telegram/WhatsApp) and MCP have no wallet balance, so they keep typed amounts; the domain module is
shared for when they do.

## E. UX-03 — login illustration · CODE + BROWSER

Each capability chip carries its mark (FloFi line icons; EVM and Solana use the repository's official brand marks, `public/brand/crypto/sources.md`),
with two subtle orbit rings (one slowly animated only without reduced-motion). Carousel, controls, copy, methods, themes and the phone band are
unchanged; everything stays decorative (`aria-hidden`).

## F. The owner's recovery procedure (OWNER acceptance, after deploy)

1. Sign in at flofi.xyz with **Google** (lands in the Nov 13 account B). `/board` shows "You boarded with another sign-in." (or, for a non-Gmail
   address, the quiet "Boarded with another sign-in method?" link). Choose **Bring this sign-in to my boarded account**.
2. On Sign-in methods choose **Bring this sign-in to my other account** (FloFi checks B is empty at FloFi and at Privy).
3. Sign in with the original **Web3 wallet** (account A, #001). Confirm **Close it and continue**.
4. Choose **Link Google** and complete Google. Google then opens account A.

If B holds anything (for example a Privy embedded wallet created during onboarding on Nov 13), FloFi refuses to close it and says why: keep using the
wallet sign-in (nothing is lost), or move the funds and contact support — FloFi will not strand a wallet. Nothing in this procedure grants beta access
to B, moves production records, or touches A's grant, pass or wallets.

Privy dashboard prerequisites (owner): Google and email login enabled for linking (they are login methods already); if bot protection is enabled,
"Link email" is hidden (stated on the page) and Google linking is unaffected.

## G. Limitations (stated, not hidden)

- Real Google/Privy OAuth link returns, Privy `freeze`/`delete` on the live app, and the owner's procedure are **OWNER** acceptance; BROWSER tests use
  the MOCKED emulator (link completes in place, no redirect).
- Adding a **Web3 wallet** as a sign-in method from Sign-in methods is not offered (Privy's wallet link is modal-only here); wallets for transactions
  are added as before. Removing a sign-in method is not offered.
- Duplicate detection (B3/B6) uses only strongly verified addresses (email code, gmail.com/googlemail.com Google); other Google/Apple addresses get
  the quiet link and the recovery email, not the question.
- A duplicate holding a wallet (embedded or sign-in) is never retired; recovery then relies on the original method.
- The fee reserves of UX-02 are conservative constants; Simulate remains the authority on fees and balances.
- A link window is bound to the Privy session and its start, not to the kind of method being linked; a method linked at Privy outside FloFi inside
  that same window (which needs the person's own live Privy session at that moment) would be adopted.
- The recovery cap is tenant-wide; many senders can still use up a day's three answers (logged when reached). The access answer is unaffected.
