-- SPDX-License-Identifier: AGPL-3.0-only
-- BUILD-CHAT-LEARNING-002 0014: automatic Copilot learning, additive. Two new tables: each verified identity's own choice about persistent automatic
-- learning (recorded with the legal basis it was made under), and the bounded evidence FloFi observed in that identity's natural interaction (answers
-- to FloFi's own questions, corrections of readings FloFi made on its own, applied proposals, explicit statements). Both reference learning_subjects
-- (0013) with ON DELETE CASCADE, so every erasure of a subject — by any build — erases them too; that foreign key is the only thing touching an
-- existing relation (its referential triggers on learning_subjects). Nothing here is a message, a transcript, an amount, an address, a recipient, a
-- slippage, a balance, a signature or an authorization: a term is a short validated word and a target is one closed-vocabulary value.
SET LOCAL lock_timeout = '5s';

-- 1. Persistent automatic learning, per identity. No row: no choice recorded (the deployment's mode decides: off, consent = not collected,
--    legitimate interest = collected unless the identity objected). `enabled` is the choice; `basis` and `notice_version` say under which legal
--    basis and notice it was recorded; `decided_at` when.
CREATE TABLE learning_automatic_settings (
  tenant_id text NOT NULL,
  subject_id text NOT NULL,
  enabled boolean NOT NULL,
  basis text NOT NULL CHECK (basis IN ('CONSENT', 'LEGITIMATE_INTEREST')),
  notice_version integer NOT NULL CHECK (notice_version BETWEEN 1 AND 1000),
  decided_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, subject_id),
  FOREIGN KEY (tenant_id, subject_id) REFERENCES learning_subjects (tenant_id, subject_id) ON DELETE CASCADE
);

-- 2. Evidence: how often one identity's own interaction showed that a word means one closed-vocabulary target (or which reply language it uses).
--    Counters only, each request counted at most once (`last_request`, a keyed digest of a random per-conversation id and the request's ordinal;
--    `last_conversation` likewise counts distinct conversations). `promoted_at`: the meaning was learned (it is then a row of learning_memories).
--    Unpromoted evidence expires; a correction of a learned meaning deletes it.
CREATE TABLE learning_evidence (
  tenant_id text NOT NULL,
  subject_id text NOT NULL,
  term text NOT NULL CHECK (term = '' OR (length(term) BETWEEN 2 AND 32 AND term !~ '[[:cntrl:]]' AND term = btrim(term))),
  target text NOT NULL CHECK (target ~ '^(network|asset|operation):[A-Z][A-Z0-9_]{1,31}$' OR target IN ('language:EN', 'language:PT')),
  stated integer NOT NULL DEFAULT 0 CHECK (stated BETWEEN 0 AND 1000),
  clarified integer NOT NULL DEFAULT 0 CHECK (clarified BETWEEN 0 AND 1000),
  corrected integer NOT NULL DEFAULT 0 CHECK (corrected BETWEEN 0 AND 1000),
  confirmed integer NOT NULL DEFAULT 0 CHECK (confirmed BETWEEN 0 AND 1000),
  conversations integer NOT NULL DEFAULT 0 CHECK (conversations BETWEEN 0 AND 100000),
  last_request bytea CHECK (last_request IS NULL OR octet_length(last_request) = 32),
  last_conversation bytea CHECK (last_conversation IS NULL OR octet_length(last_conversation) = 32),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  promoted_at timestamptz,
  PRIMARY KEY (tenant_id, subject_id, term, target),
  FOREIGN KEY (tenant_id, subject_id) REFERENCES learning_subjects (tenant_id, subject_id) ON DELETE CASCADE,
  CHECK ((term = '') = (target LIKE 'language:%'))
);
CREATE INDEX learning_evidence_seen ON learning_evidence (tenant_id, last_seen_at);
