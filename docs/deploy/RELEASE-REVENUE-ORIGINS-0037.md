# Release: execution origins and the platform fee ledger (migration 0037)

BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001. Owner-run procedure. Nothing here signs, submits or moves funds. Every step is idempotent.
Schema facts: [SCHEMA-COMPATIBILITY.md §29](SCHEMA-COMPATIBILITY.md#29-certificate-0037_execution_origins_platform_fees).

## 0. Preconditions

- The production database is at exact schema 36 (`schema_migrations` head `36 studio_certification`).
- The build that carries the 0037 certificate is deployed to every database consumer (API, worker, web). Until step 1 it serves schema 36
  with origin recording, the backfill and the fee ledger dormant.

## 0b. Rehearse

Rehearse steps 1 to 3 on a disposable Neon branch of production with the dedicated SQL roles, and keep the catalog and verify reports.

## 1. Apply 0037

```bash
DATABASE_MIGRATION_URL=… node apps/reference-dapp/backend/admin-cli.ts revenue-origins-migrate --tenant default
```

Expected: `{"applied":[37]}`; a rerun applies nothing. A lock timeout (5 s) rolls back completely; retry later.

## 1b. Apply 0038 (authorized fee basis)

```bash
DATABASE_MIGRATION_URL=… node apps/reference-dapp/backend/admin-cli.ts revenue-collection-migrate --tenant default
```

Expected: `{"applied":[38]}` on exact schema 37; a rerun applies nothing. One table, `platform_fee_authorizations`
([SCHEMA-COMPATIBILITY.md §30](SCHEMA-COMPATIBILITY.md#30-certificate-0038_platform_fee_authorizations)). From here on every new execution records
the fee basis its Review disclosed; an execution without one is never charged.

## 2. Apply the schema-38 least-privilege policy

Apply `docs/deploy/database-privileges/apply.sql` with the updated `policy.sql` as described in
[DATABASE-LEAST-PRIVILEGE.md](DATABASE-LEAST-PRIVILEGE.md), then run `verify.sql`. The policy pins the schema-38 ledger, so it must be applied
after steps 1 and 1b, never before. Grants added by 0037: runtime `SI` on `execution_origins`; admin web `S` on the three new tables; admin
operations `SI` on the three new tables and `S` on `workflow_run_steps`. Added by 0038: runtime `SI` on `platform_fee_authorizations` and `SI`
plus column `UPDATE (state, collection, version)` on `platform_fee_ledger` (collection runs in the API and worker through the ledger's checked
transitions); admin web and admin operations `S` on `platform_fee_authorizations`.

Run step 2 immediately after step 1b. In between, on a database enforcing the schema-36 policy, origin and authorization writes fail quietly
(nothing breaks; those executions keep no origin and can never be charged) and the Admin fee and channel panels are unavailable.

Rehearsal (2026-11-28, Neon branch `revenue-0037-rehearsal-20261128` of production): 0037 and 0038 applied in the runner's transaction shape
(advisory lock, exact-head guard, lock timeout); the resulting 38-entry history hashes to the schema-38 policy's `ledger_sha256`. The branch holds
a copy of production data: delete it when no longer needed.

## 3. Recover historical origins (dry run first)

```bash
DATABASE_ADMIN_OPERATIONS_URL=… node apps/reference-dapp/backend/admin-cli.ts origin-backfill --tenant default \
  --approvals-complete-since <oldest retained approval, ISO>
```

The dry run reports every root single-flow run without an origin by class: `BOUND` (an approval bound it), `NO_APPROVAL` (no approval page
could have created it: Legacy Web), `AMBIGUOUS` (an approval could have; stays Unknown), `CONFLICTING_BINDINGS`, `BEFORE_COMPLETE_HISTORY`.
`--approvals-complete-since` must not precede the oldest retained approval (the command refuses with `ORIGIN_BACKFILL_HISTORY_INCOMPLETE`).
An applied approval can produce runs until retention removes it (30 days), so by default only runs created 31 days after the oldest retained
approval can be proven approval-free. If the owner confirms that no approval was ever removed (retention never ran), add
`--assert-approvals-never-purged` (recorded in the audit event); the horizon is then one day:

```bash
… origin-backfill --tenant default --approvals-complete-since <same> --assert-approvals-never-purged --apply --approval-ref <owner approval reference>
```

It writes only missing origins (first record wins) and one `EXECUTION_ORIGINS_BACKFILLED` audit event, never changes an execution, its
evidence, amounts or timestamps, and never creates a fee obligation. A rerun records nothing.

Read-only pre-check on production (2026-11-27, SQL equivalent of the dry run, nothing written): 78 reconciled root single-flow mainnet runs;
70 `NO_APPROVAL` (would be Legacy Web), 5 `AMBIGUOUS` (stay Unknown), 2 bound to MCP approvals, 1 a workflow-run step (not an execution).
The 36 retained approvals start 2026-10-09T23:04:09Z, before the first mainnet run (2026-10-11T22:14:24Z), and 20 are older than 30 days, so
retention has removed nothing since 2026-11-08; whether anything older was ever removed cannot be proven from the database, so the short horizon
needs the owner's `--assert-approvals-never-purged`. Without it, the default 31-day horizon recovers only runs from 2026-11-09 on. The exact
figures are the command's own dry-run output after step 2.

A run that automated evidence cannot resolve can be corrected only with an approval reference (audit trail; the recorded origin is never
rewritten):

```bash
… origin-correct --tenant default --run <run id> --origin <web|legacy_web|mcp_chatgpt|mcp_claude|mcp_other|telegram|developer_api|automation|unknown> \
  --reason-code <CODE> --approval-ref <ref>
```

## 4. Fee accounting and collection (owner decision; off until approved)

Collection is a separate owner-authorized transfer after completion (`src/platform-fee/settlement.ts`): for each fee asset the owner signs one plain
transfer from their own wallet to the FloFi treasury through FloFi's existing reviewed transfer flows (EVM native/ERC-20 on Ethereum, Base,
Arbitrum One and Robinhood Chain; SOL/USDC/USDT on Solana). The amount is at most what the Review disclosed (0038) and at most the final basis.
Nothing is collected without a reconciled transfer to the recorded treasury; nothing is charged for a failed, rejected, expired or cancelled
execution; nothing is charged twice (one open attempt at a time, compare-and-set on the ledger).

Activation needs ALL of these on the API and worker (Railway) and on the web deployment (Vercel, for the Review's line):

| Variable | Value |
|---|---|
| `FLOFI_PLATFORM_FEE_ACCOUNTING_FROM` | the instant accounting starts (never in the past; nothing earlier is accounted) |
| `FLOFI_PLATFORM_FEE_COLLECTION` | `on` |
| `FLOFI_PLATFORM_FEE_TREASURY_EVM` | the owner-verified EVM treasury, checksummed. Must be an EOA if native ETH fees on Base or Robinhood Chain are to be collected (those transfer profiles refuse contract recipients) |
| `FLOFI_PLATFORM_FEE_TREASURY_SOLANA` | the owner-verified Solana treasury (on-curve wallet, not a PDA) |
| `FLOFI_PLATFORM_FEE_POLICY_APPROVAL` | the approved financial policy reference |

With collection active the worker accrues completed executions each minute and reconciles open collection attempts. Without it, the operator
command still accrues on demand:

```bash
DATABASE_ADMIN_OPERATIONS_URL=… FLOFI_PLATFORM_FEE_ACCOUNTING_FROM=… node apps/reference-dapp/backend/admin-cli.ts platform-fee-accrue --tenant default
… platform-fee-accrue --tenant default --apply
```

Monitoring: logs `platform_fee.accrued`, `platform_fee.settlement_open`, `platform_fee.settlement_refused`, `platform_fee.reconciled`,
`platform_fee.sweep_failed`; the Admin fee panel (states, accrued per asset, collected per asset from transactions). Kill switch:
`FLOFI_PLATFORM_FEE_COLLECTION=off` stops new attempts immediately; open attempts keep being reconciled. A divergent transfer stops automatic
retries for that execution (attention) until reviewed.

## Before any fee policy change

Run a complete `platform-fee-accrue --apply` pass first. Accounting never starts before the current policy's effective instant, so completions
of the earlier policy that were never accrued are not accounted afterwards.

## Rollback

- Collection: `FLOFI_PLATFORM_FEE_COLLECTION=off`. Accounting: unset `FLOFI_PLATFORM_FEE_ACCOUNTING_FROM`; nothing new is accrued, existing rows stay.
- Code: roll back to a build that carries this certificate; it serves schema 37. A 0036-only binary refuses schema 37.
- Emergency schema reversal (0037 as head only): `docs/deploy/RELEASE-REVENUE-ORIGINS-0037.reversal.sql` as the migration owner (refuses
  while any fee is owed or collected), then restart every consumer and re-apply the schema-36 policy (`ca62ace`). Origins are lost; nothing
  else changes.
