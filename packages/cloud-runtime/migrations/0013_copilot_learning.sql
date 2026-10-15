-- SPDX-License-Identifier: AGPL-3.0-only
-- BUILD-CHAT-LEARNING-001 0013: FloFi's hybrid Copilot learning, additive. Private memory per verified identity, content-free feedback events, and
-- the reviewed, evaluated, versioned global glossary. Seven new tables with their own functions and triggers; no foreign key, trigger, index or
-- constraint touches a relation that existed before, so applying it locks no existing table (the triggers below only reference the existing
-- reject_append_only_mutation() function, which is not changed). Nothing here is financial authority, a key, a wallet address, a prompt or a
-- transcript: an identity is a keyed digest (FLOFI_LEARNING_SECRET), a memory is a short validated term and one closed-vocabulary target (a
-- network, a token or an operation; never an amount, an address or a slippage), and feedback events carry closed codes and counts only.
SET LOCAL lock_timeout = '5s';

-- 1. Learning subjects: one per verified identity — a proven wallet session (EVM or Solana, separately) or a provider-authenticated channel sender —
--    stored only as a keyed digest. Two separate, user-controlled purposes, each with the time consent was given and the notice version shown.
CREATE TABLE learning_subjects (
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
  subject_id text NOT NULL CHECK (subject_id ~ '^lsb_[a-z2-7]{26}$'),
  kind text NOT NULL CHECK (kind IN ('WALLET', 'CHANNEL')),
  subject_digest bytea NOT NULL CHECK (octet_length(subject_digest) = 32),
  memory_enabled boolean NOT NULL DEFAULT false,
  memory_consent_at timestamptz,
  contribute_enabled boolean NOT NULL DEFAULT false,
  contribute_consent_at timestamptz,
  notice_version integer CHECK (notice_version IS NULL OR notice_version BETWEEN 1 AND 1000),
  language text CHECK (language IS NULL OR language IN ('EN', 'PT')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, subject_id),
  UNIQUE (tenant_id, subject_digest),
  CHECK (NOT memory_enabled OR memory_consent_at IS NOT NULL),
  CHECK (NOT contribute_enabled OR contribute_consent_at IS NOT NULL)
);
CREATE INDEX learning_subjects_seen ON learning_subjects (tenant_id, last_seen_at);

-- 2. Private memory: the user's own meanings, readable only through their own identity. Deleting the subject deletes every entry.
CREATE TABLE learning_memories (
  tenant_id text NOT NULL,
  subject_id text NOT NULL,
  term text NOT NULL CHECK (length(term) BETWEEN 2 AND 32 AND term !~ '[[:cntrl:]]' AND term = btrim(term)),
  target text NOT NULL CHECK (target ~ '^(network|asset|operation):[A-Z][A-Z0-9_]{1,31}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Last saved or used: an entry untouched for the retention period expires.
  touched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, subject_id, term),
  FOREIGN KEY (tenant_id, subject_id) REFERENCES learning_subjects (tenant_id, subject_id) ON DELETE CASCADE
);
CREATE INDEX learning_memories_touched ON learning_memories (tenant_id, touched_at);

-- 3. Content-free feedback events: which kind of thing happened, its closed outcome, the scope and counts. No subject, no text, no term.
--    `evidence` keeps observed behaviour (OBSERVED), what the user stated (USER_ASSERTED) and server measurements (SYSTEM) apart: none of them is
--    ground truth about an interpretation. Rows are never changed; retention deletes them.
CREATE TABLE learning_feedback_events (
  tenant_id text NOT NULL,
  event_id bigint GENERATED ALWAYS AS IDENTITY,
  at timestamptz NOT NULL DEFAULT now(),
  scope text NOT NULL CHECK (scope IN ('WEB', 'TELEGRAM', 'WHATSAPP')),
  kind text NOT NULL CHECK (kind ~ '^[A-Z][A-Z_]{2,40}$'),
  evidence text NOT NULL CHECK (evidence IN ('OBSERVED', 'USER_ASSERTED', 'SYSTEM')),
  outcome text CHECK (outcome IS NULL OR outcome ~ '^[A-Z][A-Z0-9_]{1,60}$'),
  language text CHECK (language IS NULL OR language IN ('EN', 'PT')),
  private_entries smallint NOT NULL DEFAULT 0 CHECK (private_entries BETWEEN 0 AND 64),
  global_entries smallint NOT NULL DEFAULT 0 CHECK (global_entries BETWEEN 0 AND 64),
  knowledge_version integer CHECK (knowledge_version IS NULL OR knowledge_version >= 1),
  PRIMARY KEY (tenant_id, event_id)
);
CREATE INDEX learning_feedback_events_at ON learning_feedback_events (tenant_id, at);
CREATE TRIGGER learning_feedback_events_immutable BEFORE UPDATE ON learning_feedback_events
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

-- 4. Global glossary candidates: generalized term → target pairs (a user's opt-in contribution, or an operator's entry). Only an operator decides;
--    support counts distinct pseudonymous contributors and is shown to the reviewer, never used to promote anything.
CREATE TABLE learning_candidates (
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
  candidate_id text NOT NULL CHECK (candidate_id ~ '^lkc_[a-z2-7]{26}$'),
  term text NOT NULL CHECK (length(term) BETWEEN 2 AND 32 AND term !~ '[[:cntrl:]]' AND term = btrim(term)),
  target text NOT NULL CHECK (target ~ '^(network|asset|operation):[A-Z][A-Z0-9_]{1,31}$'),
  language text NOT NULL CHECK (language IN ('EN', 'PT', 'ANY')),
  origin text NOT NULL CHECK (origin IN ('CONTRIBUTION', 'OPERATOR')),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'APPROVED', 'REJECTED')),
  support integer NOT NULL DEFAULT 0 CHECK (support >= 0),
  created_by text CHECK (created_by IS NULL OR created_by ~ '^(adm_[a-z2-7]{26}|cli)$'),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  decided_by text CHECK (decided_by IS NULL OR decided_by ~ '^(adm_[a-z2-7]{26}|cli)$'),
  decided_at timestamptz,
  reason text CHECK (reason IS NULL OR (length(reason) BETWEEN 1 AND 200 AND reason !~ '[[:cntrl:]]')),
  PRIMARY KEY (tenant_id, candidate_id),
  UNIQUE (tenant_id, term, target),
  CHECK ((state = 'PENDING') = (decided_at IS NULL)),
  CHECK ((decided_at IS NULL) = (decided_by IS NULL)),
  CHECK ((origin = 'OPERATOR') = (created_by IS NOT NULL))
);
CREATE INDEX learning_candidates_state ON learning_candidates (tenant_id, state, support DESC, last_seen_at DESC);

-- A candidate's identity never changes; decisions follow PENDING → APPROVED | REJECTED, APPROVED → REJECTED (retraction), REJECTED → PENDING
-- (reopened). Support and last_seen_at may change in any state.
CREATE FUNCTION learning_candidate_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.candidate_id IS DISTINCT FROM OLD.candidate_id OR NEW.term IS DISTINCT FROM OLD.term
     OR NEW.target IS DISTINCT FROM OLD.target OR NEW.language IS DISTINCT FROM OLD.language OR NEW.origin IS DISTINCT FROM OLD.origin
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.first_seen_at IS DISTINCT FROM OLD.first_seen_at THEN
    RAISE EXCEPTION 'LEARNING_CANDIDATE_IMMUTABLE' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT ((OLD.state = 'PENDING' AND NEW.state IN ('APPROVED', 'REJECTED'))
     OR (OLD.state = 'APPROVED' AND NEW.state = 'REJECTED') OR (OLD.state = 'REJECTED' AND NEW.state = 'PENDING')) THEN
    RAISE EXCEPTION 'LEARNING_CANDIDATE_TRANSITION_INVALID' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER learning_candidate_transition BEFORE UPDATE ON learning_candidates FOR EACH ROW EXECUTE FUNCTION learning_candidate_transition();

-- One row per contributor and candidate: a keyed digest of the contributor (unlinkable to a subject without FLOFI_LEARNING_SECRET), erased with
-- the contributor's data or by retention.
CREATE TABLE learning_candidate_support (
  tenant_id text NOT NULL,
  candidate_id text NOT NULL,
  contributor_digest bytea NOT NULL CHECK (octet_length(contributor_digest) = 32),
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, candidate_id, contributor_digest),
  FOREIGN KEY (tenant_id, candidate_id) REFERENCES learning_candidates (tenant_id, candidate_id) ON DELETE CASCADE
);
CREATE INDEX learning_candidate_support_contributor ON learning_candidate_support (tenant_id, contributor_digest);
CREATE INDEX learning_candidate_support_at ON learning_candidate_support (tenant_id, at);

-- 5. Every deterministic evaluation of a glossary document (passed or not): the document's SHA-256 (of its jsonb text, computed here) and
--    content-free metrics. Append-only.
CREATE TABLE learning_evaluations (
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
  evaluation_id bigint GENERATED ALWAYS AS IDENTITY,
  at timestamptz NOT NULL DEFAULT now(),
  purpose text NOT NULL CHECK (purpose IN ('DRY_RUN', 'PUBLISH', 'ROLLBACK')),
  base_version integer CHECK (base_version IS NULL OR base_version >= 1),
  document_sha256 text NOT NULL CHECK (document_sha256 ~ '^[0-9a-f]{64}$'),
  corpus text NOT NULL CHECK (corpus ~ '^[a-z0-9][a-z0-9._-]{0,39}$'),
  passed boolean NOT NULL,
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 16384),
  created_by text NOT NULL CHECK (created_by ~ '^(adm_[a-z2-7]{26}|cli)$'),
  PRIMARY KEY (tenant_id, evaluation_id)
);
CREATE INDEX learning_evaluations_at ON learning_evaluations (tenant_id, at DESC);
CREATE TRIGGER learning_evaluations_append_only BEFORE UPDATE OR DELETE ON learning_evaluations
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

-- 6. Published glossary versions: append-only and gapless per tenant; the latest is active; a NULL document means no glossary (disabled). A
--    document is published only with a PASSING evaluation of exactly that document (same SHA-256 of its jsonb text), checked here.
CREATE TABLE learning_knowledge_versions (
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
  version integer NOT NULL CHECK (version >= 1),
  document jsonb CHECK (document IS NULL OR (jsonb_typeof(document) = 'object' AND octet_length(document::text) <= 32768)),
  document_sha256 text CHECK (document_sha256 IS NULL OR document_sha256 ~ '^[0-9a-f]{64}$'),
  evaluation_id bigint,
  restored_from integer CHECK (restored_from IS NULL OR (restored_from >= 1 AND restored_from < version)),
  created_by text NOT NULL CHECK (created_by ~ '^(adm_[a-z2-7]{26}|cli)$'),
  reason text CHECK (reason IS NULL OR (length(reason) BETWEEN 1 AND 200 AND reason !~ '[[:cntrl:]]')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, version),
  FOREIGN KEY (tenant_id, evaluation_id) REFERENCES learning_evaluations (tenant_id, evaluation_id),
  CHECK ((document IS NULL) = (document_sha256 IS NULL)),
  CHECK ((document IS NULL) = (evaluation_id IS NULL))
);
CREATE FUNCTION learning_knowledge_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE latest integer;
BEGIN
  SELECT max(version) INTO latest FROM learning_knowledge_versions WHERE tenant_id = NEW.tenant_id;
  IF NEW.version <> coalesce(latest, 0) + 1 THEN
    RAISE EXCEPTION 'LEARNING_KNOWLEDGE_VERSION_CONFLICT' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.document IS NOT NULL AND (NEW.document_sha256 <> encode(sha256(convert_to(NEW.document::text, 'UTF8')), 'hex') OR NOT EXISTS (
       SELECT 1 FROM learning_evaluations e WHERE e.tenant_id = NEW.tenant_id AND e.evaluation_id = NEW.evaluation_id AND e.passed
         AND e.document_sha256 = NEW.document_sha256)) THEN
    RAISE EXCEPTION 'LEARNING_EVALUATION_REQUIRED' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER learning_knowledge_admission BEFORE INSERT ON learning_knowledge_versions FOR EACH ROW EXECUTE FUNCTION learning_knowledge_admission();
CREATE TRIGGER learning_knowledge_versions_append_only BEFORE UPDATE OR DELETE ON learning_knowledge_versions
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
