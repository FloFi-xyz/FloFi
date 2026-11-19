-- SPDX-License-Identifier: AGPL-3.0-only
-- BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: owner-requested disposal also recognizes provably unstarted Uniswap v3 position-management simulations
-- (`flofi.uniswap-position-run.v1`). It redefines only the snapshot predicate of 0016 (unchanged otherwise, byte for byte): the record must have
-- no authorization, no attempt, no observed result, no evidence and a PENDING verdict in every historic snapshot, and every other 0016 check of
-- `purge_unstarted_execution` (status, attempts, evidence, recovery, leases, work items, intents, journals, tenant and owner) still applies.
-- No table, trigger, row, privilege or other function changes. 0016 itself is immutable and untouched.
SET LOCAL lock_timeout = '5s';
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
  ELSIF s->>'format'='flofi.uniswap-position-run.v1' THEN
    -- BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: a Uniswap v3 position-management run (collect, partial withdrawal, exit, close). Exactly the record's
    -- own keys; `request` is the owner's choice (operation, token id, portion, close) and `result` must be null below (no observed outcome).
    allowed := ARRAY['format','id','provenance','workflow','owner','request','review','authorization','attempts','result','evidence','verdict','error'];
    -- Every one of those keys must be present: a snapshot that lacks one (e.g. a future shape) is retained, never assumed unstarted.
    IF NOT s ?& allowed THEN RETURN false; END IF;
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
  FOREACH nested IN ARRAY ARRAY[s->'authorization',s->'authorized',s->'reviewedManifestHash',s->'acceptedManifestHash',s->'reviewAccepted',s->'outcome',s->'evidence',s->'source',s->'destination',s->'refund',s->'recoveryOf',s->'received',s->'feeObligation',s->'position',s->'lastHint',s->'approvalProof',s->'priorApproval',s->'walletDiagnostic',s->'submissionError',s->'attempt',s->'divergence',s->'walletManagedNonce',s->'result'] LOOP
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
