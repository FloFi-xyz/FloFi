-- SPDX-License-Identifier: AGPL-3.0-only
-- Content-free operational aggregates. No identity, prompt, workflow or transaction data.
-- Additive: existing financial and authorization relations are untouched.
SET LOCAL lock_timeout = '5s';

CREATE TABLE copilot_daily_metrics (
  tenant_id text NOT NULL REFERENCES tenants(tenant_id),
  day date NOT NULL,
  surface text NOT NULL CHECK (surface IN ('WEB', 'CHANNEL')),
  mode text NOT NULL CHECK (mode IN ('live', 'replay')),
  provenance text NOT NULL CHECK (provenance IN ('SERVER', 'CLIENT')),
  kind text NOT NULL CHECK (kind IN ('INTERPRETATION', 'TURN')),
  outcome text NOT NULL CHECK (outcome ~ '^[A-Z][A-Z0-9_]{1,80}$'),
  model text NOT NULL CHECK (length(model) <= 100),
  events bigint NOT NULL DEFAULT 0 CHECK (events >= 0),
  duration_ms bigint NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  input_samples bigint NOT NULL DEFAULT 0 CHECK (input_samples >= 0),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  output_samples bigint NOT NULL DEFAULT 0 CHECK (output_samples >= 0),
  reasoning_tokens bigint NOT NULL DEFAULT 0 CHECK (reasoning_tokens >= 0),
  reasoning_samples bigint NOT NULL DEFAULT 0 CHECK (reasoning_samples >= 0),
  tool_calls bigint NOT NULL DEFAULT 0 CHECK (tool_calls >= 0),
  tool_failures bigint NOT NULL DEFAULT 0 CHECK (tool_failures >= 0),
  tool_rounds bigint NOT NULL DEFAULT 0 CHECK (tool_rounds >= 0),
  mismatches bigint NOT NULL DEFAULT 0 CHECK (mismatches >= 0),
  clarifications bigint NOT NULL DEFAULT 0 CHECK (clarifications >= 0),
  repeated_question_reports bigint NOT NULL DEFAULT 0 CHECK (repeated_question_reports >= 0),
  correction_reports bigint NOT NULL DEFAULT 0 CHECK (correction_reports >= 0),
  turns_to_proposal bigint NOT NULL DEFAULT 0 CHECK (turns_to_proposal >= 0),
  proposals bigint NOT NULL DEFAULT 0 CHECK (proposals >= 0),
  proposal_steps bigint NOT NULL DEFAULT 0 CHECK (proposal_steps >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, day, surface, mode, provenance, kind, outcome, model),
  CHECK (provenance <> 'CLIENT' OR (surface = 'WEB' AND kind = 'TURN' AND model = '')),
  CHECK (kind <> 'TURN' OR model = '')
);
