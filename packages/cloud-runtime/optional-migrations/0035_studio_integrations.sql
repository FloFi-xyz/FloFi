-- SPDX-License-Identifier: AGPL-3.0-only
-- Additive studio state. Applies only under the explicit operator migration.
SET LOCAL lock_timeout = '5s';

CREATE TABLE studio_integration_versions (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  slug text NOT NULL CHECK (slug ~ '^[a-z][a-z0-9-]{1,49}$'),
  version integer NOT NULL CHECK (version > 0),
  generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0),
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
    'DRAFT', 'VERIFIED', 'CERTIFICATION_PENDING', 'CERTIFIED', 'PUBLISHED', 'SUSPENDED', 'REVOKED'
  )),
  verification jsonb,
  test_result jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, project_id, slug, version),
  FOREIGN KEY (tenant_id, project_id) REFERENCES developer_project_owners (tenant_id, project_id) ON DELETE CASCADE,
  CHECK (verification IS NULL OR jsonb_typeof(verification) = 'object'),
  CHECK (test_result IS NULL OR jsonb_typeof(test_result) = 'object'),
  CHECK (status NOT IN ('VERIFIED', 'CERTIFICATION_PENDING', 'CERTIFIED', 'PUBLISHED') OR verification IS NOT NULL),
  CHECK (status NOT IN ('CERTIFICATION_PENDING', 'CERTIFIED', 'PUBLISHED') OR test_result IS NOT NULL),
  CHECK (status NOT IN ('DRAFT', 'SUSPENDED', 'REVOKED') OR (verification IS NULL AND test_result IS NULL))
);

CREATE INDEX studio_integration_review_queue
  ON studio_integration_versions (tenant_id, updated_at, project_id, slug, version)
  WHERE status = 'CERTIFICATION_PENDING';

CREATE TABLE studio_integration_events (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  slug text NOT NULL,
  version integer NOT NULL,
  generation integer NOT NULL,
  at timestamptz NOT NULL,
  event text NOT NULL CHECK (event IN ('CREATED', 'VERIFIED', 'TESTED', 'SUBMITTED', 'INVALIDATED', 'SUSPENDED', 'REVOKED')),
  evidence jsonb,
  PRIMARY KEY (tenant_id, project_id, slug, version, generation),
  FOREIGN KEY (tenant_id, project_id, slug, version)
    REFERENCES studio_integration_versions (tenant_id, project_id, slug, version) ON DELETE CASCADE
);
