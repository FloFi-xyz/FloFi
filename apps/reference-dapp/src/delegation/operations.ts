// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-AUTOMATION-002: the owner's delegated-execution operations as ONE closed contract, executed where the deployment's runtime runs — the
 * Automations pattern: in process on the embedded runtime (`server/delegation-operation.ts`), or on the Railway API (`POST /v1/delegation/:method`)
 * with the verified owner in `x-flofi-workflow-owner` and the wallets the request proved in `x-flofi-wallet-principals`.
 *
 * The owner is always the verified session principal handed in by the caller, never an argument; `proven` are the other wallets THIS request
 * proved (a Credential can only be enrolled for one of them). Owner operations hold `SignerAdmin` only: none of them can sign a transaction.
 */
import type { AutomationConfig } from '../automations/config.ts';
import { createPgAutomationStore } from '../automations/pg-store.ts';
import type { AutomationHost } from '../automations/runtime.ts';
import type { Owner } from '../automations/store.ts';
import { typedId } from '../platform/ids.ts';
import { EXECUTOR_FUNDED_GAS_RETIRED, type DelegationConfig } from './config.ts';
import { delegationRuntime, signerAdmin, signerProvider, transportFor, type DelegationSeams } from './runtime.ts';
import { createDelegationService, type DelegationService } from './service.ts';
import { DELEGATION_EXECUTE_RUN_KIND } from './run-source.ts';
import type { WorkflowRunStore } from '../workflow-runs/pg-store.ts';
import { DELEGATED_AUTHORIZATION_SECONDS } from '../workflow-runs/state-machine.ts';

export const DELEGATION_OPERATIONS = Object.freeze(['workflowRunWalletReview', 'workflowRunWalletSign', 'workflowRunWalletRevoke', 'overview', 'passkeyOptions', 'passkeyRegister', 'passkeyRevoke', 'credentialPrepare', 'credentialComplete',
  'credentialRevoke', 'credentialRevocationComplete', 'credentialReverify', 'automationPreview', 'automationCreate', 'authorizationReview', 'authorizationSign',
  'authorizationRevoke', 'authorizationReauthorize', 'executionDetail', 'executionResume'] as const);
export type DelegationOperation = (typeof DELEGATION_OPERATIONS)[number];
export const isDelegationOperation = (value: unknown): value is DelegationOperation => typeof value === 'string' && (DELEGATION_OPERATIONS as readonly string[]).includes(value);
/** Registering a passkey binds an authorization key to the owner: it needs a wallet sign-in that is at most this old (checked by the BFF). */
export const FRESH_SESSION_OPERATIONS: ReadonlySet<DelegationOperation> = new Set(['passkeyOptions', 'passkeyRegister']);
export const FRESH_SESSION_MS = 15 * 60_000;
export const IDEMPOTENT_DELEGATION_OPERATIONS: ReadonlySet<DelegationOperation> = new Set(['automationCreate']);

export function ownerDelegationService(config: DelegationConfig, automationConfig: AutomationConfig, host: AutomationHost,
  log: (event: string, fields: Readonly<Record<string, string | number | boolean | null>>) => void, now: () => Date, seams: DelegationSeams = {}): DelegationService {
  if (automationConfig.tenantId !== config.tenantId) throw new Error('DELEGATION_TENANT_MISMATCH');
  const rt = delegationRuntime(config, host, { ...seams, now });
  const provider = signerProvider(config, seams);
  return createDelegationService({ config, db: host.db, store: rt.store, automations: createPgAutomationStore(host.db, host.tenantId),
    signer: provider ? signerAdmin(provider) : null, transport: (chain, purpose) => transportFor(config, chain, purpose, seams), now, newId: typedId, log });
}

const invalid = (): never => { throw new Error('DELEGATION_INPUT_INVALID'); };
const id = (value: unknown, prefix: string) => typeof value === 'string' && new RegExp(`^${prefix}_[a-z2-7]{26}$`).test(value) ? value : invalid();
/**
 * BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001: a run the owner may authorize here — this owner's own run, its EVM wallet one THIS request
 * proved, still choosing its mode (review/sign) — loaded from the run store, never from the caller's arguments.
 */
async function ownedRun(runs: WorkflowRunStore | undefined, owner: Owner, proven: readonly Owner[], runId: string, pending: boolean) {
  const run = runs ? await runs.byId(runId) : invalid();
  if (!run || run.owner.namespace !== owner.namespace || run.owner.address !== owner.address) throw new Error('WORKFLOW_RUN_NOT_FOUND');
  const wallet = run.wallets.eip155;
  if (!wallet || !proven.some(p => p.namespace === 'eip155' && p.address === wallet)) throw new Error('WALLET_SESSION_REQUIRED');
  if (pending) assertChoosing(run);
  return { ...run, wallet };
}
const assertChoosing = (run: { readonly state: string; readonly mode: string | null }) => {
  if (run.state !== 'PENDING' || run.mode !== null) throw new Error(run.mode === 'CONFIRM_EACH_STEP' ? 'WORKFLOW_RUN_CONFIRM_MODE_CHOSEN' : `WORKFLOW_RUN_${run.state}`);
};
/**
 * Runs one operation for `owner` (the verified principal). Throws a closed code for invalid arguments and every refusal. `runs` (the workflow
 * run store on the same database) serves the run operations; without it they refuse.
 */
/**
 * BUILD-FLOFI-UNIVERSAL-WORKFLOW-002, invariant S1: the operations that would create NEW delegated authority for FloFi's executor — whose
 * session address sends and pays for every redemption — are refused at this product boundary (embedded BFF and Railway API alike) with
 * EXECUTOR_FUNDED_GAS_RETIRED. Reading, revoking and ending existing authority stays available, so nothing already signed is stranded.
 */
export const EXECUTOR_FUNDED_OPERATIONS: ReadonlySet<DelegationOperation> = new Set(['workflowRunWalletReview', 'workflowRunWalletSign', 'credentialPrepare',
  'credentialComplete', 'automationCreate', 'authorizationReview', 'authorizationSign', 'authorizationReauthorize', 'executionResume']);
export async function runDelegationOperation(service: DelegationService, owner: Owner, proven: readonly Owner[], method: DelegationOperation, args: readonly unknown[],
  runs?: WorkflowRunStore): Promise<unknown> {
  const arity = (n: number) => { if (args.length !== n) invalid(); };
  if (EXECUTOR_FUNDED_OPERATIONS.has(method)) throw new Error(EXECUTOR_FUNDED_GAS_RETIRED);
  switch (method) {
    case 'workflowRunWalletReview': {
      arity(1);
      const run = await ownedRun(runs, owner, proven, id(args[0], 'wfr'), true);
      return service.workflowRunWalletReview(owner, { runId: run.runId, strategy: run.strategy, workflowHash: run.workflowHash, validitySeconds: DELEGATED_AUTHORIZATION_SECONDS,
        wallet: run.wallet });
    }
    case 'workflowRunWalletSign': {
      arity(3);
      if (!Number.isSafeInteger(args[1]) || (args[1] as number) < 1) invalid();
      const run = await ownedRun(runs, owner, proven, id(args[0], 'wfr'), false);
      // A retry after a lost response: a run that is already DELEGATED answers only if this exact revision is the ACTIVE one (the service returns
      // early); it is never activated twice.
      if (run.mode === 'DELEGATED') {
        return service.workflowRunWalletSign(owner, run.runId, args[1] as number, args[2], async () => { throw new Error('WORKFLOW_RUN_DELEGATED'); }, true);
      }
      assertChoosing(run);
      return service.workflowRunWalletSign(owner, run.runId, args[1] as number, args[2],
        (tx, authorizationId) => runs!.activateDelegatedWithin(tx, run.runId, authorizationId, DELEGATION_EXECUTE_RUN_KIND));
    }
    case 'workflowRunWalletRevoke': {
      arity(1);
      const run = await ownedRun(runs, owner, proven, id(args[0], 'wfr'), false);
      await service.workflowRunAuthorizationRevoke(owner, run.runId);
      return { revoked: true };
    }
    case 'overview': arity(0); return service.overview(owner);
    case 'passkeyOptions': arity(0); return service.passkeyOptions(owner);
    case 'passkeyRegister': arity(1); return service.passkeyRegister(owner, args[0]);
    case 'passkeyRevoke': arity(1); return service.passkeyRevoke(owner, id(args[0], 'psk'));
    case 'credentialPrepare': arity(1); return service.credentialPrepare(owner, proven, args[0]);
    case 'credentialComplete': arity(2); return service.credentialComplete(owner, id(args[0], 'grt'), args[1]);
    case 'credentialRevoke': arity(1); return service.credentialRevoke(owner, id(args[0], 'grt'));
    case 'credentialRevocationComplete': arity(2); return service.credentialRevocationComplete(owner, id(args[0], 'grt'), args[1]);
    case 'credentialReverify': arity(1); return service.credentialReverify(owner, id(args[0], 'grt'));
    case 'automationPreview': arity(1); return service.automationPreview(owner, args[0]);
    case 'automationCreate': arity(1); return service.automationCreate(owner, args[0]);
    case 'authorizationReview': arity(1); return service.authorizationReview(owner, id(args[0], 'dau'));
    case 'authorizationSign': {
      arity(3);
      if (!Number.isSafeInteger(args[1]) || (args[1] as number) < 1) invalid();
      return service.authorizationSign(owner, id(args[0], 'dau'), args[1] as number, args[2]);
    }
    case 'authorizationRevoke': arity(1); return service.authorizationRevoke(owner, id(args[0], 'dau'));
    case 'authorizationReauthorize': arity(1); return service.authorizationReauthorize(owner, id(args[0], 'dau'));
    case 'executionDetail': arity(1); return service.executionDetail(owner, id(args[0], 'dex'));
    case 'executionResume': arity(1); return service.executionResume(owner, id(args[0], 'dex'));
  }
}
