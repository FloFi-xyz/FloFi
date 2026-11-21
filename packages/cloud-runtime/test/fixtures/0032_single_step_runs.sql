-- SPDX-License-Identifier: AGPL-3.0-only
-- BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001 0032: a workflow run may have exactly one step.
-- The Editor runs ONE financial card as a one-step USER_FUNDED workflow run (one owner confirmation, one wallet batch the owner's own
-- wallet authorizes and pays for). 0015's column check limited a run to 2..8 steps; this migration widens exactly that CHECK,
-- `workflow_runs_step_count_check`, to 1..8, in one ALTER TABLE statement, exactly as 0010/0022/0023 widened theirs. Nothing else changes:
-- no table, column, index, function, trigger, privilege or row is added, changed or removed (0015's `workflow_run_transition` already
-- handles one step: `current_step` stays 0 and `0 >= 1` is false). Every row valid under 0031 is valid under this migration unchanged, so
-- the validation scan cannot fail on existing data. Builds before this one never create a one-step run. See
-- docs/deploy/SCHEMA-COMPATIBILITY.md §24 (certificate 0032_single_step_runs).
SET LOCAL lock_timeout = '5s';

ALTER TABLE workflow_runs
  DROP CONSTRAINT workflow_runs_step_count_check,
  ADD CONSTRAINT workflow_runs_step_count_check CHECK (step_count BETWEEN 1 AND 8);
