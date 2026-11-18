-- SPDX-License-Identifier: AGPL-3.0-only
-- FinOps is optional on schema 28. The ledger is separate from any public execution or authorization relation.
SET LOCAL lock_timeout = '5s';

CREATE TABLE finops_cost_records (
  tenant_id text NOT NULL REFERENCES tenants (tenant_id),
  record_id bigint GENERATED ALWAYS AS IDENTITY,
  scope_id text NOT NULL CHECK (scope_id ~ '^[a-z][a-z0-9-]{1,50}$'),
  environment text NOT NULL CHECK (environment IN ('production', 'shared', 'preview', 'development')),
  source text NOT NULL CHECK (source IN ('INVOICE', 'ACCOUNTING', 'PROVIDER_COST', 'USAGE', 'ASSUMPTION')),
  period_start date NOT NULL,
  period_end date NOT NULL CHECK (period_end > period_start AND period_end - period_start <= 366),
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object' AND octet_length(document::text) <= 4096),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, record_id)
);
CREATE INDEX finops_cost_records_scope_period ON finops_cost_records
  (tenant_id, scope_id, environment, source, period_start, period_end, record_id DESC);
CREATE INDEX finops_cost_records_period ON finops_cost_records (tenant_id, period_end, period_start);
CREATE TRIGGER finops_cost_records_append_only BEFORE UPDATE OR DELETE ON finops_cost_records
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

-- Bounded daily provider request aggregates, without account, wallet or conversation identifiers.
CREATE TABLE finops_ai_daily_usage (
  tenant_id text NOT NULL REFERENCES tenants (tenant_id),
  day date NOT NULL,
  surface text NOT NULL CHECK (surface IN ('WEB', 'TELEGRAM', 'WHATSAPP', 'CHANNEL')),
  provider text NOT NULL CHECK (provider IN ('OPENAI', 'ANTHROPIC')),
  model text NOT NULL CHECK (model = '' OR model ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$'),
  requests bigint NOT NULL CHECK (requests > 0),
  successes bigint NOT NULL CHECK (successes BETWEEN 0 AND requests),
  duration_ms bigint NOT NULL CHECK (duration_ms >= 0),
  input_tokens bigint NOT NULL CHECK (input_tokens >= 0),
  input_samples bigint NOT NULL CHECK (input_samples BETWEEN 0 AND requests),
  output_tokens bigint NOT NULL CHECK (output_tokens >= 0),
  output_samples bigint NOT NULL CHECK (output_samples BETWEEN 0 AND requests),
  cached_input_tokens bigint NOT NULL CHECK (cached_input_tokens >= 0),
  cached_input_samples bigint NOT NULL CHECK (cached_input_samples BETWEEN 0 AND requests),
  cache_write_tokens bigint NOT NULL CHECK (cache_write_tokens >= 0),
  cache_write_samples bigint NOT NULL CHECK (cache_write_samples BETWEEN 0 AND requests),
  reasoning_tokens bigint NOT NULL CHECK (reasoning_tokens >= 0),
  reasoning_samples bigint NOT NULL CHECK (reasoning_samples BETWEEN 0 AND requests),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, day, surface, provider, model)
);
