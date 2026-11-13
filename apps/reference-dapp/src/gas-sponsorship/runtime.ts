// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-MAINNET-EXEC-002: the network-fee sponsorship runtime of one process (web tier). It holds no key of any owner and signs nothing on
 * an EVM chain: it creates single-use grants for exactly reviewed calls, answers the wallet's ERC-7677 paymaster requests through FloFi's proxy
 * (the provider's key stays here), and records what the sponsor paid. Disabled or misconfigured (`config.ts`): null — every operation stays
 * user-funded, exactly as before.
 *
 * Durable state is the deployment's PostgreSQL execution storage (namespace `gas-sponsorship`): the budget ledger and the grants must be shared by
 * every serverless instance (a per-instance file would let each instance spend the whole daily budget). Never memory, a file or /tmp in production.
 */
import { randomUUID } from 'node:crypto';
import { createPostgresLeaseStore, createPostgresLogStore, type Database } from '@defi-workflow-engine/cloud-runtime';
import type { ExecutionStorage } from '@defi-workflow-engine/reference-executor';
import { paymasterProxyUrl, readGasSponsorshipConfig } from './config.ts';
import { callsHash, createGrantStore, createSponsorLedger } from './ledger.ts';
import { handlePaymasterRpc, paymasterTransport, type JsonRpcRequest, type JsonRpcResponse, type PaymasterTransport } from './paymaster-service.ts';

type Env = Readonly<Record<string, string | undefined>>;
export const GAS_SPONSORSHIP_NAMESPACE = 'gas-sponsorship';
/** What a prepared wallet batch carries when FloFi offers to sponsor its network fee (the browser hands `url` + `context` to the wallet). */
export type SponsorshipOffer = { readonly grantId: string | null; readonly chain: string; readonly paymaster: string; readonly url: string;
  readonly context: { readonly flofiGrant: string } | null };
/** The port the user-funded wallet-batch flow uses (`user-funded/groups.ts`). */
export type SponsorshipPort = {
  /** An offer for exactly these calls of this owner on this chain, or null when the chain is not sponsored. `preview`: no grant is created. */
  readonly offer: (input: { readonly chain: string; readonly owner: string; readonly calls: readonly { readonly target: string; readonly value: bigint; readonly data: string }[];
    /** The preparation's own fee ceiling per gas and simulated batch gas: a sponsored operation is never allowed more. */
    readonly maxFeePerGas: bigint; readonly gas: bigint; readonly ttlSeconds: number; readonly preview: boolean }) => Promise<SponsorshipOffer | null>;
  /**
   * The operation hashes a grant sponsored, or null when the grant is unknown. Read from the durable grant alone: a process without the
   * sponsorship configuration (a worker) still reconciles a batch sponsored elsewhere; the paymaster it must name is pinned in the artifact.
   */
  readonly operations: (grantId: string) => Promise<readonly string[] | null>;
  /** Records the fee the sponsor actually paid for one of them (from the chain), on the grant's own network ledger. */
  readonly settle: (grantId: string, userOpHash: string, actualGasCost: bigint) => Promise<void>;
};
/** The proxy's runtime. It never exposes its configuration (the provider URL carries the provider's key). */
export type GasSponsorshipRuntime = SponsorshipPort & {
  /** One ERC-7677 request to FloFi's paymaster proxy for `chainId`. */
  readonly paymaster: (chainId: number, request: JsonRpcRequest) => Promise<JsonRpcResponse>;
};

/** The deployment's PostgreSQL storage for sponsorship state. */
export function sponsorshipStorage(host: { readonly db: Database; readonly tenantId: string }): ExecutionStorage {
  return { log: createPostgresLogStore({ db: host.db, tenantId: host.tenantId, namespace: GAS_SPONSORSHIP_NAMESPACE }),
    leases: createPostgresLeaseStore({ db: host.db, tenantId: host.tenantId, namespace: GAS_SPONSORSHIP_NAMESPACE, busyCode: 'GAS_SPONSOR_BUSY', holderId: `web-${randomUUID()}` }) };
}

type StorageOf = ExecutionStorage | (() => ExecutionStorage);
type Options = { readonly transport?: PaymasterTransport; readonly now?: () => Date };
/** Durable state, opened on first use only (a deployment that never offers or reconciles a sponsorship never touches it). */
function lazyState(storageOf: StorageOf, now: () => Date) {
  let state: { grants: ReturnType<typeof createGrantStore>; ledger: ReturnType<typeof createSponsorLedger> } | null = null;
  return () => {
    if (!state) { const storage = typeof storageOf === 'function' ? storageOf() : storageOf; state = { grants: createGrantStore(storage, now), ledger: createSponsorLedger(storage, now) }; }
    return state;
  };
}
/** Settles one sponsored operation on the grant's own network ledger (no configuration needed: the grant names its network). */
async function settleOn(state: ReturnType<ReturnType<typeof lazyState>>, grantId: string, userOpHash: string, actualGasCost: bigint): Promise<void> {
  const found = await state.grants.read(grantId), use = found?.uses.find(u => u.userOpHash === userOpHash.toLowerCase());
  if (!found || !use) throw new Error('GAS_SPONSOR_OPERATION_UNKNOWN');
  await state.ledger.settle(found.grant.network, grantId, actualGasCost, use.userOpHash, new Date(found.grant.createdAt));
}

/**
 * The port for the user-funded flow: offers only where the operator configured the chain; reads and settles grants from durable state wherever
 * there is storage (null without it: nothing sponsored can be prepared or reconciled there).
 */
export function sponsorshipPort(env: Env, storageOf: StorageOf | null, options: Options = {}): SponsorshipPort | null {
  if (!storageOf) return null;
  const config = readGasSponsorshipConfig(env), now = options.now ?? (() => new Date()), state = lazyState(storageOf, now);
  return {
    async offer({ chain, owner, calls, maxFeePerGas, gas, ttlSeconds, preview }) {
      const sponsor = config.enabled ? config.evm[chain] ?? null : null, url = paymasterProxyUrl(config, chain);
      if (!sponsor || !url) return null;
      const { grants, ledger } = state();
      // The day's budget already spent: no offer (the batch stays user-funded); the proxy re-checks the exact cost when the wallet asks.
      if (await ledger.spentToday(chain) + sponsor.maxWeiPerOp > sponsor.dailyBudgetWei) return null;
      if (preview) return { grantId: null, chain, paymaster: sponsor.paymaster, url, context: null };
      const grant = await grants.create({ network: chain, owner, callsHash: callsHash(calls), maxFeePerGas, callGasLimit: gas, ttlSeconds });
      return { grantId: grant.id, chain, paymaster: sponsor.paymaster, url, context: { flofiGrant: grant.id } };
    },
    async operations(grantId) {
      const found = await state().grants.read(grantId);
      return found ? found.uses.map(u => u.userOpHash) : null;
    },
    settle: (grantId, userOpHash, actualGasCost) => settleOn(state(), grantId, userOpHash, actualGasCost),
  };
}

/** The paymaster proxy's runtime: only where sponsorship is configured for at least one EVM chain (null otherwise: nothing is sponsored). */
export function gasSponsorshipRuntime(env: Env, storageOf: StorageOf | null, options: Options = {}): GasSponsorshipRuntime | null {
  const config = readGasSponsorshipConfig(env);
  if (!config.enabled || !storageOf || !Object.keys(config.evm).length) return null;
  const now = options.now ?? (() => new Date()), state = lazyState(storageOf, now), port = sponsorshipPort(env, storageOf, options)!;
  const transport = options.transport ?? paymasterTransport();
  return {
    ...port,
    async paymaster(chainId, request) {
      const sponsor = config.evm[`eip155:${chainId}`] ?? null;
      if (!sponsor) return { jsonrpc: '2.0', id: request.id ?? null, error: { code: -32602, message: 'GAS_SPONSOR_CHAIN_UNEXPECTED' } };
      const { grants, ledger } = state();
      return handlePaymasterRpc({ sponsor, grants, ledger, transport, now }, request);
    },
  };
}
