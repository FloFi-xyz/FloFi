# FloFi: release of BUILD-FLOFI-FLIGHT-LAUNCH-001 (Flight FloFi launch completion, migration 0024)

Status: **preparation only**. Nothing here was run against a production or shared database, Resend, DNS, Vercel or Railway, and no
production configuration was changed. The owner separately authorizes every deployment, migration and configuration change below.

## Identities

| | Version | Name | SHA-256 |
| --- | --- | --- | --- |
| Base (current `main`) | 23 | `user_funded_groups` | `aea46318eee01184af97a814bb88a19dd0a1ad60e9b64b6079de39d7a6b7594e` |
| This release | 24 | `flight_launch` | `a9def02ddd0ec6ccd89181dc51d9f7f50a20b9265feec8b236abd9e4a3fa7bc0` |

Assessment: [SCHEMA-COMPATIBILITY.md §18](./SCHEMA-COMPATIBILITY.md#18-certificate-0024_flight_launch). Additive: seven new `flight_*`
tables, three nullable columns, two partial unique indexes.

## Release order (Neon, Railway, worker, Vercel)

A build that ships 0024 on a database at 23 refuses every database-backed feature (`SCHEMA_NOT_MIGRATED`), and a build without the
certificate refuses a database at 24 (`MIGRATION_HISTORY_MISMATCH`). So:

1. **Release A — certificate first.** The commit `RELEASE A: schema 0024 compatibility certificate` of this branch carries only the
   certificate (`CERTIFIED_FORWARD_MIGRATIONS`, base 23), its fixture and §18; `SHIPPED_MIGRATIONS` stays at 23. Cherry-pick it onto `main`
   (its own PR, owner's decision), run CI, and deploy it to **every** consumer of the production database: Railway API and worker, Vercel
   Production. Its `migrate` pre-deploy is a no-op on schema 23. Check `/readyz` and `migrate.applied versions=none schema_version=23`.
2. **Release B — this PR**, only after Release A is live everywhere:
   1. **Variables first** (no effect until the code ships): Vercel Production `FLOFI_FLIGHT_ACCESS_SECRET`; Railway worker
      `FLOFI_FLIGHT_ACCESS_SECRET` (same value), `RESEND_API_KEY`, `FLOFI_FLIGHT_EMAIL=enabled` and the calendar variables Vercel has (see
      [ENVIRONMENT.md §5n](./ENVIRONMENT.md)). Leave `FLOFI_FLIGHT_EMAIL` unset if Resend/DNS (runbook §2–§5) is not verified yet: then no
      email is sent and everything else works.
   2. **Railway API** deploys first; its pre-deploy applies 0024 once (one transaction, migration advisory lock; a failure rolls back to 23).
      Verify the ledger (below) and `/readyz`.
   3. **Railway worker** next. Logs: `flight.email.worker_enabled` (or `worker_disabled` with the missing setting's code).
   4. **Vercel Production last**, after the API logged `migrate.applied versions=24` (staged deployment, then `vercel promote`, as in
      SCHEMA-COMPATIBILITY.md §4). Previews sharing production's database must have Release A merged first.
3. **Verify (read-only):**
   - `SELECT version, name, sha256 FROM schema_migrations ORDER BY version DESC LIMIT 1` → 24 `flight_launch` `a9def02d…`;
   - `https://flofi.xyz/board` answers 200 with **no count of people** (view source: no "ON THE LIST", "BOARDED" or "SEATS LEFT");
     `curl -s https://flofi.xyz/api/board/state` has no `counters`;
   - `node apps/reference-dapp/backend/flight-admin.ts email-status --tenant default` shows the limits and no held email;
   - after the runbook's §7 test send: SPF/DKIM/DMARC pass in Gmail and Outlook.
4. **X preview:** once a real card exists, paste its `https://flofi.xyz/card/<id>` into a post draft on X (the Card Validator's preview now
   lives in the post composer) and confirm the large card image. `curl -s https://flofi.xyz/card/<id> | grep -E 'og:image|twitter:card'` must show
   `summary_large_image` and `https://flofi.xyz/card/<id>/image`. Not done during engineering (no public deployment).

## Rollback (never deletes list entries, cards or emails)

| Situation | Safe action |
| --- | --- |
| Email misbehaves | `flight-admin.ts email-pause` (immediate, no deploy) or unset `FLOFI_FLIGHT_EMAIL` on the worker and restart it. Pending emails stay in the outbox (`email-cancel` withdraws them if the team decides). |
| Access links or cards misbehave | Roll Vercel back to **Release A** (it accepts schema 24): `/board` returns to the 0020 behavior (public counters, no access links, no card pages). No data is removed. |
| Before 0024 is applied | Any earlier build. |
| After 0024 is applied | Release A or later only (an older build refuses schema 24). Keep the tables; do not reverse the migration. |

Ending the campaign: `flight-admin.ts purge-lists` deletes lists, outbox, access records; cards stay with their accounts; unsubscribe digests
stay so an opt-out keeps being honored.
