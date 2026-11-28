-- SPDX-License-Identifier: AGPL-3.0-only
-- Emergency reversal of 0037_execution_origins_platform_fees (owner decision only; see RELEASE-REVENUE-ORIGINS-0037.md). One transaction, run from
-- the reviewed checkout with the direct migration connection: it refuses unless 0037 (exact identity) is the database's newest migration and while
-- any fee row is owed or collected (export and settle those first), then drops the three 0037 tables and their three functions and removes only
-- the 0037 ledger row. Recorded origins and waived/not-applicable fee rows are lost; no execution, evidence or pre-existing object changes.
-- Afterwards: restart or redeploy every database consumer (they remember 0037 as active) and re-apply the schema-36 least-privilege policy.
BEGIN;
SET LOCAL lock_timeout = '5s';
-- The migration runner's own advisory lock: no concurrent runner can add a migration between the check below and the ledger change.
SELECT pg_advisory_xact_lock(7340032001);
DO $$ BEGIN
  IF (SELECT max(version) FROM schema_migrations) <> 37 OR NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 37 AND name = 'execution_origins_platform_fees'
    AND sha256 = '03e82a3120d3d71c32f5315dcaf39d86bbc2266d00264a024884e0b4eecd7074') THEN RAISE EXCEPTION 'NOT_CERTIFIED_0037_HEAD'; END IF;
  IF EXISTS (SELECT 1 FROM platform_fee_ledger WHERE state IN ('DUE', 'COLLECTION_PENDING', 'COLLECTED', 'COLLECTION_FAILED')) THEN
    RAISE EXCEPTION 'REVERSAL_REFUSED_FEES_RECORDED'; END IF;
END $$;
DROP TABLE platform_fee_ledger, execution_origin_corrections, execution_origins;
DROP FUNCTION platform_fee_transition(), execution_origin_correction_append_only(), execution_origin_immutable();
DELETE FROM schema_migrations WHERE version = 37;
COMMIT;
