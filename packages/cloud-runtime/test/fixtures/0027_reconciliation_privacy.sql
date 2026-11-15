-- SPDX-License-Identifier: AGPL-3.0-only
-- BUILD-FLOFI-RECONCILIATION-PRIVACY-UX-001 0027: additive. Six new tables with their own functions and triggers. No existing relation,
-- function, trigger, CHECK or index changes, and no existing row is read, rewritten or deleted. In particular `admin_audit_events` keeps its
-- append-only trigger and every row as written: the privacy controls below govern only text and keys created from this build on.
--
-- Nothing here is financial authority and nothing here can change an execution's state: the nonce-conflict table is a diagnostic cache that no
-- flow reads, and the privacy tables hold operator text, lookup keys, legal holds, data-subject requests and retention approvals.
--
-- Rolling deployments: if a lock cannot be taken within 5 s (the foreign keys briefly lock `tenants` and `execution_runs` against concurrent
-- schema changes), the migration fails and rolls back entirely, instead of queueing every later writer behind it.
SET LOCAL lock_timeout = '5s';

-- 1. P0: read-only nonce-conflict investigations, one row per conflicted attempt. Removed with its run (owner history purge).
CREATE TABLE execution_nonce_conflicts (
  tenant_id text NOT NULL,
  run_id text NOT NULL,
  attempt_id text NOT NULL CHECK (attempt_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$'),
  flow text NOT NULL CHECK (flow ~ '^[a-z][a-z0-9-]{0,62}$'),
  chain_id text NOT NULL CHECK (chain_id ~ '^[1-9][0-9]{0,19}$'),
  nonce text NOT NULL CHECK (nonce ~ '^(0|[1-9][0-9]{0,19})$'),
  conflicting_transaction_hash text CHECK (conflicting_transaction_hash IS NULL OR conflicting_transaction_hash ~ '^0x[0-9a-f]{64}$'),
  classification text NOT NULL CHECK (classification IN ('MATCHING_TRANSACTION_CONFIRMED', 'CONFLICTING_TRANSACTION_IDENTIFIED',
    'DELEGATED_EXECUTION_UNDETERMINED', 'POSSIBLE_ALTERNATE_NONCE', 'INSUFFICIENT_CHAIN_EVIDENCE')),
  evidence_fingerprint text NOT NULL CHECK (evidence_fingerprint ~ '^[0-9a-f]{64}$'),
  report jsonb NOT NULL CHECK (jsonb_typeof(report) = 'object' AND octet_length(report::text) <= 32768),
  stable_observations integer NOT NULL CHECK (stable_observations >= 0),
  investigations integer NOT NULL CHECK (investigations >= 1),
  first_observed_at timestamptz NOT NULL,
  last_checked_at timestamptz NOT NULL,
  last_changed_at timestamptz NOT NULL,
  last_verified_at timestamptz,
  last_check_code text CHECK (last_check_code IS NULL OR last_check_code ~ '^[A-Z][A-Z0-9_]{1,80}$'),
  escalated_at timestamptz,
  PRIMARY KEY (tenant_id, run_id, attempt_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES execution_runs (tenant_id, run_id) ON DELETE CASCADE
);

-- 2. P1: legal holds. A hold blocks retention and erasure of what it covers; it is released (never deleted) with its own approval reference.
CREATE TABLE privacy_legal_holds (
  tenant_id text NOT NULL REFERENCES tenants (tenant_id),
  hold_id text NOT NULL CHECK (hold_id ~ '^lgh_[a-z2-7]{26}$'),
  scope text NOT NULL CHECK (scope IN ('TENANT', 'RUN', 'LOOKUP_PERIOD')),
  scope_value text CHECK (scope_value IS NULL OR scope_value ~ '^(?!0[xX])[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{2,60}$'),
  approval_ref text NOT NULL CHECK (approval_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{2,119}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  release_approval_ref text CHECK (release_approval_ref IS NULL OR release_approval_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{2,119}$'),
  PRIMARY KEY (tenant_id, hold_id),
  CHECK ((scope = 'TENANT') = (scope_value IS NULL)),
  CHECK ((released_at IS NULL) = (release_approval_ref IS NULL))
);
CREATE INDEX privacy_legal_holds_active ON privacy_legal_holds (tenant_id, scope, scope_value) WHERE released_at IS NULL;
CREATE FUNCTION privacy_legal_hold_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'PRIVACY_LEGAL_HOLD_PERMANENT' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.hold_id IS DISTINCT FROM OLD.hold_id OR NEW.scope IS DISTINCT FROM OLD.scope
     OR NEW.scope_value IS DISTINCT FROM OLD.scope_value OR NEW.reason_code IS DISTINCT FROM OLD.reason_code OR NEW.approval_ref IS DISTINCT FROM OLD.approval_ref
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR OLD.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'PRIVACY_LEGAL_HOLD_IMMUTABLE' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER privacy_legal_hold_transition BEFORE UPDATE OR DELETE ON privacy_legal_holds FOR EACH ROW EXECUTE FUNCTION privacy_legal_hold_transition();

-- 3. P1: support free text (recovery reasons, notes), separate from the append-only audit skeleton. The audit event keeps `textRef` and an HMAC
--    of the body under the row's own random salt; deleting the row (retention or an approved erasure) deletes body and salt together, leaving
--    the skeleton intact and the digest unlinkable. A body never changes (a correction is a new note). An active legal hold blocks deletion.
CREATE TABLE admin_support_texts (
  tenant_id text NOT NULL REFERENCES tenants (tenant_id),
  text_id text NOT NULL CHECK (text_id ~ '^stx_[a-z2-7]{26}$'),
  purpose text NOT NULL CHECK (purpose IN ('RECOVERY_REASON', 'SUPPORT_NOTE')),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 500 AND body !~ '[[:cntrl:]]'),
  salt bytea NOT NULL CHECK (octet_length(salt) = 32),
  run_id text CHECK (run_id IS NULL OR run_id ~ '^(?!0[xX])[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
  incident_id text CHECK (incident_id IS NULL OR incident_id ~ '^[A-Za-z0-9:._-]{1,140}$'),
  created_by text NOT NULL CHECK (created_by ~ '^(adm_[a-z2-7]{26}|cli)$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, text_id),
  CHECK (expires_at > created_at)
);
CREATE INDEX admin_support_texts_expiry ON admin_support_texts (tenant_id, expires_at);
CREATE INDEX admin_support_texts_run ON admin_support_texts (tenant_id, run_id) WHERE run_id IS NOT NULL;
CREATE FUNCTION admin_support_text_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'ADMIN_SUPPORT_TEXT_IMMUTABLE' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF EXISTS (SELECT 1 FROM privacy_legal_holds h WHERE h.tenant_id = OLD.tenant_id AND h.released_at IS NULL
      AND (h.scope = 'TENANT' OR (h.scope = 'RUN' AND h.scope_value = OLD.run_id))) THEN
    RAISE EXCEPTION 'ADMIN_SUPPORT_TEXT_LEGAL_HOLD' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER admin_support_text_guard BEFORE UPDATE OR DELETE ON admin_support_texts FOR EACH ROW EXECUTE FUNCTION admin_support_text_guard();

-- 4. P1: period-scoped lookup-fingerprint keys (calendar quarters). Each key is random and stored only wrapped (AES-256-GCM) under a key
--    derived from the deployment's admin secret, so the database alone cannot compute a fingerprint. Destroying a key (wrapped bytes set to NULL,
--    the row kept as the record of destruction) makes that quarter's SUPPORT_SEARCH fingerprints unlinkable without touching an audit row.
--    `kek_id` identifies the wrapping key: after an admin-secret rotation the old rows can no longer be unwrapped and a new key is created
--    for the same quarter under the new `kek_id` (each audit event names the `kek_id` and quarter it used).
CREATE TABLE admin_lookup_keys (
  tenant_id text NOT NULL REFERENCES tenants (tenant_id),
  period text NOT NULL CHECK (period ~ '^[0-9]{4}-Q[1-4]$'),
  wrapped_key bytea CHECK (wrapped_key IS NULL OR octet_length(wrapped_key) = 60),
  kek_id text NOT NULL CHECK (kek_id ~ '^[0-9a-f]{16}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  destroyed_at timestamptz,
  destroy_reason text CHECK (destroy_reason IS NULL OR destroy_reason IN ('RETENTION_EXPIRED', 'KEK_UNAVAILABLE')),
  PRIMARY KEY (tenant_id, period, kek_id),
  CHECK ((destroyed_at IS NULL) = (destroy_reason IS NULL)),
  CHECK ((destroyed_at IS NULL) = (wrapped_key IS NOT NULL))
);
CREATE FUNCTION admin_lookup_key_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'ADMIN_LOOKUP_KEY_PERMANENT' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.period IS DISTINCT FROM OLD.period OR NEW.kek_id IS DISTINCT FROM OLD.kek_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR OLD.destroyed_at IS NOT NULL OR NEW.destroyed_at IS NULL THEN
    RAISE EXCEPTION 'ADMIN_LOOKUP_KEY_IMMUTABLE' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM privacy_legal_holds h WHERE h.tenant_id = OLD.tenant_id AND h.released_at IS NULL
      AND (h.scope = 'TENANT' OR (h.scope = 'LOOKUP_PERIOD' AND h.scope_value = OLD.period))) THEN
    RAISE EXCEPTION 'ADMIN_LOOKUP_KEY_LEGAL_HOLD' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER admin_lookup_key_transition BEFORE UPDATE OR DELETE ON admin_lookup_keys FOR EACH ROW EXECUTE FUNCTION admin_lookup_key_transition();

-- 5. P1: data-subject requests (access, correction, erasure, objection, restriction). The subject is a keyed fingerprint, never a raw wallet.
--    RECEIVED → APPROVED | REJECTED, APPROVED → COMPLETED; identity fields never change; rows are never deleted.
CREATE TABLE privacy_requests (
  tenant_id text NOT NULL REFERENCES tenants (tenant_id),
  request_id text NOT NULL CHECK (request_id ~ '^dsr_[a-z2-7]{26}$'),
  kind text NOT NULL CHECK (kind IN ('ACCESS', 'CORRECTION', 'ERASURE', 'OBJECTION', 'RESTRICTION')),
  subject_kind text NOT NULL CHECK (subject_kind IN ('WALLET', 'ADMIN_PRINCIPAL')),
  subject_ref text NOT NULL CHECK (subject_ref ~ '^([0-9a-f]{32}|adm_[a-z2-7]{26})$'),
  state text NOT NULL CHECK (state IN ('RECEIVED', 'APPROVED', 'REJECTED', 'COMPLETED')),
  decision_code text CHECK (decision_code IS NULL OR decision_code ~ '^[A-Z][A-Z0-9_]{2,60}$'),
  approval_ref text CHECK (approval_ref IS NULL OR approval_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{2,119}$'),
  result jsonb CHECK (result IS NULL OR (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 4096)),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, request_id),
  CHECK ((state = 'RECEIVED') = (decided_at IS NULL)),
  CHECK ((state = 'COMPLETED') = (completed_at IS NOT NULL)),
  CHECK (state NOT IN ('APPROVED', 'COMPLETED') OR approval_ref IS NOT NULL)
);
CREATE FUNCTION privacy_request_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'PRIVACY_REQUEST_PERMANENT' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.subject_kind IS DISTINCT FROM OLD.subject_kind OR NEW.subject_ref IS DISTINCT FROM OLD.subject_ref OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'PRIVACY_REQUEST_IMMUTABLE' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT ((OLD.state = 'RECEIVED' AND NEW.state IN ('APPROVED', 'REJECTED')) OR (OLD.state = 'APPROVED' AND NEW.state = 'COMPLETED'
      AND NEW.approval_ref IS NOT DISTINCT FROM OLD.approval_ref AND NEW.decided_at IS NOT DISTINCT FROM OLD.decided_at
      AND NEW.decision_code IS NOT DISTINCT FROM OLD.decision_code)) THEN
    RAISE EXCEPTION 'PRIVACY_REQUEST_TRANSITION_INVALID' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER privacy_request_transition BEFORE UPDATE OR DELETE ON privacy_requests FOR EACH ROW EXECUTE FUNCTION privacy_request_transition();

-- 6. P1: retention activations. Deploying this build activates nothing: destructive retention runs only while an ACTIVE row exists for the
--    policy, created by the operator CLI with the reference of the approval (legal/owner) it rests on. One active activation per policy.
CREATE TABLE privacy_retention_activations (
  tenant_id text NOT NULL REFERENCES tenants (tenant_id),
  activation_id text NOT NULL CHECK (activation_id ~ '^rta_[a-z2-7]{26}$'),
  policy text NOT NULL CHECK (policy IN ('SUPPORT_TEXT', 'LOOKUP_KEYS')),
  retention_days integer NOT NULL CHECK (retention_days BETWEEN 30 AND 3650),
  approval_ref text NOT NULL CHECK (approval_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{2,119}$'),
  state text NOT NULL CHECK (state IN ('ACTIVE', 'REVOKED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (tenant_id, activation_id),
  CHECK ((state = 'REVOKED') = (revoked_at IS NOT NULL))
);
CREATE UNIQUE INDEX privacy_retention_activations_active ON privacy_retention_activations (tenant_id, policy) WHERE state = 'ACTIVE';
CREATE FUNCTION privacy_retention_activation_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'PRIVACY_RETENTION_ACTIVATION_PERMANENT' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.activation_id IS DISTINCT FROM OLD.activation_id OR NEW.policy IS DISTINCT FROM OLD.policy
     OR NEW.retention_days IS DISTINCT FROM OLD.retention_days OR NEW.approval_ref IS DISTINCT FROM OLD.approval_ref OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NOT (OLD.state = 'ACTIVE' AND NEW.state = 'REVOKED') THEN
    RAISE EXCEPTION 'PRIVACY_RETENTION_ACTIVATION_IMMUTABLE' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER privacy_retention_activation_transition BEFORE UPDATE OR DELETE ON privacy_retention_activations FOR EACH ROW
  EXECUTE FUNCTION privacy_retention_activation_transition();

-- 7. TRUNCATE fires no row trigger: it is refused outright on every table whose rows carry holds, permanence or immutability.
CREATE FUNCTION reject_privacy_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'PRIVACY_TRUNCATE_REFUSED: %', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
CREATE TRIGGER admin_support_texts_no_truncate BEFORE TRUNCATE ON admin_support_texts FOR EACH STATEMENT EXECUTE FUNCTION reject_privacy_truncate();
CREATE TRIGGER admin_lookup_keys_no_truncate BEFORE TRUNCATE ON admin_lookup_keys FOR EACH STATEMENT EXECUTE FUNCTION reject_privacy_truncate();
CREATE TRIGGER privacy_legal_holds_no_truncate BEFORE TRUNCATE ON privacy_legal_holds FOR EACH STATEMENT EXECUTE FUNCTION reject_privacy_truncate();
CREATE TRIGGER privacy_requests_no_truncate BEFORE TRUNCATE ON privacy_requests FOR EACH STATEMENT EXECUTE FUNCTION reject_privacy_truncate();
CREATE TRIGGER privacy_retention_activations_no_truncate BEFORE TRUNCATE ON privacy_retention_activations FOR EACH STATEMENT
  EXECUTE FUNCTION reject_privacy_truncate();
