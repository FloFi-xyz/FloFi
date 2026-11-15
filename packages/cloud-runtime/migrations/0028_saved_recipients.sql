-- SPDX-License-Identifier: AGPL-3.0-only
-- BUILD-FLOFI-UNIFIED-COPILOT-001 0028: Saved Recipients, an account's address book of PUBLIC destination addresses. Additive: one new table
-- with the indexes of its own keys. No existing relation, function, trigger, CHECK or index changes, and no existing row is read or rewritten.
--
-- A saved recipient is a name for a public address and nothing else. No column holds a key, seed phrase, signing credential, delegation or
-- allowlist entry, and nothing here is proof that the account controls the address: ownership is derived at read time from the account's
-- verified wallets. No flow reads this table to decide where funds go; an address is re-checked for its network at every use, shown in full
-- at Review and signed for by the owner's own wallet.
--
-- Scoped per account, not per tenant: two accounts may save the same address, because saving an address is not ownership. Removed with its
-- account (ON DELETE CASCADE), so deleting a FloFi account deletes its saved recipients.
--
-- Rolling deployments: the foreign key briefly takes a SHARE ROW EXCLUSIVE lock on `flofi_accounts` (the new table is empty, so nothing is
-- scanned). If that lock cannot be taken within 5 s, the migration fails and rolls back entirely instead of queueing every later sign-in behind it.
SET LOCAL lock_timeout = '5s';

CREATE TABLE flofi_account_recipients (
  tenant_id text NOT NULL,
  account_id text NOT NULL,
  recipient_id text NOT NULL CHECK (recipient_id ~ '^rcp_[a-z2-7]{26}$'),
  ecosystem text NOT NULL CHECK (ecosystem IN ('EVM', 'SOLANA')),
  -- The canonical public address: EVM in lower case, never the zero address; Solana base58 exactly as typed, never the System Program.
  -- Before writing, the application also checks EIP-55 for mixed-case EVM input and that a Solana address is a 32-byte on-curve wallet key.
  address text NOT NULL,
  -- A display name of 1-40 characters on one line (no C0/C1 control character). The application also refuses names shaped like an address
  -- or key material, and card numbers, so a name can never carry an address or a secret.
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 40 AND label !~ '[\x01-\x1f\x7f-\x9f]'),
  -- The name's comparison key (case, accents, punctuation and spacing folded by the application). Unique per account, so a recipient named
  -- in a message is never ambiguous. Bounded: Unicode decomposition of a 40-character name stays well within 160 characters.
  label_key text NOT NULL CHECK (char_length(label_key) BETWEEN 1 AND 160),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, account_id, recipient_id),
  -- One record per address and account: saving an address again returns the existing record, never a duplicate or an overwrite.
  CONSTRAINT flofi_account_recipients_address UNIQUE (tenant_id, account_id, ecosystem, address),
  CONSTRAINT flofi_account_recipients_label UNIQUE (tenant_id, account_id, label_key),
  FOREIGN KEY (tenant_id, account_id) REFERENCES flofi_accounts (tenant_id, account_id) ON DELETE CASCADE,
  CHECK ((ecosystem = 'EVM' AND address ~ '^0x[0-9a-f]{40}$' AND address <> '0x0000000000000000000000000000000000000000')
    OR (ecosystem = 'SOLANA' AND address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' AND address <> '11111111111111111111111111111111'))
);
