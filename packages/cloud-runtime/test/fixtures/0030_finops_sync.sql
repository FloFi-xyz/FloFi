-- SPDX-License-Identifier: AGPL-3.0-only
-- One independent schedule and fenced lease per tenant/provider. Only the
-- derived meter snapshots are replaced; the financial ledger is append-only.
SET LOCAL lock_timeout = '5s';

CREATE TABLE finops_sync_jobs (
  tenant_id text NOT NULL REFERENCES tenants (tenant_id),
  provider text NOT NULL CHECK (provider IN ('neon','railway','vercel','openai','anthropic','circleci','resend','alchemy')),
  configured boolean NOT NULL,
  next_run_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  requested_at timestamptz,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  historical_review_at timestamptz,
  last_error text CHECK (last_error ~ '^FINOPS_[A-Z0-9_]{3,64}$'),
  cycle_started_at timestamptz,
  periods jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(periods) = 'array' AND jsonb_array_length(periods) <= 3),
  checkpoint text CHECK (length(checkpoint) <= 512 AND checkpoint ~ '^[A-Za-z0-9._:-]+$'),
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  polls smallint NOT NULL DEFAULT 0 CHECK (polls BETWEEN 0 AND 20),
  lease_token uuid,
  lease_expires_at timestamptz,
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
  PRIMARY KEY (tenant_id, provider)
);
CREATE INDEX finops_sync_jobs_due ON finops_sync_jobs (tenant_id, next_run_at) WHERE configured;

CREATE TABLE finops_sync_snapshots (
  tenant_id text NOT NULL,
  provider text NOT NULL,
  period_start date NOT NULL CHECK (EXTRACT(day FROM period_start) = 1),
  period_end date NOT NULL CHECK (period_end > period_start AND period_end - period_start <= 31),
  quality text NOT NULL CHECK (quality IN ('FULL','PARTIAL','UNAVAILABLE')),
  limitations text[] NOT NULL CHECK (cardinality(limitations) <= 16),
  meter_count integer NOT NULL CHECK (meter_count BETWEEN 0 AND 3000),
  meters jsonb NOT NULL CHECK (jsonb_typeof(meters) = 'array' AND jsonb_array_length(meters) = meter_count AND octet_length(meters::text) <= 1250000),
  collected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, provider, period_start),
  FOREIGN KEY (tenant_id, provider) REFERENCES finops_sync_jobs (tenant_id, provider)
);
