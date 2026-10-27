# FloFi: publication of PRs #127 and #128

Status: preparation and nonproduction certification only. The owner must separately authorize production deployment, migration and any
financial transaction. This document is the single rollout sequence for both PRs; it does not authorize production changes.

## Artifacts and scope

- Release A: #127, shared live estimates and recovery after confirmed USDC approval; ships schema 15 with the exact 0016 compatibility certificate.
- Release B: #127 + #128, schema 16, safe owner-history deletion/archive and a history mutation kill switch.
- Immutable migration: `0016_owner_history_purge.sql`, SHA-256 `a3c258cadd9d7865ad9d36d63ec0921fc47455bb3651c201074f3b0486b4be6f`.
- Public mainnets only; default slippage 100 bps; workflow fee 0.1%; no amount caps; no public MOCKED data; retain the `fast-uri@3.1.9` exception.
- No expansion to the remaining Caio findings or redesign. Approval confirmation alone never certifies Bridge execution.

## Before authorization

1. Require all CircleCI contexts on the exact final commits, clean integration with current main, unit/type/lint/build/schema checks and real
   PostgreSQL suites. Preserve the two independent PRs and attach evidence with tested source fingerprints.
2. Validate #127 on a branch-specific Vercel preview using embedded backend and a dedicated empty Neon project. No production database URL,
   session key, API token, wallet keys or copied production data. Compare the browser amounts to the same response and correlation ID,
   record genuine provider refusals and verify no execution/financial attempts were created. Quotes can be unavailable legitimately.
3. Certify #128 against real disposable PostgreSQL through Dashboard → authenticated server action → backend → database. Verify deletion
   of the run and dependent disposable data, immutable audit, financial evidence retention, other-wallet refusal, refresh, new session and
   writer resurrection refusal. Archive keeps financial observation/reconciliation available.
4. Verify 15 → 16 and Release A cold starts on 16. Inject a failing 0016 and prove transaction rollback. Do not use production data for this.
5. Verify approval → expired Review → refreshed quote/simulation → new Review in the same run. Preserve the confirmed approval and its hash;
   require explicit new authorization before preparing the deposit. Reject ambiguous/pending/deposit attempts and changed workflows.

## Authorized rollout, in order

1. **Backend/worker A first.** Publish the certified Release A to Railway API, worker and every embedded backend/operator consumer of the
   database. Vercel bundles its BFF and UI together: rebuild that artifact as A before 0016 so an old BFF cannot refuse the newer schema.
   This compatibility prerequisite is part of backend rollout; the final history frontend B still follows migration and backend verification.
   Its existing migration predeploy is a no-op on schema 15. Check health/readiness, schema ledger, real read-only quotes and worker
   observation. The pre-#127 production binary cannot be the rollback target after 0016. Do not activate the new history frontend yet.
2. **Compatible migration.** Run the exact Release B migrator once with a reviewed production connection, bounded lock timeout and the
   normal advisory lock. Verify ledger versions/hashes, readiness on A and B, unchanged existing records and active observation. Migration
   0016 is atomic and additive; it performs no historical purge. Stop on any ledger mismatch or compatibility failure.
3. **Backend/worker B.** Publish the integrated artifact with `FLOFI_OWNER_HISTORY=read-only`. Verify authorized history reads, hidden archive
   masks, tombstone guards and continuing reconciliation. Deletion/archive mutations should return `HISTORY_READ_ONLY`. Creation and
   simulation remain available. A B worker started prematurely refuses schema 15; hold it until migration succeeds.
4. **Frontend B last.** Publish the exact verified frontend and check Swap/Bridge estimates, real refusal messages, fees/slippage, and current
   Review behavior in a real browser. Check wallet isolation and history read disposition. Then, under the owner's production authorization,
   remove the history read-only switch and verify the feature with an explicitly approved disposable owned run. Never delete historical
   candidates automatically. If a canary is not authorized, leave mutations read-only and report that activation is pending.
5. **Financial verification is separate.** A real Bridge canary requires specific authorization of source/destination, assets, amount, wallet
   and fees. Evidence must include source deposit receipt and destination delivery/reconciliation. An approved USDC allowance or a live quote
   is insufficient. Until that evidence exists, report financial Bridge execution as uncertified.

## Rollback

| Point of failure | Action |
| --- | --- |
| A before migration | Restore the previous artifact; schema remains 15. |
| Migration fails | Transaction rolls back to 15; keep A running, do not release B. Resolve the lock/error and retry the exact migration. |
| Schema 16, before history mutations | Restore certified A if needed; retain schema 16 and the audit/guards. No downmigration. |
| After any deletion/archive | Set `FLOFI_OWNER_HISTORY=read-only`; keep B-compatible history readers/masks/tombstones. Restore only a certified B-compatible artifact; keep financial observation alive. |
| Quote/provider failure | Show the real provider state and correlation reference; do not substitute estimates or authorize an expired Review. |

Do not drop audit tables, disable append-only protections, restore deleted identities or roll schema back to 15. Rollback never reverses an
on-chain approval or deposit. Observe/reconcile any attempted deposit before considering another transaction; never retry blindly.

## Evidence boundaries

Local PostgreSQL and loopback-wallet browser tests prove application behavior with synthetic records. Hosted read-only mainnet quotes prove
provider access and displayed values at observation time. Neither proves a real source deposit or destination settlement. Test results,
CircleCI commits, hosted URL/correlation IDs and actual observations belong in the two build reports; pending steps must stay marked pending.
