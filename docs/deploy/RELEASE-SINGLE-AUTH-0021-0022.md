# FloFi: release of single-authorization workflow runs (migrations 0021 and 0022)

BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001. Two releases, certificate first, as for 0018, 0019 and 0020. After Release B, delegated
execution is activated by configuration alone ([SINGLE-AUTH-MAINNET-ACTIVATION.md](./SINGLE-AUTH-MAINNET-ACTIVATION.md)).

## Identities

| | Version | Name | SHA-256 |
| --- | --- | --- | --- |
| Base (production and current `main`) | 20 | `flight_flofi` | `a7ce1f42753017de90eede9784a205bcd3b6fa0134b26eecb530dc2e505b2892` |
| Release B | 21 | `workflow_grants` | `07a789dc1b6fb10c2fe46430342845946fbc1f06e176cbbab78102d66ed044a7` |
| Release B | 22 | `editor_requester` | `f5b05c8bd32bf70bfa95e2b6ecc075b909f604334a13188c1651c2bd31e16d43` |

Assessment: [SCHEMA-COMPATIBILITY.md §15](./SCHEMA-COMPATIBILITY.md#15-certificate-0021_workflow_grants) and §16. Both migrations are
additive: no table is dropped, no row changes, and every row valid at schema 20 stays valid.

## Production state (read-only check, 2026-11-06)

- Neon `Flofi` (default branch): `schema_migrations` 1–20, newest `20 flight_flofi a7ce1f42…`.
- Vercel `flofi` Production, the Railway API (`flofi-api`) and the Railway Worker (`flofi-worker`) all run `5a85832` (main). `flofi.xyz` and
  `wallet.flofi.xyz` are aliases of that Production deployment.
- All three services deploy `main` automatically on merge.

## Release A: the certificate

Its own PR against `main`, carrying only:

- the certificate `{ base: 20 flight_flofi, migrations: [21 workflow_grants, 22 editor_requester] }` in `CERTIFIED_FORWARD_MIGRATIONS`;
- the exact bytes as `packages/cloud-runtime/test/fixtures/0021_workflow_grants.sql` and `0022_editor_requester.sql`;
- the assessment (SCHEMA-COMPATIBILITY.md §15–16) and this document.

`SHIPPED_MIGRATIONS` stays at 20, so its `migrate` pre-deploy is a no-op. With the certificate active, `backend/schema-compatibility.pg.test.ts`
runs the API and worker across the two fixtures on PostgreSQL.

1. CircleCI green on the PR, then merge. The merge deploys Vercel Production, the API and the worker.
2. Check: the API logs `migrate.applied versions=none schema_version=20`; `/readyz` answers 200; all three services report the same commit.

## Release B: the feature and the migrations (PR 166)

Merge `main` (with Release A) into the PR branch first, so it carries the same certificate. Then, with CircleCI green, merge.

1. The **Railway API** pre-deploy applies 0021 and 0022 once, each in its own transaction under the migration advisory lock. A failure rolls
   back that migration and stops the deployment. Release A processes keep serving: their certificate accepts schema 21 and 22.
2. The **worker** and **Vercel Production** deploy from the same merge. If the new Vercel deployment becomes ready before the API has
   migrated, its database-backed features answer `SCHEMA_NOT_MIGRATED` for those minutes. The 0020 release did not hit this: the API applied
   0020 80 seconds after its deployment started (22:10:01 UTC), and Vercel Production was ready about a minute later (22:11:06 UTC).
3. Verify (read-only):
   - `SELECT version, name, sha256 FROM schema_migrations ORDER BY version DESC LIMIT 3` lists 22 and 21 with the SHA-256s above;
   - the row counts of `credential_grants` and `delegated_authorization_revisions` are unchanged by the migration;
   - `/readyz` (API) and `https://flofi.xyz/api/flofi/readiness` report the merge commit; the worker's deployment is that commit;
   - `flofi.xyz` and `wallet.flofi.xyz` alias the new Production deployment.

Without delegation variables the product is unchanged after Release B: every run offers "Confirm each step", and "Authorize the whole
workflow once" shows `DELEGATION_NOT_ENABLED`. Activation is the next, configuration-only step.

## Rollback

| Situation | Safe rollback target |
| --- | --- |
| Before 0021/0022 are applied | Any earlier build |
| After 0021/0022 are applied | Release A or any later build. An older Vercel deployment or Railway release without the certificate refuses schema 22 (`MIGRATION_HISTORY_MISMATCH`) |

Keep the certificate. Do not revert the migrations: they are additive, and Release A runs unchanged on schema 22.
