# BUILD-FLOFI-FLIGHT-LAUNCH-001 — Flight FloFi launch completion

Owner request (2026-11-09): complete the Flight FloFi campaign with the team's final decisions of 9 Nov 2026 — campaign email through Resend,
beta access by link and six-digit code, the seven approved emails, creators' early access, the final card flow and public card pages, and no
public aggregate count of people — as an extension of BUILD-FLOFI-FLIGHT-001, without changing financial execution, authentication or wallets.
Source: the team-approved Claude Artifact "Flight FloFi" (https://claude.ai/artifact/9swYNgCuDz4pmW93fbBWMD, version `1794236006-f919`,
read in full during engineering). Release: [RELEASE-FLIGHT-LAUNCH-0024.md](../deploy/RELEASE-FLIGHT-LAUNCH-0024.md). Operations:
[FLIGHT-EMAIL-RESEND.md](../deploy/FLIGHT-EMAIL-RESEND.md). Variables: [ENVIRONMENT.md §5n](../deploy/ENVIRONMENT.md).

## What was built

| Requirement | Implementation |
| --- | --- |
| Resend integration | `src/flight/email/resend.ts`: REST client, server-only key, `Idempotency-Key` = outbox email id, every answer classified (sent, rate limited, quota, configuration, rejected, idempotency conflict, unknown); domain status from `GET /domains` (or an operator attestation for a sending-only key) |
| Outbox, quota, delivery | Migration 0024 `flight_emails` + `src/flight/email/outbox.ts` + `delivery.ts`: intent rows written in the same transaction as their event, `dedupe_key` idempotency, atomic quota reservation under a per-tenant advisory lock (daily and monthly, configurable, room for external sends), whole-batch reservation (a batch that does not fit is held, never sent partially), leases fenced by token, crash recovery to UNKNOWN, same-key retries only inside the provider's 24-hour window, then HELD for an operator; validity expiry; suppression check at send time; pacing; provider quota/key stops |
| Worker | `backend/flight-email-worker.ts`, loaded by `main.ts worker` with `FLOFI_FLIGHT_EMAIL=enabled` (15-second cycle; scheduler for Email 2 and Email 3) |
| Seven emails | `src/flight/email/templates.ts` (versioned, EN/PT, tables with inline styles, PNG artwork in `public/brand/flight/email/`, plain-text part, List-Unsubscribe one-click). Status per email below |
| Access by link and code | `src/flight/access.ts`, `access-store.ts`, `/board/access` (Continue page, token in the URL fragment), `/api/board/access/{consume,code,request}`; claims bind a proven list entry to the signed-in FloFi account (or a 30-day HttpOnly browser session until sign-in) |
| Paths A/B/C | A: list → Email 1/2/3 → link/code → sign-in → simulation → card. B: creator invites with recipient (`creator-invite(s)`), Email 6, TEST flight 11 Nov 14:00–18:00 BRT (TEST card never stored), real boarding at 12 Nov 9:00. C: "Not on the list. Yet." with Join the next flight (Email 5) and the access forms |
| Founding/Passenger/invites | Unchanged numbering guarantees; invites only for a Founding seat boarded straight from the beta list (`carriesInvites`) — invited people never get invites; historical invites untouched |
| Card flow and public card | Handle step → card (Share on X with the approved text and the card's link, Download card, Copy link, invites) → `/card/{id}` (public, unguessable 60-bit id, noindex, OG/Twitter `summary_large_image`) → `/card/{id}/image` (server-rendered 1200 × 630; `?download=1` 1600 × 900 `flofi-boarding-card-042.png`) |
| No public counts | Removed from the landing, all states, PT/EN, accessibility labels, server HTML, `/api/board/state` (`foundingOpen` yes/no only), the Founding section, OG and emails; totals stay in `flight-admin.ts stats` |
| Operator tools | `flight-admin.ts` email-status/attention/release/cancel/pause/resume/unblock/mark-delivered/backfill-confirmations/send-due, creator-invite(s), remove-card, revoke-access (recipients masked) |
| Privacy | Notice version `2026-11-09`; EN/PT sections for campaign email (Resend as processor), access links, public cards, retention |

## The seven emails

| # | Template | Trigger | Status |
| --- | --- | --- | --- |
| 1 | `LIST_CONFIRMATION` | New beta-list entry (same transaction), once; `email-backfill-confirmations` for earlier entries | Implemented, tested (fake provider) |
| 2 | `EVE` | Scheduler at `FLOFI_FLIGHT_EVE_EMAIL_AT` (11 Nov 20:00 BRT) for un-boarded, not-unsubscribed beta-list entries; expires at boarding | Implemented, tested |
| 3 | `GROUP_BOARDING` (+ `ACCESS_REQUESTED`) | Scheduler when a group opens; link 72 h + code; Founding block only while seats are open; no counts | Implemented, tested |
| 4a | `CARD_FOUNDING` | Card issued (same transaction); card image, link, 3 invites when the holder has them | Implemented, tested |
| 4b | `CARD_PASSENGER` | Card issued | Implemented, tested |
| 5 | `NEXT_FLIGHT` | Join the next flight | Implemented, tested |
| 6 | `CREATOR_INVITE` | Operator `creator-invite(s)`, one per recipient, `--send-at` | Implemented, tested |

No real email was sent: Resend, DNS and Gmail forwarding are external steps (runbook). English wording changes the team must confirm are in
`TEMPLATE_DEVIATIONS` (templates.ts): Email 2 drops "routes have a small limit during the beta" (no such limit exists and this build adds no
barrier); Email 3 says the button "confirms your boarding" (it does not sign anyone in) and prints the code; Email 6 says a simulation is
enough (FloFi cannot promise nothing is signed); 4a/4b show the real card image. Portuguese bodies are a translation (the artifact has PT
subjects only). Email 0 (old Google Forms list) is outside the seven.

## Interpretations for the team

1. **Access is proven, not typed.** A list entry reaches an account only through a Privy-verified login email or a used link/code. Typing an
   address never grants anything. The campaign never gates `/app` (owner rule of this build overrides the artifact's `requireAccess()` plan).
2. **Email 3's code** lives as long as the link (72 h, single use, 5 wrong tries, rate limited per client and per address); a code requested
   at /board lives 15 minutes.
3. **Creators**: test window 14:00–18:00 BRT (artifact) rather than "from 14:00" open-ended; the TEST card is dated with the official boarding
   day (12 NOV 2026) and is never stored, numbered or shared.
4. **Quota day** is the UTC day; batches are reserved whole.

## Validation (this sandbox: Node 24.21.0, PostgreSQL 16 loopback, pinned Chromium headless shell 1243)

See the PR description for the exact commands and results. Not proven here: real delivery by Resend, DNS, X's crawler, Vercel/Railway
deployments, and the forward-compatibility PostgreSQL-18-only assertion (CI runs PostgreSQL 18).
