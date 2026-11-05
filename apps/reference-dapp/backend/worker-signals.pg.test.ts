// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The worker can be stopped cleanly from the moment it reports `worker.starting`. Its SIGTERM/SIGINT handlers are registered before that
 * line: a probe preloaded into the real `backend/main.ts worker` process counts them at the very write of the line, which makes this a
 * deterministic check of what used to be a timing race (a SIGTERM sent on that line could land before the handler and kill the process,
 * exit code null — seen on a loaded CI runner in BUILD-DB-COMPAT-001 test 12). Then a SIGTERM sent on the line exits 0.
 * Disposable loopback PostgreSQL only; the probe only observes (it changes nothing the worker does).
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createTestDatabase } from '../../../packages/cloud-runtime/test/pg-harness.ts';

const APP = fileURLToPath(new URL('..', import.meta.url));
/** Writes one `probe.signal_listeners` record, with the process's SIGTERM and SIGINT listener counts, as `worker.starting` is written. */
const PROBE = `data:text/javascript,${encodeURIComponent(`
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  if (String(chunk).includes('"event":"worker.starting"'))
    write(JSON.stringify({ event: 'probe.signal_listeners', sigterm: process.listenerCount('SIGTERM'), sigint: process.listenerCount('SIGINT') }) + '\\n');
  return write(chunk, ...rest);
};`)}`;

describe('the worker stops cleanly from the moment it reports starting (PostgreSQL)', () => {
  it('has its SIGTERM/SIGINT handlers in place when it logs worker.starting, and a SIGTERM sent on that line exits 0', async () => {
    const t = await createTestDatabase(), evidence = await mkdtemp(join(tmpdir(), 'flofi-worker-signals-'));
    try {
      const proc = spawn(process.execPath, ['--import', PROBE, 'backend/main.ts', 'worker'], {
        cwd: APP, stdio: ['ignore', 'pipe', 'ignore'],
        env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test', DATABASE_URL: t.url, EVIDENCE_DIRECTORY: evidence } });
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => proc.once('exit', (code, signal) => resolve({ code, signal })));
      const records: Record<string, unknown>[] = [];
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WORKER_START_TIMEOUT')), 60_000);
        let buffer = '';
        proc.stdout.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
            const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
            if (!line.startsWith('{')) continue;
            const record = JSON.parse(line) as Record<string, unknown>;
            records.push(record);
            // As test 12 does: stop the worker the moment it reports starting.
            if (record.event === 'worker.starting') { clearTimeout(timer); proc.kill('SIGTERM'); resolve(); }
          }
        });
        void exited.then(({ code }) => { clearTimeout(timer); reject(new Error(`WORKER_EXITED_${code}`)); });
      });
      expect(records.find(r => r.event === 'probe.signal_listeners')).toEqual({ event: 'probe.signal_listeners', sigterm: 1, sigint: 1 });
      expect(await exited).toEqual({ code: 0, signal: null });
    } finally { await t.drop(); await rm(evidence, { recursive: true, force: true }); }
  }, 90_000);
});
