// SPDX-License-Identifier: AGPL-3.0-only
/**
 * HOTFIX WORKFLOW_RUN_WORKER_LOAD_FAILED: every module the Railway backend can load on plain Node is loadable by plain Node.
 *
 * `backend/main.ts` (API and worker) and `backend/admin-cli.ts` run under Node's own type stripping, which refuses TypeScript that needs a
 * transform (parameter properties, enums, namespaces…) with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX. Vitest, Next.js and `tsc` all accept that
 * syntax, so nothing caught it when PR #190 added a parameter property to `src/gas-sponsorship/paymaster-service.ts`: the module sits in the
 * workflow-run worker's closure, and from that deploy on the production worker logged `WORKFLOW_RUN_WORKER_LOAD_FAILED` and never advanced a
 * multi-step workflow run. Loading a module is not enough to guard this (opt-in subsystems are dynamic imports, some deep inside handlers), so
 * this walks the whole relative import graph — static, re-export and dynamic `import()` — from both entry points, resolving specifiers exactly as
 * plain Node plus `source-resolution.ts` do, and asks Node's own stripper about every module. Then plain Node really loads the workflow-run worker.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { SOURCE_ROOT } from './source-resolution.ts';

const APP = fileURLToPath(new URL('..', import.meta.url));
const ENTRY_POINTS = ['backend/main.ts', 'backend/admin-cli.ts'];
// Import/export declarations (including `export * from`) and dynamic imports with a literal specifier. Type-only declarations are erased.
const SPECIFIERS = /^\s*(import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm;

/** Resolves a relative specifier as plain Node would, plus the one bundler rule `source-resolution.ts` installs (extensionless, inside src/). */
function resolveRelative(specifier: string, from: string): string | null {
  const exact = resolve(dirname(from), specifier);
  if (existsSync(exact) && statSync(exact).isFile()) return exact;
  if (from.startsWith(SOURCE_ROOT) && !/\.[cm]?[jt]sx?$/.test(specifier) && existsSync(`${exact}.ts`) && `${exact}.ts`.startsWith(SOURCE_ROOT)) return `${exact}.ts`;
  return null;
}

function plainNodeGraph() {
  const modules = new Map<string, string | null>(), unresolved: string[] = [];
  const queue = ENTRY_POINTS.map(p => resolve(APP, p));
  while (queue.length) {
    const file = queue.pop()!;
    if (modules.has(file)) continue;
    const text = readFileSync(file, 'utf8');
    let refusal: string | null = null;
    try { stripTypeScriptTypes(text); } catch (error) { refusal = `${(error as { code?: string }).code}: ${(error as Error).message.split('\n')[0]}`; }
    modules.set(file, refusal);
    for (const match of text.matchAll(SPECIFIERS)) {
      if (match[2]) continue;
      const specifier = match[3] ?? match[4]!;
      if (!specifier.startsWith('.')) continue;
      const target = resolveRelative(specifier, file);
      if (!target) { unresolved.push(`${relative(APP, file)} -> ${specifier}`); continue; }
      if (/\.[cm]?ts$/.test(target)) queue.push(target);
      else if (/\.tsx$/.test(target)) unresolved.push(`${relative(APP, file)} -> ${specifier} (TSX cannot load on plain Node)`);
    }
  }
  return { modules, unresolved };
}

const run = (code: string) => promisify(execFile)(process.execPath, ['--input-type=module', '-e', code],
  { cwd: APP, timeout: 60_000, env: { PATH: process.env.PATH ?? '', NODE_ENV: 'production' } })
  .then(({ stdout }) => ({ code: 0, stdout }), (error: { code: number; stdout: string; stderr: string }) => ({ code: error.code, stdout: error.stdout + error.stderr }));

describe('HOTFIX the backend closure loads on plain Node (Railway API, worker and operator CLI)', () => {
  it('every module reachable from backend/main.ts and backend/admin-cli.ts resolves and is accepted by Node type stripping', () => {
    const { modules, unresolved } = plainNodeGraph();
    const local = (file: string) => relative(APP, file).split(sep).join('/');
    // The walk reaches the opt-in subsystems' dynamic imports, including the module that disabled the workflow-run worker.
    for (const reached of ['backend/workflow-run-worker.ts', 'src/workflow-runs/worker.ts', 'src/gas-sponsorship/paymaster-service.ts',
      'backend/automation-worker.ts', 'backend/delegation-worker.ts', 'backend/flight-email-worker.ts', 'backend/load-failure.ts',
      'backend/finops-worker.ts', 'src/admin/finops/sync-engine.ts', 'src/admin/finops/sync-providers.ts'])
      expect([...modules.keys()].map(local)).toContain(reached);
    expect(modules.size).toBeGreaterThan(200);
    expect([...modules].filter(([, refusal]) => refusal).map(([file, refusal]) => `${local(file)}: ${refusal}`)).toEqual([]);
    expect(unresolved).toEqual([]);
  });

  it('Node refuses a parameter property in strip-only mode (what the guard detects)', () => {
    expect(() => stripTypeScriptTypes('class Refusal extends Error { constructor(readonly rpcCode: number) { super(); } }'))
      .toThrow(expect.objectContaining({ code: 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX' }));
    expect(() => stripTypeScriptTypes('class Refusal extends Error { readonly rpcCode: number; constructor(rpcCode: number) { super(); this.rpcCode = rpcCode; } }'))
      .not.toThrow();
  });

  it('plain Node loads the workflow-run worker as main.ts does and gets its advance handler and sweep', async () => {
    const result = await run(`
      const { loadWorkflowRunWorker } = await import('./backend/workflow-run-worker.ts');
      const logger = { info() {}, warn() {}, error() {} };
      const parts = await loadWorkflowRunWorker({ FLOFI_WORKFLOW_RUNS: 'enabled' }, {}, 'default', logger, {});
      const off = await loadWorkflowRunWorker({}, {}, 'default', logger, {});
      console.log(JSON.stringify({ kinds: Object.keys(parts.handlers ?? {}), sweep: typeof parts.sweep, capabilities: parts.capabilities, off }));`);
    expect(result).toEqual({ code: 0, stdout: expect.any(String) });
    expect(JSON.parse(result.stdout.trim())).toEqual({ kinds: ['workflow-run.advance'], sweep: 'function',
      capabilities: { userFunded: 'USER_FUNDED_NOT_ENABLED', delegation: false }, off: { disabled: 'WORKFLOW_RUNS_NOT_ENABLED', reason: null } });
  });

  it('plain Node loads the FinOps billing loop on its own, as main.ts does, without another subsystem installing source resolution', async () => {
    const result = await run(`
      const { loadFinancialSync } = await import('./backend/finops-worker.ts');
      const events = [];
      const logger = { info(event, fields) { events.push([event, fields]); }, warn(event, fields) { events.push([event, fields]); }, error() {} };
      const input = { databaseUrl: 'postgres://nobody@127.0.0.1:1/none', tenantId: 'default', logger };
      const ineligible = await loadFinancialSync({ FLOFI_FINOPS_SYNC: 'enabled', FLOFI_FINOPS_BILLING_TENANT: 'other' }, input);
      const loop = await loadFinancialSync({ FLOFI_FINOPS_SYNC: 'enabled', FLOFI_FINOPS_BILLING_TENANT: 'default', FLOFI_FINOPS_CIRCLECI_BILLING_TOKEN: 'inert' }, input);
      await loop.stop();
      console.log(JSON.stringify({ ineligible, events }));`);
    expect(result).toEqual({ code: 0, stdout: expect.any(String) });
    expect(JSON.parse(result.stdout.trim())).toEqual({ ineligible: null, events: [['finops.worker_ineligible', { code: 'FINOPS_BILLING_TENANT_MISMATCH' }],
      ['finops.worker_enabled', { providers: 'circleci', hours: 24 }]] });
  });

  it('plain Node loads the paymaster proxy module itself (its JSON-RPC refusal codes are covered by gas-sponsorship.test.ts)', async () => {
    const result = await run(`
      const { installSourceResolution } = await import('./backend/source-resolution.ts');
      installSourceResolution();
      const { handlePaymasterRpc } = await import('./src/gas-sponsorship/paymaster-service.ts');
      console.log(typeof handlePaymasterRpc);`);
    expect(result).toEqual({ code: 0, stdout: 'function\n' });
  });
});
