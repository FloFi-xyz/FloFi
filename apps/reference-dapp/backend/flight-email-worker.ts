// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-FLIGHT-LAUNCH-001: Flight FloFi email delivery on the Railway worker. Loaded by `main.ts worker` only when the worker sets
 * FLOFI_FLIGHT_EMAIL=enabled. It runs its own short cycle (every 15 seconds, so Email 1 goes out right after a join) beside the worker's
 * queue, and stops with the worker. Without its settings it logs `flight.email.worker_disabled` with a fixed code and sends nothing; the
 * rest of the worker is unaffected either way.
 */
import type { Database, Logger } from '@defi-workflow-engine/cloud-runtime';
import { installSourceResolution } from './source-resolution.ts';

type Env = Readonly<Record<string, string | undefined>>;
export const FLIGHT_EMAIL_EVERY_MS = 15_000;

export async function loadFlightEmailWorker(env: Env, db: Database, tenantId: string, logger: Logger):
  Promise<{ readonly start: () => void; readonly stop: () => Promise<void> } | { readonly disabled: string }> {
  installSourceResolution();
  const { flightEmailRuntime } = await import('../src/flight/email/runtime.ts');
  const runtime = flightEmailRuntime(env, db, tenantId, logger);
  if ('disabled' in runtime) return runtime;
  let timer: NodeJS.Timeout | null = null, running: Promise<unknown> | null = null, stopped = false;
  const tick = () => {
    if (stopped || running) return;
    running = runtime.delivery.cycle()
      .catch(error => logger.warn('flight.email.cycle_failed', { error_code: error instanceof Error && /^[A-Z0-9_:]{3,80}$/.test(error.message) ? error.message : 'CYCLE_FAILED' }))
      .finally(() => { running = null; });
  };
  return {
    start() { if (!timer) { tick(); timer = setInterval(tick, FLIGHT_EMAIL_EVERY_MS); timer.unref(); } },
    async stop() { stopped = true; if (timer) clearInterval(timer); await running; },
  };
}
