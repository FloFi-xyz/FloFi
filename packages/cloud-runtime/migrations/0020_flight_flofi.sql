-- SPDX-License-Identifier: AGPL-3.0-only
-- BUILD-FLOFI-FLIGHT-001: the Flight FloFi launch campaign (flofi.xyz/board). A beta list, its boarding groups, invites, boarding passes
-- (the first 100 are numbered Founding seats), the evidence that a pass was earned by a real server-side simulation, and content-free
-- daily campaign counters. A campaign benefit is never financial authority and never gates the product: /app stays open to everyone.
-- Personal data here: a list email (with the notice version shown), an optional public X handle, and account ids. No wallet key, seed
-- phrase, session token, IP address, amount, prompt or transaction is stored. Erasure: deleting a FloFi account cascades to its pass,
-- its simulation evidence and its invite redemption; list entries are erased by email (operator command) or at the end of the beta.
-- Additive: eight new flight_* tables. Foreign keys reference flofi_accounts and tenants; nothing on any pre-existing relation changes.
SET LOCAL lock_timeout = '5s';

-- Boarding groups: when the list entries of a group may board. An entry with no group boards when the campaign opens.
CREATE TABLE flight_batches (
  tenant_id text NOT NULL REFERENCES tenants(tenant_id),
  batch_no integer NOT NULL CHECK (batch_no BETWEEN 1 AND 999),
  opens_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, batch_no)
);

-- The beta list (FIRST) and the list of the next flight (NEXT). One entry per address; the address is stored lower-cased.
CREATE TABLE flight_list_entries (
  tenant_id text NOT NULL REFERENCES tenants(tenant_id),
  entry_id text NOT NULL CHECK (entry_id ~ '^fle_[0-9a-f]{32}$'),
  email text NOT NULL CHECK (length(email) BETWEEN 6 AND 254 AND email = lower(email) AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  flight text NOT NULL CHECK (flight IN ('FIRST', 'NEXT')),
  language text NOT NULL CHECK (language IN ('EN', 'PT')),
  -- The version of the privacy notice the person saw when joining.
  notice text NOT NULL CHECK (notice ~ '^[a-z0-9.-]{1,40}$'),
  batch_no integer,
  joined_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- Set when a pass is issued to an account with this address: an entry boards once, even if that account is later deleted.
  boarded_at timestamptz,
  PRIMARY KEY (tenant_id, entry_id),
  UNIQUE (tenant_id, email),
  FOREIGN KEY (tenant_id, batch_no) REFERENCES flight_batches (tenant_id, batch_no),
  CHECK (flight = 'FIRST' OR batch_no IS NULL)
);
CREATE INDEX flight_list_entries_flight ON flight_list_entries (tenant_id, flight, joined_at);

-- Abuse protection for the public list form: a keyed digest of the client's network address (never the address), pruned on write.
CREATE TABLE flight_join_attempts (
  tenant_id text NOT NULL REFERENCES tenants(tenant_id),
  client text NOT NULL CHECK (client ~ '^[0-9a-f]{64}$'),
  attempted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX flight_join_attempts_client ON flight_join_attempts (tenant_id, client, attempted_at);
CREATE INDEX flight_join_attempts_time ON flight_join_attempts (tenant_id, attempted_at);

-- Boarding passes. One per account; boarding_no is the global boarding order; founding_seat is set for the first 100 only. The
-- constraints are the limit: no seat outside 1..100, no seat twice, no second pass for an account. Numbers come from flight_issuance.
CREATE TABLE flight_passes (
  tenant_id text NOT NULL,
  pass_id text NOT NULL CHECK (pass_id ~ '^flp_[0-9a-f]{32}$'),
  account_id text NOT NULL,
  origin text NOT NULL CHECK (origin IN ('LIST', 'INVITE', 'CREATOR')),
  boarding_no integer NOT NULL CHECK (boarding_no >= 1),
  founding_seat integer CHECK (founding_seat BETWEEN 1 AND 100),
  handle text CHECK (handle ~ '^[A-Za-z0-9_]{1,15}$'),
  -- Shown on the public departures board only when the person chose it (and gave a handle).
  public boolean NOT NULL DEFAULT false,
  route jsonb NOT NULL CHECK (jsonb_typeof(route) = 'object' AND octet_length(route::text) <= 4096),
  run_id text NOT NULL CHECK (length(run_id) BETWEEN 1 AND 200),
  departed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, pass_id),
  UNIQUE (tenant_id, account_id),
  UNIQUE (tenant_id, boarding_no),
  UNIQUE (tenant_id, founding_seat),
  FOREIGN KEY (tenant_id, account_id) REFERENCES flofi_accounts (tenant_id, account_id) ON DELETE CASCADE,
  CHECK (NOT public OR handle IS NOT NULL)
);
CREATE INDEX flight_passes_departures ON flight_passes (tenant_id, departed_at DESC) WHERE public;

-- Invites: three per Founding pass, and invites the FloFi team issues (CREATOR). Single use; one redeemed invite per account.
CREATE TABLE flight_invites (
  tenant_id text NOT NULL REFERENCES tenants(tenant_id),
  code text NOT NULL CHECK (code ~ '^FLF-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$'),
  issuer text NOT NULL CHECK (issuer IN ('FOUNDING', 'CREATOR')),
  issuer_pass_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  redeemed_by text,
  redeemed_at timestamptz,
  PRIMARY KEY (tenant_id, code),
  FOREIGN KEY (tenant_id, issuer_pass_id) REFERENCES flight_passes (tenant_id, pass_id) ON DELETE SET NULL (issuer_pass_id),
  FOREIGN KEY (tenant_id, redeemed_by) REFERENCES flofi_accounts (tenant_id, account_id) ON DELETE SET NULL (redeemed_by),
  CHECK (issuer = 'FOUNDING' OR issuer_pass_id IS NULL),
  CHECK (redeemed_by IS NULL OR redeemed_at IS NOT NULL)
);
CREATE UNIQUE INDEX flight_invites_redeemer ON flight_invites (tenant_id, redeemed_by) WHERE redeemed_by IS NOT NULL;
CREATE INDEX flight_invites_issuer ON flight_invites (tenant_id, issuer_pass_id) WHERE issuer_pass_id IS NOT NULL;

-- The numbers ever issued, per tenant: boarding numbers and Founding seats are taken from here under its row lock, so a number
-- freed by a deleted account is never issued again and no more than 100 Founding seats are ever issued.
CREATE TABLE flight_issuance (
  tenant_id text NOT NULL PRIMARY KEY REFERENCES tenants(tenant_id),
  boarded integer NOT NULL DEFAULT 0 CHECK (boarded >= 0),
  founding integer NOT NULL DEFAULT 0 CHECK (founding BETWEEN 0 AND 100),
  CHECK (founding <= boarded)
);

-- Evidence that a signed-in, eligible account completed a server-side simulation: the run and the route the server itself saw
-- simulated (networks and step labels, never an amount). A pass is issued only against this evidence; it is kept for two hours.
CREATE TABLE flight_simulations (
  tenant_id text NOT NULL,
  account_id text NOT NULL,
  run_id text NOT NULL CHECK (length(run_id) BETWEEN 1 AND 200),
  flow text NOT NULL CHECK (flow ~ '^[a-z0-9-]{1,64}$'),
  workflow_id text NOT NULL CHECK (length(workflow_id) BETWEEN 1 AND 200),
  revision integer NOT NULL CHECK (revision >= 0),
  route jsonb NOT NULL CHECK (jsonb_typeof(route) = 'object' AND octet_length(route::text) <= 4096),
  simulated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, account_id, run_id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES flofi_accounts (tenant_id, account_id) ON DELETE CASCADE
);
CREATE INDEX flight_simulations_time ON flight_simulations (tenant_id, simulated_at);

-- Content-free daily campaign counters (closed event, detail and origin codes; no identity, address, prompt or route).
CREATE TABLE flight_daily_events (
  tenant_id text NOT NULL REFERENCES tenants(tenant_id),
  day date NOT NULL,
  event text NOT NULL CHECK (event IN ('list_join', 'board_click', 'access_result', 'route_example_click', 'prompt_submit', 'simulation_ok',
    'share_click', 'invite_redeem')),
  detail text NOT NULL CHECK (detail ~ '^[a-z_]{0,32}$'),
  origin text NOT NULL CHECK (origin IN ('list', 'invite', 'creator', 'none')),
  events bigint NOT NULL DEFAULT 0 CHECK (events >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, day, event, detail, origin)
);
