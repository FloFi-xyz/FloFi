// SPDX-License-Identifier: AGPL-3.0-only
/**
 * HOTFIX WORKFLOW_RUN_WORKER_LOAD_FAILED: the cause of an opt-in subsystem's load failure is logged as closed fields only — a fixed code, Node's
 * error code, the error class and the repository file it points at — and never the exception text, which can carry connection strings or tokens.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadFailureFields } from './load-failure.ts';

const SECRET = 'postgres://flofi_runtime:s3cr3t-Pa55@db.internal.example:5432/flofi?sslmode=require';
let root = '', moduleFile = '';
beforeAll(async () => {
  // Node reports real paths (macOS /var is /private/var).
  root = await realpath(await mkdtemp(join(tmpdir(), 'flofi-load-failure-'))) + sep;
  await mkdir(join(root, 'apps', 'demo', 'src'), { recursive: true });
  await mkdir(join(root, 'apps', 'demo', 'node_modules'), { recursive: true });
  await writeFile(join(root, 'apps', 'demo', 'node_modules', 'p.js'), 'export {};\n');
  moduleFile = join(root, 'apps', 'demo', 'src', 'broken.ts');
  await writeFile(moduleFile, 'export class Refusal extends Error { constructor(readonly rpcCode: number) { super(); } }\n');
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
const withStack = (error: Error, stack: string) => Object.assign(error, { stack });

describe('HOTFIX loadFailureFields', () => {
  it('names a real type-stripping refusal on plain Node: code, class and the repository file, nothing else', async () => {
    const helper = pathToFileURL(fileURLToPath(new URL('./load-failure.ts', import.meta.url))).href;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
      const { loadFailureFields } = await import(${JSON.stringify(helper)});
      try { await import(${JSON.stringify(pathToFileURL(moduleFile).href)}); console.log('LOADED'); }
      catch (error) { console.log(JSON.stringify(loadFailureFields(error, ${JSON.stringify(root)}))); }`], { timeout: 30_000, env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test' } });
    expect(JSON.parse(stdout.trim())).toEqual({ cause_code: 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX', node_error: 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX',
      error_type: 'SyntaxError', module: 'apps/demo/src/broken.ts' });
  });

  it('keeps a thrown closed code and never the text of any other message', () => {
    expect(loadFailureFields(new Error('USER_FUNDED_SOLANA_RPC_INVALID'), root)).toEqual({ cause_code: 'USER_FUNDED_SOLANA_RPC_INVALID' });
    const leaked = loadFailureFields(new TypeError(`connect failed for ${SECRET}`), root);
    expect(leaked).toEqual({ cause_code: 'UNCLASSIFIED_ERROR', error_type: 'TypeError' });
    expect(JSON.stringify(leaked)).not.toMatch(/s3cr3t|flofi_runtime|db\.internal/);
    expect(loadFailureFields('a string', root)).toEqual({ cause_code: 'UNCLASSIFIED_ERROR' });
    expect(loadFailureFields(null, root)).toEqual({ cause_code: 'UNCLASSIFIED_ERROR' });
  });

  it('never logs a non-string message, code or name, and never throws whatever was thrown', () => {
    const leaky = { toString: () => 'DB_DOWN', url: SECRET };
    const odd = Object.assign(new Error('x'), { message: leaky, name: leaky, code: leaky });
    expect(loadFailureFields(odd, root)).toEqual({ cause_code: 'UNCLASSIFIED_ERROR' });
    expect(JSON.stringify(loadFailureFields(odd, root))).not.toContain('s3cr3t');
    const stackless = new Error('X_FAILED');
    Object.defineProperty(stackless, 'stack', { value: 42 });
    expect(loadFailureFields(stackless, root)).toEqual({ cause_code: 'X_FAILED' });
    const hostile = new Error('x');
    for (const key of ['message', 'stack', 'code', 'url', 'name', 'cause']) Object.defineProperty(hostile, key, { get() { throw new Error(SECRET); } });
    expect(loadFailureFields(hostile, root)).toEqual({ cause_code: 'UNCLASSIFIED_ERROR' });
    const proxy = new Proxy(new Error('x'), { get() { throw new Error(SECRET); }, getPrototypeOf() { throw new Error(SECRET); } });
    expect(loadFailureFields(proxy, root)).toEqual({ cause_code: 'UNCLASSIFIED_ERROR' });
  });

  it('names a database or system cause by its SQLSTATE or system code', () => {
    expect(loadFailureFields(Object.assign(new Error(`password authentication failed for ${SECRET}`), { code: '28P01' }), root))
      .toEqual({ cause_code: 'UNCLASSIFIED_ERROR', sql_state: '28P01' });
    expect(loadFailureFields(Object.assign(new Error(`connect ECONNREFUSED ${SECRET}`), { code: 'ECONNREFUSED' }), root))
      .toEqual({ cause_code: 'ECONNREFUSED', system_error: 'ECONNREFUSED' });
    expect(loadFailureFields(Object.assign(new Error('wrapped'), { cause: { code: '57P01' } }), root)).toEqual({ cause_code: 'UNCLASSIFIED_ERROR', sql_state: '57P01' });
  });

  it('takes Node error codes only in their closed form', () => {
    const missing = Object.assign(new Error(`Cannot find package 'x' imported from ${SECRET}`), { code: 'ERR_MODULE_NOT_FOUND' });
    expect(loadFailureFields(missing, root)).toEqual({ cause_code: 'ERR_MODULE_NOT_FOUND', node_error: 'ERR_MODULE_NOT_FOUND' });
    expect(loadFailureFields(Object.assign(new Error('x'), { code: 'not a code; ' + SECRET }), root)).toEqual({ cause_code: 'UNCLASSIFIED_ERROR' });
    expect(loadFailureFields(Object.assign(new Error('x'), { name: 'Evil name ' + SECRET }), root)).toEqual({ cause_code: 'UNCLASSIFIED_ERROR' });
  });

  it('reports a module only from a location V8 printed, for an existing file of the repository', () => {
    const href = pathToFileURL(moduleFile).href;
    // A stack frame, and the header line of a syntax error.
    expect(loadFailureFields(withStack(new Error('X_FAILED'), `Error: X_FAILED\n    at load (${href}:3:9)\n    at node:internal/x:1:1`), root).module)
      .toBe('apps/demo/src/broken.ts');
    expect(loadFailureFields(withStack(new SyntaxError('x'), `${href}:1\nexport class …\n\nSyntaxError: x`), root).module).toBe('apps/demo/src/broken.ts');
    // Never from the message text (even a multi-line one shaped like V8's own lines), a file outside the repository, a missing file or node_modules.
    const injected = `x\n${moduleFile}:1\n    at y (${href}:3:9)`;
    expect(loadFailureFields(withStack(new Error(injected), `Error: ${injected}\n    at node:internal/x:1:1`), root)).toEqual({ cause_code: 'UNCLASSIFIED_ERROR' });
    for (const stack of [`Error: ${href}:1`, `Error: x\n    at y (file:///etc/passwd.js:1:1)`, `Error: x\n    at y (${pathToFileURL(join(root, 'apps', 'demo', 'src', 'nope.ts')).href}:1:1)`,
      `Error: x\n    at y (${pathToFileURL(join(root, 'apps', 'demo', 'node_modules', 'p.js')).href}:1:1)`, `Error: x\n    at y (file:///tmp/${encodeURIComponent(SECRET)}.ts:1:1)`])
      expect([stack, loadFailureFields(withStack(new Error('x'), stack), root).module]).toEqual([stack, undefined]);
  });
});
