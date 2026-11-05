-- SPDX-License-Identifier: AGPL-3.0-only
-- BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001: workflow grants — the single wallet-signed authorization of a delegated workflow run.
--
-- A workflow grant is an ERC-7710 delegation the owner's wallet signs once per chain for ONE run: exactly that run's calls, each usable
-- once (ExactCalldata + IdEnforcer), inside a short window. Its authority is the wallet signature itself, so it has no passkey; every
-- Credential (reusable, class-scoped) grant still must have one. A run authorization signed this way has no passkey assertion: its
-- revision records the wallet signatures (`assertion`) under an envelope of kind WALLET_WORKFLOW. Additive: no row changes.

ALTER TABLE credential_grants ALTER COLUMN passkey_id DROP NOT NULL;
ALTER TABLE credential_grants ADD CONSTRAINT credential_grants_passkey_or_workflow_grant CHECK (
  passkey_id IS NOT NULL OR (mechanism = 'EVM_ERC7710_METAMASK_V1_3' AND scope->>'kind' = 'WORKFLOW'));

-- The revision CHECK of 0011 requires a passkey for every signed revision; it is replaced by one that also admits a wallet-signed
-- workflow authorization (and nothing else).
DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint
    WHERE conrelid = 'delegated_authorization_revisions'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%passkey_id IS NOT NULL%';
  IF c IS NULL THEN RAISE EXCEPTION 'MIGRATION_0020_REVISION_CHECK_NOT_FOUND'; END IF;
  EXECUTE format('ALTER TABLE delegated_authorization_revisions DROP CONSTRAINT %I', c);
END $$;
ALTER TABLE delegated_authorization_revisions ADD CONSTRAINT delegated_authorization_revisions_signed CHECK (
  state IN ('PENDING_SIGNATURE', 'SUPERSEDED', 'REVOKED', 'EXPIRED')
  OR (assertion IS NOT NULL AND signed_at IS NOT NULL AND envelope IS NOT NULL
      AND (passkey_id IS NOT NULL OR (envelope->>'kind' = 'WALLET_WORKFLOW' AND assertion->>'kind' = 'WALLET_WORKFLOW'))));
