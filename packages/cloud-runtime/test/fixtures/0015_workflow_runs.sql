-- SPDX-License-Identifier: AGPL-3.0-only
-- BUILD-CHAT-E2E-001 0015: durable workflow runs (the sequential runner of a multi-step conversational workflow), additive.
--
-- A workflow run executes ONE approved multi-step workflow (an approval handoff whose plan is SEQUENTIAL) for the wallets its owner proved
-- when claiming it. Steps run strictly in order; a step starts only after the previous one reconciled. Two authorization modes, chosen once:
-- CONFIRM_EACH_STEP (each step is an ordinary owner-signed run of its own flow) and DELEGATED (the whole workflow under ONE Universal
-- Workflow Authorization, executed by the BUILD-AUTOMATION-002 delegated executor). What is stored: ids, the canonical strategy and hashes,
-- states, closed codes and public facts (run ids, transaction hashes, evidence environment/outcome/bundle hash, reconciled amounts). Never key
-- material, calldata or signatures.
--
-- Existing objects: the two BUILD-AUTOMATION-002 tables that named an automation rule as the only source of a delegated authorization and
-- execution now also accept a workflow run: their rule/occurrence columns become nullable, each gains a nullable `workflow_run_id`, an
-- exclusive-source check, a foreign key and a uniqueness rule, and a trigger that fires ONLY when `workflow_run_id` itself is written. Every
-- existing row keeps its rule and occurrence and satisfies every new rule; no existing function, trigger or index is redefined. See
-- docs/deploy/SCHEMA-COMPATIBILITY.md §9 (certificate 0015_workflow_runs).
SET LOCAL lock_timeout = '5s';

-- 1. Workflow runs.
CREATE TABLE workflow_runs (
  tenant_id text NOT NULL REFERENCES tenants (tenant_id),
  run_id text NOT NULL CHECK (run_id ~ '^wfr_[a-z2-7]{26}$'),
  handoff_id text NOT NULL,
  requester_kind text NOT NULL CHECK (requester_kind IN ('MCP_ACCOUNT', 'DEVELOPER_PROJECT', 'CHANNEL_CONVERSATION', 'AUTOMATION_RULE')),
  requester_ref text NOT NULL CHECK (length(requester_ref) BETWEEN 1 AND 128),
  owner_namespace text NOT NULL CHECK (owner_namespace IN ('eip155', 'solana')),
  owner_account text NOT NULL CHECK (
    (owner_namespace = 'eip155' AND owner_account ~ '^0x[0-9a-f]{40}$') OR
    (owner_namespace = 'solana' AND owner_account ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')),
  -- Every namespace's proven wallet, bound at the claim: {"eip155": "0x…", "solana": "…"}.
  wallets jsonb NOT NULL CHECK (jsonb_typeof(wallets) = 'object' AND octet_length(wallets::text) <= 512),
  strategy jsonb NOT NULL CHECK (jsonb_typeof(strategy) = 'object' AND octet_length(strategy::text) <= 16384),
  workflow_hash text NOT NULL CHECK (workflow_hash ~ '^0x[0-9a-f]{64}$'),
  engine_version text NOT NULL CHECK (engine_version ~ '^[a-z0-9][a-z0-9.+-]{0,63}$'),
  step_count integer NOT NULL CHECK (step_count BETWEEN 2 AND 8),
  mode text CHECK (mode IS NULL OR mode IN ('CONFIRM_EACH_STEP', 'DELEGATED')),
  state text NOT NULL CHECK (state IN ('PENDING', 'RUNNING', 'COMPLETED', 'HALTED', 'FAILED', 'ATTENTION', 'CANCELLED', 'EXPIRED')),
  current_step integer NOT NULL DEFAULT 0 CHECK (current_step BETWEEN 0 AND 7),
  authorization_id text CHECK (authorization_id IS NULL OR authorization_id ~ '^dau_[a-z2-7]{26}$'),
  code text CHECK (code IS NULL OR code ~ '^[A-Z][A-Z0-9_]{2,80}$'),
  -- The single "workflow completed" fact (every step reconciled), written once: the one event a per-workflow fee may ever key on.
  completed_at timestamptz,
  expires_at timestamptz NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, run_id),
  UNIQUE (tenant_id, handoff_id),
  UNIQUE (tenant_id, run_id, owner_namespace, owner_account),
  FOREIGN KEY (tenant_id, handoff_id) REFERENCES mcp_handoffs (tenant_id, handoff_id),
  CHECK ((state = 'COMPLETED') = (completed_at IS NOT NULL)),
  CHECK (mode IS NOT NULL OR state IN ('PENDING', 'CANCELLED', 'EXPIRED')),
  -- The mode and the delegated authorization are bound together, at the start (confirm) or at the passkey activation (delegated).
  CHECK ((mode IS NULL AND authorization_id IS NULL) OR (mode = 'CONFIRM_EACH_STEP' AND authorization_id IS NULL)
    OR (mode = 'DELEGATED' AND authorization_id IS NOT NULL)),
  CHECK (expires_at > created_at)
);
CREATE INDEX workflow_runs_owner ON workflow_runs (tenant_id, owner_namespace, owner_account, created_at DESC);
CREATE INDEX workflow_runs_requester ON workflow_runs (tenant_id, requester_kind, requester_ref, created_at DESC);
CREATE INDEX workflow_runs_open ON workflow_runs (tenant_id, updated_at) WHERE state IN ('PENDING', 'RUNNING', 'ATTENTION');

CREATE FUNCTION workflow_run_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.handoff_id IS DISTINCT FROM OLD.handoff_id
     OR NEW.requester_kind IS DISTINCT FROM OLD.requester_kind OR NEW.requester_ref IS DISTINCT FROM OLD.requester_ref
     OR NEW.owner_namespace IS DISTINCT FROM OLD.owner_namespace OR NEW.owner_account IS DISTINCT FROM OLD.owner_account OR NEW.wallets IS DISTINCT FROM OLD.wallets
     OR NEW.strategy IS DISTINCT FROM OLD.strategy OR NEW.workflow_hash IS DISTINCT FROM OLD.workflow_hash OR NEW.engine_version IS DISTINCT FROM OLD.engine_version
     OR NEW.step_count IS DISTINCT FROM OLD.step_count OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.created_at IS DISTINCT FROM OLD.created_at
     -- The mode and the authorization are chosen once; the completion fact is written once.
     OR (OLD.mode IS NOT NULL AND NEW.mode IS DISTINCT FROM OLD.mode)
     OR (OLD.authorization_id IS NOT NULL AND NEW.authorization_id IS DISTINCT FROM OLD.authorization_id)
     OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at)
     OR NEW.current_step < OLD.current_step OR NEW.current_step >= OLD.step_count OR NEW.version <= OLD.version THEN
    RAISE EXCEPTION 'WORKFLOW_RUN_IMMUTABLE' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.state IN ('COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED') THEN
    RAISE EXCEPTION 'WORKFLOW_RUN_TERMINAL' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.state <> OLD.state AND NOT (
       (OLD.state = 'PENDING' AND NEW.state IN ('RUNNING', 'FAILED', 'CANCELLED', 'EXPIRED'))
    OR (OLD.state = 'RUNNING' AND NEW.state IN ('COMPLETED', 'HALTED', 'FAILED', 'ATTENTION', 'CANCELLED'))
    OR (OLD.state = 'ATTENTION' AND NEW.state IN ('RUNNING', 'COMPLETED', 'HALTED', 'FAILED'))
    OR (OLD.state = 'HALTED' AND NEW.state IN ('RUNNING', 'CANCELLED'))) THEN
    RAISE EXCEPTION 'WORKFLOW_RUN_TRANSITION_INVALID' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER workflow_run_transition BEFORE UPDATE ON workflow_runs FOR EACH ROW EXECUTE FUNCTION workflow_run_transition();

-- 2. Steps: one row per step, created with the run. A step's resolved strategy and hash are written once, when it becomes READY.
CREATE TABLE workflow_run_steps (
  tenant_id text NOT NULL,
  run_id text NOT NULL,
  step_index integer NOT NULL CHECK (step_index BETWEEN 0 AND 7),
  state text NOT NULL CHECK (state IN ('PENDING', 'READY', 'AWAITING_OWNER', 'DELEGATED', 'RECONCILED', 'FAILED', 'UNCERTAIN', 'SKIPPED', 'BLOCKED')),
  flow text CHECK (flow IS NULL OR flow ~ '^[a-z][a-z0-9-]{1,63}$'),
  strategy jsonb CHECK (strategy IS NULL OR (jsonb_typeof(strategy) = 'object' AND octet_length(strategy::text) <= 8192)),
  workflow_hash text CHECK (workflow_hash IS NULL OR workflow_hash ~ '^0x[0-9a-f]{64}$'),
  -- A bound step's resolution: {"amountFrom": k, "cap": "…", "received": "…", "used": "…", "asset": {...}} (native units).
  bound jsonb CHECK (bound IS NULL OR (jsonb_typeof(bound) = 'object' AND octet_length(bound::text) <= 2048)),
  -- Owner-signed steps: when the owner loaded this step (runs of its flow created after it, reviewing exactly its hash, are its runs).
  claimed_at timestamptz,
  -- Public reconciled facts: run/execution ids, transaction hashes, evidence environment/outcome/bundle hash, spent/received.
  outcome jsonb CHECK (outcome IS NULL OR (jsonb_typeof(outcome) = 'object' AND octet_length(outcome::text) <= 16384)),
  code text CHECK (code IS NULL OR code ~ '^[A-Z][A-Z0-9_]{2,80}$'),
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, run_id, step_index),
  FOREIGN KEY (tenant_id, run_id) REFERENCES workflow_runs (tenant_id, run_id),
  CHECK ((strategy IS NULL) = (workflow_hash IS NULL)),
  CHECK (state NOT IN ('READY', 'AWAITING_OWNER', 'RECONCILED') OR strategy IS NOT NULL),
  CHECK (state <> 'AWAITING_OWNER' OR (flow IS NOT NULL AND claimed_at IS NOT NULL)),
  CHECK (state <> 'RECONCILED' OR outcome IS NOT NULL)
);
CREATE FUNCTION workflow_run_step_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.step_index IS DISTINCT FROM OLD.step_index
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.version <= OLD.version
     OR (OLD.strategy IS NOT NULL AND (NEW.strategy IS DISTINCT FROM OLD.strategy OR NEW.workflow_hash IS DISTINCT FROM OLD.workflow_hash))
     OR (OLD.flow IS NOT NULL AND NEW.flow IS DISTINCT FROM OLD.flow)
     OR (OLD.bound IS NOT NULL AND NEW.bound IS DISTINCT FROM OLD.bound)
     OR (OLD.claimed_at IS NOT NULL AND NEW.claimed_at IS DISTINCT FROM OLD.claimed_at) THEN
    RAISE EXCEPTION 'WORKFLOW_RUN_STEP_IMMUTABLE' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.state IN ('RECONCILED', 'FAILED', 'SKIPPED') THEN
    RAISE EXCEPTION 'WORKFLOW_RUN_STEP_TERMINAL' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.state <> OLD.state AND NOT (
       (OLD.state = 'PENDING' AND NEW.state IN ('READY', 'DELEGATED', 'SKIPPED', 'BLOCKED'))
    OR (OLD.state = 'READY' AND NEW.state IN ('AWAITING_OWNER', 'SKIPPED', 'BLOCKED'))
    OR (OLD.state = 'AWAITING_OWNER' AND NEW.state IN ('RECONCILED', 'FAILED', 'UNCERTAIN', 'SKIPPED', 'BLOCKED'))
    OR (OLD.state = 'DELEGATED' AND NEW.state IN ('RECONCILED', 'FAILED', 'UNCERTAIN', 'BLOCKED', 'SKIPPED'))
    OR (OLD.state = 'UNCERTAIN' AND NEW.state IN ('RECONCILED', 'FAILED'))
    -- A blocked step (nothing submitted) is re-evaluated only when its owner resumes the halted run.
    OR (OLD.state = 'BLOCKED' AND NEW.state IN ('PENDING', 'READY', 'SKIPPED'))) THEN
    RAISE EXCEPTION 'WORKFLOW_RUN_STEP_TRANSITION_INVALID' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER workflow_run_step_transition BEFORE UPDATE ON workflow_run_steps FOR EACH ROW EXECUTE FUNCTION workflow_run_step_transition();

-- 3. Append-only audit trail (closed codes, ids and public facts only).
CREATE TABLE workflow_run_events (
  tenant_id text NOT NULL,
  event_id bigint GENERATED ALWAYS AS IDENTITY,
  run_id text NOT NULL,
  step_index integer CHECK (step_index IS NULL OR step_index BETWEEN 0 AND 7),
  kind text NOT NULL CHECK (kind ~ '^[A-Z][A-Z0-9_]{2,60}$'),
  code text CHECK (code IS NULL OR code ~ '^[A-Z][A-Z0-9_]{2,80}$'),
  detail jsonb CHECK (detail IS NULL OR (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 4096)),
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, event_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES workflow_runs (tenant_id, run_id)
);
CREATE INDEX workflow_run_events_run ON workflow_run_events (tenant_id, run_id, event_id);
CREATE FUNCTION workflow_run_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'WORKFLOW_RUN_RECORD_APPEND_ONLY' USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
CREATE TRIGGER workflow_run_events_append_only BEFORE UPDATE OR DELETE ON workflow_run_events FOR EACH ROW EXECUTE FUNCTION workflow_run_append_only();
CREATE TRIGGER workflow_runs_no_delete BEFORE DELETE ON workflow_runs FOR EACH ROW EXECUTE FUNCTION workflow_run_append_only();
CREATE TRIGGER workflow_run_steps_no_delete BEFORE DELETE ON workflow_run_steps FOR EACH ROW EXECUTE FUNCTION workflow_run_append_only();

-- 4. Delegated authorizations and executions: a workflow run as their source, beside an automation rule and occurrence.
ALTER TABLE delegated_authorizations ALTER COLUMN rule_id DROP NOT NULL;
ALTER TABLE delegated_authorizations ADD COLUMN workflow_run_id text;
ALTER TABLE delegated_authorizations ADD CONSTRAINT delegated_authorizations_source CHECK ((rule_id IS NULL) <> (workflow_run_id IS NULL));
ALTER TABLE delegated_authorizations ADD CONSTRAINT delegated_authorizations_workflow_run UNIQUE (tenant_id, workflow_run_id);
ALTER TABLE delegated_authorizations ADD CONSTRAINT delegated_authorizations_workflow_run_owner FOREIGN KEY (tenant_id, workflow_run_id, owner_namespace, owner_account)
  REFERENCES workflow_runs (tenant_id, run_id, owner_namespace, owner_account);

ALTER TABLE delegated_executions ALTER COLUMN rule_id DROP NOT NULL;
ALTER TABLE delegated_executions ALTER COLUMN occurrence_id DROP NOT NULL;
ALTER TABLE delegated_executions ADD COLUMN workflow_run_id text;
ALTER TABLE delegated_executions ADD CONSTRAINT delegated_executions_source CHECK (
  (rule_id IS NOT NULL AND occurrence_id IS NOT NULL AND workflow_run_id IS NULL) OR (rule_id IS NULL AND occurrence_id IS NULL AND workflow_run_id IS NOT NULL));
ALTER TABLE delegated_executions ADD CONSTRAINT delegated_executions_workflow_run FOREIGN KEY (tenant_id, workflow_run_id) REFERENCES workflow_runs (tenant_id, run_id);
-- One delegated execution per workflow run, ever (a run executes its workflow once; recovery reuses the row).
CREATE UNIQUE INDEX delegated_executions_one_per_run ON delegated_executions (tenant_id, workflow_run_id) WHERE workflow_run_id IS NOT NULL;

-- The source of an authorization or execution never changes. A column-scoped trigger: it fires only for an UPDATE that names
-- `workflow_run_id`, which no previous build ever writes; the existing transition triggers are unchanged.
CREATE FUNCTION delegated_workflow_run_source_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.workflow_run_id IS DISTINCT FROM OLD.workflow_run_id THEN
    RAISE EXCEPTION 'DELEGATED_SOURCE_IMMUTABLE' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER delegated_authorizations_source_immutable BEFORE UPDATE OF workflow_run_id ON delegated_authorizations
  FOR EACH ROW EXECUTE FUNCTION delegated_workflow_run_source_immutable();
CREATE TRIGGER delegated_executions_source_immutable BEFORE UPDATE OF workflow_run_id ON delegated_executions
  FOR EACH ROW EXECUTE FUNCTION delegated_workflow_run_source_immutable();
