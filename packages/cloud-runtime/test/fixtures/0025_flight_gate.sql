-- SPDX-License-Identifier: AGPL-3.0-only
-- BUILD-FLOFI-FLIGHT-GATE-002: additive product-access grants. No existing campaign, account, Admin, execution or outbox row is modified.
-- Access is independent of wallet financial authority: no key, session token, signature, email or transaction is stored here.
-- A grant records a previously proved campaign source. New wallet bindings are written only by explicit boarding, not by login.
-- Revoked grants remain tombstones; repeated boarding and alternative authentication cannot reactivate them.
SET LOCAL lock_timeout = '5s';

CREATE TABLE flight_beta_grants (
  tenant_id text NOT NULL,
  account_id text NOT NULL,
  source text NOT NULL CHECK (source IN ('LIST', 'INVITE', 'PASS')),
  source_ref text NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 100),
  granted_at timestamptz NOT NULL,
  revoked_at timestamptz,
  PRIMARY KEY (tenant_id, account_id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES flofi_accounts (tenant_id, account_id) ON DELETE CASCADE
);

CREATE TABLE flight_beta_wallets (
  tenant_id text NOT NULL,
  account_id text NOT NULL,
  namespace text NOT NULL CHECK (namespace IN ('eip155', 'solana')),
  address text NOT NULL,
  linked_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, namespace, address),
  FOREIGN KEY (tenant_id, account_id) REFERENCES flight_beta_grants (tenant_id, account_id) ON DELETE CASCADE,
  CHECK ((namespace = 'eip155' AND address ~ '^0x[0-9a-f]{40}$') OR
    (namespace = 'solana' AND address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'))
);
CREATE INDEX flight_beta_wallets_account ON flight_beta_wallets (tenant_id, account_id);

-- OAuth consent explicitly binds the existing MCP account to the same live FloFi session.
-- A shared browser cannot move a binding to another FloFi account; re-consent may refresh its session only.
CREATE TABLE flight_beta_mcp_accounts (
  tenant_id text NOT NULL,
  mcp_account_id text NOT NULL,
  flofi_account_id text NOT NULL,
  session_id text NOT NULL CHECK (session_id ~ '^[0-9a-f]{32}$'),
  PRIMARY KEY (tenant_id, mcp_account_id),
  FOREIGN KEY (tenant_id, mcp_account_id) REFERENCES mcp_accounts (tenant_id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, flofi_account_id) REFERENCES flofi_accounts (tenant_id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, session_id) REFERENCES flofi_account_sessions (tenant_id, session_id) ON DELETE CASCADE
);
