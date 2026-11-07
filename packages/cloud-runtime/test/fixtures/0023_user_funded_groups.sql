-- SPDX-License-Identifier: AGPL-3.0-only
-- BUILD-FLOFI-UNIVERSAL-WORKFLOW-002 0023: user-funded workflow runs and their execution groups, additive.
--
-- A workflow run (0015) gains a third mode, USER_FUNDED: the workflow is cut into execution groups (consecutive steps one wallet authorizes
-- with one interaction on one chain), and the OWNER'S OWN ACCOUNT pays every network fee — an EIP-5792 wallet batch the wallet sends, an
-- ERC-4337 user operation of the owner's own smart account (no paymaster; the EntryPoint charges the owner's prefund) that a bundler
-- relays, Solana transactions whose fee payer is the owner. FloFi never funds, advances, sponsors or reimburses gas (invariant S1): the
-- fee payer of every group is written once, must be the wallet the run bound for that namespace, and is checked here at insert.
--
-- Existing objects: two CHECK constraints of workflow_runs (0015) are widened exactly as 0010/0022 widened theirs — the mode list gains
-- USER_FUNDED, and the mode/authorization co-constraint admits USER_FUNDED without a delegated authorization (it has none: nothing is
-- delegated to FloFi). Grouped steps reuse the existing step state DELEGATED ("executing outside its own flow, observed by the run") and
-- its existing transitions, so workflow_run_steps, its trigger and every existing function, trigger and index are unchanged. Every row valid
-- under 0022 is valid under this migration unchanged. New: one table with its own trigger functions. What is stored: ids, codes, public
-- facts and what the owner's wallet returned for the group (a wallet batch id, a user operation signature, signed Solana transactions) —
-- never key material. See docs/deploy/SCHEMA-COMPATIBILITY.md §17 (certificate 0023_user_funded_groups).
SET LOCAL lock_timeout = '5s';

-- 1. The run mode.
ALTER TABLE workflow_runs
  DROP CONSTRAINT workflow_runs_mode_check,
  ADD CONSTRAINT workflow_runs_mode_check CHECK (mode IS NULL OR mode IN ('CONFIRM_EACH_STEP', 'DELEGATED', 'USER_FUNDED'));
ALTER TABLE workflow_runs
  DROP CONSTRAINT workflow_runs_check3,
  ADD CONSTRAINT workflow_runs_check3 CHECK ((mode IS NULL AND authorization_id IS NULL) OR (mode = 'CONFIRM_EACH_STEP' AND authorization_id IS NULL)
    OR (mode = 'DELEGATED' AND authorization_id IS NOT NULL) OR (mode = 'USER_FUNDED' AND authorization_id IS NULL));

-- 2. Execution groups of a USER_FUNDED run (created with the mode, in the same transaction).
CREATE TABLE workflow_run_groups (
  tenant_id text NOT NULL,
  run_id text NOT NULL,
  group_index integer NOT NULL CHECK (group_index BETWEEN 0 AND 7),
  namespace text NOT NULL CHECK (namespace IN ('eip155', 'solana')),
  chain text NOT NULL,
  -- The account charged for every network fee of this group: the run's own wallet on this namespace (checked at insert, then frozen).
  fee_payer text NOT NULL,
  step_from integer NOT NULL CHECK (step_from BETWEEN 0 AND 7),
  step_to integer NOT NULL CHECK (step_to BETWEEN 0 AND 7),
  strategy text NOT NULL CHECK (strategy IN ('EVM_WALLET_BATCH', 'EVM_USER_OPERATION', 'EVM_OWNER_STEP', 'SOLANA_SIGN_ALL', 'SOLANA_DURABLE_NONCE', 'SOLANA_OWNER_STEP')),
  signing text NOT NULL CHECK (signing IN ('UPFRONT', 'WHEN_DUE')),
  -- The bridge step whose reconciled delivery on this chain this group waits for (null: none).
  awaits_delivery integer CHECK (awaits_delivery IS NULL OR awaits_delivery BETWEEN 0 AND 7),
  state text NOT NULL CHECK (state IN ('PLANNED', 'PREPARED', 'AUTHORIZED', 'SUBMITTED', 'RECONCILED', 'FAILED', 'UNCERTAIN', 'BLOCKED', 'SKIPPED', 'EXPIRED')),
  -- What FloFi built for the owner to sign: exact calls / unsigned transactions / typed data, amounts, quotes and the fee estimate
  -- (a Solana group keeps each transaction's address lookup tables for verification, hence the larger bound).
  prepared jsonb CHECK (prepared IS NULL OR (jsonb_typeof(prepared) = 'object' AND octet_length(prepared::text) <= 262144)),
  -- What the owner's wallet returned: a wallet batch id, a user operation signature, signed Solana transactions (never a key).
  owner_authorization jsonb CHECK (owner_authorization IS NULL OR (jsonb_typeof(owner_authorization) = 'object' AND octet_length(owner_authorization::text) <= 65536)),
  -- Public submission facts: transaction hashes / signatures, the user operation hash, when.
  submission jsonb CHECK (submission IS NULL OR (jsonb_typeof(submission) = 'object' AND octet_length(submission::text) <= 16384)),
  -- Reconciled facts: receipts, gas actually paid and by whom, spent/received per step.
  outcome jsonb CHECK (outcome IS NULL OR (jsonb_typeof(outcome) = 'object' AND octet_length(outcome::text) <= 16384)),
  -- The same code grammar as workflow_runs / workflow_run_steps / workflow_run_events (a group code is copied to them in one transaction).
  code text CHECK (code IS NULL OR code ~ '^[A-Z][A-Z0-9_]{2,80}$'),
  valid_until timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, run_id, group_index),
  FOREIGN KEY (tenant_id, run_id) REFERENCES workflow_runs (tenant_id, run_id),
  CHECK ((namespace = 'eip155' AND chain ~ '^eip155:[1-9][0-9]{0,18}$' AND fee_payer ~ '^0x[0-9a-f]{40}$')
    OR (namespace = 'solana' AND chain ~ '^solana:[1-9A-HJ-NP-Za-km-z]{32}$' AND fee_payer ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')),
  CHECK (step_to >= step_from),
  CHECK (awaits_delivery IS NULL OR awaits_delivery < step_from),
  CHECK (state NOT IN ('PREPARED', 'AUTHORIZED') OR prepared IS NOT NULL),
  CHECK (state <> 'AUTHORIZED' OR owner_authorization IS NOT NULL),
  CHECK (state NOT IN ('SUBMITTED', 'UNCERTAIN') OR submission IS NOT NULL),
  CHECK (state <> 'RECONCILED' OR outcome IS NOT NULL)
);
CREATE INDEX workflow_run_groups_due ON workflow_run_groups (tenant_id, updated_at) WHERE state IN ('AUTHORIZED', 'SUBMITTED', 'UNCERTAIN');

CREATE FUNCTION workflow_run_group_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  run_mode text;
  run_wallets jsonb;
BEGIN
  SELECT mode, wallets INTO run_mode, run_wallets FROM workflow_runs WHERE tenant_id = NEW.tenant_id AND run_id = NEW.run_id;
  IF run_mode IS DISTINCT FROM 'USER_FUNDED' THEN
    RAISE EXCEPTION 'WORKFLOW_RUN_GROUP_MODE_INVALID' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- S1: the fee payer is the owner's own wallet of this namespace, never any other account.
  IF run_wallets ->> NEW.namespace IS DISTINCT FROM NEW.fee_payer THEN
    RAISE EXCEPTION 'GAS_PAYER_NOT_OWNER' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.state <> 'PLANNED' OR NEW.owner_authorization IS NOT NULL OR NEW.submission IS NOT NULL OR NEW.outcome IS NOT NULL THEN
    RAISE EXCEPTION 'WORKFLOW_RUN_GROUP_INSERT_INVALID' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER workflow_run_group_insert BEFORE INSERT ON workflow_run_groups FOR EACH ROW EXECUTE FUNCTION workflow_run_group_insert();

CREATE FUNCTION workflow_run_group_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.run_id IS DISTINCT FROM OLD.run_id OR NEW.group_index IS DISTINCT FROM OLD.group_index
     OR NEW.namespace IS DISTINCT FROM OLD.namespace OR NEW.chain IS DISTINCT FROM OLD.chain OR NEW.fee_payer IS DISTINCT FROM OLD.fee_payer
     OR NEW.step_from IS DISTINCT FROM OLD.step_from OR NEW.step_to IS DISTINCT FROM OLD.step_to OR NEW.awaits_delivery IS DISTINCT FROM OLD.awaits_delivery
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.version <= OLD.version
     -- What was signed is frozen once authorized, in EVERY later state (BLOCKED and SKIPPED included): the prepared artifact, the strategy and
     -- the owner's authorization. A signed group is never planned again: a signed user operation or a sent batch stays valid on chain, so a
     -- replacement could execute the same steps twice.
     OR ((OLD.owner_authorization IS NOT NULL OR OLD.state IN ('AUTHORIZED', 'SUBMITTED', 'UNCERTAIN', 'RECONCILED', 'FAILED'))
         AND (NEW.prepared IS DISTINCT FROM OLD.prepared OR NEW.owner_authorization IS DISTINCT FROM OLD.owner_authorization
           OR NEW.strategy IS DISTINCT FROM OLD.strategy OR NEW.signing IS DISTINCT FROM OLD.signing OR NEW.state = 'PLANNED'))
     -- A submission is written once and never rewritten (a re-broadcast sends exactly these bytes, never new ones).
     OR (OLD.submission IS NOT NULL AND NEW.submission IS DISTINCT FROM OLD.submission) THEN
    RAISE EXCEPTION 'WORKFLOW_RUN_GROUP_IMMUTABLE' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.state IN ('RECONCILED', 'FAILED', 'SKIPPED') THEN
    RAISE EXCEPTION 'WORKFLOW_RUN_GROUP_TERMINAL' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.state <> OLD.state AND NOT (
       (OLD.state = 'PLANNED' AND NEW.state IN ('PREPARED', 'SUBMITTED', 'RECONCILED', 'FAILED', 'UNCERTAIN', 'BLOCKED', 'SKIPPED'))
    OR (OLD.state = 'PREPARED' AND NEW.state IN ('AUTHORIZED', 'SUBMITTED', 'EXPIRED', 'BLOCKED', 'SKIPPED', 'PLANNED'))
    OR (OLD.state = 'AUTHORIZED' AND NEW.state IN ('SUBMITTED', 'EXPIRED', 'BLOCKED', 'SKIPPED'))
    OR (OLD.state = 'SUBMITTED' AND NEW.state IN ('RECONCILED', 'FAILED', 'UNCERTAIN'))
    OR (OLD.state = 'UNCERTAIN' AND NEW.state IN ('RECONCILED', 'FAILED'))
    OR (OLD.state = 'EXPIRED' AND NEW.state IN ('PLANNED', 'SKIPPED'))
    OR (OLD.state = 'BLOCKED' AND NEW.state IN ('PLANNED', 'SKIPPED'))) THEN
    RAISE EXCEPTION 'WORKFLOW_RUN_GROUP_TRANSITION_INVALID' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER workflow_run_group_transition BEFORE UPDATE ON workflow_run_groups FOR EACH ROW EXECUTE FUNCTION workflow_run_group_transition();
CREATE TRIGGER workflow_run_groups_no_delete BEFORE DELETE ON workflow_run_groups FOR EACH ROW EXECUTE FUNCTION workflow_run_append_only();
