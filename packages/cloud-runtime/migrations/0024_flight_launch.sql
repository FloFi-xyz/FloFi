-- SPDX-License-Identifier: AGPL-3.0-only
-- BUILD-FLOFI-FLIGHT-LAUNCH-001 0024: the Flight FloFi launch completion (team decisions of 9 Nov 2026), additive.
--
-- Campaign email through Resend (an outbox with idempotent, quota-reserved delivery), proof that a person controls a beta-list address
-- (a single-use access link and a six-digit code, stored only as digests), the binding of a proven list entry to the FloFi account the
-- person signed in with, one-click unsubscribe, and a public, unguessable link for each boarding card. A campaign record is never financial
-- authority: nothing here signs, authorizes, links a wallet, creates an account or gates /app.
-- Personal data: list addresses (already in 0020) are referenced by entry; an outbox row carries its recipient address and language until it
-- is pruned (90 days after it settles; at once on erasure, by cascade). No token, code, link, session secret or API key is stored in clear:
-- links and sessions are SHA-256 digests of 256-bit secrets, codes are keyed HMAC digests, unsubscribed addresses are SHA-256 digests.
-- Existing objects: two nullable columns on flight_passes, one nullable column on flight_invites, two partial unique indexes. Every row valid
-- under 0023 stays valid, and a build without 0024 (v23) keeps working unchanged: it names its columns on every INSERT and never reads the new
-- ones. New: seven flight_* tables. See docs/deploy/SCHEMA-COMPATIBILITY.md §18 (certificate 0024_flight_launch).
SET LOCAL lock_timeout = '5s';

-- 1. Boarding cards: the public link id (12 random base32 letters, never sequential) and a takedown time (the person's request or moderation).
ALTER TABLE flight_passes
  ADD COLUMN public_id text CHECK (public_id ~ '^[a-z2-7]{12}$'),
  ADD COLUMN removed_at timestamptz;
CREATE UNIQUE INDEX flight_passes_public_id ON flight_passes (tenant_id, public_id) WHERE public_id IS NOT NULL;

-- 2. Invites the team addresses to one person (Email 6): the recipient, so each invite's delivery is traceable. FOUNDING invites have none.
ALTER TABLE flight_invites
  ADD COLUMN recipient text CHECK (recipient IS NULL OR (length(recipient) BETWEEN 6 AND 254 AND recipient = lower(recipient)
    AND recipient ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'));
CREATE UNIQUE INDEX flight_invites_recipient ON flight_invites (tenant_id, recipient) WHERE recipient IS NOT NULL;

-- 3. Access tokens: proof that a person reads a beta-list address. One link (72 hours, single use) and one six-digit code (short-lived,
-- at most 5 wrong tries, single use) per token; using either consumes both. Only digests are stored.
CREATE TABLE flight_access_tokens (
  tenant_id text NOT NULL REFERENCES tenants(tenant_id),
  token_id text NOT NULL CHECK (token_id ~ '^fat_[0-9a-f]{32}$'),
  entry_id text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('BOARDING')),
  link_hash text NOT NULL CHECK (link_hash ~ '^[0-9a-f]{64}$'),
  code_hash text NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  link_expires_at timestamptz NOT NULL,
  code_expires_at timestamptz NOT NULL,
  code_attempts integer NOT NULL DEFAULT 0 CHECK (code_attempts BETWEEN 0 AND 1000),
  consumed_at timestamptz,
  revoked_at timestamptz,
  PRIMARY KEY (tenant_id, token_id),
  UNIQUE (tenant_id, link_hash),
  FOREIGN KEY (tenant_id, entry_id) REFERENCES flight_list_entries (tenant_id, entry_id) ON DELETE CASCADE,
  CHECK (link_expires_at > created_at AND code_expires_at > created_at)
);
CREATE INDEX flight_access_tokens_entry ON flight_access_tokens (tenant_id, entry_id, created_at DESC);
CREATE INDEX flight_access_tokens_expiry ON flight_access_tokens (tenant_id, link_expires_at);

-- 4. A browser that proved a list address before signing in: an HttpOnly cookie holds a 256-bit secret, this table its digest (30 days).
CREATE TABLE flight_access_sessions (
  tenant_id text NOT NULL REFERENCES tenants(tenant_id),
  session_hash text NOT NULL CHECK (session_hash ~ '^[0-9a-f]{64}$'),
  entry_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, session_hash),
  FOREIGN KEY (tenant_id, entry_id) REFERENCES flight_list_entries (tenant_id, entry_id) ON DELETE CASCADE,
  CHECK (expires_at > created_at)
);
CREATE INDEX flight_access_sessions_expiry ON flight_access_sessions (tenant_id, expires_at);

-- 5. A proven list entry bound to the FloFi account the person signed in with: one account per entry, one entry per account. Campaign access
-- only: it never signs anyone in, never adds an identity or a wallet to the account.
CREATE TABLE flight_access_claims (
  tenant_id text NOT NULL,
  entry_id text NOT NULL,
  account_id text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, entry_id),
  UNIQUE (tenant_id, account_id),
  FOREIGN KEY (tenant_id, entry_id) REFERENCES flight_list_entries (tenant_id, entry_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, account_id) REFERENCES flofi_accounts (tenant_id, account_id) ON DELETE CASCADE
);

-- 6. Abuse limits of the access endpoints (code tries, link requests, link uses): a keyed digest of the client or of the address, pruned
-- after one day. Never the network address or the email address itself.
CREATE TABLE flight_access_attempts (
  tenant_id text NOT NULL REFERENCES tenants(tenant_id),
  kind text NOT NULL CHECK (kind IN ('CODE_CLIENT', 'CODE_ADDRESS', 'REQUEST_CLIENT', 'REQUEST_ADDRESS', 'CONSUME_CLIENT')),
  subject text NOT NULL CHECK (subject ~ '^[0-9a-f]{64}$'),
  attempted_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX flight_access_attempts_subject ON flight_access_attempts (tenant_id, kind, subject, attempted_at);
CREATE INDEX flight_access_attempts_time ON flight_access_attempts (tenant_id, attempted_at);

-- 7. The email outbox. One row per intended email; `dedupe_key` makes every trigger idempotent (a repeated join, a restarted worker, a
-- re-run scheduler never enqueue twice). Delivery: PENDING → SENDING (quota reserved, leased) → SENT | UNKNOWN (the provider's answer was
-- lost: never assumed unsent; retried with the same idempotency key while the provider still deduplicates it, then held for an operator)
-- | PENDING again (transient error, bounded retries) | FAILED (permanent) | HELD (needs a team decision: quota, provider configuration,
-- unresolved outcome) | CANCELLED (unsubscribed, no longer eligible, expired, paused campaign withdrawn by the operator).
CREATE TABLE flight_emails (
  tenant_id text NOT NULL REFERENCES tenants(tenant_id),
  email_id text NOT NULL CHECK (email_id ~ '^fem_[0-9a-f]{32}$'),
  dedupe_key text NOT NULL CHECK (dedupe_key ~ '^[a-z0-9:_.-]{1,200}$'),
  template text NOT NULL CHECK (template IN ('LIST_CONFIRMATION', 'EVE', 'GROUP_BOARDING', 'ACCESS_REQUESTED', 'CARD_FOUNDING', 'CARD_PASSENGER',
    'NEXT_FLIGHT', 'CREATOR_INVITE')),
  template_version integer NOT NULL CHECK (template_version BETWEEN 1 AND 1000),
  category text NOT NULL CHECK (category IN ('CAMPAIGN', 'ESSENTIAL')),
  recipient text NOT NULL CHECK (length(recipient) BETWEEN 6 AND 254 AND recipient = lower(recipient) AND recipient ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  language text NOT NULL CHECK (language IN ('EN', 'PT')),
  trigger text NOT NULL CHECK (trigger ~ '^[a-z_]{1,40}$'),
  batch_key text CHECK (batch_key ~ '^[a-z0-9-]{1,64}$'),
  entry_id text,
  pass_id text,
  invite_code text,
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'SENDING', 'SENT', 'UNKNOWN', 'HELD', 'FAILED', 'CANCELLED')),
  not_before timestamptz NOT NULL,
  expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 100),
  next_attempt_at timestamptz NOT NULL,
  lease_token text CHECK (lease_token ~ '^[0-9a-f]{32}$'),
  lease_until timestamptz,
  reserved_at timestamptz,
  first_attempt_at timestamptz,
  provider_id text CHECK (provider_id ~ '^[A-Za-z0-9-]{1,100}$'),
  status_reason text CHECK (status_reason ~ '^[A-Z0-9_]{1,60}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  sent_at timestamptz,
  PRIMARY KEY (tenant_id, email_id),
  UNIQUE (tenant_id, dedupe_key),
  FOREIGN KEY (tenant_id, entry_id) REFERENCES flight_list_entries (tenant_id, entry_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, pass_id) REFERENCES flight_passes (tenant_id, pass_id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, invite_code) REFERENCES flight_invites (tenant_id, code) ON DELETE CASCADE,
  CHECK ((state = 'SENDING') = (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK (state NOT IN ('SENDING', 'SENT', 'UNKNOWN') OR reserved_at IS NOT NULL),
  CHECK (state <> 'SENT' OR sent_at IS NOT NULL)
);
CREATE INDEX flight_emails_due ON flight_emails (tenant_id, next_attempt_at) WHERE state IN ('PENDING', 'SENDING', 'UNKNOWN');
CREATE INDEX flight_emails_reserved ON flight_emails (tenant_id, reserved_at) WHERE reserved_at IS NOT NULL;
CREATE INDEX flight_emails_batch ON flight_emails (tenant_id, batch_key, state) WHERE batch_key IS NOT NULL;
CREATE INDEX flight_emails_recipient ON flight_emails (tenant_id, recipient);

-- 8. Addresses that asked not to receive campaign email (one click), or that the provider rejected: the SHA-256 of the lower-cased address.
CREATE TABLE flight_email_suppressions (
  tenant_id text NOT NULL REFERENCES tenants(tenant_id),
  address_hash text NOT NULL CHECK (address_hash ~ '^[0-9a-f]{64}$'),
  reason text NOT NULL CHECK (reason IN ('UNSUBSCRIBED', 'PROVIDER_REJECTED', 'OPERATOR')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, address_hash)
);

-- 9. The operator's switch and the provider's own stop: campaign sending paused (without stopping the product), and a provider block (daily
-- or monthly quota answered by Resend, an invalid key) until a time or until an operator clears it.
CREATE TABLE flight_email_control (
  tenant_id text NOT NULL PRIMARY KEY REFERENCES tenants(tenant_id),
  paused boolean NOT NULL DEFAULT false,
  paused_reason text CHECK (paused_reason ~ '^[A-Za-z0-9_ .:-]{1,120}$'),
  blocked_until timestamptz,
  blocked_reason text CHECK (blocked_reason ~ '^[A-Z0-9_]{1,60}$'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
