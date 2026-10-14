// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-ADMIN-001: the admin operator CLI runs on plain Node (no bundler) and refuses to run unconfigured: no command, no tenant or no
 * database URL is a fixed error code on stderr and exit code 1 — never a stack or a secret.
 */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const cwd = fileURLToPath(new URL('..', import.meta.url));
const cli = (args: string[], env: Record<string, string> = {}) => promisify(execFile)(process.execPath, ['backend/admin-cli.ts', ...args],
  { cwd, timeout: 60_000, env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test', ...env } })
  .then(r => ({ code: 0, stdout: r.stdout, stderr: r.stderr }), (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));

describe('BUILD-ADMIN-001 admin operator CLI', () => {
  it('loads under plain Node and refuses to run unconfigured', async () => {
    expect(await cli([])).toMatchObject({ code: 1, stdout: '', stderr: expect.stringMatching(/^COMMAND_INVALID: /) });
    expect(await cli(['grant', '--wallet', '0x' + '1'.repeat(40)])).toMatchObject({ code: 1, stderr: expect.stringMatching(/^TENANT_REQUIRED: /) });
    expect(await cli(['list', '--tenant', 'default', '--preview-branch', 'b'])).toMatchObject({ code: 1, stderr: expect.stringMatching(/^TENANT_REQUIRED: /) });
    expect(await cli(['list', '--tenant', 'Bad Tenant'])).toMatchObject({ code: 1, stderr: 'TENANT_ID_INVALID\n' });
    expect(await cli(['grant', '--tenant', 'default', '--admin', 'yes'])).toMatchObject({ code: 1, stderr: 'ARGUMENTS_INVALID\n' });
    expect(await cli(['list', '--tenant', 'default'])).toMatchObject({ code: 1, stderr: 'DATABASE_URL_REQUIRED\n' });
  });
});
