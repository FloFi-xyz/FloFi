-- SPDX-License-Identifier: AGPL-3.0-only
-- BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 0037: durable execution origins and the platform fee ledger. Additive: three new tables, each with
-- its own (non SECURITY DEFINER) trigger functions; no pre-existing relation, function, trigger, policy or index changes.
--
-- 1. execution_origins: the channel an execution started from, written once at creation (or when an approval binds a run, or by the audited
--    backfill) and never updated. One row per execution: a single flow (`execution_runs`) or a workflow run (`workflow_runs`). It follows the
--    execution's life: an owner-deleted unstarted run takes its origin with it (ON DELETE CASCADE), so the 0016/0033 purge procedures keep working.
-- 2. execution_origin_corrections: append-only, explicitly approved historical corrections (the origin row itself is never rewritten).
-- 3. platform_fee_ledger: one row per execution (the canonical execution identity, never a saved workflow), recording the fee a completed
--    execution owes under the policy it ran with, and, later, its collection. Exactly-once by its unique keys; every state change is a
--    compare-and-set on `version` through the transition trigger; COLLECTED needs collection evidence (transactions) in the row itself.
-- See docs/deploy/SCHEMA-COMPATIBILITY.md §29 (certificate 0037_execution_origins_platform_fees) and docs/deploy/RELEASE-REVENUE-ORIGINS-0037.md.
SET LOCAL lock_timeout = '5s';

CREATE TABLE execution_origins (
  tenant_id text NOT NULL REFERENCES tenants (tenant_id),
  run_id text,
  workflow_run_id text,
  origin text NOT NULL CHECK (origin IN ('web_chat', 'web_editor', 'web', 'legacy_web', 'mcp_chatgpt', 'mcp_claude', 'mcp_other', 'telegram',
    'developer_api', 'automation', 'unknown')),
  -- CREATION: written by the server when the execution was created; APPROVAL_BINDING: when the approval it was signed through bound it;
  -- BACKFILL: the audited historical recovery (docs/deploy/RELEASE-REVENUE-ORIGINS-0037.md).
  basis text NOT NULL CHECK (basis IN ('CREATION', 'APPROVAL_BINDING', 'BACKFILL')),
  -- A closed code naming the server-side record the origin was derived from (never an identifier, address or label).
  evidence text NOT NULL CHECK (evidence ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((run_id IS NULL) <> (workflow_run_id IS NULL)),
  UNIQUE (tenant_id, run_id),
  UNIQUE (tenant_id, workflow_run_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES execution_runs (tenant_id, run_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, workflow_run_id) REFERENCES workflow_runs (tenant_id, run_id) ON DELETE CASCADE
);
CREATE INDEX execution_origins_recorded ON execution_origins (tenant_id, recorded_at);

CREATE FUNCTION execution_origin_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'EXECUTION_ORIGIN_IMMUTABLE' USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
CREATE TRIGGER execution_origin_immutable BEFORE UPDATE ON execution_origins FOR EACH ROW EXECUTE FUNCTION execution_origin_immutable();

CREATE TABLE execution_origin_corrections (
  tenant_id text NOT NULL REFERENCES tenants (tenant_id),
  correction_id text NOT NULL CHECK (correction_id ~ '^eoc_[a-z2-7]{26}$'),
  run_id text,
  workflow_run_id text,
  origin text NOT NULL CHECK (origin IN ('web_chat', 'web_editor', 'web', 'legacy_web', 'mcp_chatgpt', 'mcp_claude', 'mcp_other', 'telegram',
    'developer_api', 'automation', 'unknown')),
  previous_origin text CHECK (previous_origin IS NULL OR previous_origin IN ('web_chat', 'web_editor', 'web', 'legacy_web', 'mcp_chatgpt', 'mcp_claude',
    'mcp_other', 'telegram', 'developer_api', 'automation', 'unknown')),
  approval_ref text NOT NULL CHECK (approval_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$'),
  reason_code text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, correction_id),
  CHECK ((run_id IS NULL) <> (workflow_run_id IS NULL)),
  FOREIGN KEY (tenant_id, run_id) REFERENCES execution_runs (tenant_id, run_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, workflow_run_id) REFERENCES workflow_runs (tenant_id, run_id) ON DELETE CASCADE
);
CREATE INDEX execution_origin_corrections_run ON execution_origin_corrections (tenant_id, run_id, created_at) WHERE run_id IS NOT NULL;
CREATE INDEX execution_origin_corrections_workflow_run ON execution_origin_corrections (tenant_id, workflow_run_id, created_at) WHERE workflow_run_id IS NOT NULL;

CREATE FUNCTION execution_origin_correction_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'EXECUTION_ORIGIN_CORRECTION_APPEND_ONLY' USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
CREATE TRIGGER execution_origin_correction_append_only BEFORE UPDATE ON execution_origin_corrections FOR EACH ROW
  EXECUTE FUNCTION execution_origin_correction_append_only();

CREATE TABLE platform_fee_ledger (
  tenant_id text NOT NULL REFERENCES tenants (tenant_id),
  run_id text,
  workflow_run_id text,
  policy_id text NOT NULL CHECK (policy_id ~ '^flofi-platform-fee/[a-z0-9.-]{1,40}$'),
  rate_bps integer NOT NULL CHECK (rate_bps BETWEEN 0 AND 10000),
  -- DUE: a completed execution owes the fee (collection not started). NOT_APPLICABLE: nothing feeable. WAIVED: the execution did not
  -- complete. UNSUPPORTED: its accounting cannot be read; never charged. COLLECTION_*: the collection lifecycle (only with collection active).
  state text NOT NULL CHECK (state IN ('DUE', 'NOT_APPLICABLE', 'WAIVED', 'UNSUPPORTED', 'COLLECTION_PENDING', 'COLLECTED', 'COLLECTION_FAILED')),
  reason text CHECK (reason IS NULL OR reason ~ '^[A-Z][A-Z0-9_]{2,80}$'),
  -- Per exact asset: {"chainId","address","decimals","principal","fee"} in native units (decimal strings).
  lines jsonb NOT NULL CHECK (jsonb_typeof(lines) = 'array' AND jsonb_array_length(lines) <= 16 AND octet_length(lines::text) <= 8192),
  origin text CHECK (origin IS NULL OR origin IN ('web_chat', 'web_editor', 'web', 'legacy_web', 'mcp_chatgpt', 'mcp_claude', 'mcp_other', 'telegram',
    'developer_api', 'automation', 'unknown')),
  network_environment text NOT NULL CHECK (network_environment IN ('MAINNET', 'PUBLIC_TESTNET', 'MOCKED')),
  collection jsonb CHECK (collection IS NULL OR (jsonb_typeof(collection) = 'object' AND octet_length(collection::text) <= 4096)),
  execution_completed_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((run_id IS NULL) <> (workflow_run_id IS NULL)),
  UNIQUE (tenant_id, run_id),
  UNIQUE (tenant_id, workflow_run_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES execution_runs (tenant_id, run_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, workflow_run_id) REFERENCES workflow_runs (tenant_id, run_id) ON DELETE CASCADE,
  -- Something is owed only with a positive fee line; a fee is never reported collected without the transactions that collected it.
  CHECK (state NOT IN ('DUE', 'COLLECTION_PENDING', 'COLLECTED', 'COLLECTION_FAILED') OR jsonb_array_length(lines) > 0),
  CHECK (state <> 'COLLECTED' OR (collection IS NOT NULL AND jsonb_typeof(collection->'transactions') = 'array'
    AND jsonb_array_length(collection->'transactions') > 0)),
  CHECK (state <> 'DUE' OR collection IS NULL)
);
CREATE INDEX platform_fee_ledger_created ON platform_fee_ledger (tenant_id, created_at);
CREATE INDEX platform_fee_ledger_open ON platform_fee_ledger (tenant_id, updated_at) WHERE state IN ('DUE', 'COLLECTION_PENDING', 'COLLECTION_FAILED');

CREATE FUNCTION platform_fee_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state NOT IN ('DUE', 'NOT_APPLICABLE', 'WAIVED', 'UNSUPPORTED') OR NEW.collection IS NOT NULL OR NEW.version <> 1 THEN
      RAISE EXCEPTION 'PLATFORM_FEE_INSERT_INVALID' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    -- Only the cascade of an owner-deleted unstarted execution can reach here; anything owed or collected stays.
    IF OLD.state IN ('DUE', 'COLLECTION_PENDING', 'COLLECTED', 'COLLECTION_FAILED') THEN
      RAISE EXCEPTION 'PLATFORM_FEE_LEDGER_RETAINED' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.workflow_run_id IS DISTINCT FROM OLD.workflow_run_id
     OR NEW.policy_id IS DISTINCT FROM OLD.policy_id OR NEW.rate_bps IS DISTINCT FROM OLD.rate_bps OR NEW.lines IS DISTINCT FROM OLD.lines
     OR NEW.origin IS DISTINCT FROM OLD.origin OR NEW.network_environment IS DISTINCT FROM OLD.network_environment
     OR NEW.execution_completed_at IS DISTINCT FROM OLD.execution_completed_at OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'PLATFORM_FEE_LEDGER_IMMUTABLE' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT ((OLD.state = 'DUE' AND NEW.state = 'COLLECTION_PENDING')
       OR (OLD.state = 'COLLECTION_PENDING' AND NEW.state IN ('COLLECTED', 'COLLECTION_FAILED'))
       OR (OLD.state = 'COLLECTION_FAILED' AND NEW.state = 'COLLECTION_PENDING')) THEN
    RAISE EXCEPTION 'PLATFORM_FEE_TRANSITION_INVALID' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER platform_fee_transition BEFORE INSERT OR UPDATE OR DELETE ON platform_fee_ledger FOR EACH ROW EXECUTE FUNCTION platform_fee_transition();
