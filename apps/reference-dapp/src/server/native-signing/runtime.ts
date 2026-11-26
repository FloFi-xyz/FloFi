// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-NATIVE-CHANNEL-SIGNING-001: the deployment's native signing service — its durable session journal (the platform's execution log,
 * namespace `native-signing`), the approval surface every FloFi requester shares, the flow runtime (the same `cloudFlow` the signing page uses,
 * with the execution pause honoured and the proven owner as principal), the requester's Flight identity, and each conversation's own delivery.
 * `FLOFI_NATIVE_SIGNING=disabled` turns the whole surface off (default: on wherever approvals and the cloud runtime are).
 */
import { randomUUID } from 'node:crypto';
import { createPostgresLeaseStore, createPostgresLogStore } from '@defi-workflow-engine/cloud-runtime';
import type { EngineRuntime } from '../../platform/index.ts';
import { betaAccessMode } from '../../flight/beta-access.ts';
import { mcpBetaIdentity } from '../../mcp/beta-access.ts';
import { approvalSurface } from '../approval-surface.ts';
import { publicOrigin } from '../deployment.ts';
import { guardFlowExecution } from '../execution-guard.ts';
import { cloudFlow } from '../flow-runtime.ts';
import { platformStateHost, type PlatformStateHost } from '../platform-state-host.ts';
import { walletSessionKey } from '../wallet-session.ts';
import { nativeMessage } from './messages.ts';
import { createNativeSigning, type NativeDeps, type NativeFlowPort } from './service.ts';
import { createNativeSessionStore, nativeSealer } from './session-store.ts';

type Env = Readonly<Record<string, string | undefined>>;
export const NATIVE_SIGNING_NAMESPACE = 'native-signing';
export const nativeSigningEnabled = (env: Env) => (env.FLOFI_NATIVE_SIGNING ?? 'enabled') !== 'disabled';

/** The flow runtime as the native service calls it: new execution methods respect `FLOFI_EXECUTION_PAUSED` exactly as the signing page's do. */
export function cloudNativeFlow(env: Env): NativeFlowPort {
  return async <T,>(flow: Parameters<NativeFlowPort>[0], method: string, args: readonly unknown[], context: Parameters<NativeFlowPort>[3]) => {
    try { guardFlowExecution(method, env); } catch (error) { return { ok: false as const, code: error instanceof Error ? error.message : 'EXECUTION_PAUSED' }; }
    const result = await cloudFlow<T>(flow, method, args, { env, principal: context.principal, betaIdentity: context.betaIdentity });
    return result ?? { ok: false as const, code: 'NATIVE_SIGNING_CLOUD_RUNTIME_REQUIRED' };
  };
}

/** The deployment's service; `overrides` are test seams (a host, an engine runtime, a flow port, a notifier, a clock). */
export async function nativeSigningService(env: Env = process.env, overrides: Partial<Pick<NativeDeps, 'flow' | 'notify' | 'now'>> & {
  readonly host?: PlatformStateHost; readonly runtime?: EngineRuntime;
  /** Tests: the channel providers' transport (a Bot API double). */
  readonly channelSeams?: { readonly telegramFetch?: typeof fetch } } = {}) {
  if (!nativeSigningEnabled(env)) throw new Error('NATIVE_SIGNING_NOT_ENABLED');
  const origin = publicOrigin(env) ?? (() => { throw new Error('NATIVE_SIGNING_ORIGIN_REQUIRED'); })();
  const host = overrides.host ?? await platformStateHost(env);
  const store = createNativeSessionStore(createPostgresLogStore({ db: host.db, tenantId: host.tenantId, namespace: NATIVE_SIGNING_NAMESPACE }));
  // One confirmation per approval at a time, across every instance (the platform's durable leases, the same namespace as the journal).
  const leases = createPostgresLeaseStore({ db: host.db, tenantId: host.tenantId, namespace: NATIVE_SIGNING_NAMESPACE, busyCode: 'NATIVE_SIGNING_BUSY',
    holderId: `native-${randomUUID()}` });
  return createNativeSigning({ env, origin, store, sealer: nativeSealer(walletSessionKey(env), host.tenantId), lock: (key, action) => leases.hold(key, action),
    surface: () => approvalSurface(env, () => undefined, { host, ...overrides.runtime ? { runtime: overrides.runtime } : {} }),
    flow: overrides.flow ?? cloudNativeFlow(env),
    notify: overrides.notify ?? (async (session, event, confirmRef) => {
      // An MCP host's panel reads the session status; a conversation gets each event as a message.
      if (session.requester.kind !== 'CHANNEL_CONVERSATION') return;
      const message = nativeMessage(origin, session, event, confirmRef);
      if (!message) return;
      const { deliverNativeNotice } = await import('../../channels/native-signing.ts');
      await deliverNativeNotice(env, { conversationId: session.requester.ref, handoffId: session.handoffId, ...message }, { host,
        ...overrides.runtime ? { runtime: overrides.runtime } : {}, ...overrides.channelSeams ? { seams: overrides.channelSeams } : {},
        ...overrides.now ? { now: overrides.now } : {} });
    }),
    // Beta: an MCP account carries the Flight identity it was bound to at sign-in; a conversation carries none (its proposals are signed in FloFi then).
    betaIdentity: async requester => betaAccessMode(env) === 'open' || requester.kind !== 'MCP_ACCOUNT' ? null
      : mcpBetaIdentity(host, requester.ref, Date.now(), env).catch(() => null),
    ...overrides.now ? { now: overrides.now } : {} });
}

/**
 * A conversation's "Sign with …" button: the channel-keyed token names its approval, its conversation and the wallet. Starting authorizes nothing;
 * the session still needs the wallet's proof, the requester's claim rule, the Review in the conversation and its confirmation there.
 */
export async function startFromChannelToken(env: Env, token: unknown, overrides: Parameters<typeof nativeSigningService>[1] = {}) {
  const { readChannelDeployment } = await import('../../channels/registry.ts');
  const { readNativeStartToken } = await import('../../channels/core/native-start.ts');
  const deployment = readChannelDeployment(env);
  if (!deployment.ok || !deployment.deployment.core.nativeSigning) throw new Error('NATIVE_SIGNING_NOT_ENABLED');
  const start = readNativeStartToken(deployment.deployment.core.keys, token, overrides.now?.() ?? new Date());
  if (!start) throw new Error('NATIVE_START_INVALID');
  const service = await nativeSigningService(env, overrides);
  return service.start({ handoffId: start.handoffId, requester: { kind: 'CHANNEL_CONVERSATION', ref: start.conversationId }, wallet: start.wallet,
    returnTo: 'TELEGRAM', language: deployment.deployment.core.language });
}
