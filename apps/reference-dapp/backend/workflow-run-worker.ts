// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHAT-E2E-001: the workflow runner on the Railway worker. Loaded by `main.ts worker` only when FLOFI_WORKFLOW_RUNS=enabled; otherwise
 * neither this module nor the resolution rule is loaded and the worker is unchanged. It reads step runs through this worker's own backend
 * (owner-scoped, read-only) and never signs or submits; the worker's flow services keep their observe-only transports.
 */
import { createRunQueries, type Database, type Logger } from '@defi-workflow-engine/cloud-runtime';
import type { Backend } from './app.ts';
import { installSourceResolution } from './source-resolution.ts';

type Env = Readonly<Record<string, string | undefined>>;
export async function loadWorkflowRunWorker(env: Env, db: Database, tenantId: string, logger: Logger, backend: Backend) {
  installSourceResolution();
  const [{ workflowRunWorkerParts }, { embeddedMcpRuntime }, { ownerRunReaders }] = await Promise.all([import('../src/workflow-runs/worker.ts'),
    import('../src/mcp/runtime.ts'), import('../src/server/flow-runtime.ts')]);
  const runtime = embeddedMcpRuntime({ backend, ...ownerRunReaders(createRunQueries(db, tenantId)) });
  return workflowRunWorkerParts(env, db, tenantId, logger, runtime);
}
