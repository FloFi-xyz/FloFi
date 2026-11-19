// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-FINOPS-AUTOMATED-SYNC-002: the billing loop on the Railway worker. Loaded by `main.ts worker` only when FLOFI_FINOPS_SYNC=enabled.
 * Plain Node resolves the app's extensionless imports only through the source-resolution hook, so it is installed here, independently of
 * whichever other worker subsystem is enabled. The loop runs on its own one-connection pool, outside the execution queue.
 */
import { createDatabase, type Logger } from '@defi-workflow-engine/cloud-runtime';
import { installSourceResolution } from './source-resolution.ts';

type Env = Readonly<Record<string, string | undefined>>;
export async function loadFinancialSync(env: Env, input: { databaseUrl: string; tenantId: string; logger: Logger }): Promise<{ stop(): Promise<void> } | null> {
  installSourceResolution();
  const [engine, { financialAdapters }] = await Promise.all([import('../src/admin/finops/sync-engine.ts'), import('../src/admin/finops/sync-providers.ts')]);
  if (!engine.financialSyncEnabled(env, input.tenantId)) {
    input.logger.warn('finops.worker_ineligible', { code: 'FINOPS_BILLING_TENANT_MISMATCH' });
    return null;
  }
  const hours = engine.financialSyncHours(env);
  const configured = financialAdapters.filter(adapter => adapter.configured(env)).map(adapter => adapter.id);
  const billingDb = createDatabase({ connectionString: input.databaseUrl, maxConnections: 1, applicationName: 'flofi-finops-sync' });
  try {
    const loop = engine.startFinancialSync({ host: { db: billingDb, tenantId: input.tenantId }, env, adapters: financialAdapters, logger: input.logger });
    // Provider ids only: never a credential or an endpoint.
    input.logger.info('finops.worker_enabled', { providers: configured.join(','), hours });
    return { stop: () => loop.stop().finally(() => billingDb.close()) };
  } catch (cause) {
    await billingDb.close().catch(() => undefined);
    throw cause;
  }
}
