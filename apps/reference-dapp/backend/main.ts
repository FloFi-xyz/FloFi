// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Flofi backend entry point (BUILD-CLOUD-001), run directly by Node 24's TypeScript support:
 *
 *   node apps/reference-dapp/backend/main.ts migrate          apply pending schema migrations (deploy step)
 *   node apps/reference-dapp/backend/main.ts api              stateless HTTP API (N replicas)
 *   node apps/reference-dapp/backend/main.ts worker           reconciliation/evidence worker (N replicas)
 *   node apps/reference-dapp/backend/main.ts import-journal <flow> <absolute journal dir> <run id>
 *                                                            copy one validated local run log into PostgreSQL
 *
 * Configuration is environment-only (see docs/deploy/CLOUD.md). The backend holds no key, signs nothing and
 * has no transaction submission path; API and worker refuse to start against an unmigrated schema, and serve a newer one only
 * under this build's forward-compatibility certificate (BUILD-DB-COMPAT-001, docs/deploy/SCHEMA-COMPATIBILITY.md).
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { assertSchemaCompatible, createDatabase, createHttpServer, createLogger, createPostgresWorkQueue, createWorker, migrate,
  readEvidenceStore, readRuntimeConfig, sweep, type SchemaCompatibility, type WorkHandler } from '@defi-workflow-engine/cloud-runtime';
import { createFileLogStore, utf8 } from '@defi-workflow-engine/reference-executor';
import { createRobinhoodTransferService } from '../src/server/robinhood-transfer-service.ts';
import { deploymentEnvironment } from '../src/server/deployment.ts';
import { createSupplyService } from '../src/server/supply-service.ts';
import { validatePublicRunLog } from '../src/server/public-testnet-service.ts';
import { createBackend } from './app.ts';
import { flowMode, FLOWS, isFlowName, type FlowName } from './flows.ts';
import { assertDedicatedPreviewDatabase } from './preview-migration.ts';

const [command, ...rest] = process.argv.slice(2);
const logger = createLogger({ service: `flofi-${command ?? 'backend'}` });
// Startup stage reported by `backend.failed`: a fixed label, never configuration or exception text.
let stage = 'command';
// BUILD-DB-COMPAT-001: the database's schema version, plus this build's and the certified newer migrations when the database is ahead.
const schemaFields = (schema: SchemaCompatibility) => ({ schema_version: schema.version, ...schema.forward.length
  ? { application_schema_version: schema.application, forward_migrations: schema.forward.map(m => `${m.version}_${m.name}`).join(',') } : {} });

async function main(): Promise<void> {
  if (command === 'migrate') {
    stage = 'config';
    const config = readRuntimeConfig(process.env, 'migrate');
    stage = 'migrate';
    const db = createDatabase({ connectionString: config.migrationDatabaseUrl, maxConnections: 1, applicationName: 'flofi-migrate' });
    try {
      // BUILD-ADMIN-001: a Vercel Preview build never migrates a database that a non-Preview deployment (Production) writes to.
      if (deploymentEnvironment(process.env) === 'preview') { stage = 'preview_database'; await assertDedicatedPreviewDatabase(db); stage = 'migrate'; }
      // A database ahead of this build is never changed: certified, nothing is applied and the check below reports it; otherwise both fail closed.
      logger.info('migrate.applied', { versions: (await migrate(db)).join(',') || 'none', ...schemaFields(await assertSchemaCompatible(db)) });
    } finally { await db.close(); }
    return;
  }
  if (command === 'import-journal') {
    const [flow, directory, runId] = rest;
    if (!flow || !isFlowName(flow) || !directory || !isAbsolute(directory) || !runId || !FLOWS[flow].runId.test(runId)) throw new Error('IMPORT_ARGUMENTS_INVALID');
    const config = readRuntimeConfig(process.env, 'worker');
    // The full flow validator (append-only history rules, provenance) checks the local data before anything is copied.
    const provenance = flowMode(flow, process.env) === 'harness' ? 'MOCKED' : 'PUBLIC_TESTNET';
    const offline = () => Promise.reject(new Error('IMPORT_OFFLINE'));
    let bytes: Uint8Array | null;
    if (flow === 'base-sepolia-swap') {
      // The local swap journal keeps one overwritten snapshot (`<id>.json`): it becomes the first line of the durable log.
      const snapshot = await readFile(join(directory, runId + '.json'), 'utf8');
      bytes = new TextEncoder().encode(JSON.stringify(JSON.parse(snapshot)) + '\n');
      validatePublicRunLog(bytes);
    } else {
      await (flow === 'robinhood-transfer' ? createRobinhoodTransferService({ journalDir: directory, provenance, rpc: offline })
        : createSupplyService({ journalDir: directory, provenance, rpc: offline })).load(runId);
      bytes = await createFileLogStore(directory).read(runId + '.jsonl');
    }
    if (!bytes) throw new Error('IMPORT_SOURCE_MISSING');
    const source: Uint8Array = bytes;
    const db = createDatabase({ connectionString: config.databaseUrl, maxConnections: 2, applicationName: 'flofi-import' });
    try {
      await assertSchemaCompatible(db);
      const backend = createBackend({ db, env: process.env, logger, tenantId: config.tenantId, holderId: config.workerId, evidenceStore: null });
      const { log } = backend.storage(flow, config.tenantId);
      // Byte-identical copy; projections and required work are derived in the same transaction.
      await log.extend(runId + '.jsonl', source, () => undefined);
      logger.info('import.completed', { flow, run_id: runId, byte_length: source.length, lines: utf8(source).trimEnd().split('\n').length });
    } finally { await db.close(); }
    return;
  }
  if (command !== 'api' && command !== 'worker') throw new Error('COMMAND_INVALID');
  stage = 'config';
  const config = readRuntimeConfig(process.env, command);
  stage = 'database';
  const db = createDatabase({ connectionString: config.databaseUrl, maxConnections: config.databasePoolMax, applicationName: `flofi-${command}` });
  stage = 'schema';
  const schema = await assertSchemaCompatible(db);
  stage = 'evidence_store';
  const evidenceStore = readEvidenceStore(process.env);
  stage = 'backend';
  const backend = createBackend({ db, env: process.env, logger, tenantId: config.tenantId, holderId: config.workerId, evidenceStore });
  stage = 'flow_modes';
  const modes = Object.fromEntries((Object.keys(FLOWS) as FlowName[]).map(flow => [flow, flowMode(flow, process.env)]));
  logger.info(`${command}.starting`, { ...schemaFields(schema), tenant_id: config.tenantId, worker_id: config.workerId,
    evidence_store: evidenceStore?.id ?? 'none', flows: JSON.stringify(modes) });
  stage = command;

  if (command === 'api') {
    // BUILD-AUTOMATION-001: with FLOFI_AUTOMATIONS=enabled the API also serves the Automations workspace and automation approval links
    // (owner CRUD/state, no-authority handoffs). Off by default; a load failure leaves every existing route serving.
    let routes = backend.routes;
    if (process.env.FLOFI_AUTOMATIONS === 'enabled') {
      const extra = await import('./automation-api.ts').then(m => m.loadAutomationApi(process.env, { db, tenantId: config.tenantId, backend, logger })).catch(() => null);
      if (extra) { routes = [...routes, ...extra]; logger.info('automation.api_enabled', { routes: extra.map(r => r.name).join(',') }); }
      else logger.error('automation.api_disabled', { error_code: 'AUTOMATION_API_LOAD_FAILED' });
      // BUILD-AUTOMATION-002: owner operations of delegated execution (passkeys, Credentials, authorizations). Off by default; they never
      // sign or submit (no executor on the API).
      if (process.env.FLOFI_DELEGATION === 'enabled') {
        const delegation = await import('./delegation-api.ts').then(m => m.loadDelegationApi(process.env, { db, tenantId: config.tenantId, logger })).catch(() => null);
        if (delegation) { routes = [...routes, ...delegation]; logger.info('delegation.api_enabled', { routes: delegation.map(r => r.name).join(',') }); }
        else logger.error('delegation.api_disabled', { error_code: 'DELEGATION_API_LOAD_FAILED' });
      }
    }
    const server = createHttpServer({ routes, logger, authToken: config.apiAuthToken,
      ready: async () => { await db.query('SELECT 1'); return true; } });
    server.keepAliveTimeout = 65_000;
    server.listen(config.port, config.host, () => logger.info('api.listening', { port: config.port }));
    const shutdown = () => { logger.info('api.stopping'); server.close(() => { db.close().finally(() => process.exit(0)); }); setTimeout(() => process.exit(0), 25_000).unref(); };
    process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
    return;
  }
  if (!evidenceStore) throw new Error('EVIDENCE_STORE_REQUIRED');
  // BUILD-AUTOMATION-001: with FLOFI_AUTOMATIONS=enabled this worker also evaluates automations (proposals for owners, never execution)
  // and its sweep is their scheduler heartbeat. Off by default: without it nothing below changes. A misconfiguration disables
  // automations only (logged), never the worker's reconciliation.
  let automations: { readonly handlers: Readonly<Record<string, WorkHandler>>; readonly sweep: () => Promise<unknown> } | null = null;
  if (process.env.FLOFI_AUTOMATIONS === 'enabled') {
    const parts = await import('./automation-worker.ts').then(m => m.loadAutomationWorker(process.env, db, config.tenantId, logger))
      .catch(() => ({ disabled: 'AUTOMATION_WORKER_LOAD_FAILED', reason: null }));
    if ('disabled' in parts) logger.error('automation.worker_disabled', { error_code: parts.disabled, reason: parts.reason ?? undefined });
    else { automations = parts; logger.info('automation.worker_enabled', { kinds: Object.keys(parts.handlers).join(','), telegram: parts.telegram }); }
  }
  // BUILD-AUTOMATION-002: the delegated executor, opt-in (FLOFI_DELEGATED_EXECUTION=enabled) and only with a signer provider — which a hosted
  // deployment cannot configure, so in standard production it stays disabled (logged) and nothing below changes.
  let delegation: { readonly handlers: Readonly<Record<string, WorkHandler>>; readonly sweep: () => Promise<unknown> } | null = null;
  if (process.env.FLOFI_DELEGATED_EXECUTION === 'enabled') {
    const parts = await import('./delegation-worker.ts').then(m => m.loadDelegationWorker(process.env, db, config.tenantId, logger))
      .catch(() => ({ disabled: 'DELEGATION_WORKER_LOAD_FAILED', reason: null }));
    if ('disabled' in parts) logger.error('delegation.worker_disabled', { error_code: parts.disabled, reason: parts.reason ?? undefined });
    else { delegation = parts; logger.info('delegation.worker_enabled', { kinds: Object.keys(parts.handlers).join(',') }); }
  }
  const handlers = { ...automations?.handlers, ...delegation?.handlers, ...backend.handlers };
  // BUILD-CLOUD-PARITY-001: a worker serves only its deployment's tenant, so a shared database never mixes deployments' runs.
  // BUILD-AUTOMATION-001: and it claims only the work kinds it has handlers for: another service's items are left to that service
  // instead of being dead-lettered here.
  const tenantQueue = createPostgresWorkQueue({ db, ownerId: config.workerId, tenantId: config.tenantId });
  const queue = { ...tenantQueue, claim: (limit: number) => tenantQueue.claim(limit, Object.keys(handlers)) };
  const worker = createWorker({ queue, handlers, logger, workerId: config.workerId, concurrency: config.workerConcurrency,
    sweep: async () => { try { await sweep(db, { tenantId: config.tenantId }); } finally { await automations?.sweep(); await delegation?.sweep().catch(() => undefined); } } });
  const shutdown = () => { logger.info('worker.stopping'); worker.stop().finally(() => db.close().finally(() => process.exit(0))); setTimeout(() => process.exit(1), 120_000).unref(); };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
  await worker.start();
}

main().catch(error => {
  // Only classified codes are logged: driver messages can embed connection details.
  const sqlState = (error as { code?: unknown; cause?: { code?: unknown } }).code ?? (error as { cause?: { code?: unknown } }).cause?.code;
  logger.error('backend.failed', { command, stage, error_code: error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(error.message) ? error.message : 'UNCLASSIFIED_ERROR',
    sql_state: typeof sqlState === 'string' && /^[0-9A-Z]{5}$/.test(sqlState) ? sqlState : undefined,
    system_error: typeof sqlState === 'string' && /^E[A-Z]{2,20}$/.test(sqlState) ? sqlState : undefined,
    node_error: typeof sqlState === 'string' && /^ERR_[A-Z0-9_]{1,60}$/.test(sqlState) ? sqlState : undefined,
    error_type: error instanceof Error && /^[A-Za-z]{1,40}Error$/.test(error.name) ? error.name : undefined });
  process.exit(1);
});
