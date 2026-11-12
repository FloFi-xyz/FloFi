// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-AUTOMATION-002: wiring of delegated execution shared by owner operations and the executor — the store on the deployment's PostgreSQL
 * host (shared with automations), chain transports by purpose and the signer provider. The executor's own wiring (signing capability, work
 * handler, sweep) is `executor-runtime.ts`, which owner operations never import.
 *
 * Signer capabilities are split by role: owner operations receive only `SignerAdmin` (create a session key for a new grant, read its address,
 * destroy it on revocation) and can never sign; only the executor receives `SignerUser`. In production the provider is AWS KMS
 * (BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001), where the same split is also enforced by IAM: the API's credentials allow only
 * kms:GetPublicKey and the worker's kms:Sign on the one key ARN. `none` remains the default.
 */
import { betaAccessMode, createBetaAccessStore } from '../flight/beta-access.ts';
import { flightCalendarFrom } from '../flight/campaign.ts';
import type { Owner } from './pg-store.ts';
import type { Database } from '@defi-workflow-engine/cloud-runtime';
import { awsCredentialsFromEnv, awsKmsSignerProvider, localDisposableSignerProvider, memorySignerProvider, type AwsCredentials,
  type DelegatedSignerProvider } from '@defi-workflow-engine/reference-executor';
import { DELEGATION_EXECUTE_KIND } from '../automations/pg-store.ts';
import { DELEGATION_EXECUTE_RUN_KIND } from './run-source.ts';
import { guarded, httpRpc, type ChainTransport, type TransportPurpose } from './chains.ts';
import type { DelegationConfig } from './config.ts';
import { createPgDelegationStore, type DelegationStore } from './pg-store.ts';

type Env = Readonly<Record<string, string | undefined>>;
type Rpc = (method: string, params: readonly unknown[]) => Promise<unknown>;
export type SignerAdmin = Pick<DelegatedSignerProvider, 'id' | 'create' | 'address' | 'destroy'>;
export type SignerUser = Pick<DelegatedSignerProvider, 'signEvmDigest' | 'signSolanaMessage'>;
export type DelegationHost = { readonly db: Database; readonly tenantId: string };
export type DelegationSeams = { readonly rpc?: (chain: string) => Rpc | null; readonly fetch?: typeof fetch; readonly signer?: DelegatedSignerProvider; readonly now?: () => Date;
  /** The AWS credentials of the KMS provider (default: the standard AWS variables of this process, read per request). */
  readonly awsCredentials?: () => AwsCredentials };
export const DELEGATION_WORK_KINDS = Object.freeze([DELEGATION_EXECUTE_KIND, DELEGATION_EXECUTE_RUN_KIND] as const);

let memory: DelegatedSignerProvider | null = null;
const kms = new Map<string, DelegatedSignerProvider>();
/** This process's signer provider, or null (`none`). The memory provider is one per process (loopback tests on a single server). */
export function signerProvider(config: DelegationConfig, seams: DelegationSeams = {}): DelegatedSignerProvider | null {
  if (seams.signer) return seams.signer;
  if (config.signer.kind === 'memory') return memory ??= memorySignerProvider();
  if (config.signer.kind === 'local-disposable') return localDisposableSignerProvider(config.signer.directory);
  if (config.signer.kind === 'aws-kms') {
    const { region, evmKeyArn } = config.signer, credentials = seams.awsCredentials ?? (() => awsCredentialsFromEnv(process.env));
    if (seams.awsCredentials || seams.fetch) return awsKmsSignerProvider({ region, evmKeyArn, credentials, ...(seams.fetch ? { fetch: seams.fetch } : {}), audit: kmsAudit });
    let provider = kms.get(evmKeyArn);
    if (!provider) kms.set(evmKeyArn, provider = awsKmsSignerProvider({ region, evmKeyArn, credentials, audit: kmsAudit }));
    return provider;
  }
  return null;
}
/** One structured line per KMS signature (digest, executor address, key ARN; never a credential), alongside CloudTrail's own record. */
const kmsAudit = (event: object) => { console.info(JSON.stringify(event)); };
export const signerAdmin = (provider: DelegatedSignerProvider): SignerAdmin => ({ id: provider.id, create: provider.create, address: provider.address, destroy: provider.destroy });
export const signerUser = (provider: DelegatedSignerProvider): SignerUser => ({ signEvmDigest: provider.signEvmDigest, signSolanaMessage: provider.signSolanaMessage });

/** The guarded transport of `chain` for `purpose`, or null when the chain is not enabled on this deployment. */
export function transportFor(config: DelegationConfig, chain: string, purpose: TransportPurpose, seams: DelegationSeams = {}): ChainTransport | null {
  const injected = seams.rpc?.(chain);
  if (injected) return guarded(chain, purpose, config.mode === 'MOCKED_HARNESS' ? 'MOCKED' : 'PUBLIC', injected);
  if (config.mode === 'MOCKED_HARNESS') return guarded(chain, purpose, 'MOCKED', httpRpc(`${config.harnessUrl}/rpc/${encodeURIComponent(chain)}`, seams.fetch));
  const url = config.rpc[chain];
  return url ? guarded(chain, purpose, 'PUBLIC', httpRpc(url, seams.fetch)) : null;
}

export type DelegationRuntime = { readonly config: DelegationConfig; readonly host: DelegationHost; readonly store: DelegationStore; readonly now: () => Date;
  readonly seams: DelegationSeams; readonly authorizeBeta: (owner: Owner) => Promise<string | null> };
export function delegationRuntime(config: DelegationConfig, host: DelegationHost, seams: DelegationSeams = {}, env: Env = process.env): DelegationRuntime {
  return { config, host, store: createPgDelegationStore(host.db, host.tenantId), now: seams.now ?? (() => new Date()), seams, authorizeBeta: async owner => {
    const mode = betaAccessMode(env);
    if (mode === 'open') return null;
    if (mode !== 'beta') return 'BETA_ACCESS_CLOSED';
    const { calendar } = flightCalendarFrom(env);
    if (!calendar) return 'BETA_CONFIGURATION_INVALID';
    const result = await createBetaAccessStore(host, calendar, env).requireWallet(owner, (seams.now?.() ?? new Date()).getTime());
    return result.ok ? null : result.code;
  } };
}
