-- SPDX-License-Identifier: AGPL-3.0-only
-- BUILD-FLOFI-PRIVY-UX-001: Privy is FloFi's authentication and embedded-wallet provider.
-- Additive only: four CHECK constraints are widened so the 0018 tables can also hold a Privy user identity and Privy-managed wallets.
-- No row is inserted, updated, moved or deleted, and every row that satisfied 0018 satisfies these constraints unchanged (including
-- every Turnkey-managed wallet and organization, which stay exactly as they are). Still no private key, seed phrase, OTP code, OAuth/OIDC
-- or Privy token is ever stored: only the Privy user id (a public DID) and public wallet metadata.
SET LOCAL lock_timeout = '5s';

-- A Privy user (its DID, `did:privy:…`) is one sign-in identity of at most one account, like a Google subject or a verified email.
ALTER TABLE flofi_account_identities
  DROP CONSTRAINT flofi_account_identities_kind_check,
  ADD CONSTRAINT flofi_account_identities_kind_check CHECK (kind IN ('GOOGLE', 'APPLE', 'EMAIL', 'EIP155', 'SOLANA', 'PRIVY')),
  DROP CONSTRAINT flofi_account_identities_check,
  ADD CONSTRAINT flofi_account_identities_check CHECK (
    (kind = 'EIP155' AND subject ~ '^0x[0-9a-f]{40}$') OR
    (kind = 'SOLANA' AND subject ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$') OR
    (kind = 'EMAIL' AND length(subject) <= 254 AND subject = lower(subject) AND subject ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') OR
    (kind IN ('GOOGLE', 'APPLE') AND subject ~ '^[A-Za-z0-9._-]{1,255}$') OR
    (kind = 'PRIVY' AND subject ~ '^did:privy:[A-Za-z0-9]{8,64}$'));

-- Privy-managed wallets: generated or imported in the person's own Privy embedded wallet. Privy shows its owner the private key of
-- either kind (never a recovery phrase), and its wallet id is optional public metadata. Turnkey-managed wallets keep their rules.
ALTER TABLE flofi_account_wallets
  DROP CONSTRAINT flofi_account_wallets_check2,
  ADD CONSTRAINT flofi_account_wallets_check2 CHECK (origin = 'EXTERNAL' OR (provider = 'turnkey' AND provider_resource IS NOT NULL) OR provider = 'privy'),
  DROP CONSTRAINT flofi_account_wallets_check3,
  ADD CONSTRAINT flofi_account_wallets_check3 CHECK (origin <> 'GENERATED' OR export = 'RECOVERY_PHRASE' OR (provider = 'privy' AND export = 'PRIVATE_KEY'));
