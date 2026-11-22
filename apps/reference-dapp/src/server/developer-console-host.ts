// SPDX-License-Identifier: AGPL-3.0-only
import { accountHost, currentAccountSession } from '../accounts/account-host';
import { betaAccessMode } from '../flight/beta-access';
import { isOtherAccountOfBoardedPerson } from '../flight/other-account';
import { isHostedDeployment } from './deployment';
import { platformStateHost } from './platform-state-host';
import { createDeveloperConsoleStore, developerOwnershipInstalled } from '../developer/console-store';
import { readDeveloperConfig } from '../developer/config';

export const DEVELOPER_CONSOLE_PATH = '/developers/console';

export function developerConsoleConfigured(env: typeof process.env = process.env): boolean {
  return env.FLOFI_DEVELOPER_CONSOLE === 'enabled' && readDeveloperConfig(env).enabled;
}

export async function developerConsoleHost(env: typeof process.env = process.env) {
  const config = readDeveloperConfig(env);
  if (env.FLOFI_DEVELOPER_CONSOLE !== 'enabled' || !config.enabled) return { status: 'unavailable' } as const;
  const state = await platformStateHost(env);
  if (state.tenantId !== config.tenantId || !await developerOwnershipInstalled(state.db)) return { status: 'unavailable' } as const;
  const account = await accountHost(env), session = await currentAccountSession(account, env);
  if (!session) return { status: 'signed-out' } as const;
  if (account && betaAccessMode(env) === 'beta'
    && await isOtherAccountOfBoardedPerson(session.accountId, await account.store.identities(session.accountId), env)) return { status: 'other-account' } as const;
  const environment = !isHostedDeployment(env) && env.FLOFI_DEVELOPER_CONSOLE_TEST_KEYS === 'ALLOW_LOCAL_ONLY'
    && new URL(config.origin).protocol === 'http:' ? 'sandbox' as const : null;
  return { status: 'signed-in', ...state, session, config, environment,
    store: createDeveloperConsoleStore(state.db, state.tenantId, session.accountId) } as const;
}
