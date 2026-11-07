# User-funded workflow execution: deployment, verification and rollback

BUILD-FLOFI-UNIVERSAL-WORKFLOW-002 ([ADR-0008](../adr/ADR-0008-user-funded-execution.md)). This runbook deploys user-funded execution groups
and retires the FloFi-funded delegated executor. It **supersedes §2–§3 of [SINGLE-AUTH-MAINNET-ACTIVATION.md](./SINGLE-AUTH-MAINNET-ACTIVATION.md)**:
the executor is never funded and never sends anything any more.

Steps marked **[OWNER]** change production, create a paid resource or move real funds; nothing here was performed during engineering.

## 0. What changes

- Every network fee of a user workflow is paid by the owner's own wallet (invariant S1). FloFi funds, advances, sponsors and reimburses nothing.
- New run mode `USER_FUNDED`: execution groups, one wallet interaction per group per chain (EIP-5792 atomic batch, the owner's own ERC-4337
  user operation, one Solana sign-all request), other steps through their own flows. Off unless `FLOFI_USER_FUNDED_EXECUTION=enabled`.
- The delegated executor can no longer send, sign for, or pay for anything (`EXECUTOR_GAS_PAYER_REFUSED`); new delegated authority is
  refused at the product boundary (`EXECUTOR_FUNDED_GAS_RETIRED`). Confirm-each-step runs and owner-confirmed automations are unchanged.
- Migration 0023 (additive): `workflow_runs` admits `USER_FUNDED`; new table `workflow_run_groups` (DB-checked fee payer = run wallet).

## 1. Pre-flight (read only)

1. Confirm production is at schema 22 and the constraint names 0023 replaces exist:
   ```sql
   SELECT version, name FROM schema_migrations ORDER BY version DESC LIMIT 1;           -- 22 editor_requester
   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'workflow_runs'::regclass
     AND conname IN ('workflow_runs_mode_check', 'workflow_runs_check3');              -- both rows; keep both definitions (rollback §8)
   ```
   (Verified read-only on 2026-11-07: both present with the 0015 definitions.)
2. Confirm nothing depends on the executor:
   ```sql
   SELECT count(*) FROM delegated_authorizations;   -- 0 on 2026-11-07
   SELECT count(*) FROM delegated_executions;        -- 0
   SELECT count(*) FROM credential_grants;           -- 0
   SELECT state, count(*) FROM work_items WHERE kind LIKE 'delegation.%' GROUP BY 1;   -- none
   ```
   If any of these is non-zero at release time, stop: list them for the owner; the new build blocks their execution (fail closed) and the
   owner decides whether to revoke them (`workflowRunWalletRevoke` / `authorizationRevoke` stay available).

## 2. Release A — compatibility certificate **[OWNER: merge + deploy]**

Commits `RELEASE A: schema 0023 compatibility certificate` and `RELEASE A (amended): …` (they touch only the certificate in
`packages/cloud-runtime/src/migrations.ts`, its fixture and SCHEMA-COMPATIBILITY §17) can be cherry-picked to `main` alone, in that order. Deploy it to
every database consumer (Vercel, Railway `flofi-api`, Railway `flofi-worker`) **before** any build that applies 0023. Without it, rolling
back after 0023 is impossible (the previous build refuses schema 23 with `MIGRATION_HISTORY_MISMATCH`).

## 3. Release B — this build **[OWNER: merge + deploy]**

1. CircleCI green on the PR (typecheck, lint, build, schema drift, unit, PostgreSQL 18 suites incl. `user-funded-groups-migration.pg.test.ts`,
   governance, browser profiles).
2. Merge. The deploy step runs `migrate` once (0023 is one transaction, `lock_timeout = 5s`; a short ACCESS EXCLUSIVE lock on `workflow_runs`).
3. All three services must run the same commit.

## 4. Configuration (names only; values are the owner's) **[OWNER]**

User-funded execution is off until enabled. Set on **Vercel** (web tier: prepare/authorize/report run inline) **and Railway `flofi-worker`**
(relays due user operations / Solana transactions, reconciles):

| Variable | Value | Notes |
|---|---|---|
| `FLOFI_WORKFLOW_RUNS` | `enabled` | existing |
| `FLOFI_USER_FUNDED_EXECUTION` | `enabled` | `disabled` (default) turns the mode off everywhere |
| `FLOFI_USER_FUNDED_CHAINS` | e.g. `eip155:1,eip155:8453,eip155:42161,eip155:4663,solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | CAIP-2 mainnets only; an unknown value disables the feature (`USER_FUNDED_CONFIGURATION_INVALID`) |
| `FLOFI_USER_FUNDED_RPC_<chainId>` | https read RPC per EVM chain | falls back to `FLOFI_DELEGATION_RPC_<chainId>`; a chain without one is not offered |
| `FLOFI_BUNDLER_RPC_<chainId>` | https ERC-4337 v0.7 bundler (optional) | only for delayed EVM groups signed upfront; the bundler must serve EntryPoint `0x0000000071727De22E5E9d8BAf0edAc6f37da032` on that chain (verified at first use). A bundler is repaid by the EntryPoint from the **owner's** prefund; it must not be configured with a paymaster |
| `GRYLOO_SOLANA_RPC_URL`, `JUPITER_API_KEY` | existing | Solana groups |

No new secret is required for EVM batches (the wallet sends them). A bundler URL that embeds an API key is a credential: store it as a
Railway/Vercel secret, never in the repository.

## 5. The AWS KMS executor key **[OWNER]** — keep, do not delete, do not fund

1. **Do not delete the key** (and do not schedule deletion). It is retained for audit of the previous build's configuration.
2. Remove its signing capability: in the worker principal's IAM policy, drop `kms:Sign` (keep `kms:GetPublicKey` only if someone wants to
   re-verify a legacy grant's executor address; otherwise remove the policy). Rotate/remove the worker's AWS access keys if they existed only
   for signing.
3. Railway `flofi-worker` / `flofi-api`: set `FLOFI_DELEGATED_SIGNER=none` and unset `FLOFI_DELEGATED_EXECUTION` (or leave them: this build's
   executor cannot send in any configuration — the transport has no send method and every step is refused before simulation).
4. Never send funds to the executor address. If it already holds ETH, that balance is unused by this build; recovering it requires a
   transaction signed by the KMS key from an operator-controlled script — an owner decision, outside this build.
5. Expected log after deploy: no `flofi.kms.sign` lines; any legacy delegated execution logs `delegation.executor_gas_refused`.

## 6. Verification after deploy (no real funds needed)

1. `/approve` of a 2-step same-chain workflow on an enabled chain shows **"Pay the fees from my own wallet, in one wallet interaction"** and
   never "Authorize the whole workflow once".
2. MCP `request_user_approval` / `get_approval_status`: the plan's `delegatedSingleAuthorization.reason` is `EXECUTOR_FUNDED_GAS_RETIRED`;
   `userFunded.feePayer` is `OWNER_WALLET`.
3. Worker logs: `workflow_run.advanced` items; no `delegation.*` sends.
4. Database: `SELECT mode, state, count(*) FROM workflow_runs GROUP BY 1, 2;` — new user-funded runs appear as `USER_FUNDED`.

## 7. First real-funds execution (team testing) **[OWNER — real funds, owner-controlled wallet only]**

Real mainnet execution is the owner's action through the reviewed wallet flow; nothing is executed by FloFi on its own. Suggested first
runs, small amounts, owner wallet: (a) Base: swap 1 USDC → WETH then transfer the WETH to the same wallet (one MetaMask batch);
(b) Solana: two SOL/SPL transfers (one Phantom request); (c) Base → Solana bridge then Jupiter swap (bridge step + a group signed when due).
Record the transaction hashes, gas paid and payer in `docs/builds/BUILD-FLOFI-UNIVERSAL-WORKFLOW-002-REPORT.md` §Evidence.

## 8. Rollback

- **Feature off (no deploy):** set `FLOFI_USER_FUNDED_EXECUTION=disabled`. New runs offer confirm-each-step only. Open USER_FUNDED runs then
  report `USER_FUNDED_NOT_ENABLED` and wait (nothing is relayed); their owners can still read status, and runs with nothing in flight can be ended.
- **Application rollback:** redeploy the **Release A deployment** (main with the two Release A commits) on all three services — never a commit
  older than Release A, which refuses schema 23 (`MIGRATION_HISTORY_MISMATCH`). That build serves schema 23 (certificate) and never acts on a
  USER_FUNDED run (it neither loads, relays nor cancels a grouped step). A signed user operation of an open run stays valid on chain: tell its
  owner to revoke it (the panel's "Cancel the signed operation in my wallet") before or after the rollback. The delegated executor of that
  build would again be able to send — keep `FLOFI_DELEGATED_EXECUTION` unset / `FLOFI_DELEGATED_SIGNER=none` and `kms:Sign` removed so the
  rollback cannot resurrect FloFi-funded gas.
- **Schema:** 0023 is never reverted in normal operation (additive). Emergency reversal is a last resort, run only by the owner, only with a
  build that ships ≤ 22 deployed everywhere, as ONE transaction that refuses itself while any user-funded row exists (not exercised in CI —
  review it against the production catalog first):
  ```sql
  BEGIN;
  SET LOCAL lock_timeout = '5s';
  DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM workflow_runs WHERE mode = 'USER_FUNDED') OR EXISTS (SELECT 1 FROM workflow_run_groups) THEN
      RAISE EXCEPTION 'ROLLBACK_REFUSED_USER_FUNDED_ROWS_EXIST';
    END IF;
  END $$;
  DROP TABLE workflow_run_groups;
  DROP FUNCTION workflow_run_group_insert(), workflow_run_group_transition();
  ALTER TABLE workflow_runs DROP CONSTRAINT workflow_runs_mode_check, ADD CONSTRAINT workflow_runs_mode_check CHECK (<0015 definition>);
  ALTER TABLE workflow_runs DROP CONSTRAINT workflow_runs_check3, ADD CONSTRAINT workflow_runs_check3 CHECK (<0015 definition>);
  DELETE FROM schema_migrations WHERE version = 23;
  COMMIT;
  ```
  The two `<0015 definition>` placeholders are the exact `pg_get_constraintdef` texts captured in pre-flight §1 (verified 2026-11-07).

## 9. Monitoring

- `workflow_run.group_blocked`, `workflow_run.group_failed` (codes: `GAS_PAYER_NOT_OWNER`, `RECONCILIATION_*`, `USER_OPERATION_*`,
  `SOLANA_BLOCKHASH_EXPIRED`), `workflow_run.user_operation_relayed`, `workflow_run.group_reconciled` (with gas paid).
- A `GAS_PAYER_NOT_OWNER` or `GAS_SPONSORSHIP_REFUSED` is a security signal (someone else paid or sponsored): investigate.
