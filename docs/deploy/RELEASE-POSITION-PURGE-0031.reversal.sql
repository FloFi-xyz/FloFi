-- SPDX-License-Identifier: AGPL-3.0-only
-- Emergency reversal of 0031_position_history_purge (owner decision only; see RELEASE-POSITION-PURGE-0031.md). One transaction, run from the
-- reviewed checkout with the direct migration connection: it refuses unless 0031 (exact identity) is the database's newest migration, restores
-- 0016's snapshot predicate byte for byte, and removes only the 0031 ledger row. Position runs already deleted stay deleted (their tombstones
-- are immutable); no row, table, trigger or privilege is touched.
BEGIN;
SET LOCAL lock_timeout = '5s';
-- The migration runner's own advisory lock: no concurrent runner can add a migration between the check below and the ledger change.
SELECT pg_advisory_xact_lock(7340032001);
DO $$ BEGIN
  IF (SELECT max(version) FROM schema_migrations) <> 31 OR NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = 31 AND name = 'position_history_purge'
    AND sha256 = 'c7d4a08223df2a3d5f32d70902d1d5b2efd5ec961b67f146ea20c2a4afeb898d') THEN RAISE EXCEPTION 'NOT_CERTIFIED_0031_HEAD'; END IF;
END $$;
CREATE OR REPLACE FUNCTION disposable_execution_snapshot(s jsonb, p_id text, p_owner text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE item record; nested jsonb; allowed text[];
BEGIN
  IF jsonb_typeof(s) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF NOT (s ? 'format') AND s ?& ARRAY['quote','workflow','reviewedManifestHash','attempts','outcome'] THEN
    allowed := ARRAY['quote','workflow','reviewedManifestHash','attempts','outcome','divergence'];
  ELSIF s->>'format' IN ('flofi.universal-bridge-run.v1','flofi.router-run.v1','flofi.uniswap-liquidity-run.v1',
      'gryloo.supply-run.v1','gryloo.native-transfer-run.v1','gryloo.jupiter-run.v1','gryloo.orca-devnet-run.v1','gryloo.solana-transfer-run.v1') THEN
    allowed := ARRAY['format','id','provenance','workflow','owner','review','authorization','phase','attempts','attempt','journal','ownerInitiated',
      'source','destination','refund','lastHint','routeChanges','requote','evidence','verdict','error','received','feeObligation','scanFrom','position',
      'observations','evidenceClass','notSubmitted','submissionError','walletDiagnostic','recoveryOf','absence','walletManagedNonce','approvalProof','priorApproval'];
  ELSE RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(s) k WHERE NOT k=ANY(allowed)) THEN RETURN false; END IF;
  IF s ? 'attempts' THEN
    IF jsonb_typeof(s->'attempts') IS DISTINCT FROM 'array' OR s->'attempts'<>'[]'::jsonb THEN RETURN false; END IF;
  ELSIF NOT (s ? 'attempt') OR s->'attempt'<>'null'::jsonb THEN RETURN false; END IF;
  IF coalesce(s->>'id',s#>>'{quote,executionId}') IS DISTINCT FROM p_id OR
     coalesce(s->>'owner',s#>>'{review,owner}',s#>>'{review,account}',s#>>'{quote,ownerReview,account}',s#>>'{facts,owner,address}') IS DISTINCT FROM p_owner THEN RETURN false; END IF;
  IF coalesce(s->>'phase',s->>'status','SIMULATED') NOT IN ('PREPARED','SIMULATED','SIMULATION_FAILED','DRAFT') THEN RETURN false; END IF;
  IF s ? 'verdict' AND s->>'verdict'<>'PENDING' OR s ? 'ownerInitiated' AND s->'ownerInitiated'<>'false'::jsonb OR
    s ? 'observations' AND s->'observations'<>'[]'::jsonb THEN RETURN false; END IF;
  FOREACH nested IN ARRAY ARRAY[s->'authorization',s->'authorized',s->'reviewedManifestHash',s->'acceptedManifestHash',s->'reviewAccepted',s->'outcome',s->'evidence',s->'source',s->'destination',s->'refund',s->'recoveryOf',s->'received',s->'feeObligation',s->'position',s->'lastHint',s->'approvalProof',s->'priorApproval',s->'walletDiagnostic',s->'submissionError',s->'attempt',s->'divergence',s->'walletManagedNonce'] LOOP
    IF nested IS NOT NULL AND nested NOT IN ('null'::jsonb,'false'::jsonb,'""'::jsonb) THEN RETURN false; END IF;
  END LOOP;
  FOR item IN WITH RECURSIVE walk(v) AS (
    SELECT s UNION ALL SELECT child.v FROM walk w CROSS JOIN LATERAL (
      SELECT value AS v FROM jsonb_each(CASE WHEN jsonb_typeof(w.v)='object' THEN w.v ELSE '{}'::jsonb END)
      UNION ALL SELECT value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(w.v)='array' THEN w.v ELSE '[]'::jsonb END)
    ) child
  ) SELECT e.key,e.value FROM walk w CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(w.v)='object' THEN w.v ELSE '{}'::jsonb END) e LOOP
    IF item.key ~* '^(signature|signed.*|transactionHash|txHash|authorization|authorizedCommitment|broadcast.*|submitted.*|receipt|reconciliation|settlement|sourceTransaction|destinationTransaction)$' AND
      item.value NOT IN ('null'::jsonb,'false'::jsonb,'""'::jsonb) THEN RETURN false; END IF;
    IF item.key='toState' AND item.value #>> '{}' NOT IN ('CREATED','DRAFT','SIMULATED','PREPARED','VALIDATED','PLANNED','REVIEWED') THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END; $$;
REVOKE ALL ON FUNCTION disposable_execution_snapshot(jsonb,text,text) FROM PUBLIC;
DELETE FROM schema_migrations WHERE version = 31 AND name = 'position_history_purge'
  AND sha256 = 'c7d4a08223df2a3d5f32d70902d1d5b2efd5ec961b67f146ea20c2a4afeb898d';
COMMIT;
