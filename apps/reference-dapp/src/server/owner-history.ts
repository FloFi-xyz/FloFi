// SPDX-License-Identifier: AGPL-3.0-only
import type { HistoryDisposition, HistoryKind } from '@defi-workflow-engine/cloud-runtime';
import { cloudApiBaseUrl } from './cloud-api-client.ts';
import { embeddedRuntime, flowRuntimeKind } from './flow-runtime.ts';
import { currentWalletPrincipals } from './session-principal.ts';
import { workflowOwner, WORKFLOW_OWNER_HEADER } from '../domain/saved-workflow.ts';

/** Server session is the authority. Browser account is an expected-wallet guard, never an ownership claim. */
export async function ownerHistoryOperation(expectedAccount: string, method: 'change' | 'disposition', kind: HistoryKind, id: string, action?: 'DELETE' | 'ARCHIVE',
  seams: { principals?: typeof currentWalletPrincipals; transport?: typeof fetch; env?: Readonly<Record<string, string | undefined>> } = {}): Promise<HistoryDisposition> {
  try {
    const expected = workflowOwner(/^0x/i.test(expectedAccount) ? `eip155:${expectedAccount.toLowerCase()}` : `solana:${expectedAccount}`);
    const principals = await (seams.principals ?? currentWalletPrincipals)();
    const principal = expected && principals.find(p => p.namespace === expected.namespace && p.address === expected.address);
    if (!principal) return { ok: false, code: 'RUN_NOT_FOUND' };
    const env = seams.env ?? process.env, runtime = flowRuntimeKind(env), args = [kind, id, ...method === 'change' ? [action] : []];
    if (runtime === 'embedded') return await (await embeddedRuntime(env)).backend.callHistory(method, args, principal);
    if (runtime !== 'remote') return { ok: false, code: 'HISTORY_INVALID' };
    const base = cloudApiBaseUrl(env)!;
    const response = await (seams.transport ?? fetch)(new URL(`v1/owner-history/${method}`, base.href.endsWith('/') ? base : new URL(base.href + '/')), {
      method: 'POST', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { 'content-type': 'application/json', ...env.API_AUTH_TOKEN ? { authorization: `Bearer ${env.API_AUTH_TOKEN}` } : {},
        [WORKFLOW_OWNER_HEADER]: `${principal.namespace}:${principal.address}` }, body: JSON.stringify({ args }) });
    const result: unknown = await response.json();
    if (!response.ok || !result || typeof result !== 'object') return { ok: false, code: 'HISTORY_INVALID' };
    const value = result as Record<string, unknown>;
    if (value.ok === true && ['DELETED','ARCHIVED','VISIBLE'].includes(value.disposition as string) &&
      (method === 'disposition' || value.disposition === (action === 'DELETE' ? 'DELETED' : 'ARCHIVED')))
      return result as HistoryDisposition;
    if (value.ok === false && ['RUN_NOT_FOUND','RUN_DELETE_REFUSED','HISTORY_INVALID','HISTORY_READ_ONLY'].includes(value.code as string)) return result as HistoryDisposition;
    return { ok: false, code: 'HISTORY_INVALID' };
  } catch { return { ok: false, code: 'HISTORY_INVALID' }; }
}
