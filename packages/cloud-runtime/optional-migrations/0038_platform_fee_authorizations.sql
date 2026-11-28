-- SPDX-License-Identifier: AGPL-3.0-only
-- BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (completion) 0038: the authorized platform fee basis. Additive: one new table with its own
-- (non SECURITY DEFINER) trigger function; no pre-existing relation, function, trigger, policy or index changes.
--
-- platform_fee_authorizations: the FloFi platform fee the owner was shown and authorized for one execution, written once when the execution is
-- authorized (a workflow run when it is created from its approved Review; a single flow when its Review is bound) and never updated. One row per
-- execution (the same canonical identity as platform_fee_ledger: an execution_runs root run or a workflow_runs run). A collector may charge at most
-- these lines (per exact asset) and never an asset that is not listed; an execution without a row is never charged. The revision is the reviewed
-- workflow hash, so a changed amount, route or recipient is a different revision and needs a new authorization. It follows the execution's life:
-- an owner-deleted unstarted run takes its row with it (ON DELETE CASCADE), so the 0016/0033 purge procedures keep working.
-- See docs/deploy/SCHEMA-COMPATIBILITY.md §30 (certificate 0038_platform_fee_authorizations) and docs/deploy/RELEASE-REVENUE-ORIGINS-0037.md.
SET LOCAL lock_timeout = '5s';

CREATE TABLE platform_fee_authorizations (
  tenant_id text NOT NULL REFERENCES tenants (tenant_id),
  run_id text,
  workflow_run_id text,
  policy_id text NOT NULL CHECK (policy_id ~ '^flofi-platform-fee/[a-z0-9.-]{1,40}$'),
  rate_bps integer NOT NULL CHECK (rate_bps BETWEEN 0 AND 10000),
  -- FEEABLE: at least one asset carries a positive fee. NOT_APPLICABLE: nothing feeable. UNSUPPORTED: the basis could not be read; never charged.
  status text NOT NULL CHECK (status IN ('FEEABLE', 'NOT_APPLICABLE', 'UNSUPPORTED')),
  -- Per exact asset: {"chainId","address","decimals","principal","fee"} in native units (decimal strings): the cap a collector may charge.
  lines jsonb NOT NULL CHECK (jsonb_typeof(lines) = 'array' AND jsonb_array_length(lines) <= 16 AND octet_length(lines::text) <= 8192),
  -- SHA-256 of the canonical basis (policy, rate, status, lines) the Review disclosed: what the owner saw and what is stored are comparable.
  basis_sha256 text NOT NULL CHECK (basis_sha256 ~ '^[0-9a-f]{64}$'),
  -- The reviewed workflow revision the basis belongs to.
  workflow_hash text NOT NULL CHECK (workflow_hash ~ '^0x[0-9a-f]{64}$'),
  authorized_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((run_id IS NULL) <> (workflow_run_id IS NULL)),
  CHECK (status = 'FEEABLE' OR jsonb_array_length(lines) = 0),
  CHECK (status <> 'FEEABLE' OR jsonb_array_length(lines) > 0),
  UNIQUE (tenant_id, run_id),
  UNIQUE (tenant_id, workflow_run_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES execution_runs (tenant_id, run_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, workflow_run_id) REFERENCES workflow_runs (tenant_id, run_id) ON DELETE CASCADE
);
CREATE INDEX platform_fee_authorizations_authorized ON platform_fee_authorizations (tenant_id, authorized_at);

CREATE FUNCTION platform_fee_authorization_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'PLATFORM_FEE_AUTHORIZATION_IMMUTABLE' USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
CREATE TRIGGER platform_fee_authorization_immutable BEFORE UPDATE ON platform_fee_authorizations FOR EACH ROW
  EXECUTE FUNCTION platform_fee_authorization_immutable();
