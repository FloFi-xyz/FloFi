// SPDX-License-Identifier: AGPL-3.0-only
'use server';

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { freshlyAuthenticated } from '../accounts/account-session';
import { DEVELOPER_CONSOLE_PATH, developerConsoleHost } from '../server/developer-console-host';
import { fixedWindow } from '../platform/index';

type Result = { ok: false; code: string } | { ok: true; projectId: string; key?: string; keyId?: string };
const errors = new Set(['ACCOUNT_SESSION_REQUIRED', 'PROJECT_NOT_FOUND', 'PROJECT_NOT_ACTIVE', 'PROJECT_NAME_INVALID',
  'PROJECT_DESCRIPTION_INVALID', 'PROJECT_LIMIT', 'KEY_LIMIT', 'KEY_NOT_FOUND', 'SCOPES_INVALID', 'LIVE_MODE_DISABLED']);

export async function changeDeveloperProject(_previous: Result | null, data: FormData): Promise<Result> {
  try {
    const host = await developerConsoleHost();
    if (host.status !== 'signed-in') return { ok: false, code: host.status === 'signed-out' ? 'ACCOUNT_SESSION_REQUIRED' : 'CONSOLE_UNAVAILABLE' };
    if ((await headers()).get('origin') !== host.config.origin) return { ok: false, code: 'ORIGIN_FORBIDDEN' };
    const now = new Date();
    const read = (name: string) => {
      const value = data.get(name);
      return typeof value === 'string' ? value : '';
    };
    const op = read('operation');
    const touchesSecret = op === 'issue' || op === 'rotate';
    if (touchesSecret && !host.environment) return { ok: false, code: 'LIVE_MODE_DISABLED' };
    if (touchesSecret && !freshlyAuthenticated(host.session, now)) return { ok: false, code: 'ACCOUNT_REAUTHENTICATION_REQUIRED' };
    if (!await fixedWindow(host.db, host.tenantId).allow(`dev:console:${host.session.accountId}`, 30, 3_600, now))
      return { ok: false, code: 'CONSOLE_RATE_LIMITED' };
    let projectId = read('projectId');
    let issued: { key: string; keyId: string } | undefined;
    switch (op) {
      case 'create': projectId = await host.store.create(read('name').trim(), read('description').trim(), now); break;
      case 'edit': await host.store.edit(projectId, read('name').trim(), read('description').trim(), now); break;
      case 'disable':
        if (read('confirm') !== 'on') return { ok: false, code: 'INVALID_REQUEST' };
        await host.store.disable(projectId, now);
        break;
      case 'revoke': await host.store.revoke(projectId, read('keyId'), now); break;
      case 'issue':
      case 'rotate':
        if (!host.environment) return { ok: false, code: 'LIVE_MODE_DISABLED' };
        issued = await host.store.issue(projectId, host.environment, data.getAll('scope').map(String), host.config, now, op === 'rotate' ? (read('keyId') || 'invalid') : undefined);
        break;
      default: return { ok: false, code: 'INVALID_REQUEST' };
    }
    if (!issued) revalidatePath(DEVELOPER_CONSOLE_PATH);
    return { ok: true, projectId, ...issued };
  } catch (cause) {
    const code = cause instanceof Error ? cause.message : '';
    return { ok: false, code: errors.has(code) ? code : 'CONSOLE_REQUEST_FAILED' };
  }
}
