# BUILD-FLOFI-UX-FIX-003 — Mainnet-only Copilot, conversational bridge, clean cards, wallet reliability, Settings/login

Owner request: fix production problems in Chat, Editor, Bridge, MetaMask, Login and Settings without weakening financial validation,
signing protections or security, without production changes, migrations, new variables or real-money transactions. Branch
`claude/friendly-lovelace-mbwtlq`; one PR. The owner later authorized merging and deploying (Vercel, Railway) only once every
mandatory check is green (see "Owner follow-up" below).

## P0-1 — No test network in any public option

**Root cause.** The public (PUBLIC_MAINNET) Copilot still built bridge options from the engineering Router table:
`planBridge` offered `[ROUTER_NETWORK_OPTIONS.testnet, ROUTER_NETWORK_OPTIONS.mainnet]` ("Base Sepolia → Arbitrum Sepolia",
"Base → Arbitrum One") whatever the scope. Two more leaks of the same kind: the public liquidity buttons ("Uniswap v3 on Base",
"Orca on Solana", "Uniswap v3 on Ethereum") were mapped to Base Sepolia / Solana Devnet / Ethereum Sepolia, and options or prose
written by the model were shown unfiltered.

**Change.**
- `domain/copilot-authoring.ts`: Router pairs and the Router amount-range text are scope-aware; in the public product an unnamed
  bridge side (legacy Router path and `planRoute`) is asked by the universal bridge, one side at a time, among the mainnets of the
  universal-router registry (`UNIVERSAL_NETWORKS`). Whether a live route exists is still decided at Simulate (no route is presumed).
  A side the user did name is kept even when the model leaves it out.
- `domain/network-scope.ts`: `mentionsTestNetwork` / `publicText` — the one boundary for display text (EN and PT wording).
- `domain/copilot-conversation.ts`: model-written options, questions, refusals and explanations naming a test network are replaced by
  FloFi's own wording; liquidity buttons author on the mainnet they name.
- `server/copilot-service.ts`: the model prompt's edit example names a mainnet.
- Engineering scope (CI, local opt-in only, never hosted) keeps every test-network engine unchanged; historical runs stay readable.

Channels (Telegram/WhatsApp) share the conversation engine; MCP already had a public schema. Regression:
`channels/core/conversation-mainnet.test.ts`.

## P0-2 — "bridge eth to 1 usd" → "usdc" → route lost ETH

**Root cause (reproduced in a unit test before the fix).** `copilot-asset-intent.ts` `explicitInputAsset` read the only
"number + token" clause of the message — "**1 usd**", written after "to" — as the *source* amount and asset, and overwrote the
model's `asset: ETH` with "usd". The currency question then asked about the source; the answer "usdc" became the source asset; the
amount 1 was reused as the amount sent; picking "Base → Arbitrum One" authored `bridge 1 USDC from Base to Arbitrum`.

**Change.**
- Destination-role grammar (`destinationAmounts`, `withoutDestinationAmounts`): a number written after to/into/for/para/pra/por/
  receive… is what the user wants to **receive**. It never names the asset sent, is never grounded as the amount sent, excludes
  "up to", "get", and amounts of the asset being sent ("set it to 0.5 ETH"). It applies only to a new single action
  (`Grounding.receiving`), never to edits ("change the swap to 4 USDC").
- Every provider FloFi uses is exact-input (Relay `EXACT_INPUT`, Across/LI.FI `exactInput`). So FloFi asks "How much ETH would you
  like to send?" and says why: "You asked to receive 1 USDC. FloFi prepares this from the amount you send, so it cannot guarantee
  exactly 1 USDC: Simulate shows the estimated amount you would receive, after fees." (EN/PT). No ETH amount, fee or received amount
  is invented.
- A reply "1 USDC" to "How much ETH…?" is asked again ("That amount is in USDC, but this step sends ETH"), never read as 1 ETH.
- Moving a bridge side to another network carries the token by symbol and resolves it again there; a contract/mint FloFi cannot name
  is never carried to another chain (it was: Arbitrum's USDC `0xaf88…@6` on Ethereum); a default or native destination token yields
  the new network's default, stated.
- The model schema's swap/bridge `amount` description says it is the amount sent.

Tests: `domain/copilot-mainnet-bridge.test.ts` (30) — the three model readings of the reported dialogue, PT, "0.01 ETH from Base to
USDC on Arbitrum", "10 USDC from Base to Solana", "swap ETH to USDC", omitted-then-completed fields, network-only and
destination-asset-only changes, wrong-unit answers, "up to", ambiguous amounts, unportable tokens, default/native outputs.

## P0-3 — MetaMask "Transaction 66 failed! Transaction not found on network after timeout"

**Status: partially investigated — not resolved.** The original MetaMask notification has not been reproduced, and no production
record of "Transaction 66" was available. The defects below are real and fixed, and they are consistent with the symptom, but nothing
here proves they caused this notification. The issue stays open until the owner's evidence (checklist below) confirms or rules out
each hypothesis.

**What the code does (verified).** Injected wallets get exactly one `eth_sendTransaction` per Execute click; FloFi never broadcasts
a MetaMask transaction itself; the durable attempt and nonce reservation fence duplicates; a missing receipt is PENDING/UNCERTAIN and
no read timeout becomes FAILED; "Confirmed" requires a receipt with status 1 verified by FloFi's own RPC.

**Defects found and fixed (possible contributors, not a confirmed cause).**
1. Ethereum mainnet swaps (owner-bound Review) were built with `maxPriorityFeePerGas: 0x0` and Arbitrum's Nitro fee policy
   (`public-testnet-service.ts` `bindSwapOwner`). Ethereum mainnet transfers also carried a zero tip
   (`reference-compiler/native-transfer.ts` offered a tip only on OP Stack). An L1 transaction without a tip is refused by node
   mempools or never mined — consistent with "not found on network after timeout". Now the node's suggested tip is offered, bounded
   by the unchanged reviewed fee ceiling and budget; a node that suggests none fails closed before Review; a pre-fix zero-tip Review
   needs a new Review; a momentary tip reading at Execute never retires a valid Review. Arbitrum/Robinhood (Nitro/Orbit) and the
   engineering Ethereum Sepolia profile are byte-identical.
2. A recorded swap hash that never mines stayed PENDING forever and held its nonce reservation. Once the reviewed nonce is used on
   chain (≥ 30 s after submission, not for reviewed delegations), the existing nonce discovery now adopts the same reviewed call under
   its new hash (wallet speed-up) or records `NONCE_CONSUMED_BY_DIFFERENT_TRANSACTION` (cancel). Never FAILED, never resent.
3. The universal-router store did not check the wallet's own pending nonce before signing (the Router and liquidity stores do); it
   now stops with `UNIVERSAL_WALLET_NONCE_MISMATCH` before the wallet is asked.

Tests (`server/ethereum-runtime.test.ts`, MOCKED loopback chain): tip present and within the ceiling (swap, native and token
transfer); no-tip/over-ceiling refusal; tip drift at Execute; broadcast-but-unmined stays PENDING across observes and RPC timeouts on
a new instance, then CONFIRMED with the same hash; speed-up adoption; cancel recorded.

**Not proven / outside FloFi.** We have no production run record or MetaMask log for "Transaction 66". Two hypotheses fit the code:
(a) the zero L1 tip above (Ethereum swaps/transfers), and (b) MetaMask Smart Account (EIP-7702) relays — FloFi verifies and reconciles
the relayer's transaction while the owner's nonce 66 stays unused, so MetaMask times out its own record. (b) is MetaMask's own
bookkeeping and is not changed here. To tell them apart, the owner can record from MetaMask the nonce, the hash, the priority fee
("Site suggested"), Smart Transactions / Smart Account settings and version; on the explorer, whether the owner has `0xef0100…`
delegation code and whether FloFi's recorded hash was sent by the owner or a relayer; in FloFi, the attempt state, `txHash`,
`tx.maxPriorityFeePerGas` and `receipt.submissionKind`. Never share a seed phrase or key.

## P1-4/6 — Clean cards, readable amounts

**Root cause.** `composer-card.tsx` rendered provider diagnostics on the card ("Approximate · provider · Simulate before review",
"Builder verified / Live quote only", the "Provider estimates" list, "USD price unavailable", "Calculating…"). Amounts used 22 px
monospace with `overflow-wrap:anywhere` in a ~90 px column next to the token pill, so "0.997401" broke between digits.

**Change.** The card shows action, assets, amounts and networks; it adds a sentence only when the owner must act (mismatched networks,
or why no estimate exists, with the support reference where the message points to it) or when a route can only be quoted
("Estimate only: FloFi cannot execute this route yet." — a quote is never presented as executable). Amounts are one line, sized to
their column from their own length (12–22 px, container units), clipped with an ellipsis past 12 px with the full value in the title;
values are never rounded. USD-first values and the lines under amounts never wrap either. A quote in flight is a fixed-size
placeholder inside one persistent polite live region (assistive technology hears "Calculating estimate…" then the amount); the card
keeps its size when the quote arrives. Review still shows route, fees, minimum and risks.

## P1-5 — Bridge settings popover

The popover stacked protocol paragraphs and duplicated the card's networks, token and amount. A bridge's settings are now only what
the card does not edit — recipient, routing, slippage — with no protocol text (`RouterForm`/`UniversalBridgeForm` `options`). The
submit still builds the full validated `SET_*_BRIDGE` command (the card's amount draft included); a Router draft whose networks are
not a certified pair cannot be submitted from it. The popover never covers a pending proposal's Review button.

## P1-7 — Settings menu and sign-in

**Root cause (Settings).** On first open the menu called two server actions — `learningAvailability()` and `accountState()` (four
database reads, full account view) — which Next.js runs one at a time per client behind any other action, then inserted rows
("Privacy & memory", "My account"/"Sign in"), changed Disconnect, and changed width (`width:max-content`).

**Change.** The learning tier arrives with the page (product layout bootstrap). A new `accountPresence()` action returns only
`{accounts, signedIn}` from one verified-session read (no account data leaves the server); `state/account-presence.ts` shares one
request per page, prefetched at idle time or on hover/focus, kept in page memory only, forgotten when the page observes another Privy
user, re-read on visibility after 30 s. The account row exists from the first frame (placeholder → My account/Sign in); the menu has
a fixed width.

**Sign-in.** `store.account()` ran its three independent reads (account, identities, wallets) one after another on every sign-in and
account page; they now run concurrently (same tenant/account scoping). A parallel proof/Privy-read was tried and reverted after
security review (a replayed token would have triggered a Privy API call).

**Measurements.** Production timings were not measured (no production access in this build). Structural evidence: Settings open went
from up to two serialized server actions (five DB reads) and up to two reflows to zero requests at open when prefetched (one DB read
otherwise) and zero reflows (browser-asserted: identical bounding box after 1.5 s, signed in and out). Account reads go from 3 to 1
database round trip of latency (≈ 2 RTT saved per account view; a sign-in performs two). Live Privy OAuth/SDK timing, cold starts
and hydration still need production telemetry.

## Validation (local; CircleCI remains the certification authority)

- `pnpm check` (typecheck, lint, production build, schema check, 531 unit files / 6,472 tests): pass.
  `python3 scripts/governance_lite.py` + its 21 self-tests: pass. `agent_guard.py check`: pass.
- PostgreSQL (loopback PostgreSQL 16): `apps/reference-dapp/src/accounts` 17 files / 147 tests, including `account-store.pg` and
  `account-service.pg`: pass.
- Browser suites, run inside `cimg/node:24.21.0-browsers@sha256:7e52dee8…` with CI's SHA-pinned Chrome-for-Testing 153.0.8010.12
  headless shell (archive SHA-256 `a9da0288…`), each suite as its own server instance like CI, loopback/MOCKED only:
  `default-product` 109 passed / 2 failed (`build009` ×2 — they fail identically on `origin/main` in this environment; they need the
  live LI.FI host and pass on CircleCI), `canvas-corrections` 6/6, `review-execute-recovery-components` 39/39, `workflow-ux-authoring`
  12/12, `canvas-workflow-ux` 8/8, `universal-bridge` 11/11, `copilot` 13/13, `auth-wallets` 16/16.
- Visual baselines: before updating, `origin/main` passed its own baselines in that environment (so it reproduces CI rendering). Seven
  card screenshots changed by this build were regenerated there (`--update-snapshots=changed`); diffs inspected: card cleanup only.
- Found while testing and fixed: the settings popover could cover a pending proposal's Review button, and the Canvas call-to-action
  notes blocked pointer events over cards they overlapped (now click-through except their controls).
- Not run by CI and not claimed: `header-controls`, `bridge-network-picker`, `global-product-polish` are retired specs (ignored by the
  Playwright config); `composer-product-cleanup`, `card-*`, `canvas-action-setup`, `theme-amount-display`, `stocks-pool-authoring`,
  `workflow-composer` are in no CI suite and fail on `origin/main` too. Their expectations were updated where this build changed the
  copy they assert; the Settings stability test lives in the active `auth-wallets` suite.
- Specialist reviews (read-only): flofi-chat, flofi-wallet-execution, flofi-security, flofi-frontend-ux, flofi-bridge. Confirmed
  findings were fixed (wrong-unit amount answers, over-broad destination grammar, non-portable token identities, tip drift at
  Execute, zero-tip legacy Reviews, quote-only routes shown as executable, live-region announcements, USD wrapping, compact-form
  drafts, replay amplification of the sign-in read — reverted). The other 14 domains were not invoked.

## Limitations and follow-ups

- MetaMask: partially investigated, not resolved. The notification is not reproduced and its cause is not confirmed; see the status
  and evidence checklist in P0-3. Fee overrun after a user speed-up stays a recorded bounds divergence (unchanged policy, owner
  decision).
- Transfers and supply do not yet adopt a replacement hash the way swaps now do; the public swap store has no wallet-side nonce check.
- Long amounts beyond ~11 characters are clipped on the card; the exact value opens on tap or keyboard (owner follow-up below) and
  Review shows exact values. The USD-first sub-line is not a disclosure: tapping the USD figure switches back to the token amount.
- Channels show at most four buttons, so Robinhood Chain is typed rather than tapped in the source question.
- The PT universal-bridge Canvas panel strings keep their European-Portuguese wording ("regista"); their meaning matches EN.

## Owner follow-up (same PR)

1. **FloFi fee copy, EN/PT.** Owner policy: the 0.1% fee is recorded on completed universal bridges and is not charged at this time.
   The Portuguese Copilot note said FloFi charged no fee on the bridge; it now says, like English, that a 0.1% fee obligation is
   recorded for each completed bridge and is not charged now (`copilot-messages.ts`). The Canvas "Real funds" note now also says it is
   not charged (EN and PT), and the universal Review's "FloFi fee (0.1% obligation)" line and note, which had no Portuguese text, are
   translated. The other universal fee sentences said "not collected / not settled on-chain yet", which can read as if the fee might
   be charged elsewhere; all now say "not charged at this time", and their Portuguese is Brazilian Portuguese like the rest of the
   product. Copy only: `fee-obligation.ts`, the obligation record and accounting are unchanged; nothing is collected. Routes without
   an obligation keep "Not charged". Regression: `i18n/flofi-fee-copy.test.ts` (both notes; every universal Review/panel fee sentence
   has PT text stating recorded and not charged; one wording; the old "não cobra taxa" sentence cannot return).
2. **Exact value by touch.** A card value clipped to one line (measured, `scrollWidth > clientWidth`) becomes a disclosure
   (`role=button`, `aria-expanded`): tap, click, Enter or Space shows the exact value and token in a bubble over the card; a second tap,
   Escape (handled on the value and bubble only; focus returns), a tap elsewhere or focus moving on (Tab) closes it; a new quote closes
   it and it never reopens by itself. Clipping is measured before paint. Values that fit stay plain text with their title. The USD-first
   token sub-line, which cut digits off with no ellipsis, now ends in an ellipsis and opens the same way. Keys on the value never reach
   the canvas; the value has the app's focus ring; the bubble has a dark-theme surface. The card keeps its size and one-line layout;
   nothing is rounded. Regressions: `workflow-ux-authoring` "exact value on a touch screen" (390 px, touch: clipped one-line value, tap
   open/close, tap elsewhere, Enter/Space/Escape, Tab closes, a new quote closes, bubble on screen, card size unchanged, no duplicate
   title, short value not a button) and `build-fix-ux` (USD-first sub-line: ellipsis, token visible, exact value on click, Escape).
   A flofi-frontend-ux review of this follow-up found 2 medium and 6 low issues; all were fixed as above.
3. **MetaMask** documented as partially investigated (P0-3 status), not as resolved.
