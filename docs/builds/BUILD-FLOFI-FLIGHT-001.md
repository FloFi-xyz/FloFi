# BUILD-FLOFI-FLIGHT-001 — Flight FloFi at flofi.xyz/board

Owner request (2026-11-05): implement, integrate and validate `/board` from the team-approved Claude Artifact "Flight FloFi"
(https://claude.ai/artifact/9swYNgCuDz4pmW93fbBWMD, version `1793892357-f7d9`) before the campaign starts on 9 Nov 2026, alongside the
approved landing (BUILD-FLOFI-LAUNCH-001), without blocking the product. Release: [RELEASE-FLIGHT-0020.md](../deploy/RELEASE-FLIGHT-0020.md).

## What was built

| Board | Implementation |
| --- | --- |
| Landing · Now boarding (desktop), Final call, 5 mobile states | `/board` (`components/flight/*`): header with EN · PT, hero per state, marquee, departures, how it works, Founding Members, example routes, footer with the risk notice |
| Landing · Handoff (states, data, events, behaviour, rules) | `src/flight/*`, `/api/board/*`, migration 0020 (below) |
| Peça 2 · Cartão (2 and 4 steps) + developer map | The Founding boarding pass, variable fields A–G from the holder's real pass |
| Peça 3 · Cartão de passageiro | The passenger pass once the 100 Founding seats are taken |
| Peça 4 · Not on the list | State 4 |
| Landing · OG | `app/board/opengraph-image.png`, the fixed 1200 × 630 board (no counter, as the handoff asks) |
| Gota options, style sheet | Artwork in `public/brand/flight/` (provenance and SHA-256 in `source.md`) |
| Posts 1–5 and calendar | Not code: every post links `flofi.xyz/board`, which now answers (the browser suite checks the page and its image) |

**Data (handoff → implementation).** `on_list` = beta-list entries; `boarded` = passes issued; `founding_left` = 100 − Founding passes;
`departures[]` = the last 5 passes whose holder chose to show them (handle, route, steps, seat — never an amount); `closes_at` =
2026-11-16 23:59 BRT; `opens_at` = the person's boarding group. **Events** (content-free daily counters, `flight_daily_events`): list_join,
board_click, access_result (list · invite · batch_closed · not_listed), route_example_click, prompt_submit, simulation_ok, share_click
(founding · passenger · not_listed), invite_redeem; origin list · invite · creator.

**Guarantees.** The 100 Founding seats are a database constraint (seat 1..100, unique) and every pass takes its numbers from the tenant's
`flight_issuance` row under its row lock (at most 100 Founding, ever): 260 concurrent requests for 130 accounts give exactly seats
#001–#100 and 30 passenger passes, and a deleted holder's seat or boarding number is never issued again (`store.pg.test.ts`). A pass is
issued only from the server's own record of a successful simulation by that signed-in, eligible account in the last two hours — the run
and the route the server projected from the workflow it simulated — so a browser can neither forge a pass nor add a step to its route.
The record is made by the flow runtime's simulation observer (`cloudFlow`, on the embedded and remote runtimes; `simulate` for every flow
and `prepare` for the catalog swaps on Ethereum, Base, Arbitrum and Robinhood Chain once the owner's preflight is in it), which the /app
server actions register; it records only a workflow of exactly one financial step (every mainnet service simulates one), cannot change,
fail or hold a simulation for more than two seconds, and logs a fixed outcome code. One pass per account; one entry per email (a repeat is answered exactly like
a new address); invites are single use, one per account, never one's own. The campaign gates only its own benefit: `/app` stays open
to everyone.

## Interpretations (where the boards are silent) — for the team to confirm

1. **Who "Board now" is.** "Pede e-mail ou carteira" is the existing FloFi account sign-in (Privy: email code, Google or a Web3 wallet).
   The list is matched by the account's verified addresses (email or Google/Apple email); a wallet-only account boards with an invite.
2. **When a pass is issued.** "simulation_ok (= cartão emitido)": at the first valid server-side simulation in /app by an eligible
   account during boarding (MCP and channel previews do not issue passes). Its route is what the server simulated, on mainnets only
   (ETH · BASE · ARB · SOL · RH): the whole workflow when FloFi simulates it at once (a composition), the first step when /app runs the
   workflow step by step — the server never sees later steps before they are simulated, so it cannot certify them. Extending a pass's
   route as later steps are simulated is a possible follow-up for the team to decide.
3. **Boarding groups.** An entry with no group boards when boarding opens (17 Nov, 9:00 BRT); the team creates later groups and assigns
   entries in joining order with the operator CLI. The boards define no group sizes or dates beyond the example (Group 3, 19 Nov).
4. **The night between the list closing and boarding** uses the approved Post 5 ("Gate closed. Boarding starts tomorrow. 9:00 BRT. See
   you on board."); the form then joins the next flight.
5. **Passenger seat.** The boarding number in the middle seat ("214E"). The passenger card's "Founding seats reopen tomorrow" is **not
   shown**: no such rule exists (the 100 seats are final), and showing it would promise one.
6. **More than 4 steps** shows 3 and "+N steps" (the developer map's proposal, marked "not yet tested" on the board).
7. **X handle** is optional, self-declared (not verified with X), and appears on the public departures board only if the holder ticks it.
8. **Invites.** 3 per Founding pass (the perk) plus invites the team issues (origin "creator"); none for passenger passes.
9. **"We'll email you"**: FloFi sends no email; the team exports each group's addresses (`export-batch`) and emails them.
10. **Not built** (no design or rule in the material): the Founding Members wall; early access in Claude/ChatGPT and Discord help are
    team operations. The footer's "Terms" link is omitted (FloFi has no Terms page); "Risks" links the Security guide.
11. **Portuguese** /board copy is a translation (the boards are English only), including stickers and the marquee — to be reviewed.
12. **Mascot poses** follow where the boards place them (A on the hero, C beside how it works and on Not on the list, B on the Founding
    card, the card and standby poses on the passes); the "Gota options" board still says "para escolha do time".

## Specialist review (flofi-security, flofi-data-privacy, flofi-workflow) and what changed

Read-only reviews of the first version found no blocker; their findings and the resolutions:

- **Route integrity and coverage** (workflow high, security low): EVM catalog swaps simulate through `prepare` and recorded nothing;
  sequence steps are simulated as projections the browser's canonical workflow did not match; and a browser could post extra,
  unsimulated steps into a pass's route. Now the server records the route it simulated and the pass carries that route; the browser only
  names the workflow in Review.
- **The flow runtime reached the account host** (the channel boundary suite caught `next/headers`, Privy and Turnkey in the shared workflow
  renderer's closure), and the hook was unbounded. Now `cloudFlow` calls an import-free observer slot (`server/simulation-observer.ts`),
  guarded and capped at two seconds (`flow-runtime.test.ts`), which the /app server actions register by importing the flow runtime
  through `app/cloud-flow.ts`. (A Next.js server-start hook was tried and dropped: its trace is shipped with every function and pulled
  test fixtures into it, which the function-package gate refuses.)
- **Seats and invites could be reissued** after an account deletion (and with them three more invites): `flight_issuance` keeps every
  number issued.
- **The pass lock was taken before eligibility**: ineligible or evidence-less requests are now answered before any lock.
- **The list form**: a request without a client digest escaped every limit (now counted under `NO_CLIENT` toward the deployment-wide
  limit); an IPv6 client is keyed by its /64; the join answer no longer carries the counter; the attempts count is time-bounded; the
  signed-in path stores only addresses the operator's `erase-email` accepts; the notice now says joining is agreeing.
- **Retention without traffic**: `prune` (page, at most every five minutes, and the operator CLI) enforces one day, two hours and 13
  months; `purge-lists` also clears attempts and evidence.
- **Return paths**: `safeReturnPath` refuses dot and empty segments (`/board/../..//evil.example`); an invite sign-in returns to the invite
  form.
- **Operator CLI**: a mistyped tenant is refused (never created); exported cells that a spreadsheet would read as formulas are written as
  text.
- **Release document**: corrected. A build shipping 0020 refuses a schema-19 database for every database feature (and the reverse), so
  Release A is its own PR and Vercel production deploys only after the API has migrated.

A second round (flofi-security re-review, flofi-frontend-ux, flofi-infrastructure-ci) found and fixed: a list entry could board again
after its account was deleted (entries are now marked boarded); a quote-only `prepare` and multi-step workflows could count as simulations
(now the owner's preflight and exactly one financial step); concurrent list requests of one client could pass its limit (per-client
lock); the server-start hook's trace shipped test fixtures with every function (replaced by action-side registration); on phones the
mascot covered the consent notice; the marquee could not be paused (WCAG 2.2.2); focus and live regions were lost on state changes; an
invite's confirmation was lost in the group-still-closed state; the consent sentence was not tied to the form; low-contrast colours; a
/board sign-in that left onboarding by another exit never asked for its pass; and the runbook lacked preconditions, the concrete Vercel
promotion steps and safe rollback targets.

Open for the owner and team (not decided by engineering): a confirmation step for list addresses (anyone can submit any address; the
team's first email is where a person can object); whether the exact public "on the list" counter is acceptable (comparing it before and
after submitting an address can hint that the address was new); invitees who take Founding seats receive 3 invites each (the boards'
perk), so one list member's invites can chain (one entry plus scripted wallet-only accounts could reach all 100 Founding seats); a free
quote is not enough, but any owner preflight is; plus-addressed aliases are separate list entries; a rotating-IPv6 flood can reach the
deployment-wide list limit (Vercel's firewall is the platform answer); Post 5's "Boarding starts tomorrow" is shown until 9:00 on the
day itself; the Discord link in the footer should be a non-expiring invite; the privacy page names CNPD (Portugal) for complaints.

## Privacy (LGPD/GDPR)

New processing is disclosed in `/privacy` ("Flight FloFi campaign", both languages; review date 5 Nov 2026) — to be signed off by the
owner/legal before launch. Stored: list email (lower-cased), language and notice version; a keyed digest of the client's network address for
one day (rate limit; never the address); simulation evidence for two hours (run, flow, workflow id and route, never an amount); the pass
(route, boarding number, optional public handle). These periods are enforced by `prune`, with or without traffic. Erasure: account
deletion cascades to pass and evidence and unlinks invite use; `erase-email` removes a list address; `purge-lists` ends the lists. The
team's email tool is a processor of exported addresses; an export is a new mode-0600 file kept only until the email is sent.

## Verification

`store.pg.test.ts` (12, real PostgreSQL: list and limits including requests without a client digest, every access state, invites,
evidence-bound issuance, a list entry boarding once (not again after account deletion or for a second account with the same address),
100 Founding seats under 260 concurrent requests, no reissue after deletion, departures privacy, erasure, retention, tenant isolation),
`flight-flofi-migration.pg.test.ts` (2), `campaign.test.ts` (9: dates, access, inputs, seats, route projection, the simulation record,
IPv6 /64 keying, CSV cells, the hosted refusal of the test clock, browser events), `flow-runtime.test.ts` (the observer never changes,
fails or holds a result), `account-session.test.ts` (return paths), and the `flight` browser profile `board.spec.ts` (8, embedded runtime,
MOCKED Privy and Jupiter, disposable database: all five states and their transitions at 1440 px and, in English and Portuguese, at 320 and
360 px with every heading, text, control and split-flap row inside the viewport; Board now → sign-in → onboarding → /app with the draft;
the operator CLI; an invite used once; a pass issued by a real simulation through the action-side observer; Founding full and the
passenger pass; every CTA, the posts' link and OG image; /login and /app). Release A's tree also ran `backend/schema-compatibility.pg.test.ts`
(API and worker across the 0020 fixture) locally. `scripts/function_traces.py` passes (largest function 45.3 MB). Local and loopback
evidence only on PostgreSQL 16 (CI runs 18.6, where one pre-existing 0015 assertion depends on catalogued NOT NULL constraints); CircleCI
certifies, and a public Preview of `/board` needs an isolated Preview database (see the release document).
