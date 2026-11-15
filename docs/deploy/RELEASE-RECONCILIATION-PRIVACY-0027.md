# FloFi: release of BUILD-FLOFI-RECONCILIATION-PRIVACY-UX-001 (nonce-conflict reconciliation, Support privacy, Admin login; migration 0027)

Status (2026-11-15): **Release A has been merged and deployed; Release B remains in preparation.** Release A was merged via [PR #197](https://github.com/FloFi-xyz/FloFi/pull/197) at `8b03736c513c3a3c17917f6a3533acd3a1af3499`. The Railway API and worker deployments report SUCCESS, the Vercel Production deployment reports READY, and a read-only Neon query still shows schema version 26. These deployment status checks do not replace the release-time `/readyz` and worker log checks. PR #192 (production hotfix, `2c61ce7`) was merged and deployed after it; that build also carries the certificate. The owner has authorized Release B end to end (merge, schema 0027 on Neon, Railway API, worker and Vercel), following the controlled procedure in the release order below. Build report: [BUILD-FLOFI-RECONCILIATION-PRIVACY-UX-001](../builds/BUILD-FLOFI-RECONCILIATION-PRIVACY-UX-001.md).

## Identities

| | Version | Name | SHA-256 |
| --- | --- | --- | --- |
| Base (current `main`) | 26 | `flight_early_list` | `51fc9c3195ba179a4068b7c66a267216ed102d0a65f1c59a6e94fd8fb34f10c8` |
| This release | 27 | `reconciliation_privacy` | `6edd545c5f7076aa85468c52e79a198df187af71001793695675527f5f96c069` |

Assessment: [SCHEMA-COMPATIBILITY.md §19](./SCHEMA-COMPATIBILITY.md#19-certificate-0027_reconciliation_privacy). Additive: six new tables
with their own functions, triggers and indexes; nothing pre-existing changes.

## Configuration

**No variable is required.** Two optional variables exist; leave them unset unless counsel approves different periods:
`FLOFI_SUPPORT_TEXT_RETENTION_DAYS` (Vercel, where the Admin runs; default 365) and `FLOFI_SUPPORT_LOOKUP_RETENTION_DAYS` (operator shell for
the CLI dry run; default 365). Neither deletes anything: destructive retention needs an approved activation through the operator CLI.

## Release order (Neon, Railway API, Railway worker, Vercel)

A build that ships 0027 on a database at 26 refuses every database-backed feature (`SCHEMA_NOT_MIGRATED`), and a build without the certificate
refuses a database at 27 (`MIGRATION_HISTORY_MISMATCH`). So:

1. **Release A — completed.** [PR #197](https://github.com/FloFi-xyz/FloFi/pull/197) merged the schema 0027 forward-compatibility certificate (including the independent `packages/cloud-runtime/test/certificate-0027.pg.test.ts` regression test and fixture) without shipping migration 0027. The merged Release A commit is `8b03736c513c3a3c17917f6a3533acd3a1af3499`. Railway API, Railway worker and Vercel Production have deployments for this commit reporting SUCCESS, SUCCESS and READY respectively; Neon remains on schema 26. **Before deploying Release B, verify that the exact Release A commit is actively serving in every production consumer, the API and worker are healthy (`/readyz`, startup/work processing and deploy logs), and the schema is still 26.** If any consumer has moved to an incompatible commit, stop and reassess rather than migrating.
   **Controlled procedure for Release B (owner-authorized, 2026-11-15).** Railway API, Railway worker and Vercel Production all deploy
   automatically and concurrently from `main` (Railway `checkSuites: false`; Vercel Production has its own `DATABASE_URL`). On the PR #192
   merge the worker went live 10 s *before* the API, so a plain merge could start Release B consumers on schema 26
   (`SCHEMA_NOT_MIGRATED`). Instead, 0027 is applied to Neon **before** the merge, while every consumer still runs `2c61ce7` (Release A
   certificate + PR #192), which serves schema 27 by certificate. The transaction mirrors `migrate()` exactly: `pg_advisory_xact_lock(7340032001)`,
   a guard that aborts unless the ledger is exactly the shipped 1–26 (version, name, SHA-256), the statements of
   `0027_reconciliation_privacy.sql` (its own `SET LOCAL lock_timeout = '5s'` first), then the ledger row `(27, reconciliation_privacy,
   6edd545c…c069)`. It was rehearsed on disposable PostgreSQL (schema dump identical to applying the file whole; a second run is refused by
   the guard; the Release B runner then reports `versions=none schema_version=27`). After the merge, each consumer starts on schema 27 in any
   order and the API pre-deploy is a no-op (`migrate.applied versions=none schema_version=27`).
2. **Release B — this PR**, only after Release A is live everywhere (the generic order below; see the controlled procedure above):
   1. **Railway API** deploys first; its pre-deploy applies 0027 once (one transaction under the migration advisory lock, `lock_timeout 5s`; a
      failure rolls back to 26 and the previous deployment keeps serving — retry in a quieter moment). Check `migrate.applied versions=27`.
   2. **Railway worker** next. From now on, a run whose observation ends in a nonce conflict is investigated read-only and paced. Runs whose
      check already stopped (Incidents A and B: `OBSERVATION_BUDGET_EXHAUSTED`) are **not** touched automatically: they stay as they are until an
      operator chooses *Resume transaction check* (see below).
   3. **Vercel Production** last (Admin pages: investigation section, separate note/reason text, period lookup keys, login fix). Until it is
      live, the Release A Admin keeps working on schema 27 (it never reads the new tables). A note written by Release B is not listed by a
      Release A Admin and a reason shows as "—" (it reads the old inline fields) — display only, during the overlap. Notes written through a
      Release A Admin meanwhile are stored inline in the audit table (outside the new controls); keep the overlap short.
3. **Verify (read-only):** `/admin/login` in light and dark mode (no white strip); Support → a run → *Diagnose* renders; Support search
   works (a quarter key row appears in `admin_lookup_keys`); `admin-cli.ts retention-report --tenant default` returns `dryRun: true` with
   `basis: PROPOSED_NOT_ACTIVE` for both policies. **Do not** run `retention-activate` or `retention-apply` without the legal approval below.

## Incidents A and B after deployment (operator, optional, read-only)

For `xuni-379461c2e3f1807a0dc0455342a51d21` and `xroute-a09617c2bb8ac5469cab1fc955a3fd32`: Support → *Diagnose* → *Resume transaction check*
(preview, reason, confirm). The worker then observes once more, investigates read-only and shows *Nonce-conflict investigation*. It cannot
sign, submit, replay or decide the outcome; it may take a few minutes (bounded scan windows every 30 s) and, with unchanged evidence, stops
again for review after 24 h with `NONCE_CONFLICT_STABLE_OPERATOR_REVIEW`. Record a *Finding* note with the classification. Each resume
counts toward the limit of 3 per execution per 7 days.

## Activating retention (separate, owner + counsel)

Only after counsel approves the periods and bases (build report §5.4): `retention-report` (dry run) → review the counts →
`retention-activate --policy SUPPORT_TEXT --days <approved> --approval-ref <reference>` → `retention-apply --policy SUPPORT_TEXT`, and likewise
`LOOKUP_KEYS`. Place legal holds first for anything under dispute (`legal-hold`). Applying is audited (`PRIVACY_RETENTION_APPLIED`, counts
only) and never touches execution records or the audit skeleton. Backups keep deleted data until their window passes.

## Rollback

- **Application rollback** (any time): redeploy Release A on Railway API, worker and Vercel. It serves schema 27 by certificate. The worker
  returns to the previous observation cadence (no investigation, no escalation); runs escalated with `NONCE_CONFLICT_STABLE_OPERATOR_REVIEW`
  stay flagged and Release A's Admin explains the code as unknown — resume them only with Release B, or leave them for review. Texts in
  `admin_support_texts` remain (not shown by Release A); nothing is lost.
- **Do not** roll back to a build older than Release A once 0027 is applied: it refuses schema 27.
- **Emergency reversal of 0027** (last resort, owner decision, after rolling every consumer back to Release A): it deletes every investigation
  record, Support text written since Release B, lookup key, hold, request and activation. The audit skeleton keeps its references. **Refuse
  it while any legal hold is active** (`SELECT count(*) FROM privacy_legal_holds WHERE released_at IS NULL` must be 0) and only when 0027 is the
  newest row of `schema_migrations`; export `admin_support_texts`, `privacy_requests`, `privacy_legal_holds` and
  `privacy_retention_activations` first. In one transaction, starting with `SET LOCAL lock_timeout = '5s';`: `DROP TABLE execution_nonce_conflicts, admin_support_texts, admin_lookup_keys, privacy_requests, privacy_retention_activations,
  privacy_legal_holds; DROP FUNCTION admin_support_text_guard(), admin_lookup_key_transition(), privacy_request_transition(),
  privacy_retention_activation_transition(), privacy_legal_hold_transition(), reject_privacy_truncate(); DELETE FROM schema_migrations WHERE version = 27 AND
  sha256 = '6edd545c5f7076aa85468c52e79a198df187af71001793695675527f5f96c069';`.
