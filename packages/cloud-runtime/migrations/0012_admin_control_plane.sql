-- SPDX-License-Identifier: AGPL-3.0-only
-- BUILD-ADMIN-001 0012: the private FloFi Admin control plane, additive. Nothing here is financial authority: an administrator can read
-- operational data and tune the Copilot interpreter; no table below can sign, submit, approve or change an execution. Every row is
-- tenant-scoped. No key, signature, secret, prompt or transcript is stored. Existing tables keep their meaning; the only change to an
-- existing table is one read index on execution_runs for time-ranged analytics.

-- 1. Administrators: explicit grants to a proven EVM wallet, made only by the operator CLI (database access). A wallet session never
--    implies a grant. Identity and role never change; a grant only moves ACTIVE → REVOKED (re-granting creates a new principal).
CREATE TABLE admin_principals (
  tenant_id text NOT NULL REFERENCES tenants (tenant_id),
  principal_id text NOT NULL CHECK (principal_id ~ '^adm_[a-z2-7]{26}$'),
  namespace text NOT NULL CHECK (namespace = 'eip155'),
  account text NOT NULL CHECK (account ~ '^0x[0-9a-f]{40}$'),
  role text NOT NULL CHECK (role IN ('VIEWER', 'OPERATOR')),
  state text NOT NULL CHECK (state IN ('ACTIVE', 'REVOKED')),
  label text CHECK (label IS NULL OR (length(label) BETWEEN 1 AND 80 AND label !~ '[[:cntrl:]]')),
  granted_by text NOT NULL CHECK (granted_by = 'cli'),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (tenant_id, principal_id),
  CHECK ((state = 'REVOKED') = (revoked_at IS NOT NULL))
);
CREATE UNIQUE INDEX admin_principals_active_account ON admin_principals (tenant_id, namespace, account) WHERE state = 'ACTIVE';

CREATE FUNCTION admin_principal_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ADMIN_PRINCIPAL_PERMANENT' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.principal_id IS DISTINCT FROM OLD.principal_id OR NEW.namespace IS DISTINCT FROM OLD.namespace
     OR NEW.account IS DISTINCT FROM OLD.account OR NEW.role IS DISTINCT FROM OLD.role OR NEW.label IS DISTINCT FROM OLD.label
     OR NEW.granted_by IS DISTINCT FROM OLD.granted_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'ADMIN_PRINCIPAL_IMMUTABLE' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT (OLD.state = 'ACTIVE' AND NEW.state = 'REVOKED') THEN
    RAISE EXCEPTION 'ADMIN_PRINCIPAL_TRANSITION_INVALID' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER admin_principal_transition BEFORE UPDATE OR DELETE ON admin_principals FOR EACH ROW EXECUTE FUNCTION admin_principal_transition();

-- 2. Server-side admin sessions. The browser holds only a sealed reference; every request re-checks the row and the principal, so a
--    sign-out or a revoked grant ends access immediately. A session only ends, once.
CREATE TABLE admin_sessions (
  tenant_id text NOT NULL,
  session_id text NOT NULL CHECK (session_id ~ '^[a-f0-9]{32}$'),
  principal_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ended_at timestamptz,
  end_reason text CHECK (end_reason IS NULL OR end_reason IN ('SIGNED_OUT', 'REVOKED', 'PRINCIPAL_REVOKED')),
  PRIMARY KEY (tenant_id, session_id),
  FOREIGN KEY (tenant_id, principal_id) REFERENCES admin_principals (tenant_id, principal_id),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '12 hours'),
  CHECK ((ended_at IS NULL) = (end_reason IS NULL))
);
CREATE INDEX admin_sessions_principal ON admin_sessions (tenant_id, principal_id, created_at DESC);

CREATE FUNCTION admin_session_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ADMIN_SESSION_PERMANENT' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR OLD.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'ADMIN_SESSION_IMMUTABLE' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER admin_session_transition BEFORE UPDATE OR DELETE ON admin_sessions FOR EACH ROW EXECUTE FUNCTION admin_session_transition();

-- 3. Append-only audit of administrative actions: closed codes, opaque ids and versions only (a refused sign-in stores no address).
CREATE TABLE admin_audit_events (
  tenant_id text NOT NULL REFERENCES tenants (tenant_id),
  event_id bigint GENERATED ALWAYS AS IDENTITY,
  at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL CHECK (actor ~ '^(adm_[a-z2-7]{26}|cli|anonymous)$'),
  kind text NOT NULL CHECK (kind ~ '^[A-Z][A-Z0-9_]{2,60}$'),
  outcome text NOT NULL CHECK (outcome IN ('OK', 'REFUSED', 'FAILED')),
  code text CHECK (code IS NULL OR code ~ '^[A-Z][A-Z0-9_]{2,80}$'),
  target text CHECK (target IS NULL OR target ~ '^[A-Za-z0-9:._-]{1,120}$'),
  detail jsonb CHECK (detail IS NULL OR (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 4096)),
  PRIMARY KEY (tenant_id, event_id)
);
CREATE INDEX admin_audit_events_at ON admin_audit_events (tenant_id, at DESC, event_id DESC);
CREATE INDEX admin_audit_events_kind ON admin_audit_events (tenant_id, kind, at DESC);
CREATE TRIGGER admin_audit_events_append_only BEFORE UPDATE OR DELETE ON admin_audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

-- 4. Versioned runtime settings. Append-only and gapless per key; the latest version is the active one. A rollback is a new version
--    that restores an older document; a NULL document returns to the deployment's environment bootstrap. Concurrent writers of the
--    same next version conflict on the primary key (optimistic concurrency).
CREATE TABLE admin_settings_versions (
  tenant_id text NOT NULL REFERENCES tenants (tenant_id),
  setting_key text NOT NULL CHECK (setting_key IN ('copilot')),
  version integer NOT NULL CHECK (version >= 1),
  document jsonb CHECK (document IS NULL OR (jsonb_typeof(document) = 'object' AND octet_length(document::text) <= 8192)),
  restored_from integer CHECK (restored_from IS NULL OR (restored_from >= 1 AND restored_from < version)),
  created_by text NOT NULL CHECK (created_by ~ '^(adm_[a-z2-7]{26}|cli)$'),
  reason text CHECK (reason IS NULL OR (length(reason) BETWEEN 1 AND 200 AND reason !~ '[[:cntrl:]]')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, setting_key, version)
);
CREATE FUNCTION admin_settings_gapless() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE latest integer;
BEGIN
  SELECT max(version) INTO latest FROM admin_settings_versions WHERE tenant_id = NEW.tenant_id AND setting_key = NEW.setting_key;
  IF NEW.version <> coalesce(latest, 0) + 1 THEN
    RAISE EXCEPTION 'ADMIN_SETTINGS_VERSION_CONFLICT' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER admin_settings_gapless BEFORE INSERT ON admin_settings_versions FOR EACH ROW EXECUTE FUNCTION admin_settings_gapless();
CREATE TRIGGER admin_settings_versions_append_only BEFORE UPDATE OR DELETE ON admin_settings_versions
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

-- 5. Analytics facts: a derived, rebuildable cache of what each run's canonical record says (its actions, their networks, a bridge's
--    destination, a composition's step runs). Written off the execution path (by the admin read path or the operator CLI), never read
--    by an execution, never containing an address. Deleting every row only costs a re-index.
CREATE TABLE admin_run_facts (
  tenant_id text NOT NULL,
  run_id text NOT NULL CHECK (run_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
  indexer_version integer NOT NULL CHECK (indexer_version >= 1),
  indexed_log_version bigint NOT NULL CHECK (indexed_log_version >= 1),
  state text NOT NULL CHECK (state IN ('INDEXED', 'UNINDEXABLE')),
  code text CHECK (code IS NULL OR code ~ '^[A-Z][A-Z0-9_]{2,80}$'),
  composition_of text CHECK (composition_of IS NULL OR composition_of ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
  actions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(actions) = 'array' AND octet_length(actions::text) <= 16384),
  indexed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, run_id),
  CHECK ((state = 'UNINDEXABLE') = (code IS NOT NULL))
);
CREATE INDEX admin_run_facts_composition ON admin_run_facts (tenant_id, composition_of) WHERE composition_of IS NOT NULL;

-- 6. Time-ranged analytics read the run projection by creation time.
CREATE INDEX execution_runs_created ON execution_runs (tenant_id, created_at);
