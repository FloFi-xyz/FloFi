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
- Email 3 rows already enqueued as v2 (if boarding was scheduled under the old date) keep their v2 text and language: retries must
  keep the provider idempotency payload. Inspect `email-status` before 09:00 if the worker ran past the old opening.

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
- **"Waitlist minus invited guests" for Email 3.** The scheduler sends Email 3 to every un-boarded FIRST-flight list entry. An invited
  guest who is also on the list and has not boarded would get both emails. This build does not change sending logic; check the overlap
  before 09:00.
- A retired Email 6 v4 row left in `SENDING` by a worker crash is not moved to `UNKNOWN` by lease recovery (only the current version
  is, an existing rule since v1–v3). It can never be resent; check `email-status` for `CREATOR_INVITE`/`SENDING` after deploy.
- Email 3's access note keeps the repository's documented wording ("confirma o seu embarque…, uma vez") rather than the canvas's older
  "entra com este e-mail", per `TEMPLATE_DEVIATIONS`.

## Evidence

Local only (Node 22.23.4 here; the pinned toolchain is Node 24.21.0): Flight and backend unit suites 93/93; database-backed suites on a
disposable loopback PostgreSQL 16 (`launch.pg`, `flight-admin.pg`, `beta-access.pg` and the other Flight `*.pg.test.ts`) 142/142 in the
combined run (now 135/135 with the Email 6 opening regression). Tests use a fake provider: delivery, inbox placement and the real Resend quota are not proven. CircleCI remains the
certification authority.
