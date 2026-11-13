# BUILD-FLOFI-FLIGHT-EMAILS-1311-001 — Boarding emails for Friday 13 Nov

Branch: `claude/design-implementation-qwurbw`. Base: `origin/main` at `bef4419`.
Source: the Claude Design canvas "Flight FloFi · E-mails de embarque (13/11)" (version `1794538309-a79e`, boards 00–06).

Boarding moved from Thursday 12 Nov to **Friday 13 Nov, 09:00 BRT** (America/Sao_Paulo). This build changes only what the canvas lists.

## Implemented

| Email | Where | Before | After |
|---|---|---|---|
| 3, 4a, 4b, 5, 6 | Language | Recipient's stored locale (EN or PT) | **Portuguese for everyone** (`LAUNCH_LANGUAGE` in `templates.ts`), applied when the row is enqueued: `enqueueEmail` and the Email 3 scheduler. Emails 0, 1, 2 and the requested access email keep the stored locale. |
| 6 (`CREATOR_INVITE` v4 → **v5**) | Preheader | Seu código e como embarcar na quinta. | Seu código e como embarcar. |
| 6 | Boarding panel | NOV 12 09:00 (from the calendar) | ABERTO (EN: OPEN) |
| 6 | Step 1 | Quinta, a partir das 9h, entra em flofi.xyz/board, … | Entra em flofi.xyz/board, … (rest unchanged) |
| 3 (`GROUP_BOARDING` v2 → **v3**) | New paragraph right below the title, same `p()` style as the paragraph below it | (none) | Atrasamos um dia para corrigir alguns erros antes de abrir. Obrigado pela paciência. |

The English copy mirrors each change (preheader "Your code, and how to board.", step 1 "Go to flofi.xyz/board, …", panel `OPEN`,
Email 3 note "We held boarding back one day to fix a few bugs before opening. Thanks for your patience."), so English never names the wrong
weekday; nobody receives English for these emails while `LAUNCH_LANGUAGE` is set. The delay note is only in Email 3 (`GROUP_BOARDING`),
not in the essential "requested again" access email (`ACCESS_REQUESTED`, unchanged at v2).

Unchanged: subjects, layout, colors, fonts, gota images, buttons, links, variables, footers and quotas. Emails 4a, 4b and 5 are
byte-identical to before (asserted against the frozen renderer); their Portuguese text already matches board 06.

### One sending-logic fix the plan needs (found in specialist review)

Email 6 outbox rows used to expire when boarding opened (`expires_at = boardingOpensAt` in `inviteCreator` and
`creator-supersede-templates`). Housekeeping would cancel an Email 6 queued for 09:00 as `EXPIRED` before it was sent. A supersede run
after 09:00 would have cancelled the held v4 rows and created v5 rows that were already expired, with no CLI way back. Email 6 rows now
expire with the invite itself (30 days). Delivery still cancels the email once the invite is revoked or expired. `creator-supersede-templates`
no longer takes the boarding time. A PostgreSQL regression sends Email 6 and the superseded replacements after opening. It fails on the
old code.

### Versions and queued rows

- `templates-v4.ts` freezes the previous renderer (SHA-256 pinned in `templates.test.ts`). `renderEmailForVersion` keeps Email 6 v4
  inspectable; Email 3 v2 rows keep rendering with the frozen `templates-v2.ts`, byte-identical to before.
- Existing safety rules for Email 6 apply to v4 exactly as they did to v1–v3: delivery refuses a retired version with
  `TEMPLATE_VERSION_REVIEW`; housekeeping holds PENDING/HELD v4 rows; SENT, SENDING and UNKNOWN rows stay untouched. **Any Email 6 v4
  row still queued is held, never sent with the Thursday text.** The existing `creator-supersede-templates` (dry-run by default; `--apply`
  is an owner action) replaces eligible held rows with v5, keeping code and recipient, and now enqueues them in Portuguese.
- Email 3 rows already enqueued as v2 keep their v2 text and language until an operator runs `email-launch-upgrade` (below). Production
  had 48 such rows (22 EN, 26 PT), all PENDING with no attempt, reservation or lease, plus one CARD_FOUNDING v2 in English.

## Pre-launch operations (follow-up, operator-run; never run by this PR)

The runbook with the exact commands is [FLIGHT-1311-LAUNCH-RUNBOOK.md](../deploy/FLIGHT-1311-LAUNCH-RUNBOOK.md).

- **`email-launch-upgrade`** (`upgradeLaunchPending` in `outbox.ts`). This moves rows **in place**: unsent Email 3 v2 becomes v3 + PT,
  and unsent 4a/4b/5/6 rows in English become PT at the same version (`LAUNCH_UPGRADABLE_FROM` in `templates.ts`). It keeps `email_id`,
  which is the Resend idempotency key and also the seed of the access link, code and unsubscribe token. It also keeps `dedupe_key`,
  `recipient`, `not_before`, `expires_at`, the entry/pass/invite links and the batch. No row is created, so no duplicate can appear.
  - Eligible rows only: PENDING with `attempts = 0` and no `first_attempt_at`, `reserved_at`, lease, `provider_id` or `sent_at`.
  - Everything else is counted under `skipped` and left alone: SENT, SENDING, UNKNOWN, HELD, attempted or reserved rows.
  - Dry-run is the default. Apply refuses unless campaign email is paused and `--confirm-worker-deployed` is passed.
  - Apply runs under the quota advisory lock that `lease` takes, and re-checks every condition in the UPDATE itself.
  - Output for audit: counts before and after, the planned and updated ids, the skipped counts, and the guest/waitlist overlap.
  - A re-run is a no-op.
  - Email 6 v1–v4 are excluded: their copy changed, so they stay on the held-for-review / supersede path.
- **Deployment gate.** Old code cannot render v3. If a worker still on the old release leases a v3 row, it holds the row as `RENDER_FAILED`
  and never calls Resend. The command cannot see the worker's deployed commit from the database, so apply requires two things: the
  campaign paused (no worker leases campaign rows), and the operator's confirmation flag after checking the worker's active SHA in Railway.
- **`creator-requeue-missing`** (`enqueueMissingCreatorInvites`). For each active CREATOR invite (addressed, unredeemed, unrevoked,
  unexpired, not suppressed) with no Email 6 in PENDING/HELD/SENDING/UNKNOWN/SENT, it enqueues Email 6 v5 in PT.
  - It reuses the existing code and creates no invite.
  - The row is enqueued **HELD** (`OPERATOR_REVIEW`, batch `creators-v5`) and is sent only after `email-release --batch creators-v5`.
  - Its dedupe key `creator-v5:<code>` is the one `creator-supersede-templates` uses, so a code never gets two v5 rows from either path.
  - Dry-run reports every invite by status.
- **Guest also on the waitlist.** They receive Email 6 and Email 3, with two valid access paths. Neither blocks the other. Boarding
  cancels any Email 3 not yet sent (`BOARDED`). The recommended fix keeps access: cancel only that person's Email 3 by id before
  resuming. Their list entry and invite stay valid. The dry-run lists the overlap with a masked address and the Email 3 id.
- Tests: `launch-1311.pg.test.ts` (new suite `app.flight.launch-1311.pg`). It covers the dry-run changing nothing, both apply gates,
  two concurrent applies plus a concurrent lease (no double update, no new row, a reserved or leased row left as enqueued), preservation
  of every key and link, untouched SENT/SENDING/HELD/CANCELLED rows, idempotence, and an English waitlist entry receiving the PT v3 Email 3
  under its original id with the same link and code. For Email 6 it covers status counts, concurrent apply, no new invite, HELD until
  release, then PT v5 with the existing codes.

## Not done by this build (operator / owner actions)

No production query, configuration change, deployment, enqueue or email send was made. Still to do, as board 00 lists:

1. Set `FLOFI_FLIGHT_BOARDING_OPENS_AT=2026-11-13T09:00:00-03:00` on Vercel **and** the Railway worker (see
   [ENVIRONMENT.md](../deploy/ENVIRONMENT.md), "Campaign calendar"). The code default stays 12 Nov; the card date comes from `departedAt`.
2. Set batch 1 `opens_at` to Friday 13 Nov, 09:00 BRT.
3. Before 09:00: one Portuguese test of Email 6 and one of Email 3 to the team (Dayane), and wait for her OK.
4. Count today's sends against the Resend daily limit first; split Email 3 batches across days if needed and tell the team.
5. 09:00: Email 6 to invited guests only (manual, once, access already open), then Email 3 to the waitlist. Emails 0 and 1 are never
   resent; Email 2 is cancelled.

## Open points for owner review

- **Airport panels in Portuguese emails.** The canvas draws the Portuguese emails with English panels (`Invite code`, `Boarding`, `Gate`,
  `OPEN`, band `Flight FloFi · Invited` / `Now boarding`) and says they "stay in English". The repository's approved v2 convention
  (BUILD-FLOFI-FLIGHT-LAUNCH-ADMIN-001, enforced by `templates.test.ts`) renders them in Portuguese (`CÓDIGO DE CONVITE`, `EMBARQUE`,
  `PORTÃO`, `ABERTO`, `Convite`, `Embarcando`). This build keeps the repository convention, so the new Boarding value is `ABERTO`, matching
  the Email 3 Gate panel next to it. Switching the panels to English is a one-line-per-label change if the team confirms the canvas.
- **"Waitlist minus invited guests" for Email 3.** The scheduler still sends Email 3 to every un-boarded FIRST-flight list entry; the
  overlap is reported and handled by the operator (above), without changing who is scheduled.
- A retired Email 6 v4 row left in `SENDING` by a worker crash is not moved to `UNKNOWN` by lease recovery (only the current version
  is, an existing rule since v1–v3). It can never be resent; check `email-status` for `CREATOR_INVITE`/`SENDING` after deploy.
- Email 3's access note keeps the repository's documented wording ("confirma o seu embarque…, uma vez") rather than the canvas's older
  "entra com este e-mail", per `TEMPLATE_DEVIATIONS`.

## Evidence

Local evidence is in the PR description, run on Node 24.21.0 (official build, SHA-256 verified) and a disposable loopback PostgreSQL 16.
Tests use a fake provider, so delivery, inbox placement and the real Resend quota are not proven. CircleCI remains the certification
authority.

The first CircleCI run (`25ac8a6`) failed only at the governance gate's `git diff --check`, on a blank line at the end of
`templates-v4.ts`. The file now ends in one newline and its SHA-256 pin was updated: this frozen file had not been deployed yet.
