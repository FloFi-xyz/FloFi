-- SPDX-License-Identifier: AGPL-3.0-only
-- Flight launch gate 002: additive Google Forms provenance and Email 0 outbox support.
-- No production data, existing authorization, campaigns or sent messages are modified.
SET LOCAL lock_timeout = '5s';

ALTER TABLE flight_emails DROP CONSTRAINT flight_emails_template_check;
ALTER TABLE flight_emails ADD CONSTRAINT flight_emails_template_check CHECK (template IN
  ('EARLY_LIST', 'LIST_CONFIRMATION', 'EVE', 'GROUP_BOARDING', 'ACCESS_REQUESTED', 'CARD_FOUNDING', 'CARD_PASSENGER', 'NEXT_FLIGHT', 'CREATOR_INVITE'));

-- Existing codes keep their original validity (null expiry); new code writers explicitly set thirty days.
-- Revocation stops an unused code and any access derived from it without rewriting historical redemptions.
ALTER TABLE flight_invites
  ADD COLUMN expires_at timestamptz,
  ADD COLUMN revoked_at timestamptz;

-- The source keeps the original address, signup instant and optional locale supplied by the owner.
-- List entries use the normalized identity and earliest signup time for ordering. A repeated import cannot
-- replace claims, wallet bindings, boarding history, suppression or the one-time Email 0 reservation.
CREATE TABLE flight_early_list_imports (
  tenant_id text NOT NULL,
  entry_id text NOT NULL,
  source text NOT NULL DEFAULT 'GOOGLE_FORMS' CHECK (source = 'GOOGLE_FORMS'),
  original_email text NOT NULL CHECK (length(original_email) BETWEEN 6 AND 254),
  signed_up_at timestamptz NOT NULL,
  original_language text CHECK (original_language IN ('EN', 'PT')),
  campaign_consent boolean NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  email0_enqueued_at timestamptz,
  email0_sent_at timestamptz,
  PRIMARY KEY (tenant_id, entry_id),
  FOREIGN KEY (tenant_id, entry_id) REFERENCES flight_list_entries (tenant_id, entry_id) ON DELETE CASCADE
);
