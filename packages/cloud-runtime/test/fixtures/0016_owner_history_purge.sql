-- SPDX-License-Identifier: AGPL-3.0-only
-- Owner-requested disposal of provably unstarted conventional runs. No trigger is disabled and the global append-only function is unchanged.
CREATE TABLE owner_history_visibility (
  tenant_id text NOT NULL REFERENCES tenants(tenant_id),
  owner_account text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('EXECUTION_RUN','WORKFLOW_RUN','SAVED_WORKFLOW')),
  record_id text NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,owner_account,kind,record_id)
);
CREATE TABLE owner_history_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(tenant_id), owner_account text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('EXECUTION_RUN','WORKFLOW_RUN','SAVED_WORKFLOW')),
  record_id text NOT NULL, action text NOT NULL CHECK (action IN ('DELETED','ARCHIVED')),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER owner_history_events_append_only BEFORE UPDATE OR DELETE ON owner_history_events FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

-- Persistent identity tombstone and minimal audit; no workflow, logs, signatures or transaction bytes are retained here.
CREATE TABLE execution_purge_audit (
  tenant_id text NOT NULL REFERENCES tenants(tenant_id),
  run_id text NOT NULL,
  owner_account text NOT NULL,
  namespace text NOT NULL,
  log_name text NOT NULL,
  log_sha256 text NOT NULL,
  log_version bigint NOT NULL,
  segment_count integer NOT NULL,
  journal_count integer NOT NULL,
  purged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,run_id),
  UNIQUE (tenant_id,namespace,log_name)
);
CREATE TRIGGER execution_purge_audit_immutable BEFORE UPDATE OR DELETE ON execution_purge_audit
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

-- A transaction-scoped, private capability. No session GUC can enable deletion; it exists only during the checked procedure.
CREATE TABLE execution_purge_permits (
  tenant_id text NOT NULL, run_id text NOT NULL, namespace text NOT NULL, log_name text NOT NULL, transaction_id bigint NOT NULL,
  PRIMARY KEY (tenant_id,run_id),
  FOREIGN KEY (tenant_id,run_id) REFERENCES execution_purge_audit(tenant_id,run_id)
);
REVOKE ALL ON execution_purge_permits, execution_purge_audit FROM PUBLIC;

CREATE FUNCTION protect_execution_history() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' AND EXISTS (
    SELECT 1 FROM execution_purge_permits p WHERE p.tenant_id=OLD.tenant_id AND p.transaction_id=txid_current()
      AND CASE WHEN TG_TABLE_NAME IN ('journal_entries','execution_runs') THEN p.run_id=to_jsonb(OLD)->>'run_id'
        ELSE p.namespace=to_jsonb(OLD)->>'namespace' AND p.log_name=coalesce(to_jsonb(OLD)->>'name',to_jsonb(OLD)->>'log_name') END
  ) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'APPEND_ONLY_VIOLATION: % on %', TG_OP,TG_TABLE_NAME USING ERRCODE='integrity_constraint_violation';
END; $$;
DROP TRIGGER execution_log_segments_append_only ON execution_log_segments;
CREATE TRIGGER execution_log_segments_append_only BEFORE UPDATE OR DELETE ON execution_log_segments FOR EACH ROW EXECUTE FUNCTION protect_execution_history();
DROP TRIGGER journal_entries_append_only ON journal_entries;
CREATE TRIGGER journal_entries_append_only BEFORE UPDATE OR DELETE ON journal_entries FOR EACH ROW EXECUTE FUNCTION protect_execution_history();

CREATE FUNCTION reject_purged_execution_identity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,public,pg_temp AS $$
DECLARE v_name text;
BEGIN
  v_name := coalesce(to_jsonb(NEW)->>'name',to_jsonb(NEW)->>'log_name');
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id || ':' || NEW.namespace || ':' || v_name,0));
  IF EXISTS (SELECT 1 FROM execution_purge_audit p WHERE p.tenant_id=NEW.tenant_id AND
      (p.namespace=NEW.namespace AND p.log_name=v_name OR TG_TABLE_NAME='execution_runs' AND p.run_id=to_jsonb(NEW)->>'run_id')) THEN
    RAISE EXCEPTION 'EXECUTION_DELETED';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER execution_logs_no_recreation BEFORE INSERT OR UPDATE ON execution_logs FOR EACH ROW EXECUTE FUNCTION reject_purged_execution_identity();
CREATE TRIGGER execution_runs_no_recreation BEFORE INSERT OR UPDATE ON execution_runs FOR EACH ROW EXECUTE FUNCTION reject_purged_execution_identity();

-- Unknown/ambiguous snapshot shapes are retained. All historic snapshots, not only the projection/latest row, must pass.
CREATE FUNCTION disposable_execution_snapshot(s jsonb, p_id text, p_owner text) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
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

CREATE FUNCTION purge_unstarted_execution(p_tenant text,p_owner text,p_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,public,pg_temp AS $$
DECLARE r execution_runs%ROWTYPE; l execution_logs%ROWTYPE; b bytea; line text; n integer; j integer; snapshots integer := 0;
BEGIN
  SELECT * INTO r FROM execution_runs WHERE tenant_id=p_tenant AND run_id=p_id AND owner_account=p_owner;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM execution_purge_audit WHERE tenant_id=p_tenant AND run_id=p_id AND owner_account=p_owner) THEN RETURN '{"ok":true,"disposition":"DELETED"}'; END IF;
    RETURN '{"ok":false,"code":"RUN_NOT_FOUND"}';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant || ':' || r.namespace || ':' || r.log_name,0));
  SELECT * INTO l FROM execution_logs WHERE tenant_id=p_tenant AND namespace=r.namespace AND name=r.log_name FOR UPDATE;
  SELECT * INTO r FROM execution_runs WHERE tenant_id=p_tenant AND run_id=p_id AND owner_account=p_owner FOR UPDATE;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM execution_purge_audit WHERE tenant_id=p_tenant AND run_id=p_id AND owner_account=p_owner) THEN RETURN '{"ok":true,"disposition":"DELETED"}'; END IF;
    RETURN '{"ok":false,"code":"RUN_NOT_FOUND"}';
  END IF;
  IF l.kind IS DISTINCT FROM 'RUN' OR r.status NOT IN ('SIMULATED','PREPARED','SIMULATION_FAILED','DRAFT') OR r.has_evidence OR r.needs_observation OR r.attention_required OR r.recovery_of IS NOT NULL
    OR EXISTS (SELECT 1 FROM execution_attempts WHERE tenant_id=p_tenant AND run_id=p_id)
    OR EXISTS (SELECT 1 FROM evidence_objects WHERE tenant_id=p_tenant AND run_id=p_id)
    OR EXISTS (SELECT 1 FROM execution_runs WHERE tenant_id=p_tenant AND recovery_of=p_id)
    OR EXISTS (SELECT 1 FROM execution_leases WHERE tenant_id=p_tenant AND namespace=r.namespace AND expires_at>clock_timestamp() AND (strpos(lease_key,p_id)>0 OR lease_key=r.log_name))
    OR EXISTS (SELECT 1 FROM work_items WHERE tenant_id=p_tenant AND
      (state IN ('READY','LEASED') OR run_id IS DISTINCT FROM p_id) AND
      (run_id=p_id OR strpos(payload::text,to_jsonb(p_id)::text)>0 OR strpos(dedupe_key,p_id)>0))
    OR EXISTS (SELECT 1 FROM api_idempotency WHERE tenant_id=p_tenant AND state='IN_PROGRESS' AND claimed_until>clock_timestamp() AND left(scope,length('flows/'||r.flow||'/'))='flows/'||r.flow||'/')
    OR EXISTS (SELECT 1 FROM mcp_handoffs WHERE tenant_id=p_tenant AND p_id=ANY(run_ids))
    OR EXISTS (SELECT 1 FROM workflow_run_steps WHERE tenant_id=p_tenant AND strpos(outcome::text,to_jsonb(p_id)::text)>0)
    OR EXISTS (SELECT 1 FROM automation_rules WHERE tenant_id=p_tenant AND owner_account=p_owner AND source_workflow_id=r.workflow_id)
    OR EXISTS (SELECT 1 FROM delegated_execution_steps WHERE tenant_id=p_tenant AND strpos(to_jsonb(delegated_execution_steps)::text,to_jsonb(p_id)::text)>0)
    OR EXISTS (SELECT 1 FROM execution_logs i JOIN execution_log_segments s USING(tenant_id,namespace,name)
      WHERE i.tenant_id=p_tenant AND i.kind='INTENT' GROUP BY i.namespace,i.name
      HAVING strpos(encode(string_agg(s.bytes,''::bytea ORDER BY s.seq),'escape'),to_jsonb(p_id)::text)>0)
    OR EXISTS (SELECT 1 FROM journal_entries WHERE tenant_id=p_tenant AND run_id=p_id AND (attempt_id IS NOT NULL OR to_state NOT IN ('CREATED','DRAFT','SIMULATED','PREPARED','VALIDATED','PLANNED','REVIEWED')))
  THEN RETURN '{"ok":false,"code":"RUN_DELETE_REFUSED"}'; END IF;
  SELECT string_agg(bytes,''::bytea ORDER BY seq),count(*) INTO b,n FROM execution_log_segments WHERE tenant_id=p_tenant AND namespace=r.namespace AND name=r.log_name;
  IF n=0 OR b IS NULL OR r.log_version<>l.version OR n<>l.segment_count OR n<>l.version OR octet_length(b)<>l.byte_length OR encode(sha256(b),'hex')<>l.content_sha256 OR
    EXISTS (SELECT 1 FROM execution_log_segments WHERE tenant_id=p_tenant AND namespace=r.namespace AND name=r.log_name AND encode(sha256(bytes),'hex')<>segment_sha256)
  THEN RETURN '{"ok":false,"code":"RUN_DELETE_REFUSED"}'; END IF;
  IF (SELECT min(seq)<>0 OR max(seq)<>n-1 FROM execution_log_segments WHERE tenant_id=p_tenant AND namespace=r.namespace AND name=r.log_name) THEN RETURN '{"ok":false,"code":"RUN_DELETE_REFUSED"}'; END IF;
  FOR line IN SELECT value FROM regexp_split_to_table(convert_from(b,'UTF8'),E'\n') value WHERE value<>'' LOOP
    snapshots := snapshots+1;
    BEGIN
      IF disposable_execution_snapshot(line::jsonb,p_id,p_owner) IS DISTINCT FROM true THEN RETURN '{"ok":false,"code":"RUN_DELETE_REFUSED"}'; END IF;
    EXCEPTION WHEN invalid_text_representation THEN RETURN '{"ok":false,"code":"RUN_DELETE_REFUSED"}'; END;
  END LOOP;
  IF snapshots=0 THEN RETURN '{"ok":false,"code":"RUN_DELETE_REFUSED"}'; END IF;
  SELECT count(*) INTO j FROM journal_entries WHERE tenant_id=p_tenant AND run_id=p_id;
  INSERT INTO execution_purge_audit(tenant_id,run_id,owner_account,namespace,log_name,log_sha256,log_version,segment_count,journal_count)
    VALUES(p_tenant,p_id,p_owner,r.namespace,r.log_name,l.content_sha256,l.version,n,j);
  INSERT INTO execution_purge_permits VALUES(p_tenant,p_id,r.namespace,r.log_name,txid_current());
  DELETE FROM journal_entries WHERE tenant_id=p_tenant AND run_id=p_id;
  DELETE FROM execution_log_segments WHERE tenant_id=p_tenant AND namespace=r.namespace AND name=r.log_name;
  -- Only direct, terminal work belongs to this disposal. An indirect/shared
  -- reference above requires retention rather than deleting another run's work.
  DELETE FROM work_items WHERE tenant_id=p_tenant AND state IN ('DONE','DEAD') AND run_id=p_id;
  UPDATE api_idempotency SET response='{"ok":false,"code":"EXECUTION_DELETED"}'::jsonb,updated_at=clock_timestamp()
    WHERE tenant_id=p_tenant AND state='COMPLETED' AND strpos(response::text,to_jsonb(p_id)::text)>0;
  DELETE FROM execution_runs WHERE tenant_id=p_tenant AND run_id=p_id;
  DELETE FROM execution_logs WHERE tenant_id=p_tenant AND namespace=r.namespace AND name=r.log_name;
  DELETE FROM execution_purge_permits WHERE tenant_id=p_tenant AND run_id=p_id;
  DELETE FROM owner_history_visibility WHERE tenant_id=p_tenant AND owner_account=p_owner AND kind='EXECUTION_RUN' AND record_id=p_id;
  RETURN jsonb_build_object('ok',true,'disposition','DELETED','counts',jsonb_build_object('execution_runs',1,'execution_logs',1,'execution_log_segments',n,'journal_entries',j));
EXCEPTION WHEN foreign_key_violation THEN
  -- A concurrent FK-protected dependency won. The implicit subtransaction rolls
  -- back the audit, permits and every deletion before returning this refusal.
  RETURN '{"ok":false,"code":"RUN_DELETE_REFUSED"}';
END; $$;
REVOKE ALL ON FUNCTION protect_execution_history(),reject_purged_execution_identity(),disposable_execution_snapshot(jsonb,text,text),purge_unstarted_execution(text,text,text) FROM PUBLIC;

CREATE TRIGGER execution_runs_restricted_delete BEFORE DELETE ON execution_runs FOR EACH ROW EXECUTE FUNCTION protect_execution_history();
CREATE TRIGGER execution_logs_restricted_delete BEFORE DELETE ON execution_logs FOR EACH ROW EXECUTE FUNCTION protect_execution_history();

-- Delayed workers, projections and handoffs cannot attach a purged identity again, including JSON/array references without FKs.
CREATE FUNCTION reject_purged_history_reference() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,public,pg_temp AS $$
DECLARE r record; payload text := to_jsonb(NEW)::text;
BEGIN
  IF TG_TABLE_NAME='execution_log_segments' THEN payload := encode(NEW.bytes,'escape'); END IF;
  -- Serialize even references with no foreign key. A writer that starts before purge either
  -- commits first (and is checked by purge), or waits and sees the committed tombstone.
  FOR r IN SELECT namespace,log_name FROM execution_runs e WHERE e.tenant_id=NEW.tenant_id AND
    (strpos(payload,to_jsonb(e.run_id)::text)>0 OR strpos(to_jsonb(NEW)->>'dedupe_key',e.run_id)>0 OR TG_TABLE_NAME='execution_leases' AND
      e.namespace=to_jsonb(NEW)->>'namespace' AND strpos(to_jsonb(NEW)->>'lease_key',e.run_id)>0)
    ORDER BY namespace,log_name LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id || ':' || r.namespace || ':' || r.log_name,0));
  END LOOP;
  IF EXISTS (SELECT 1 FROM execution_purge_audit p WHERE p.tenant_id=NEW.tenant_id AND
    (strpos(payload,to_jsonb(p.run_id)::text)>0 OR strpos(to_jsonb(NEW)->>'dedupe_key',p.run_id)>0 OR TG_TABLE_NAME='execution_leases' AND
      p.namespace=to_jsonb(NEW)->>'namespace' AND strpos(to_jsonb(NEW)->>'lease_key',p.run_id)>0)) THEN
    RAISE EXCEPTION 'EXECUTION_DELETED';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER work_items_no_purged_reference BEFORE INSERT OR UPDATE ON work_items FOR EACH ROW EXECUTE FUNCTION reject_purged_history_reference();
CREATE TRIGGER mcp_handoffs_no_purged_reference BEFORE INSERT OR UPDATE ON mcp_handoffs FOR EACH ROW EXECUTE FUNCTION reject_purged_history_reference();
CREATE TRIGGER workflow_run_steps_no_purged_reference BEFORE INSERT OR UPDATE ON workflow_run_steps FOR EACH ROW EXECUTE FUNCTION reject_purged_history_reference();
CREATE TRIGGER delegated_steps_no_purged_reference BEFORE INSERT OR UPDATE ON delegated_execution_steps FOR EACH ROW EXECUTE FUNCTION reject_purged_history_reference();
CREATE TRIGGER execution_leases_no_purged_reference BEFORE INSERT OR UPDATE ON execution_leases FOR EACH ROW EXECUTE FUNCTION reject_purged_history_reference();
CREATE TRIGGER execution_segments_no_purged_reference BEFORE INSERT ON execution_log_segments FOR EACH ROW EXECUTE FUNCTION reject_purged_history_reference();
CREATE TRIGGER idempotency_no_purged_reference BEFORE INSERT OR UPDATE ON api_idempotency FOR EACH ROW EXECUTE FUNCTION reject_purged_history_reference();
REVOKE ALL ON FUNCTION reject_purged_history_reference() FROM PUBLIC;
