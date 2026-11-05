-- SPDX-License-Identifier: AGPL-3.0-only
-- BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001 0022: the FloFi Editor as an approval requester.
-- The shared approval model (mcp_handoffs, 0005/0006/0010) and the workflow runs it starts (workflow_runs, 0015) gain one requester kind:
-- EDITOR_SESSION, the signed-in FloFi account that hands its own Canvas workflow to the same workflow-run flow chats, MCP clients and
-- channels use. Its requester_id is the account id (it fits 0006's requester_id rule); like every non-MCP requester it carries no MCP
-- account or grant (0006's mcp_handoffs_requester_identity rule applies unchanged). A requester is never authority: claiming still needs a
-- proven wallet of that account, then a fresh simulation, the Strategy Manifest Review and the owner's own wallet signature.
-- Additive only: two CHECK constraints are widened, exactly as 0010 widened the first one. No table, column, index, function, trigger or row is
-- added, changed or removed, and every row valid under 0021 is valid under this migration unchanged.
SET LOCAL lock_timeout = '5s';

ALTER TABLE mcp_handoffs
  DROP CONSTRAINT mcp_handoffs_requester_kind_check,
  ADD CONSTRAINT mcp_handoffs_requester_kind_check
    CHECK (requester_kind IN ('MCP_ACCOUNT', 'DEVELOPER_PROJECT', 'CHANNEL_CONVERSATION', 'AUTOMATION_RULE', 'EDITOR_SESSION'));

ALTER TABLE workflow_runs
  DROP CONSTRAINT workflow_runs_requester_kind_check,
  ADD CONSTRAINT workflow_runs_requester_kind_check
    CHECK (requester_kind IN ('MCP_ACCOUNT', 'DEVELOPER_PROJECT', 'CHANNEL_CONVERSATION', 'AUTOMATION_RULE', 'EDITOR_SESSION'));
