// SPDX-License-Identifier: AGPL-3.0-only
'use server';
/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (KAN-25 §8.1): the web Chat's initiation reference (`server/chat-initiation.ts`), issued to the FloFi
 * account signed in on this request, and only on the FloFi app page (the proxy's authoritative `x-flofi-pathname`; never an approval page).
 * It authorizes nothing: it only lets the server record that an execution the Chat starts started in the Chat. Without an account session, on
 * any other page or on any failure the answer is null and the Chat's executions are recorded as the Editor's (fail closed).
 */
import { headers } from 'next/headers';
import { accountHost, currentAccountSession } from '../accounts/account-host';
import { withFlightAccess } from '../server/flight-access';
import { chatInitiationKey, issueChatInitiation, type ChatInitiation } from '../server/chat-initiation';
import { platformStateHost } from '../server/platform-state-host';
import { pageOfPath } from '../workflow-runs/action-page';

export async function chatInitiationReference(): Promise<ChatInitiation | null> {
  try {
    return await withFlightAccess(async () => {
      if (pageOfPath((await headers()).get('x-flofi-pathname')) !== 'APP') return null;
      const env = process.env, session = await currentAccountSession(await accountHost(env).catch(() => null), env);
      if (!session) return null;
      const { tenantId } = await platformStateHost(env);
      return issueChatInitiation(chatInitiationKey(env), tenantId, session.accountId);
    });
  } catch { return null; }
}
