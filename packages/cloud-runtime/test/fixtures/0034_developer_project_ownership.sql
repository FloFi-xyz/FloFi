-- SPDX-License-Identifier: AGPL-3.0-only
-- Account-owned developer projects use the existing project and credential records.
SET LOCAL lock_timeout = '5s';

CREATE TABLE developer_project_owners (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  account_id text NOT NULL,
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 500 AND description !~ '[[:cntrl:]]'),
  PRIMARY KEY (tenant_id, project_id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES developer_projects (tenant_id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, account_id) REFERENCES flofi_accounts (tenant_id, account_id) ON DELETE CASCADE
);
CREATE INDEX developer_project_owners_account ON developer_project_owners (tenant_id, account_id, project_id);

-- Disabling closes unaccepted proposals and revokes credentials atomically. Applied
-- proposals and wallet-owned execution records remain available to their wallet.
CREATE FUNCTION developer_close_project() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE developer_api_keys SET status = 'REVOKED', revoked_at = NEW.disabled_at
    WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id AND status = 'ACTIVE';
  UPDATE mcp_handoffs SET status = 'REVOKED', ended_at = NEW.disabled_at, signing_digest = NULL, signing_expires_at = NULL
    WHERE tenant_id = NEW.tenant_id AND requester_kind = 'DEVELOPER_PROJECT'
      AND requester_ref IN (NEW.project_id || '.sandbox', NEW.project_id || '.production')
      AND status IN ('PENDING', 'CLAIMED');
  UPDATE developer_webhook_endpoints SET status = 'DELETED', deleted_at = NEW.disabled_at
    WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id AND status = 'ACTIVE';
  UPDATE developer_webhook_deliveries SET status = 'DEAD', updated_at = NEW.disabled_at, last_error = 'PROJECT_DISABLED',
    lease_token = NULL, leased_until = NULL
    WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id AND status = 'PENDING';
  RETURN NULL;
END;
$$;
CREATE TRIGGER developer_close_project AFTER UPDATE OF status ON developer_projects FOR EACH ROW
  WHEN (OLD.status = 'ACTIVE' AND NEW.status = 'DISABLED') EXECUTE FUNCTION developer_close_project();

-- On account deletion, close its projects and remove their account association.
-- Keep immutable project IDs and handoff/strategy history for reconciliation.
CREATE FUNCTION developer_detach_project() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE developer_projects SET status = 'DISABLED', disabled_at = now()
    WHERE tenant_id = OLD.tenant_id AND project_id = OLD.project_id AND status = 'ACTIVE';
  RETURN NULL;
END;
$$;
CREATE TRIGGER developer_detach_project AFTER DELETE ON developer_project_owners
  FOR EACH ROW EXECUTE FUNCTION developer_detach_project();

-- Serialize a proposal insert with project shutdown. The existing 0007 trigger
-- still binds the immutable strategy and exact workflow hash after this check.
CREATE FUNCTION developer_require_active_project() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM developer_projects
    WHERE tenant_id = NEW.tenant_id AND project_id = split_part(NEW.requester_id, '.', 1) AND status = 'ACTIVE'
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DEVELOPER_PROJECT_DISABLED' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER developer_require_active_project BEFORE INSERT ON mcp_handoffs FOR EACH ROW
  WHEN (NEW.requester_kind = 'DEVELOPER_PROJECT') EXECUTE FUNCTION developer_require_active_project();
