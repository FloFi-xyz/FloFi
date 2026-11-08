# FloFi: release of BUILD-FLOFI-FLIGHT-001 (Flight FloFi at /board, migration 0020)

Status: preparation only. Nothing here was run against a production or shared database, and no production configuration was changed.
The owner separately authorizes every deployment, migration and configuration change below; this document authorizes none of them.

## Identities

| | Version | Name | SHA-256 |
| --- | --- | --- | --- |
| Base (current `main`) | 19 | `privy_accounts` | `aea36e602ba918a195d4bd110fda3b29459816fb76c25e0ddfdd29099847cab6` |
| This release | 20 | `flight_flofi` | `a7ce1f42753017de90eede9784a205bcd3b6fa0134b26eecb530dc2e505b2892` |

Assessment: [SCHEMA-COMPATIBILITY.md §14](./SCHEMA-COMPATIBILITY.md#14-certificate-0020_flight_flofi). 0020 adds eight `flight_*` tables and
nothing else; it is atomic and expand-only.

## Before authorization

1. **Production is exactly at schema 19.** Read-only: `SELECT version, name, sha256 FROM schema_migrations ORDER BY version` must list 1–19
   with the shipped SHA-256s (19 `privy_accounts` `aea36e60…`). If it is still at 18, finish [RELEASE-PRIVY-0019.md](./RELEASE-PRIVY-0019.md)
   first: a Release A build from current `main` ships 0019, so its pre-deploy would apply 0019 — that is 0019's release, not this one.
2. **CircleCI green on the exact commits**: the Release A commit (its own PR against `main`) and the final Release B commit. Release A
   re-activates `backend/schema-compatibility.pg.test.ts` (it runs whenever a certificate's base is the shipped head): API and worker
   across 0020 with live traffic.
3. **The platforms' auto-deploy settings** (not in this repository, not inspected here): whether a merge to `main` deploys Railway and
   Vercel Production on its own decides how step 2 of the release order is carried out.

## Infrastructure this needs

| Where | What | New? |
| --- | --- | --- |
| Neon (production database) | Migration 0020, applied by the Railway API pre-deploy (`node apps/reference-dapp/backend/main.ts migrate`) in Release B | Yes (schema only) |
| Vercel | No new required variable. `/board` uses `DATABASE_URL` (already set), `FLOFI_SESSION_SECRET` (already set: it keys the list form's rate-limit digest) and the Privy variables (already set) | No |
| Vercel | `FLOFI_FLIGHT_CLOCK_HARNESS` must **not** be set (it is a loopback test clock; hosted deployments ignore it anyway) | — |
| Vercel | Optional `FLOFI_FLIGHT_LIST_CLOSES_AT` / `FLOFI_FLIGHT_BOARDING_OPENS_AT` (ISO 8601 with offset) move the campaign calendar; unset = 11 Nov 23:59 BRT / 12 Nov 9:00 BRT (BUILD-FLOFI-UX-005) | Optional |
| Railway | No new service. The API pre-deploy migrates; the worker deploys after it (see the release order) | No |
| Email | FloFi sends no email. "We'll email you the moment it does" is the team's job: export a group with `flight-admin.ts export-batch` and send from the team's own tool | Process |

## Release order

0020 is applied by the first **Railway API deployment of any commit that contains `0020_flight_flofi.sql`** (its pre-deploy,
`node apps/reference-dapp/backend/main.ts migrate`). **The Flight FloFi PR must not be merged into a branch that deploys production
until Release A is live on every database consumer.** Why, in both directions:

- the schema-19 builds now in production carry no certificate for 0020: after 0020 is applied, any of them that checks the schema (cold
  start, readiness, a restarted worker, a rollback) refuses it with `MIGRATION_HISTORY_MISMATCH` — the whole product, not only `/board`;
- a Release B build (it ships version 20) on a database still at 19 refuses with `SCHEMA_NOT_MIGRATED` every database-backed feature
  (sign-in, accounts, cloud flows, MCP OAuth, the Developer API, approvals, Channels, `/board`) — again the whole product, not only `/board`.

1. **Release A (certificate first), its own PR against `main`.** The commit "Release A: certify migration 0020 before it ships" carries
   only the certificate (`CERTIFIED_FORWARD_MIGRATIONS`, base 19), its fixture and this documentation; `SHIPPED_MIGRATIONS` stays at 19.
   Run CI, then deploy it to **every** consumer of the production database: Railway API and worker, every embedded backend or operator
   process, and Vercel Production. Its `migrate` pre-deploy is a no-op on schema 19. Check `/readyz` and the logs
   (`migrate.applied versions=none schema_version=19`).
2. **Release B (the migration and /board)**: the Flight FloFi PR (against `main`; the launch landing it builds on is merged).
   1. **Railway API first.** Its pre-deploy applies 0020 once, in one transaction under the migration advisory lock; a failure rolls back
      to 19 and the deployment stops. Verify the ledger (below), `/readyz` on the new API, and that Release A processes still report ready
      on schema 20 (their certificate accepts it).
   2. **Worker and other backends** next (a restart is enough for Release A processes; they already accept 20).
   3. **Vercel Production last**, only after the API logged `migrate.applied versions=20`. As in
      [SCHEMA-COMPATIBILITY.md §4](./SCHEMA-COMPATIBILITY.md#4-rollout) step 2: before merging, turn off *Auto-assign Custom Production
      Domains* (or deploy with `vercel deploy --prod --skip-domain`) so the merge builds a staged deployment, and (recommended) pause the
      worker's auto-deploy; after the API has migrated, `vercel promote <url>` and resume.
   4. **Other open branches**: their Previews share production's database, so after 0020 any Preview built without the certificate refuses
      it (`MIGRATION_HISTORY_MISMATCH`). Once Release A is on `main`, merge `main` into open branches before Release B migrates.
3. **Verify** (read-only):
   - `SELECT version, name, sha256 FROM schema_migrations ORDER BY version DESC LIMIT 2` shows 20 `flight_flofi` with the SHA-256 above;
   - `https://flofi.xyz/board` answers 200 in Final call with "0 ON THE LIST"; `https://flofi.xyz/board/opengraph-image.png` is the image;
   - `node apps/reference-dapp/backend/flight-admin.ts stats --tenant default` (operator, `DATABASE_URL` of production) prints the counters.

## Vercel Preview of /board

Vercel Previews currently share production's `DATABASE_URL` (see [SCHEMA-COMPATIBILITY.md](./SCHEMA-COMPATIBILITY.md), "Previews share the
production database"). A Preview of the Flight FloFi branch on that database is at schema 19, so it refuses every database-backed feature
(`SCHEMA_NOT_MIGRATED`, as above) — `/board` shows "not available" and sign-in fails — and it must not be migrated from a Preview. A
working Preview needs a Preview-only `DATABASE_URL` for that branch (a new, empty Neon database or branch without production data), with
`FLOFI_MIGRATE_ON_BUILD=preview` so the Preview build migrates that dedicated database (`assertDedicatedPreviewDatabase` refuses a
database holding non-preview tenants). Both are owner decisions. On such a Preview database, operate with `--preview-branch <branch>`,
never `--tenant default`: rows written under `default` make it look non-dedicated, and the next Preview build refuses it
(`PREVIEW_DATABASE_NOT_DEDICATED`). The test clock is refused on every hosted deployment, so a Preview shows the real phase (Final call
until 11 Nov 23:59 BRT, or `FLOFI_FLIGHT_LIST_CLOSES_AT`); boarding is first exercised in production on 12 Nov 9:00 BRT (or
`FLOFI_FLIGHT_BOARDING_OPENS_AT`; see ENVIRONMENT.md, "Campaign calendar"). Check its runtime logs then:
`flight.observer.registered`, and `flight.evidence` with `outcome: recorded` for an eligible person's simulation.

## Operating the campaign (operator CLI, production `DATABASE_URL`, `--tenant default`)

| When | Command | Effect |
| --- | --- | --- |
| Any time | `stats` | Counters, lists by group, invites and the daily funnel (no address) |
| Before 12 Nov | `create-batch --batch 2 --opens-at 2026-11-19T09:00:00-03:00` then `assign-batch --batch 2 --count <k>` | Later groups. Entries with no group board when boarding opens (12 Nov, 9:00 BRT) |
| Before a group opens | `export-batch --batch <n> --out <new file>` | Addresses (a new mode-0600 file; values a spreadsheet would read as formulas are written as text) for the team's "your group boards" email. Keep the file only until the email is sent, then delete it; the email tool is a processor of these addresses |
| Any time | `issue-invites --count <n>` | Invites from the team (origin "creator"), shown once |
| On request | `erase-email --email <address>` | A data subject's erasure from both lists |
| Moderation | `hide-pass --pass <flp_…>` | Removes a handle from the public departures board |
| Daily (when `/board` has no visitors) | `prune` | Deletes expired records now (join attempts after one day, simulation evidence after two hours, counters after 13 months); `/board` also does this every few minutes while it is visited |
| End of the beta | `purge-lists` | Deletes every list entry, join attempt and simulation record |

## Rollback and ending the campaign

| Situation | Safe rollback target |
| --- | --- |
| Before 0020 is applied | Any earlier build (Release A or the current production one) |
| After 0020 is applied | Release A or any later build only. An older Vercel deployment (Instant Rollback) or Railway release without the certificate refuses schema 20 with `MIGRATION_HISTORY_MISMATCH` for every database-backed feature |

Keep the certificate; do not drop the `flight_*` tables. To take the campaign down, deploy a build that still ships 0020 but no `/board`
(or Release A, whose certificate accepts schema 20). The tables stay, unused. Then run `prune` — and, to end the campaign, `purge-lists`
— from a Release B checkout (Release A has no `flight-admin.ts`), since the page that prunes on its own is gone. The passes stay until
their accounts are deleted. The campaign has no end date in code: from 12 Nov (boarding) every eligible person's successful /app simulation is
recorded (a few queries, capped at two seconds); a build without `src/app/cloud-flow.ts`'s registration ends that.
