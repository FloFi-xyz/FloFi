-- SPDX-License-Identifier: AGPL-3.0-only
-- Optional Studio governance records. The schema 0035 versions and events remain intact.
SET LOCAL lock_timeout = '5s';

CREATE TABLE studio_certifications (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  slug text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  source_generation integer NOT NULL CHECK (source_generation >= 0),
  decision text NOT NULL CHECK (decision IN ('CERTIFIED', 'REJECTED')),
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  adapter_sha256 text NOT NULL CHECK (adapter_sha256 ~ '^[a-f0-9]{64}$'),
  evidence_sha256 text NOT NULL CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object' AND octet_length(evidence::text) <= 65536),
  capabilities text[] NOT NULL CHECK (capabilities IN (ARRAY[]::text[], ARRAY['network.read'], ARRAY['vault.read'])),
  CHECK ((decision = 'CERTIFIED') = (cardinality(capabilities) = 1)),
  actor text NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500 AND reason !~ '[[:cntrl:]]'),
  decided_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, project_id, slug, version),
  FOREIGN KEY (tenant_id, project_id) REFERENCES developer_projects (tenant_id, project_id),
  FOREIGN KEY (tenant_id, actor) REFERENCES admin_principals (tenant_id, principal_id)
);
CREATE TRIGGER studio_certification_append_only BEFORE UPDATE OR DELETE ON studio_certifications
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

CREATE TABLE studio_publication_events (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  slug text NOT NULL,
  version integer NOT NULL,
  revision bigint GENERATED ALWAYS AS IDENTITY,
  action text NOT NULL CHECK (action IN ('PUBLISH', 'ROLLBACK', 'SUSPEND', 'REVOKE')),
  visibility text CHECK (visibility IN ('PUBLIC', 'PRIVATE')),
  audience text[] NOT NULL CHECK (cardinality(audience) <= 16),
  CHECK ((action IN ('PUBLISH', 'ROLLBACK')) = (visibility IS NOT NULL)),
  CHECK ((visibility IS NOT DISTINCT FROM 'PRIVATE') = (cardinality(audience) > 0)),
  actor text NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500 AND reason !~ '[[:cntrl:]]'),
  changed_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, project_id, slug, revision),
  FOREIGN KEY (tenant_id, project_id, slug, version) REFERENCES studio_certifications (tenant_id, project_id, slug, version),
  FOREIGN KEY (tenant_id, actor) REFERENCES admin_principals (tenant_id, principal_id)
);
CREATE UNIQUE INDEX studio_publication_revoked_version ON studio_publication_events (tenant_id, project_id, slug, version)
  WHERE action = 'REVOKE';
CREATE TRIGGER studio_publication_append_only BEFORE UPDATE OR DELETE ON studio_publication_events
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
