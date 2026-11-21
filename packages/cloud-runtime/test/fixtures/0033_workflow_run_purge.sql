-- SPDX-License-Identifier: AGPL-3.0-only
-- BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001 0033: owner-requested deletion of a single-card attempt that provably never reached a chain.
--
-- A single Editor card runs as a one-step USER_FUNDED workflow run (0032). Its records are append-only (0015/0023 no-delete triggers), so an
-- attempt the owner abandoned before anything was sent stayed in History forever. This migration lets the OWNER delete exactly two shapes of
-- such an attempt, decided here, in the database, under the run's row lock, from the run's whole append-only history:
--   NO_WALLET_REQUEST         ended (CANCELLED, FAILED or EXPIRED) before any wallet request existed: no group was ever prepared, authorized,
--                             submitted or reconciled;
--   WALLET_REJECTED_VERIFIED  CANCELLED after the owner's wallet rejected the one wallet batch, which the server then proved from the chain was
--                             never sent (the application writes GROUP_DECLINE_VERIFIED only after its own chain reads, past the batch's on-chain
--                             deadline; the database trusts that event, written only by the application, and does not read the chain).
-- Everything else is refused and kept (Archive stays available): any authorization, submission, transaction hash, outcome or unknown outcome,
-- a re-prepared group, a Circle permit or user operation, delegated rows, developer approvals, Support texts, an active legal hold, a leased
-- work item, a live approval signing session, multi-step runs, any requester other than EDITOR_SESSION, and any event this migration does not
-- name exactly (a CLOSED allowlist of the forms the run store writes for these two shapes).
--
-- Mechanism (0016's pattern): a transaction-scoped private permit unlocks DELETE of one run's rows for the single transaction of the checked
-- procedure, and a minimal immutable tombstone keeps the identity (ids, owner, shape, final state, times, event count) — no strategy, amount,
-- recipient, hash, code or signature. 0015's `workflow_run_append_only` keeps its exact refusal (message and SQLSTATE) for every UPDATE and for
-- every DELETE without that permit; its four triggers (0015, 0023) are untouched. The run's approval handoff is deleted with it, so the approval
-- link can never be claimed again (HANDOFF_NOT_FOUND) and no run can be created for it again (its foreign key). 0015/0016/0023 stay
-- immutable. See docs/deploy/SCHEMA-COMPATIBILITY.md §25 (certificate 0033_workflow_run_purge).
SET LOCAL lock_timeout = '5s';

-- 1. The identity tombstone of a deleted attempt (immutable, like 0016's execution_purge_audit).
CREATE TABLE workflow_run_purge_audit (
  tenant_id text NOT NULL REFERENCES tenants (tenant_id),
  run_id text NOT NULL CHECK (run_id ~ '^wfr_[a-z2-7]{26}$'),
  handoff_id text NOT NULL CHECK (handoff_id ~ '^apr_[a-z2-7]{26}$'),
  owner_namespace text NOT NULL CHECK (owner_namespace = 'eip155'),
  owner_account text NOT NULL CHECK (owner_account ~ '^0x[0-9a-f]{40}$'),
  shape text NOT NULL CHECK (shape IN ('NO_WALLET_REQUEST', 'WALLET_REJECTED_VERIFIED')),
  final_state text NOT NULL CHECK (final_state IN ('CANCELLED', 'FAILED', 'EXPIRED')),
  run_created_at timestamptz NOT NULL,
  event_count integer NOT NULL CHECK (event_count >= 1),
  purged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, run_id),
  UNIQUE (tenant_id, handoff_id),
  CHECK (shape <> 'WALLET_REJECTED_VERIFIED' OR final_state = 'CANCELLED')
);
CREATE TRIGGER workflow_run_purge_audit_immutable BEFORE UPDATE OR DELETE ON workflow_run_purge_audit
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

-- 2. A transaction-scoped, private capability. No session setting can enable deletion; a permit exists only inside the checked procedure.
CREATE TABLE workflow_run_purge_permits (
  tenant_id text NOT NULL,
  run_id text NOT NULL,
  transaction_id bigint NOT NULL,
  PRIMARY KEY (tenant_id, run_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES workflow_run_purge_audit (tenant_id, run_id)
);
REVOKE ALL ON workflow_run_purge_permits, workflow_run_purge_audit FROM PUBLIC;

-- 3. 0015's append-only function, redefined with ONE exception: a DELETE of a row of exactly the run a permit names, inside the very transaction
-- that holds the permit. Every UPDATE, and every other DELETE, raises 0015's exact error. SECURITY DEFINER so the private permits table is read
-- whoever deletes; EXECUTE stays as 0015 left it (a trigger function cannot be called directly), so the documented reversal restores it exactly.
CREATE OR REPLACE FUNCTION workflow_run_append_only() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' AND EXISTS (SELECT 1 FROM workflow_run_purge_permits p
      WHERE p.tenant_id = OLD.tenant_id AND p.run_id = OLD.run_id AND p.transaction_id = txid_current()) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'WORKFLOW_RUN_RECORD_APPEND_ONLY' USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

-- 4. The checked procedure. Lock order: the run (as every run-store write), its steps and groups (as cancellation), the approval handoff, the
-- run's advance work items; then the tenant's privacy lock (as legal-hold placement and erasure). Answers, never raises, a closed result:
--   {"ok":true,"disposition":"DELETED"}                    deleted now, or already deleted by this owner (the tombstone: idempotent)
--   {"ok":false,"code":"RUN_NOT_FOUND"}                    no such run of this owner in this tenant
--   {"ok":false,"code":"RUN_DELETE_REFUSED"[,"reason":…]}  kept; reason EXECUTION_ACTIVITY | AUTHORIZATION | DEPENDENCY, or none (generic)
CREATE FUNCTION purge_unsubmitted_workflow_run(p_tenant text, p_owner text, p_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r workflow_runs%ROWTYPE;
  s workflow_run_steps%ROWTYPE;
  g workflow_run_groups%ROWTYPE;
  h mcp_handoffs%ROWTYPE;
  -- Codes that say a wallet request may have been sent or executed: never deletable.
  v_unsure constant text[] := ARRAY['WALLET_BATCH_OUTCOME_UNKNOWN', 'EIP5792_BATCH_NOT_SENT', 'WORKFLOW_STEP_EXECUTION_ALREADY_CLAIMED'];
  v_decimal constant text := '^(0|[1-9][0-9]{0,77})$';
  v_steps integer; v_groups integer; v_events integer;
  v_forms jsonb;
  v_request text; v_prepared_at text;
  v_common boolean; v_p boolean; v_d boolean; v_shape text;
  v_activity boolean; v_authorization boolean; v_dependency boolean; v_guard boolean;
BEGIN
  SELECT * INTO r FROM workflow_runs WHERE tenant_id = p_tenant AND run_id = p_id AND owner_account = p_owner FOR UPDATE;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM workflow_run_purge_audit WHERE tenant_id = p_tenant AND run_id = p_id AND owner_account = p_owner) THEN
      RETURN '{"ok":true,"disposition":"DELETED"}';
    END IF;
    RETURN '{"ok":false,"code":"RUN_NOT_FOUND"}';
  END IF;
  PERFORM 1 FROM workflow_run_steps WHERE tenant_id = p_tenant AND run_id = p_id ORDER BY step_index FOR UPDATE;
  PERFORM 1 FROM workflow_run_groups WHERE tenant_id = p_tenant AND run_id = p_id ORDER BY group_index FOR UPDATE;
  SELECT * INTO h FROM mcp_handoffs WHERE tenant_id = p_tenant AND handoff_id = r.handoff_id FOR UPDATE;
  PERFORM 1 FROM work_items WHERE tenant_id = p_tenant AND kind = 'workflow-run.advance' AND dedupe_key = p_id ORDER BY id FOR UPDATE;
  -- A legal hold placed concurrently is either committed before this point (and seen below) or waits for this transaction.
  PERFORM pg_advisory_xact_lock(hashtextextended('flofi.privacy:' || p_tenant, 0));

  SELECT * INTO s FROM workflow_run_steps WHERE tenant_id = p_tenant AND run_id = p_id AND step_index = 0;
  SELECT count(*) INTO v_steps FROM workflow_run_steps WHERE tenant_id = p_tenant AND run_id = p_id;
  SELECT * INTO g FROM workflow_run_groups WHERE tenant_id = p_tenant AND run_id = p_id AND group_index = 0;
  SELECT count(*) INTO v_groups FROM workflow_run_groups WHERE tenant_id = p_tenant AND run_id = p_id;
  v_request := g.prepared #>> '{request,id}';
  v_prepared_at := g.prepared ->> 'preparedAt';

  -- The run's whole history, each event classified into the exact form the run store writes for these shapes ('OTHER' for anything else).
  SELECT coalesce(jsonb_object_agg(form, jsonb_build_array(n, first_id, last_id)), '{}'::jsonb), coalesce(sum(n), 0)::integer INTO v_forms, v_events
  FROM (SELECT form, count(*) AS n, min(event_id) AS first_id, max(event_id) AS last_id FROM (
    SELECT e.event_id, CASE
      WHEN e.code = ANY (v_unsure) THEN 'UNSURE'
      WHEN e.kind = 'RUN_CREATED' AND e.step_index IS NULL AND e.code IS NULL AND d.keys = ARRAY['stepCount', 'workflowHash']
        AND e.detail -> 'stepCount' = '1'::jsonb AND e.detail ->> 'workflowHash' = r.workflow_hash THEN 'RUN_CREATED'
      WHEN e.kind = 'MODE_CHOSEN' AND e.step_index IS NULL AND e.code IS NULL AND d.keys = ARRAY['groups', 'mode', 'revokedUnsignedAuthorizations']
        AND e.detail ->> 'mode' = 'USER_FUNDED' AND e.detail -> 'revokedUnsignedAuthorizations' = '0'::jsonb THEN 'MODE_CHOSEN'
      WHEN e.kind = 'GROUP_STATE' AND e.step_index IS NULL AND d.keys = ARRAY['group', 'state'] AND e.detail -> 'group' = '0'::jsonb
        AND e.detail ->> 'state' IN ('PREPARED', 'BLOCKED', 'SKIPPED')
        THEN 'GROUP_' || (e.detail ->> 'state') || CASE WHEN e.code IS NULL THEN ':NONE' WHEN e.code = 'WALLET_REQUEST_REJECTED' THEN ':REJECTED' ELSE ':CODE' END
      WHEN e.kind = 'STEP_STATE' AND e.step_index = 0 AND d.keys = ARRAY['state'] AND e.detail ->> 'state' IN ('BLOCKED', 'SKIPPED')
        THEN 'STEP_' || (e.detail ->> 'state') || CASE WHEN e.code IS NULL THEN ':NONE' WHEN e.code = 'WALLET_REQUEST_REJECTED' THEN ':REJECTED' ELSE ':CODE' END
      WHEN e.kind = 'RUN_STATE' AND e.step_index IS NULL AND d.keys = ARRAY['state'] AND e.detail ->> 'state' IN ('HALTED', 'FAILED', 'EXPIRED')
        AND e.code IS DISTINCT FROM 'WALLET_REQUEST_REJECTED' THEN 'RUN_' || (e.detail ->> 'state')
      WHEN e.kind = 'RUN_CANCELLED' AND e.step_index IS NULL AND d.keys = ARRAY['state'] AND e.detail ->> 'state' = 'CANCELLED'
        AND e.code IS NOT DISTINCT FROM r.code THEN 'RUN_CANCELLED'
      WHEN e.kind = 'GROUP_WALLET_DECLINED' AND e.step_index IS NULL AND e.code = 'WALLET_REQUEST_REJECTED' AND d.keys = ARRAY['group', 'preparedAt', 'requestId']
        AND e.detail -> 'group' = '0'::jsonb AND e.detail ->> 'requestId' = v_request AND e.detail ->> 'preparedAt' = v_prepared_at THEN 'DECLINED'
      WHEN e.kind = 'GROUP_DECLINE_VERIFIED' AND e.step_index IS NULL AND e.code = 'WALLET_REQUEST_REJECTED'
        AND d.keys = ARRAY['fromBlock', 'group', 'ownerNonce', 'preparedAt', 'requestId', 'toBlock'] AND e.detail -> 'group' = '0'::jsonb
        AND e.detail ->> 'requestId' = v_request AND e.detail ->> 'preparedAt' = v_prepared_at
        AND e.detail ->> 'ownerNonce' = g.prepared ->> 'ownerNonce' AND e.detail ->> 'fromBlock' = g.prepared ->> 'fromBlock'
        AND CASE WHEN e.detail ->> 'fromBlock' ~ v_decimal AND e.detail ->> 'toBlock' ~ v_decimal
          THEN (e.detail ->> 'toBlock')::numeric >= (e.detail ->> 'fromBlock')::numeric ELSE false END THEN 'DECLINE_VERIFIED'
      ELSE 'OTHER' END AS form
    FROM workflow_run_events e
    CROSS JOIN LATERAL (SELECT coalesce(array_agg(k ORDER BY k COLLATE "C"), '{}'::text[]) AS keys FROM jsonb_object_keys(coalesce(e.detail, '{}'::jsonb)) k) d
    WHERE e.tenant_id = p_tenant AND e.run_id = p_id) c
  GROUP BY form) f;

  -- What both shapes share: a one-step Editor run of this EVM owner, never authorized or completed, its handoff this owner's own Editor claim.
  v_common := r.requester_kind = 'EDITOR_SESSION' AND r.owner_namespace = 'eip155' AND r.step_count = 1 AND r.current_step = 0
    AND r.completed_at IS NULL AND r.authorization_id IS NULL AND r.state IN ('CANCELLED', 'FAILED', 'EXPIRED')
    AND v_steps = 1 AND s.step_index = 0 AND s.outcome IS NULL AND s.flow IS NULL AND s.claimed_at IS NULL AND s.strategy IS NULL AND s.bound IS NULL
    AND h.handoff_id IS NOT NULL AND h.requester_kind = 'EDITOR_SESSION' AND h.claimed_namespace = 'eip155' AND h.claimed_address = p_owner
    AND h.plan ->> 'kind' = 'SEQUENTIAL' AND cardinality(h.run_ids) = 0
    AND coalesce((v_forms #>> '{RUN_CREATED,0}')::integer, 0) = 1
    AND coalesce((v_forms #>> '{RUN_CANCELLED,0}')::integer, 0) = (r.state = 'CANCELLED')::integer;
  v_common := coalesce(v_common, false);

  -- NO_WALLET_REQUEST: nothing was ever prepared for a wallet; only creation, the mode, blocks, skips and the run's end are in its history.
  v_p := v_common AND (r.mode IS NULL OR r.mode = 'USER_FUNDED')
    AND (r.code IS NULL OR NOT r.code = ANY (v_unsure || 'WALLET_REQUEST_REJECTED'::text))
    AND s.state IN ('PENDING', 'BLOCKED', 'SKIPPED') AND (s.code IS NULL OR NOT s.code = ANY (v_unsure || 'WALLET_REQUEST_REJECTED'::text))
    AND CASE WHEN r.mode IS NULL THEN v_groups = 0
      ELSE v_groups = 1 AND g.step_from = 0 AND g.step_to = 0 AND g.namespace = 'eip155' AND g.fee_payer = p_owner AND g.strategy = 'EVM_WALLET_BATCH'
        AND g.state IN ('BLOCKED', 'SKIPPED') AND g.prepared IS NULL AND g.owner_authorization IS NULL AND g.submission IS NULL AND g.outcome IS NULL
        AND g.valid_until IS NULL AND (g.code IS NULL OR NOT g.code = ANY (v_unsure || 'WALLET_REQUEST_REJECTED'::text)) END
    AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(v_forms) k WHERE k <> ALL (ARRAY['RUN_CREATED', 'MODE_CHOSEN', 'GROUP_BLOCKED:CODE',
      'GROUP_BLOCKED:NONE', 'GROUP_SKIPPED:CODE', 'GROUP_SKIPPED:NONE', 'STEP_BLOCKED:CODE', 'STEP_BLOCKED:NONE', 'STEP_SKIPPED:CODE',
      'STEP_SKIPPED:NONE', 'RUN_HALTED', 'RUN_FAILED', 'RUN_EXPIRED', 'RUN_CANCELLED']))
    AND coalesce((v_forms #>> '{MODE_CHOSEN,0}')::integer, 0) = (r.mode IS NOT DISTINCT FROM 'USER_FUNDED')::integer
    AND coalesce((v_forms #>> '{RUN_FAILED,0}')::integer, 0) = (r.state = 'FAILED')::integer
    AND coalesce((v_forms #>> '{RUN_EXPIRED,0}')::integer, 0) = (r.state = 'EXPIRED')::integer
    AND coalesce((v_forms #>> '{RUN_HALTED,0}')::integer, 0) <= (r.mode IS NOT DISTINCT FROM 'USER_FUNDED')::integer;
  v_p := coalesce(v_p, false);

  -- WALLET_REJECTED_VERIFIED: exactly one unsponsored wallet batch without native value, prepared once, rejected and proven never sent.
  v_d := v_common AND r.state = 'CANCELLED' AND r.mode = 'USER_FUNDED' AND (r.code IS NULL OR NOT r.code = ANY (v_unsure))
    AND s.state = 'SKIPPED' AND s.code = 'WALLET_REQUEST_REJECTED'
    AND v_groups = 1 AND g.step_from = 0 AND g.step_to = 0 AND g.namespace = 'eip155' AND g.fee_payer = p_owner AND g.strategy = 'EVM_WALLET_BATCH'
    AND g.state = 'SKIPPED' AND g.code = 'WALLET_REQUEST_REJECTED' AND g.owner_authorization IS NULL AND g.submission IS NULL AND g.outcome IS NULL
    AND g.prepared IS NOT NULL AND g.prepared ->> 'kind' = 'EVM_WALLET_BATCH' AND g.prepared ->> 'owner' = p_owner
    AND coalesce(g.prepared -> 'sponsorship', 'null'::jsonb) = 'null'::jsonb AND coalesce(g.prepared #> '{fee,sponsorship}', 'null'::jsonb) = 'null'::jsonb
    AND coalesce(g.prepared -> 'superseded', '[]'::jsonb) = '[]'::jsonb
    AND v_request ~ '^0x[0-9a-f]{64}$' AND v_prepared_at IS NOT NULL
    AND g.prepared ->> 'ownerNonce' ~ v_decimal AND g.prepared ->> 'fromBlock' ~ v_decimal
    AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(v_forms) k WHERE k <> ALL (ARRAY['RUN_CREATED', 'MODE_CHOSEN', 'GROUP_PREPARED:NONE', 'DECLINED',
      'DECLINE_VERIFIED', 'GROUP_SKIPPED:REJECTED', 'STEP_SKIPPED:REJECTED', 'RUN_CANCELLED']))
    AND coalesce((v_forms #>> '{MODE_CHOSEN,0}')::integer, 0) = 1 AND coalesce((v_forms #>> '{GROUP_PREPARED:NONE,0}')::integer, 0) = 1
    AND coalesce((v_forms #>> '{DECLINED,0}')::integer, 0) >= 1 AND coalesce((v_forms #>> '{DECLINE_VERIFIED,0}')::integer, 0) = 1
    AND coalesce((v_forms #>> '{GROUP_SKIPPED:REJECTED,0}')::integer, 0) = 1 AND coalesce((v_forms #>> '{STEP_SKIPPED:REJECTED,0}')::integer, 0) = 1
    -- In the order the store writes them: created, mode, prepared, declined (once or more), verified, skipped, cancelled.
    AND (v_forms #>> '{RUN_CREATED,2}')::bigint < (v_forms #>> '{MODE_CHOSEN,1}')::bigint
    AND (v_forms #>> '{MODE_CHOSEN,2}')::bigint < (v_forms #>> '{GROUP_PREPARED:NONE,1}')::bigint
    AND (v_forms #>> '{GROUP_PREPARED:NONE,2}')::bigint < (v_forms #>> '{DECLINED,1}')::bigint
    AND (v_forms #>> '{DECLINED,2}')::bigint < (v_forms #>> '{DECLINE_VERIFIED,1}')::bigint
    AND (v_forms #>> '{DECLINE_VERIFIED,2}')::bigint < (v_forms #>> '{GROUP_SKIPPED:REJECTED,1}')::bigint
    AND (v_forms #>> '{GROUP_SKIPPED:REJECTED,2}')::bigint < (v_forms #>> '{RUN_CANCELLED,1}')::bigint
    AND (v_forms #>> '{STEP_SKIPPED:REJECTED,2}')::bigint < (v_forms #>> '{RUN_CANCELLED,1}')::bigint;
  v_d := coalesce(v_d, false);
  -- The batch itself: 1..16 calls, none with native value (native value moves without any log the server's proof could see).
  IF v_d THEN
    v_d := CASE WHEN jsonb_typeof(g.prepared #> '{request,calls}') = 'array'
      THEN jsonb_array_length(g.prepared #> '{request,calls}') BETWEEN 1 AND 16 AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(g.prepared #> '{request,calls}') c
        WHERE jsonb_typeof(c -> 'value') IS DISTINCT FROM 'string' OR NOT (c ->> 'value') ~ '^0x0+$')
      ELSE false END;
  END IF;
  v_shape := CASE WHEN v_p THEN 'NO_WALLET_REQUEST' WHEN v_d THEN 'WALLET_REJECTED_VERIFIED' END;

  -- Anything that can still act on the run, or that the run is part of.
  v_dependency := coalesce(cardinality(h.run_ids) > 0, false)
    OR coalesce(h.signing_digest IS NOT NULL AND h.signing_expires_at > clock_timestamp(), false)
    OR EXISTS (SELECT 1 FROM developer_approvals WHERE tenant_id = p_tenant AND handoff_id = r.handoff_id)
    OR EXISTS (SELECT 1 FROM delegated_executions WHERE tenant_id = p_tenant AND workflow_run_id = p_id)
    OR EXISTS (SELECT 1 FROM delegated_authorizations WHERE tenant_id = p_tenant AND workflow_run_id = p_id)
    OR EXISTS (SELECT 1 FROM work_items WHERE tenant_id = p_tenant AND kind = 'workflow-run.advance' AND dedupe_key = p_id AND state = 'LEASED')
    OR EXISTS (SELECT 1 FROM work_items WHERE tenant_id = p_tenant AND state IN ('READY', 'LEASED') AND kind <> 'workflow-run.advance'
      AND (dedupe_key = p_id OR run_id = p_id OR strpos(payload::text, p_id) > 0));
  -- Operator records about the run: kept, and refused without saying why (they are not the owner's).
  v_guard := EXISTS (SELECT 1 FROM privacy_legal_holds WHERE tenant_id = p_tenant AND released_at IS NULL
      AND (scope = 'TENANT' OR (scope = 'RUN' AND scope_value IN (p_id, r.handoff_id))))
    OR EXISTS (SELECT 1 FROM admin_support_texts WHERE tenant_id = p_tenant AND (run_id IN (p_id, r.handoff_id) OR incident_id = 'wfr:' || p_id));

  IF v_shape IS NULL OR v_dependency OR v_guard THEN
    IF v_shape IS NOT NULL THEN
      RETURN CASE WHEN v_dependency THEN '{"ok":false,"code":"RUN_DELETE_REFUSED","reason":"DEPENDENCY"}' ELSE '{"ok":false,"code":"RUN_DELETE_REFUSED"}' END;
    END IF;
    -- The reason class, as owner history explains an execution refusal: activity first, then an authorization, then a dependency.
    v_activity := r.state IN ('COMPLETED', 'ATTENTION') OR r.completed_at IS NOT NULL OR r.code = ANY (v_unsure)
      OR EXISTS (SELECT 1 FROM workflow_run_steps WHERE tenant_id = p_tenant AND run_id = p_id
        AND (state IN ('AWAITING_OWNER', 'RECONCILED', 'FAILED', 'UNCERTAIN') OR outcome IS NOT NULL OR claimed_at IS NOT NULL OR code = ANY (v_unsure)))
      OR EXISTS (SELECT 1 FROM workflow_run_groups WHERE tenant_id = p_tenant AND run_id = p_id
        AND (state IN ('SUBMITTED', 'UNCERTAIN', 'RECONCILED', 'FAILED') OR submission IS NOT NULL OR outcome IS NOT NULL OR prepared IS NOT NULL
          OR code = ANY (v_unsure)))
      OR EXISTS (SELECT 1 FROM workflow_run_events WHERE tenant_id = p_tenant AND run_id = p_id AND (code = ANY (v_unsure)
        OR kind IN ('STEP_LOADED', 'GROUP_PREPARED_AGAIN', 'GROUP_TOKEN_GAS_PREPARED', 'GROUP_KORA_RELAY', 'GROUP_BRIDGE_OBSERVED', 'GAS_MECHANISM_SWITCHED',
          'RUN_COMPLETED', 'RUN_STEP_ADVANCED', 'GROUP_WALLET_DECLINED')
        OR (kind = 'GROUP_STATE' AND detail ->> 'state' IN ('PREPARED', 'SUBMITTED', 'UNCERTAIN', 'RECONCILED', 'FAILED', 'EXPIRED'))));
    v_authorization := r.authorization_id IS NOT NULL OR r.mode = 'DELEGATED'
      OR EXISTS (SELECT 1 FROM delegated_authorizations WHERE tenant_id = p_tenant AND workflow_run_id = p_id)
      OR EXISTS (SELECT 1 FROM workflow_run_groups WHERE tenant_id = p_tenant AND run_id = p_id AND (owner_authorization IS NOT NULL OR state = 'AUTHORIZED'))
      OR EXISTS (SELECT 1 FROM workflow_run_events WHERE tenant_id = p_tenant AND run_id = p_id AND (kind IN ('GROUP_AUTHORIZED', 'GROUP_PERMIT_SIGNED',
        'GROUP_UPGRADE_CONSENTED', 'GROUP_UPGRADE_AUTHORIZED', 'GROUP_CIRCLE_ANSWERED') OR (kind = 'GROUP_STATE' AND detail ->> 'state' = 'AUTHORIZED')));
    RETURN CASE WHEN coalesce(v_activity, false) THEN '{"ok":false,"code":"RUN_DELETE_REFUSED","reason":"EXECUTION_ACTIVITY"}'
      WHEN coalesce(v_authorization, false) THEN '{"ok":false,"code":"RUN_DELETE_REFUSED","reason":"AUTHORIZATION"}'
      WHEN v_dependency THEN '{"ok":false,"code":"RUN_DELETE_REFUSED","reason":"DEPENDENCY"}'
      ELSE '{"ok":false,"code":"RUN_DELETE_REFUSED"}' END;
  END IF;

  INSERT INTO workflow_run_purge_audit (tenant_id, run_id, handoff_id, owner_namespace, owner_account, shape, final_state, run_created_at, event_count)
    VALUES (p_tenant, p_id, r.handoff_id, r.owner_namespace, p_owner, v_shape, r.state, r.created_at, v_events);
  INSERT INTO workflow_run_purge_permits (tenant_id, run_id, transaction_id) VALUES (p_tenant, p_id, txid_current());
  DELETE FROM workflow_run_events WHERE tenant_id = p_tenant AND run_id = p_id;
  DELETE FROM workflow_run_groups WHERE tenant_id = p_tenant AND run_id = p_id;
  DELETE FROM workflow_run_steps WHERE tenant_id = p_tenant AND run_id = p_id;
  DELETE FROM workflow_runs WHERE tenant_id = p_tenant AND run_id = p_id;
  DELETE FROM workflow_run_purge_permits WHERE tenant_id = p_tenant AND run_id = p_id;
  -- After the run (its foreign key): the approval link can never be claimed again, and no run can be created for it again.
  DELETE FROM mcp_handoffs WHERE tenant_id = p_tenant AND handoff_id = r.handoff_id;
  -- Only the run's own advance work that no worker holds (a LEASED item refused above).
  DELETE FROM work_items WHERE tenant_id = p_tenant AND kind = 'workflow-run.advance' AND dedupe_key = p_id AND state IN ('READY', 'DONE', 'DEAD');
  DELETE FROM owner_history_visibility WHERE tenant_id = p_tenant AND owner_account = p_owner AND kind = 'WORKFLOW_RUN' AND record_id = p_id;
  RETURN '{"ok":true,"disposition":"DELETED"}';
EXCEPTION WHEN foreign_key_violation THEN
  -- A concurrent FK-protected dependency won. The implicit subtransaction rolls back the tombstone, the permit and every deletion.
  RETURN '{"ok":false,"code":"RUN_DELETE_REFUSED"}';
END; $$;
REVOKE ALL ON FUNCTION purge_unsubmitted_workflow_run(text, text, text) FROM PUBLIC;
