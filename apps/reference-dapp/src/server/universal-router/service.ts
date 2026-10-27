// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CROSSCHAIN-UNIVERSAL-001: the universal Cross-chain Router service — any of the five FloFi mainnets to any other.
 *
 * One implementation on the `ExecutionStorage` port (files locally, PostgreSQL in the cloud). It never signs: it asks the allowed
 * routing providers for routes, keeps only routes FloFi can verify and execute (Relay's Depository, rebuilt byte for byte), simulates
 * the exact source transactions (EVM `eth_simulateV1`; Solana `simulateTransaction` of the exact v0 message), binds a Review
 * commitment over the route, the order, the transactions and the artifact chain, persists each attempt before the owner's wallet is
 * asked, and observes and reconciles both chains. Provider status is a hint: delivery and refunds are proven on chain.
 *
 * EVM source: the owner's wallet signs and sends each reviewed call (an exact approval when the allowance is short, then the deposit).
 * Solana source: the owner's wallet signs the reviewed message (Phantom may append verified Lighthouse assertions, HOTFIX #120); FloFi
 * verifies the signed bytes and broadcasts them exactly once.
 *
 * Concurrency (HOTFIX-WORKFLOW-CONCURRENCY-001): identity is per transaction, never per owner. EVM attempts claim (owner, chain, nonce)
 * and the provider order id; Solana attempts claim the reviewed message hash, the owner signature and the order id; a delivery
 * transaction is claimed by exactly one run. Any number of independent bridges — identical ones included, each with its own quote,
 * order, Review and signature — may be in flight at once.
 *
 * Run = append-only snapshot log `xuni-<32 hex>.jsonl`; phases follow `ROUTER_PHASE_TRANSITIONS`; terminal phases never change.
 */
import { createHash, randomBytes } from 'node:crypto';
import { resolveWorkflowCapability, UNIVERSAL_ROUTER_DEPLOYMENT, type UniversalEvmDeployment, type UniversalRouterDeployment } from '@defi-workflow-engine/action-registry';
import { createBaseSepoliaReviewContext, validateAuthoringWorkflow } from '@defi-workflow-engine/reference-linter';
import { associatedTokenAddress, compileUniversalArtifacts, decodeRelayDepositLog, decodeSplTokenAccount, describeSolanaWalletChange, encodeErc20ApproveExact, readSolanaAccounts,
  solanaAddress, verifySignedSolanaSwap, verifySolanaCluster, SOLANA_ASSOCIATED_TOKEN_PROGRAM_ID, type SignedSolanaTransaction, type SolanaRpc,
  type SolanaWalletChange } from '@defi-workflow-engine/reference-compiler';
import { assertRouterTransition, canonicalUniversalAddress, compareUniversalRoutes, hashArtifactBytes, ROUTER_PHASES, universalNetworkOfChain, universalRouteCommitment,
  validateUniversalBridgeWorkflow, type EvidenceBundle, type RouteChange, type RouterPhase, type SemanticWorkflow, type UniversalBridgeFields, type UniversalNetwork,
  type UniversalRoute, type UniversalRoutingProvider, type UniversalToken } from '@defi-workflow-engine/workflow-contracts';
import { validateArtifact } from '@defi-workflow-engine/workflow-contracts/schemas';
import { utf8, type ExecutionStorage } from '@defi-workflow-engine/reference-executor';
import type { Rpc } from '../public-testnet-service.ts';
import { solanaTransactionClaim } from '../solana-transaction-claim.ts';
import * as evm from './evm-chain.ts';
import * as sol from './solana-chain.ts';
import type { ProviderStatusHint, UniversalProviderAdapter, UniversalQuoteRequest } from './relay-provider.ts';
import { feeObligationFor, flofiFeePolicy } from './fee-obligation.ts';
import { UNIVERSAL_ACTIVE, UNIVERSAL_OBSERVABLE, UNIVERSAL_RUN_ID, UNIVERSAL_SETTLING, UNIVERSAL_TERMINAL, type DestinationDelivery, type EvmReviewSource, type EvmTx,
  type ProviderConsideration, type SolanaReviewSource, type SourceSettlement, type TokenFacts, type UniversalAttempt, type UniversalBegin, type UniversalEvidence,
  type UniversalEvmAttempt, type UniversalProvenance, type UniversalRecord, type UniversalReview, type UniversalSolanaAttempt, type UniversalWalletDiagnostic } from './types.ts';

export * from './types.ts';
export { FLOFI_WORKFLOW_FEE_BPS, flofiFeeAmount, flofiFeePolicy, feeObligationFor } from './fee-obligation.ts';
const fail = (code: string): never => { throw new Error(code); };
const isObject = evm.isObject;
const CODE = /^[A-Z][A-Z0-9_]{2,80}$/;
const REFUSALS = [4001, 4100, 4200];
const APPROVAL_ABANDON_MS = 15 * 60_000;
/** Provider failures that say nothing about the route (retry later) rather than "the reviewed route is no longer offered". */
const AVAILABILITY = /_(HTTP_\d+|RATE_LIMITED|UNAVAILABLE|RESPONSE_TOO_LARGE|RESPONSE_INVALID|URL_INVALID)$/;
const SCAN_BLOCKS = 2_000, SCAN_WINDOWS = 5;
const APPROVAL_TOPIC = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
/** Routing providers whose routes the universal router discovers and compares but cannot yet execute, and why (stated, never hidden). */
export const UNIVERSAL_NOT_EXECUTABLE: Readonly<Record<Exclude<UniversalRoutingProvider, 'relay'>, string>> = Object.freeze({
  lifi: 'LIFI_BRIDGE_VERIFIER_NOT_IMPLEMENTED', mayan: 'MAYAN_TRANSACTION_BUILDER_NOT_VERIFIED', across: 'ACROSS_EXECUTES_ON_CERTIFIED_ROUTER' });
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().filter(k => (value as Record<string, unknown>)[k] !== undefined)
    .map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
}
const digest = (value: unknown) => '0x' + createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
export function universalReviewCommitment(review: UniversalReview): string { const rest: Record<string, unknown> = { ...review }; delete rest.commitment; return digest(rest); }
export const universalEvidenceClass = (provenance: UniversalProvenance): UniversalEvidence['evidenceClass'] => provenance === 'PUBLIC_MAINNET' ? 'MAINNET_EXECUTED' : 'MOCKED';
export const universalExplorerTx = (chain: string, hash: string, deployment: UniversalRouterDeployment = UNIVERSAL_ROUTER_DEPLOYMENT) =>
  (chain.startsWith('solana:') ? deployment.solana.explorer : deployment.evm[chain]?.explorer ?? '') + 'tx/' + hash;

/** Append-only run history: identity, reviewed transactions, terminal states, settlements and evidence never change; phases only move forward. */
export function validateUniversalLog(bytes: Uint8Array): void {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!text.endsWith('\n') || bytes.length > 16_777_216) fail('UNIVERSAL_STORE_CORRUPT');
  let prior: UniversalRecord | null = null;
  const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
  for (const line of text.trimEnd().split('\n')) {
    let run: UniversalRecord;
    try { run = JSON.parse(line) as UniversalRecord; } catch { return fail('UNIVERSAL_STORE_CORRUPT'); }
    const r = run.review;
    if (!isObject(run) || run.format !== 'flofi.universal-bridge-run.v1' || !UNIVERSAL_RUN_ID.test(String(run.id)) || !['MOCKED', 'PUBLIC_MAINNET'].includes(run.provenance) ||
        typeof run.owner !== 'string' || !isObject(run.workflow) || !isObject(r) || r.owner !== run.owner || r.commitment !== universalReviewCommitment(r) ||
        r.routeCommitment !== universalRouteCommitment(r.route) || r.route.depositor !== run.owner || r.route.recipient !== r.recipient ||
        r.source.ecosystem !== universalNetworkOfChain(r.route.sourceChain)?.ecosystem ||
        (run.authorization !== null && run.authorization !== r.commitment) || !(ROUTER_PHASES as readonly string[]).includes(run.phase) ||
        !Array.isArray(run.attempts) || run.attempts.length > 16 || !['PENDING', 'RECONCILED', 'DIVERGENT', 'FAILED', 'REFUNDED'].includes(run.verdict) ||
        new Set(run.attempts.map(a => a.attemptId)).size !== run.attempts.length ||
        run.attempts.some(a => !isObject(a as unknown) || !a.attemptId.startsWith(run.id + '.') || a.ecosystem !== r.source.ecosystem ||
          (a.ecosystem === 'EVM' && a.tx.from !== run.owner) || (a.reconciled && a.state !== 'CONFIRMED')) ||
        run.attempts.filter(a => UNIVERSAL_ACTIVE.includes(a.state)).length > 1 || run.attempts.filter(a => a.step === 'DEPOSIT' && a.state === 'CONFIRMED').length > 1 ||
        (run.verdict === 'RECONCILED') !== (run.evidence !== null) || (run.verdict === 'RECONCILED') !== (run.phase === 'RECONCILED') ||
        (run.evidence !== null && (run.evidence.evidenceClass !== universalEvidenceClass(run.provenance) || run.evidence.bundle?.environment !== run.evidence.evidenceClass)) ||
        (run.evidence !== null && (run.destination === null || run.source === null)) || (run.destination !== null && run.source === null) ||
        (run.phase !== 'RECONCILIATION_REQUIRED' && (UNIVERSAL_SETTLING.includes(run.phase) || run.phase === 'RECONCILED' || run.phase === 'REFUNDED') !== (run.source !== null)) ||
        (run.phase === 'REFUNDED') !== (run.refund !== null) || (run.phase === 'REFUNDED') !== (run.verdict === 'REFUNDED') ||
        (run.phase === 'FAILED') !== (run.verdict === 'FAILED') || (run.phase === 'RECONCILIATION_REQUIRED') !== (run.verdict === 'DIVERGENT') ||
        (['AUTHORIZED', 'SOURCE_SUBMITTED'].includes(run.phase) ? run.authorization !== r.commitment : run.authorization !== null) ||
        (run.phase === 'SOURCE_SUBMITTED' && !run.attempts.some(a => a.step === 'DEPOSIT' && UNIVERSAL_OBSERVABLE.includes(a.state))) ||
        typeof run.requote !== 'boolean' || (run.requote && run.phase !== 'PREPARED') || (run.received !== null && run.destination?.amount !== run.received) ||
        (run.verdict === 'PENDING') !== (run.feeObligation === null) ||
        (run.verdict === 'RECONCILED' && (run.feeObligation?.status !== 'OBLIGATED' || run.evidence?.feeObligation?.status !== 'OBLIGATED')) ||
        (run.verdict !== 'PENDING' && run.verdict !== 'RECONCILED' && run.feeObligation?.status !== 'WAIVED'))
      fail('UNIVERSAL_STORE_CORRUPT');
    if (prior) {
      if (run.id !== prior.id || run.owner !== prior.owner || run.provenance !== prior.provenance || !same(run.workflow, prior.workflow) ||
          run.attempts.length < prior.attempts.length || (prior.evidence && !same(run.evidence, prior.evidence)) || (prior.refund && !same(run.refund, prior.refund)) ||
          (prior.source && !same({ ...run.source, final: null }, { ...prior.source, final: null })) || (prior.source?.final && !run.source?.final) ||
          (prior.destination && !same({ ...run.destination, final: null }, { ...prior.destination, final: null })) || (prior.destination?.final && !run.destination?.final) ||
          (prior.verdict !== 'PENDING' && run.verdict !== prior.verdict) ||
          (!same(run.review, prior.review) && prior.attempts.some(a => a.step === 'DEPOSIT' && !['CANCELLED', 'NOT_FOUND'].includes(a.state))))
        fail('UNIVERSAL_STORE_CORRUPT');
      try { assertRouterTransition(prior.phase, run.phase); } catch { fail('UNIVERSAL_STORE_CORRUPT'); }
      for (const [index, before] of prior.attempts.entries()) {
        const after = run.attempts[index]!;
        const identity = (a: UniversalAttempt) => a.ecosystem === 'EVM' ? [a.attemptId, a.step, a.nonce, a.tx, a.reviewCommitment, a.preparedAtBlock]
          : [a.attemptId, a.step, a.messageHash, a.reviewCommitment, a.lastValidBlockHeight];
        if (!same(identity(after), identity(before)) || (before.transactionHash !== null && after.transactionHash !== before.transactionHash) ||
            (before.ecosystem === 'SOLANA' && after.ecosystem === 'SOLANA' && before.transaction !== null && after.transaction !== before.transaction) ||
            (UNIVERSAL_TERMINAL.includes(before.state) && (after.state !== before.state || !same(after, before))))
          fail('UNIVERSAL_STORE_CORRUPT');
      }
    }
    prior = run;
  }
}
export function universalNeedsObservation(value: unknown): boolean {
  const record = value as UniversalRecord, last = record.attempts.at(-1);
  return record.verdict === 'PENDING' && (!!last && UNIVERSAL_OBSERVABLE.includes(last.state) || UNIVERSAL_SETTLING.includes(record.phase));
}

export type UniversalRouterServiceInput = {
  readonly storage: ExecutionStorage;
  /** Chain-bound read clients of the four EVM mainnets, keyed by CAIP-2 chain. */ readonly evmRpcs: Readonly<Record<string, Rpc>>;
  /** Solana mainnet-beta: reads, and `sendTransaction` only on the owner-signed submit path. */ readonly solanaRpc: SolanaRpc;
  readonly providers: { readonly relay: UniversalProviderAdapter };
  readonly provenance: UniversalProvenance; readonly executionEnabled?: boolean; readonly now?: () => Date;
  /** MOCKED harness only: synthetic deployment pins. A public run always uses the verified deployment. */ readonly mockedDeployment?: UniversalRouterDeployment;
};

export function createUniversalRouterService(input: UniversalRouterServiceInput) {
  const { log, leases } = input.storage, provenance = input.provenance;
  if (provenance !== 'MOCKED' && provenance !== 'PUBLIC_MAINNET') fail('UNIVERSAL_PROVENANCE_INVALID');
  if (input.mockedDeployment && provenance !== 'MOCKED') fail('UNIVERSAL_DEPLOYMENT_PINS_MOCKED_ONLY');
  const D: UniversalRouterDeployment = input.mockedDeployment ?? UNIVERSAL_ROUTER_DEPLOYMENT;
  const now = input.now ?? (() => new Date());
  const executionEnabled = input.executionEnabled === true;
  const relay = input.providers.relay;
  const runName = (id: string) => { if (!UNIVERSAL_RUN_ID.test(id)) fail('UNIVERSAL_RUN_ID_INVALID'); return id + '.jsonl'; };
  const evmOf = (chain: string): { d: UniversalEvmDeployment; rpc: Rpc } => {
    const d = D.evm[chain] ?? fail('UNIVERSAL_NETWORK_UNSUPPORTED'), rpc = input.evmRpcs[chain] ?? fail('UNIVERSAL_NETWORK_NOT_ENABLED');
    return { d, rpc };
  };
  async function load(id: string): Promise<UniversalRecord> {
    const bytes = await log.read(runName(id));
    if (!bytes) fail('UNIVERSAL_RUN_NOT_FOUND');
    try { validateUniversalLog(bytes!); } catch { fail('UNIVERSAL_STORE_CORRUPT'); }
    const record = JSON.parse(utf8(bytes!).trimEnd().split('\n').at(-1)!) as UniversalRecord;
    if (record.id !== id) fail('UNIVERSAL_STORE_CORRUPT');
    return record;
  }
  async function save(record: UniversalRecord): Promise<UniversalRecord> {
    const name = runName(record.id), prior = await log.read(name);
    if (prior && canonical(JSON.parse(utf8(prior).trimEnd().split('\n').at(-1)!)) === canonical(record)) return record;
    await log.extend(name, new TextEncoder().encode(utf8(prior) + JSON.stringify(record) + '\n'), validateUniversalLog);
    return record;
  }
  const locked = <T,>(id: string, action: () => Promise<T>): Promise<T> => leases.hold(runName(id).slice(0, -6), action);
  const replaceAttempt = (record: UniversalRecord, attempt: UniversalAttempt): UniversalRecord =>
    ({ ...record, attempts: record.attempts.map(a => a.attemptId === attempt.attemptId ? attempt : a) });
  const active = (record: UniversalRecord) => record.attempts.find(a => UNIVERSAL_ACTIVE.includes(a.state)) ?? null;
  const sameWorkflow = (a: SemanticWorkflow, b: SemanticWorkflow) => canonical(a) === canonical(b);
  const transition = (record: UniversalRecord, phase: RouterPhase): UniversalRecord => { assertRouterTransition(record.phase, phase); return { ...record, phase }; };
  const deauthorized = (record: UniversalRecord, error: string, changes: readonly RouteChange[] = record.routeChanges, requote = record.requote): UniversalRecord =>
    ({ ...record, authorization: null, phase: record.phase === 'AUTHORIZED' || record.phase === 'SOURCE_SUBMITTED' ? 'PREPARED' : record.phase, error, routeChanges: changes,
      requote: requote && ['AUTHORIZED', 'SOURCE_SUBMITTED', 'PREPARED'].includes(record.phase) });
  const divergent = (record: UniversalRecord, code: string): UniversalRecord => ({ ...transition(record, 'RECONCILIATION_REQUIRED'), verdict: 'DIVERGENT', authorization: null, error: code,
    feeObligation: feeObligationFor(record.review.route, 'DIVERGENT') });

  // --- intent, tokens, recipient ----------------------------------------------------------------------------------------
  function intentOf(workflow: SemanticWorkflow): UniversalBridgeFields & { nodeId: string; source: UniversalNetwork; destination: UniversalNetwork } {
    const checked = validateAuthoringWorkflow(workflow, createBaseSepoliaReviewContext()) as SemanticWorkflow;
    const fields = validateUniversalBridgeWorkflow(checked);
    const capability = resolveWorkflowCapability(checked, { environment: 'MAINNET' });
    if (!capability.executionSupported || capability.nodes[0]?.adapterId !== D.adapterId) fail('UNIVERSAL_CAPABILITY_UNAVAILABLE');
    return { ...fields, source: universalNetworkOfChain(fields.sourceChain)!, destination: universalNetworkOfChain(fields.destinationChain)! };
  }
  /** Token facts read on chain; the node's decimals must be the chain's. */
  async function tokenFacts(network: UniversalNetwork, asset: UniversalBridgeFields['inputAsset']): Promise<TokenFacts> {
    if (asset.kind === 'NATIVE') return { chainId: network.chain, kind: 'NATIVE', address: null, decimals: network.native.decimals, symbol: network.native.symbol, program: null,
      verifiedOnChain: true };
    if (network.ecosystem === 'EVM') {
      const decimals = await evm.evmTokenDecimals(evmOf(network.chain).rpc, asset.address);
      if (decimals !== asset.decimals) fail('UNIVERSAL_TOKEN_DECIMALS_MISMATCH');
      return { chainId: network.chain, kind: 'TOKEN', address: asset.address, decimals, symbol: 'TOKEN', program: null, verifiedOnChain: true };
    }
    const facts = await sol.solanaMintFacts(input.solanaRpc, asset.address);
    if (facts.decimals !== asset.decimals) fail('UNIVERSAL_TOKEN_DECIMALS_MISMATCH');
    return { chainId: network.chain, kind: 'TOKEN', address: asset.address, decimals: facts.decimals, symbol: 'TOKEN', program: facts.program, verifiedOnChain: true };
  }
  const programIdOf = (facts: TokenFacts) => facts.program === 'token-2022' ? 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' : facts.program === 'spl-token'
    ? 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' : null;
  const asToken = (facts: TokenFacts): UniversalToken => ({ chainId: facts.chainId, kind: facts.kind, address: facts.address, decimals: facts.decimals, symbol: facts.symbol });
  function bindRecipient(fields: UniversalBridgeFields, destination: UniversalNetwork, owner: string, destinationWallet: string | undefined) {
    if (fields.recipient === 'CONNECTED_OWNER') return { recipient: owner, kind: 'CONNECTED_OWNER' as const };
    if (fields.recipient === 'CONNECTED_DESTINATION_WALLET') {
      if (!destinationWallet) fail('UNIVERSAL_DESTINATION_WALLET_REQUIRED');
      return { recipient: canonicalUniversalAddress(destination, destinationWallet, 'UNIVERSAL_DESTINATION_WALLET_INVALID'), kind: 'CONNECTED_DESTINATION_WALLET' as const };
    }
    return { recipient: canonicalUniversalAddress(destination, fields.recipient, 'UNIVERSAL_RECIPIENT_INVALID'), kind: 'EXPLICIT' as const };
  }
  async function destinationObservation(destination: UniversalNetwork, recipient: string, output: TokenFacts) {
    if (destination.ecosystem === 'EVM') {
      const { d, rpc } = evmOf(destination.chain), head = await evm.evmHead(rpc, d), at = evm.tag(head.number);
      const code = evm.hex(await rpc('eth_getCode', [recipient, at]));
      return { position: { kind: 'BLOCK' as const, height: head.number }, recipientBalance: (await evm.evmBalance(rpc, recipient, output.address, at)).toString(), hasCode: code.length > 2 };
    }
    await sol.assertSolanaRecipient(input.solanaRpc, recipient);
    const ata = output.kind === 'TOKEN' ? associatedTokenAddress(recipient, output.address!, programIdOf(output)!, SOLANA_ASSOCIATED_TOKEN_PROGRAM_ID) : null;
    const { slot, accounts } = await readSolanaAccounts(input.solanaRpc, ata ? [recipient, ata] : [recipient]);
    let balance = accounts[0]?.lamports ?? 0n;
    if (ata) { const account = accounts[1]; balance = account && account.data.length >= 165 ? decodeSplTokenAccount(account.data, output.program === 'token-2022').amount : 0n; }
    return { position: { kind: 'SLOT' as const, height: slot }, recipientBalance: balance.toString(), hasCode: false };
  }

  // --- quotes and selection -------------------------------------------------------------------------------------------
  async function selectRoute(fields: UniversalBridgeFields, request: UniversalQuoteRequest): Promise<{ route: UniversalRoute; considered: ProviderConsideration[] }> {
    const considered: ProviderConsideration[] = [], routes: UniversalRoute[] = [];
    for (const id of fields.providers) {
      if (id !== 'relay') { considered.push({ provider: id, outcome: 'NOT_EXECUTABLE', code: UNIVERSAL_NOT_EXECUTABLE[id], expectedOutput: null, minimumOutput: null, routeCommitment: null }); continue; }
      try {
        const route = await relay.quote(request);
        routes.push(route);
        considered.push({ provider: id, outcome: 'AVAILABLE', code: null, expectedOutput: route.expectedOutput, minimumOutput: route.minimumOutput, routeCommitment: universalRouteCommitment(route) });
      } catch (cause) {
        const code = cause instanceof Error && CODE.test(cause.message) ? cause.message : 'UNIVERSAL_PROVIDER_FAILED';
        considered.push({ provider: id, outcome: AVAILABILITY.test(code) ? 'UNAVAILABLE' : 'REFUSED', code, expectedOutput: null, minimumOutput: null, routeCommitment: null });
      }
    }
    if (!routes.length) {
      const reason = considered.find(c => c.outcome === 'REFUSED' || c.outcome === 'UNAVAILABLE')?.code;
      return fail(reason ?? considered.find(c => c.outcome === 'NOT_EXECUTABLE')?.code ?? 'UNIVERSAL_NO_EXECUTABLE_ROUTE');
    }
    // BEST_MINIMUM_OUTPUT: the highest guaranteed minimum; ties keep preference order. PREFERENCE_ORDER: the first executable provider.
    const route = fields.selection === 'BEST_MINIMUM_OUTPUT' ? routes.reduce((best, r) => BigInt(r.minimumOutput) > BigInt(best.minimumOutput) ? r : best) : routes[0]!;
    const selected = considered.map(c => c.provider === route.provider && c.outcome === 'AVAILABLE' ? { ...c, outcome: 'SELECTED' as const } : c);
    return { route, considered: selected };
  }
  const quoteRequest = (f: ReturnType<typeof intentOf>, input: TokenFacts, output: TokenFacts, owner: string, recipient: string): UniversalQuoteRequest =>
    ({ source: f.source, destination: f.destination, inputToken: asToken(input), outputToken: asToken(output), amount: f.amount, owner, recipient, slippageBps: f.slippageBps,
      nowMs: now().getTime(), reviewTtlSeconds: D.reviewTtlSeconds, inputTokenProgram: programIdOf(input) });

  // --- Review -----------------------------------------------------------------------------------------------------------
  async function buildReview(workflow: SemanticWorkflow, ownerInput: string, destinationWallet?: string): Promise<UniversalReview> {
    const f = intentOf(workflow), owner = canonicalUniversalAddress(f.source, ownerInput, 'UNIVERSAL_OWNER_INVALID');
    const { recipient, kind } = bindRecipient(f, f.destination, owner, destinationWallet);
    const inputFacts = await tokenFacts(f.source, f.inputAsset), outputFacts = await tokenFacts(f.destination, f.outputAsset);
    const destination = await destinationObservation(f.destination, recipient, outputFacts);
    const observed = now();
    if (f.source.ecosystem === 'EVM') {
      const { d, rpc } = evmOf(f.source.chain), head = await evm.evmHead(rpc, d), at = evm.tag(head.number);
      const age = observed.getTime() - head.timestamp * 1000;
      if (age > 120_000 || age < -30_000) fail('UNIVERSAL_STALE_SOURCE_HEAD');
      const depositoryCodeSha256 = await evm.assertEvmDepository(rpc, d, at);
      const { route, considered } = await selectRoute(f, quoteRequest(f, inputFacts, outputFacts, owner, recipient));
      if (route.source.ecosystem !== 'EVM') return fail('UNIVERSAL_ROUTE_TRANSACTION_INVALID');
      if (route.source.deposit.to !== d.relayDepository) fail('UNIVERSAL_UNEXPECTED_CONTRACT');
      const token = inputFacts.address, amount = BigInt(f.amount);
      const [balance, native, allowance, nonce] = await Promise.all([evm.evmBalance(rpc, owner, token, at), evm.evmBalance(rpc, owner, null, at),
        token ? evm.evmAllowance(rpc, token, owner, d.relayDepository, at) : Promise.resolve(null), rpc('eth_getTransactionCount', [owner, at]).then(evm.quantity)]);
      if (balance < amount) fail(token ? 'UNIVERSAL_INSUFFICIENT_TOKEN' : 'UNIVERSAL_INSUFFICIENT_NATIVE');
      const approvalRequired = token !== null && allowance! < amount;
      const plan: evm.EvmCall[] = [...approvalRequired ? [{ purpose: 'APPROVAL' as const, to: token!, data: encodeErc20ApproveExact(d.relayDepository, amount), value: '0' }] : [],
        { purpose: 'BRIDGE_DEPOSIT', to: route.source.deposit.to, data: route.source.deposit.data, value: route.source.deposit.value }];
      const simulated = await evm.evmSimulate(rpc, owner, plan, head.number);
      const { ownerDebit } = evm.assertDepositEffects(route, d, simulated.at(-1)!.logs, owner);
      const { priority, maximum } = await evm.evmFeePrice(rpc, d, head.baseFee);
      const calls = await Promise.all(plan.map(async (c, i) => {
        const gasUsed = simulated[i]!.gasUsed, gasLimit = await evm.evmGasLimit(rpc, d, owner, c, gasUsed, at);
        const l1 = await evm.evmL1FeeUpperBound(rpc, d, (c.data.length - 2) / 2, at);
        return { ...c, gasUsed: gasUsed.toString(), gasLimit: gasLimit.toString(), l1FeeUpperBoundWei: l1?.toString() ?? null };
      }));
      const gasLimitTotal = calls.reduce((s, c) => s + BigInt(c.gasLimit), 0n), execution = gasLimitTotal * maximum;
      const l1 = calls.map(c => c.l1FeeUpperBoundWei === null ? null : BigInt(c.l1FeeUpperBoundWei));
      const l1Total = l1.every(v => v !== null) ? l1.reduce((s, v) => s + v!, 0n) : null;
      if (native < execution + (l1Total ?? 0n) + (token ? 0n : amount)) fail('UNIVERSAL_INSUFFICIENT_GAS');
      const expiresMs = Math.min(observed.getTime() + D.reviewTtlSeconds * 1000, Date.parse(route.quote.expiresAt));
      if (expiresMs <= observed.getTime()) fail('UNIVERSAL_QUOTE_EXPIRED');
      const expiresAt = new Date(expiresMs).toISOString(), commitment = universalRouteCommitment(route), networkFee = (execution + (l1Total ?? 0n)).toString();
      const artifacts = compileUniversalArtifacts({ workflow, nodeId: f.nodeId, route, routeCommitment: commitment, owner,
        payload: { ecosystem: 'EVM', calls: plan.map(c => ({ purpose: c.purpose, to: c.to, data: c.data, value: c.value })) },
        simulation: { position: { kind: 'BLOCK', height: head.number }, observedAt: observed.toISOString(), networkFeeUpperBound: networkFee }, expiresAt });
      const source: EvmReviewSource = { ecosystem: 'EVM', chainId: d.chainId, block: { number: head.number, hash: head.hash, timestamp: head.timestamp },
        balance: balance.toString(), nativeBalance: native.toString(), allowance: allowance?.toString() ?? null, nonce: nonce.toString(), depositoryCodeSha256,
        approvals: token ? [{ token, spender: d.relayDepository, amount: f.amount, currentAllowance: allowance!.toString(), required: approvalRequired }] : [], calls,
        fees: { maxFeePerGas: maximum.toString(), maxPriorityFeePerGas: priority.toString(), gasLimitTotal: gasLimitTotal.toString(), executionFeeUpperBoundWei: execution.toString(),
          l1FeeUpperBoundWei: l1Total?.toString() ?? null, totalUpperBoundWei: l1Total === null ? null : networkFee },
        simulation: { provenance: 'TRANSACTION_SIMULATION', method: 'eth_simulateV1', block: head.number, calls: simulated.map(s => ({ purpose: s.purpose, gasUsed: s.gasUsed.toString() })),
          orderId: route.order.orderId, ownerDebit: ownerDebit.toString(), notSimulated: ['DESTINATION_DELIVERY', 'SOLVER_BEHAVIOUR', 'REFUND'] } };
      return finishReview({ f, workflow, owner, recipient, kind, route, considered, inputFacts, outputFacts, destination, observed, expiresAt, source, artifacts,
        networkFee, signatures: plan.length });
    }
    const S = D.solana;
    await verifySolanaCluster(input.solanaRpc, S.genesisHash).catch((cause: unknown) => fail(cause instanceof Error && cause.message === 'SOLANA_WRONG_CLUSTER' ? 'UNIVERSAL_WRONG_CHAIN' : 'UNIVERSAL_RPC_UNAVAILABLE'));
    const program = await sol.assertSolanaRelayProgram(input.solanaRpc, S);
    const { route, considered } = await selectRoute(f, quoteRequest(f, inputFacts, outputFacts, owner, recipient));
    if (route.source.ecosystem !== 'SOLANA' || route.source.instruction.programId !== S.relayProgram) fail('UNIVERSAL_UNEXPECTED_CONTRACT');
    const deposit = await sol.simulateSolanaDeposit(input.solanaRpc, S, route, programIdOf(inputFacts));
    const expiresMs = Math.min(observed.getTime() + D.reviewTtlSeconds * 1000, Date.parse(route.quote.expiresAt));
    if (expiresMs <= observed.getTime()) fail('UNIVERSAL_QUOTE_EXPIRED');
    const expiresAt = new Date(expiresMs).toISOString(), commitment = universalRouteCommitment(route);
    const networkFee = (BigInt(deposit.estimatedFeeLamports) + BigInt(deposit.vaultTokenCreationLamports)).toString();
    const artifacts = compileUniversalArtifacts({ workflow, nodeId: f.nodeId, route, routeCommitment: commitment, owner,
      payload: { ecosystem: 'SOLANA', messageHash: deposit.messageHash, programId: S.relayProgram },
      simulation: { position: { kind: 'SLOT', height: deposit.slot }, observedAt: observed.toISOString(), networkFeeUpperBound: networkFee }, expiresAt });
    const source: SolanaReviewSource = { ecosystem: 'SOLANA', slot: deposit.slot, balance: deposit.ownerBalanceBefore, lamports: deposit.ownerLamportsBefore,
      program: { id: S.relayProgram, programData: S.relayProgramData, authority: program.authority, deploymentSlot: program.deploymentSlot },
      message: deposit.message, messageHash: deposit.messageHash, unsignedTransaction: deposit.unsignedTransaction, blockhash: deposit.blockhash,
      lastValidBlockHeight: deposit.lastValidBlockHeight, computeUnitLimit: deposit.computeUnitLimit, computeUnitPrice: deposit.computeUnitPrice,
      estimatedFeeLamports: deposit.estimatedFeeLamports, vaultTokenCreationLamports: deposit.vaultTokenCreationLamports,
      simulation: { provenance: 'TRANSACTION_SIMULATION', method: 'simulateTransaction', slot: deposit.slot, unitsConsumed: deposit.unitsConsumed, orderId: route.order.orderId,
        ownerDebit: deposit.ownerDebit, notSimulated: ['DESTINATION_DELIVERY', 'SOLVER_BEHAVIOUR', 'REFUND'] } };
    return finishReview({ f, workflow, owner, recipient, kind, route, considered, inputFacts, outputFacts, destination, observed, expiresAt, source, artifacts,
      networkFee, signatures: 1 });
  }
  function finishReview(x: { f: ReturnType<typeof intentOf>; workflow: SemanticWorkflow; owner: string; recipient: string; kind: UniversalReview['recipientKind'];
    route: UniversalRoute; considered: ProviderConsideration[]; inputFacts: TokenFacts; outputFacts: TokenFacts; destination: Awaited<ReturnType<typeof destinationObservation>>;
    observed: Date; expiresAt: string; source: EvmReviewSource | SolanaReviewSource; artifacts: UniversalReview['artifacts']; networkFee: string; signatures: number }): UniversalReview {
    const { f, route } = x;
    if (route.depositor !== x.owner || route.recipient !== x.recipient || route.inputAmount !== f.amount || route.sourceChain !== f.source.chain ||
        route.destinationChain !== f.destination.chain || route.inputToken.address !== x.inputFacts.address || route.outputToken.address !== x.outputFacts.address)
      fail('UNIVERSAL_ROUTE_INTENT_MISMATCH');
    const review: Omit<UniversalReview, 'commitment'> = {
      format: 'flofi.universal-bridge-review.v1', owner: x.owner, recipient: x.recipient, recipientKind: x.kind, recipientHasCode: x.destination.hasCode,
      workflowHash: hashArtifactBytes('semantic-workflow', new TextEncoder().encode(JSON.stringify(x.workflow))), revision: x.workflow.revision, nodeId: f.nodeId,
      observedAt: x.observed.toISOString(), expiresAt: x.expiresAt,
      intent: { sourceChain: f.sourceChain, destinationChain: f.destinationChain, inputAsset: f.inputAsset, outputAsset: f.outputAsset, amount: f.amount, recipient: f.recipient,
        slippageBps: f.slippageBps, providers: [...f.providers], selection: f.selection },
      selection: { policy: f.selection, selected: route.provider, considered: x.considered }, route, routeCommitment: universalRouteCommitment(route),
      tokens: { input: { ...x.inputFacts, symbol: route.inputToken.symbol }, output: { ...x.outputFacts, symbol: route.outputToken.symbol } },
      source: x.source, destination: { chainId: f.destination.chain, position: x.destination.position, recipientBalance: x.destination.recipientBalance },
      deadlines: { reviewExpiresAt: x.expiresAt, quoteExpiresAt: route.quote.expiresAt, orderDeadline: route.order.deadline },
      feePolicy: flofiFeePolicy({ upperBound: x.networkFee, symbol: f.source.native.symbol, decimals: f.source.native.decimals }),
      authorizations: { sourceSignatures: x.signatures, destinationAuthorization: 'NONE' }, artifacts: x.artifacts };
    return { ...review, commitment: universalReviewCommitment(review as UniversalReview) };
  }

  // --- duplicate-effect guards ------------------------------------------------------------------------------------------
  /** Claims an exclusive identity, then persists while holding it; an entry whose attempt is no longer active (or never persisted) is stale. */
  async function claim<T>(key: string, name: string, code: string, record: UniversalRecord, attemptId: string, inner: () => Promise<T>): Promise<T> {
    return leases.hold(key, async () => {
      const entry = JSON.stringify({ runId: record.id, attemptId }) + '\n', existing = await log.read(name);
      if (existing === null) { if (!await log.create(name, new TextEncoder().encode(entry))) fail(code); }
      else {
        const prior = JSON.parse(utf8(existing).trimEnd().split('\n').at(-1)!) as { runId: string; attemptId: string };
        const holder = prior.runId === record.id ? record : await load(prior.runId);
        const held = holder.attempts.find(a => a.attemptId === prior.attemptId);
        if (held && UNIVERSAL_ACTIVE.includes(held.state) || held && held.step === 'DEPOSIT' && ['CONFIRMED', 'PENDING'].includes(held.state)) fail(code);
        await log.extend(name, new TextEncoder().encode(utf8(existing) + entry), () => undefined);
      }
      return inner();
    });
  }
  /** One delivery (or refund) transaction belongs to exactly one run: two identical bridges never reconcile against the same fill. */
  const claimSettlementTx = (kind: 'delivery' | 'refund', hash: string, id: string) =>
    solanaTransactionClaim(input.storage, `${kind}-${hash.replace(/^0x/, '')}.xuni-settlement`, id, 'UNIVERSAL_SETTLEMENT_CLAIMED_BY_ANOTHER_RUN');

  // --- EVM attempts -----------------------------------------------------------------------------------------------------
  async function assertRequestFees(review: UniversalReview, tx: EvmTx, rpc: Rpc, d: UniversalEvmDeployment, at: string, invalid: (code: string) => Promise<never>) {
    const src = review.source as EvmReviewSource;
    if (evm.quantity(await rpc('eth_chainId', [])) !== BigInt(d.chainId)) fail('UNIVERSAL_WRONG_CHAIN');
    const block = await rpc('eth_getBlockByNumber', [at, false]);
    if (!isObject(block)) fail('UNIVERSAL_RPC_INVALID');
    const price = d.nitro ? evm.quantity(await rpc('eth_gasPrice', [])) : evm.quantity((block as Record<string, unknown>).baseFeePerGas) + BigInt(tx.maxPriorityFeePerGas);
    if (price <= 0n || price > BigInt(tx.maxFeePerGas) || BigInt(tx.maxFeePerGas) > BigInt(src.fees.maxFeePerGas)) return invalid('UNIVERSAL_FEES_CHANGED_REVIEW_REQUIRED');
    const estimate = evm.quantity(await rpc('eth_estimateGas', [{ from: tx.from, to: tx.to, value: tx.value, data: tx.data }, at]));
    if (estimate <= 0n || estimate > BigInt(tx.gas)) return invalid('UNIVERSAL_GAS_CHANGED_REVIEW_REQUIRED');
    const l1 = await evm.evmL1FeeUpperBound(rpc, d, (tx.data.length - 2) / 2, at), reviewed = src.calls.find(c => c.to === tx.to && c.data === tx.data);
    if (!reviewed || l1 === null || reviewed.l1FeeUpperBoundWei === null || l1 > BigInt(reviewed.l1FeeUpperBoundWei)) return invalid('UNIVERSAL_L1_FEES_CHANGED_REVIEW_REQUIRED');
    const balance = evm.quantity(await rpc('eth_getBalance', [tx.from, at]));
    if (balance < BigInt(tx.gas) * BigInt(tx.maxFeePerGas) + l1 + BigInt(tx.value)) fail('UNIVERSAL_INSUFFICIENT_GAS');
  }
  async function beginEvm(record0: UniversalRecord, owner: string): Promise<UniversalBegin> {
    let record = record0;
    const review = record.review, route = review.route, src = review.source as EvmReviewSource, { d, rpc } = evmOf(route.sourceChain);
    const invalidate = async (code: string, changes: readonly RouteChange[] = []): Promise<never> => { await save(deauthorized(record, code, changes, true)); return fail(code); };
    const head = await evm.evmHead(rpc, d), at = evm.tag(head.number);
    try { await evm.assertEvmDepository(rpc, d, at, src.depositoryCodeSha256); } catch { return invalidate('UNIVERSAL_STATE_CHANGED_REVIEW_REQUIRED'); }
    const token = route.inputToken.address, amount = BigInt(route.inputAmount);
    const [balance, native, allowance, pendingNonce, latestNonce] = await Promise.all([evm.evmBalance(rpc, owner, token, at), evm.evmBalance(rpc, owner, null, at),
      token ? evm.evmAllowance(rpc, token, owner, d.relayDepository, at) : Promise.resolve(null), rpc('eth_getTransactionCount', [owner, 'pending']).then(evm.quantity),
      rpc('eth_getTransactionCount', [owner, at]).then(evm.quantity)]);
    if (pendingNonce < latestNonce) fail('UNIVERSAL_RPC_INVALID');
    // The same provider re-quotes the same intent; any material change is ROUTE_CHANGED, never a substitution.
    await revalidateRoute(record, invalidate);
    const step = token !== null && allowance! < amount ? 'APPROVAL' as const : 'DEPOSIT' as const, purpose = step === 'APPROVAL' ? 'APPROVAL' : 'BRIDGE_DEPOSIT';
    const index = src.calls.findIndex(c => c.purpose === purpose);
    if (index < 0) return invalidate('UNIVERSAL_STATE_CHANGED_REVIEW_REQUIRED');
    const remaining = src.calls.slice(index);
    let simulated: Awaited<ReturnType<typeof evm.evmSimulate>>;
    try { simulated = await evm.evmSimulate(rpc, owner, remaining, head.number); evm.assertDepositEffects(route, d, simulated.at(-1)!.logs, owner); }
    catch (cause) { if (cause instanceof Error && cause.message === 'UNIVERSAL_SIMULATION_UNAVAILABLE') throw cause; return invalidate('UNIVERSAL_STATE_CHANGED_REVIEW_REQUIRED'); }
    if (balance < amount) fail(token ? 'UNIVERSAL_INSUFFICIENT_TOKEN' : 'UNIVERSAL_INSUFFICIENT_NATIVE');
    if (simulated.some((c, i) => c.gasUsed > BigInt(remaining[i]!.gasLimit))) return invalidate('UNIVERSAL_GAS_CHANGED_REVIEW_REQUIRED');
    const reviewed = src.calls[index]!, maxFee = BigInt(src.fees.maxFeePerGas);
    if (native < BigInt(reviewed.gasLimit) * maxFee + BigInt(reviewed.value)) fail('UNIVERSAL_INSUFFICIENT_GAS');
    const tx: EvmTx = { chainId: d.chainHex, from: owner, to: reviewed.to, data: reviewed.data, value: evm.tag(BigInt(reviewed.value)), gas: evm.tag(BigInt(reviewed.gasLimit)),
      maxFeePerGas: evm.tag(maxFee), maxPriorityFeePerGas: evm.tag(BigInt(src.fees.maxPriorityFeePerGas)) };
    await assertRequestFees(review, tx, rpc, d, at, invalidate);
    const attempt: UniversalEvmAttempt = { ecosystem: 'EVM', attemptId: `${record.id}.${step.toLowerCase()}.${record.attempts.length + 1}`, step, state: 'PREPARED',
      reviewCommitment: review.commitment, nonce: pendingNonce.toString(), preparedAtBlock: head.number, createdAt: now().toISOString(), tx, transactionHash: null,
      replacementHash: null, receipt: null, reconciled: false, note: null };
    const persist = () => save({ ...record, attempts: [...record.attempts, attempt], error: null });
    const nonceClaim = () => claim(`${d.chainHex}-${owner}-${attempt.nonce}`, `${d.chainHex}-${owner}-${attempt.nonce}.xuni-intent`, 'UNIVERSAL_OWNER_NONCE_IN_USE', record,
      attempt.attemptId, persist);
    record = step === 'DEPOSIT' ? await claim(`order-${route.order.orderId.slice(2, 34)}`, `order-${route.order.orderId.slice(2)}.xuni-order`,
      'UNIVERSAL_ORDER_IN_FLIGHT_SIMULATE_AGAIN', record, attempt.attemptId, nonceClaim) : await nonceClaim();
    return { record, attempt, ecosystem: 'EVM', transaction: tx };
  }
  async function revalidateRoute(record: UniversalRecord, invalidate: (code: string, changes?: readonly RouteChange[]) => Promise<never>): Promise<void> {
    const review = record.review, route = review.route, f = intentOf(record.workflow);
    let fresh: UniversalRoute;
    try {
      fresh = await relay.quote({ source: f.source, destination: f.destination, inputToken: { ...route.inputToken }, outputToken: { ...route.outputToken }, amount: route.inputAmount,
        owner: route.depositor, recipient: route.recipient, slippageBps: route.slippageBps, nowMs: now().getTime(), reviewTtlSeconds: D.reviewTtlSeconds,
        inputTokenProgram: programIdOf(review.tokens.input) });
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : '';
      if (AVAILABILITY.test(code) || !CODE.test(code)) fail('UNIVERSAL_ROUTE_REVALIDATION_UNAVAILABLE');
      return invalidate('ROUTE_CHANGED', ['PROTOCOL_CHANGED']);
    }
    const changes = compareUniversalRoutes(route, fresh, 'REQUOTE');
    if (changes.length) await invalidate('ROUTE_CHANGED', changes);
  }
  async function discoverByNonce(rpc: Rpc, attempt: UniversalEvmAttempt): Promise<{ consumed: false } | { consumed: true; tx: Record<string, unknown> }> {
    const owner = attempt.tx.from, nonce = BigInt(attempt.nonce);
    const count = async (block: number) => evm.quantity(await rpc('eth_getTransactionCount', [owner, evm.tag(block)]));
    const latest = Number(evm.quantity(await rpc('eth_blockNumber', [])));
    if (!Number.isSafeInteger(latest) || latest < attempt.preparedAtBlock) fail('UNIVERSAL_RPC_INVALID');
    if (await count(latest) <= nonce) return { consumed: false };
    if (await count(attempt.preparedAtBlock) > nonce) fail('UNIVERSAL_NONCE_CONSUMED_BEFORE_PREPARATION');
    let low = attempt.preparedAtBlock, high = latest;
    while (high - low > 1) { const middle = low + Math.floor((high - low) / 2); if (await count(middle) > nonce) high = middle; else low = middle; }
    const block = await rpc('eth_getBlockByNumber', [evm.tag(high), true]);
    if (!isObject(block) || !Array.isArray((block as Record<string, unknown>).transactions)) fail('UNIVERSAL_RPC_INVALID');
    const found = ((block as Record<string, unknown>).transactions as unknown[]).find(tx => isObject(tx) && String((tx as Record<string, unknown>).from).toLowerCase() === owner &&
      evm.quantity((tx as Record<string, unknown>).nonce) === nonce);
    if (!isObject(found)) fail('UNIVERSAL_DISCOVERY_INCONSISTENT');
    return { consumed: true, tx: found as Record<string, unknown> };
  }
  /** The order's own on-chain identity: a Depository deposit event carrying the order id, found even when the hash was lost (a relayed submission). */
  async function discoverDeposit(rpc: Rpc, d: UniversalEvmDeployment, record: UniversalRecord, attempt: UniversalEvmAttempt): Promise<{ hash: string | null; nextBlock: number }> {
    const safe = await evm.evmSafeHead(rpc);
    let from = attempt.depositScanFrom ?? attempt.preparedAtBlock;
    for (let i = 0; i < SCAN_WINDOWS && from <= safe; i++) {
      const to = Math.min(from + SCAN_BLOCKS - 1, safe);
      const logs = await rpc('eth_getLogs', [{ address: d.relayDepository, fromBlock: evm.tag(from), toBlock: evm.tag(to), topics: [['0x49fed1d0b752ce30eee63c7a81133f3363b532fec5d4d7dd1ccfd005de4555e1',
        '0x8032066556caf3967d8fec4ad22a2d9e1e9576556b2903a0fcd5b1fd201e3477']] }]);
      if (!Array.isArray(logs)) fail('UNIVERSAL_RPC_INVALID');
      for (const entry of logs as unknown[]) {
        if (!isObject(entry)) continue;
        const e = entry as Record<string, unknown>;
        let event: ReturnType<typeof decodeRelayDepositLog>;
        try { event = decodeRelayDepositLog({ address: String(e.address), topics: e.topics as string[], data: String(e.data) }, d.relayDepository); } catch { continue; }
        if (event && event.id === record.review.route.order.orderId && event.from === record.owner) return { hash: String(e.transactionHash).toLowerCase(), nextBlock: from };
      }
      from = to + 1;
    }
    return { hash: null, nextBlock: from };
  }
  async function settleEvmSource(record: UniversalRecord, attempt: UniversalEvmAttempt, hash: string, raw: Record<string, unknown>): Promise<UniversalRecord> {
    const { d, rpc } = evmOf(record.review.route.sourceChain);
    let facts: evm.EvmReceiptFacts;
    try { facts = await evm.verifyEvmSubmission(rpc, d, { hash, owner: record.owner, to: attempt.tx.to, data: attempt.tx.data, value: BigInt(attempt.tx.value), preBlock: attempt.preparedAtBlock }, raw); }
    catch (cause) {
      if (cause instanceof Error && cause.message === 'RECEIPT_NOT_CANONICAL') return save({ ...record, error: 'UNIVERSAL_RECEIPT_NOT_CANONICAL' });
      if (cause instanceof Error && /^(TRANSACTION_MISMATCH|RECEIPT_INVALID)$/.test(cause.message))
        return save(replaceAttempt(divergent(record, 'UNIVERSAL_TRANSACTION_MISMATCH'), { ...attempt, state: 'RECONCILIATION_REQUIRED', note: 'UNIVERSAL_TRANSACTION_MISMATCH' }));
      throw cause;
    }
    if (facts.direct && facts.nonce !== null && facts.nonce !== BigInt(attempt.nonce))
      return save(replaceAttempt(divergent(record, 'UNIVERSAL_TRANSACTION_MISMATCH'), { ...attempt, state: 'RECONCILIATION_REQUIRED', note: 'UNIVERSAL_NONCE_MISMATCH' }));
    const receipt = { transactionHash: hash, status: facts.status, blockNumber: facts.blockNumber, blockHash: facts.blockHash, from: facts.from, gasCostWei: facts.gasCostWei.toString(),
      submissionKind: facts.direct ? 'DIRECT' as const : 'DELEGATED_SINGLE' as const };
    if (facts.status === 0) {
      if (attempt.step === 'DEPOSIT') return save(replaceAttempt({ ...transition(record, 'FAILED'), verdict: 'FAILED', authorization: null, error: 'UNIVERSAL_DEPOSIT_REVERTED',
        feeObligation: feeObligationFor(record.review.route, 'FAILED') },
        { ...attempt, state: 'REVERTED', transactionHash: attempt.transactionHash ?? hash, receipt, note: 'UNIVERSAL_DEPOSIT_REVERTED' }));
      return save(replaceAttempt(deauthorized(record, 'UNIVERSAL_APPROVAL_REVERTED'), { ...attempt, state: 'REVERTED', transactionHash: attempt.transactionHash ?? hash, receipt,
        note: 'UNIVERSAL_APPROVAL_REVERTED' }));
    }
    const logs = Array.isArray(raw.logs) ? raw.logs.filter(isObject) as unknown as evm.EvmLog[] : fail('UNIVERSAL_RECEIPT_INVALID');
    const confirmed = { ...attempt, state: 'CONFIRMED' as const, transactionHash: attempt.transactionHash ?? hash, receipt, reconciled: true };
    try {
      if (attempt.step === 'APPROVAL') {
        // Proof is the approval's own event: exactly the reviewed spender and amount. The allowance may already be consumed by another of the
        // owner's bridges (ERC-20 approvals overwrite); the deposit's begin re-reads it and asks for a new approval if it is short.
        const token = record.review.route.inputToken.address!, word = (a: string) => '0x' + a.slice(2).padStart(64, '0');
        const approvals = logs.filter(l => String(l.address).toLowerCase() === token && String(l.topics?.[0]).toLowerCase() === APPROVAL_TOPIC);
        if (approvals.length !== 1 || String(approvals[0]!.topics[1]).toLowerCase() !== word(record.owner) || String(approvals[0]!.topics[2]).toLowerCase() !== word(d.relayDepository) ||
            BigInt(String(approvals[0]!.data)) !== BigInt(record.review.route.inputAmount)) fail('UNIVERSAL_APPROVAL_MISMATCH');
        return save(replaceAttempt({ ...record, error: null }, confirmed));
      }
      const { ownerDebit } = evm.assertDepositEffects(record.review.route, d, logs, record.owner);
      const block = await rpc('eth_getBlockByNumber', [evm.tag(facts.blockNumber), false]);
      if (!isObject(block)) fail('UNIVERSAL_RPC_INVALID');
      const settled: SourceSettlement = { chainId: record.review.route.sourceChain, transactionHash: hash, position: { kind: 'BLOCK', height: facts.blockNumber },
        blockHash: facts.blockHash, timestamp: Number(evm.quantity((block as Record<string, unknown>).timestamp)), orderId: record.review.route.order.orderId,
        ownerDebit: ownerDebit.toString(), final: false, confirmedAt: now().toISOString() };
      // The authorization is consumed by the confirmed deposit; it can never authorize another one.
      return save(replaceAttempt({ ...transition(record, 'SOURCE_CONFIRMED'), authorization: null, source: settled, error: null }, confirmed));
    } catch (cause) {
      const code = cause instanceof Error && /^UNIVERSAL_[A-Z0-9_]+$/.test(cause.message) ? cause.message : null;
      if (!code || code === 'UNIVERSAL_RPC_INVALID') throw cause;
      return save(replaceAttempt(divergent(record, code), { ...attempt, state: 'RECONCILIATION_REQUIRED', receipt, note: code }));
    }
  }
  async function observeEvmAttempt(recordInput: UniversalRecord, attemptInput: UniversalEvmAttempt): Promise<UniversalRecord> {
    let record = recordInput, attempt = attemptInput;
    const { d, rpc } = evmOf(record.review.route.sourceChain);
    if (attempt.state === 'PREPARED')
      return save(replaceAttempt(deauthorized(record, 'UNIVERSAL_WALLET_NOT_SUBMITTED'), { ...attempt, state: 'CANCELLED', note: 'UNIVERSAL_WALLET_NOT_SUBMITTED' }));
    let hash = attempt.replacementHash ?? attempt.transactionHash;
    let raw = hash ? await rpc('eth_getTransactionReceipt', [hash]) : null;
    if (raw === null && attempt.step === 'DEPOSIT') {
      const scan = await discoverDeposit(rpc, d, record, attempt);
      if (scan.nextBlock > (attempt.depositScanFrom ?? attempt.preparedAtBlock)) { attempt = { ...attempt, depositScanFrom: scan.nextBlock }; record = await save(replaceAttempt(record, attempt)); }
      if (scan.hash && scan.hash !== hash) {
        const current: UniversalEvmAttempt = { ...attempt, state: 'PENDING', transactionHash: attempt.transactionHash ?? scan.hash,
          replacementHash: attempt.transactionHash !== null && attempt.transactionHash !== scan.hash ? scan.hash : attempt.replacementHash };
        const saved = await save(replaceAttempt({ ...record, error: null }, current)), receipt = await rpc('eth_getTransactionReceipt', [scan.hash]);
        if (!isObject(receipt)) return save({ ...saved, error: 'UNIVERSAL_TRANSACTION_PENDING' });
        return settleEvmSource(saved, current, scan.hash, receipt as Record<string, unknown>);
      }
    }
    if (raw === null) {
      const found = await discoverByNonce(rpc, attempt);
      if (!found.consumed) {
        const pending = evm.quantity(await rpc('eth_getTransactionCount', [record.owner, 'pending']));
        // An abandoned approval request (the wallet never sent it) is dropped; a deposit stays observation-only while its nonce is open.
        if (attempt.step === 'APPROVAL' && now().getTime() - Date.parse(attempt.createdAt) > APPROVAL_ABANDON_MS && pending === BigInt(attempt.nonce)) {
          const next = { ...attempt, state: 'NOT_FOUND' as const, note: 'UNIVERSAL_SUBMISSION_EXPIRED_NOT_EXECUTED' };
          return save(replaceAttempt(deauthorized(record, next.note), next));
        }
        return save({ ...record, error: hash ? 'UNIVERSAL_TRANSACTION_PENDING' : 'UNIVERSAL_TRANSACTION_NOT_OBSERVED' });
      }
      const foundHash = evm.hex(found.tx.hash), t = found.tx;
      const sameIntent = typeof t.to === 'string' && t.to.toLowerCase() === attempt.tx.to && typeof t.input === 'string' && t.input.toLowerCase() === attempt.tx.data &&
        evm.quantity(t.value) === BigInt(attempt.tx.value) && evm.quantity(t.chainId) === BigInt(d.chainId);
      if (!sameIntent) {
        const next = { ...attempt, state: 'NOT_FOUND' as const, transactionHash: attempt.transactionHash ?? foundHash, note: 'UNIVERSAL_NONCE_CONSUMED_BY_DIFFERENT_TRANSACTION' };
        return save(replaceAttempt(attempt.step === 'DEPOSIT' ? { ...deauthorized(record, next.note, record.routeChanges, true) } : deauthorized(record, next.note), next));
      }
      const current: UniversalEvmAttempt = { ...attempt, state: 'PENDING', transactionHash: attempt.transactionHash ?? foundHash,
        replacementHash: attempt.transactionHash !== null && attempt.transactionHash !== foundHash ? foundHash : attempt.replacementHash };
      hash = foundHash;
      raw = await rpc('eth_getTransactionReceipt', [hash]);
      const saved = await save(replaceAttempt(record, current));
      if (raw === null) return save({ ...saved, error: 'UNIVERSAL_TRANSACTION_PENDING' });
      if (!isObject(raw)) fail('UNIVERSAL_RECEIPT_INVALID');
      return settleEvmSource(saved, current, hash, raw as Record<string, unknown>);
    }
    if (!isObject(raw)) fail('UNIVERSAL_RECEIPT_INVALID');
    return settleEvmSource(record, attempt, hash!, raw as Record<string, unknown>);
  }

  // --- Solana attempts --------------------------------------------------------------------------------------------------
  const blockHeight = async (commitment: 'confirmed' | 'finalized') => {
    const height = await input.solanaRpc('getBlockHeight', [{ commitment }]);
    if (!Number.isSafeInteger(height)) fail('SOLANA_RPC_INVALID');
    return height as number;
  };
  const neverSigned = async (holder: string) => {
    const prior = await load(holder), a = prior.attempts.find(x => x.ecosystem === 'SOLANA' && x.state !== 'CANCELLED');
    return !a && prior.attempts.every(x => x.ecosystem !== 'SOLANA' || x.state === 'CANCELLED' && x.transactionHash === null);
  };
  const claimSolana = (kind: 'message' | 'signature', value: string, id: string) => solanaTransactionClaim(input.storage, `${value.replace(/^0x/, '')}.xuni-${kind}`, id,
    kind === 'message' ? 'UNIVERSAL_DUPLICATE_TRANSACTION_SIMULATE_AGAIN' : 'UNIVERSAL_DUPLICATE_SIGNATURE_NOT_SUBMITTED', kind === 'message' ? neverSigned : undefined);
  async function beginSolana(record0: UniversalRecord): Promise<UniversalBegin> {
    let record = record0;
    const review = record.review, src = review.source as SolanaReviewSource;
    const invalidate = async (code: string, changes: readonly RouteChange[] = []): Promise<never> => { await save(deauthorized(record, code, changes, true)); return fail(code); };
    const height = await blockHeight('confirmed');
    if (height >= src.lastValidBlockHeight) return invalidate('UNIVERSAL_REVIEW_EXPIRED');
    try { await sol.assertSolanaRelayProgram(input.solanaRpc, D.solana); } catch { return invalidate('UNIVERSAL_STATE_CHANGED_REVIEW_REQUIRED'); }
    await revalidateRoute(record, invalidate);
    await claimSolana('message', src.messageHash, record.id);
    const attempt: UniversalSolanaAttempt = { ecosystem: 'SOLANA', attemptId: `${record.id}.deposit.${record.attempts.length + 1}`, step: 'DEPOSIT', state: 'PREPARED',
      reviewCommitment: review.commitment, createdAt: now().toISOString(), transactionHash: null, reconciled: false, note: null, messageHash: src.messageHash,
      preparedAtHeight: height, lastValidBlockHeight: src.lastValidBlockHeight, transaction: null, walletGuard: null, feeLamports: null };
    const route = review.route;
    record = await claim(`order-${route.order.orderId.slice(2, 34)}`, `order-${route.order.orderId.slice(2)}.xuni-order`, 'UNIVERSAL_ORDER_IN_FLIGHT_SIMULATE_AGAIN', record,
      attempt.attemptId, () => save({ ...record, attempts: [...record.attempts, attempt], error: null }));
    return { record, attempt, ecosystem: 'SOLANA', unsignedTransaction: src.unsignedTransaction, walletChain: D.solana.walletChain };
  }
  async function observeSolanaAttempt(record: UniversalRecord, attempt: UniversalSolanaAttempt): Promise<UniversalRecord> {
    if (attempt.state === 'PREPARED')
      return save(replaceAttempt(deauthorized(record, 'UNIVERSAL_WALLET_NOT_SUBMITTED'), { ...attempt, state: 'CANCELLED', note: 'UNIVERSAL_WALLET_NOT_SUBMITTED' }));
    if (!attempt.transactionHash || !attempt.transaction) return save({ ...record, error: 'UNIVERSAL_TRANSACTION_NOT_OBSERVED' });
    // Height before status: if finalized height is past validity and the signature is still unknown, it can never land.
    const finalized = await blockHeight('finalized');
    const statuses = await input.solanaRpc('getSignatureStatuses', [[attempt.transactionHash], { searchTransactionHistory: true }]);
    const value = isObject(statuses) && Array.isArray((statuses as Record<string, unknown>).value) ? ((statuses as Record<string, unknown>).value as unknown[])[0] : fail('SOLANA_RPC_INVALID');
    if (value === null || value === undefined) {
      if (finalized > attempt.lastValidBlockHeight) {
        const landed = await input.solanaRpc('getTransaction', [attempt.transactionHash, { encoding: 'base64', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]);
        if (landed === null) {
          const next = { ...attempt, state: 'NOT_FOUND' as const, note: 'UNIVERSAL_TRANSACTION_EXPIRED_NOT_EXECUTED' };
          return save(replaceAttempt(deauthorized(record, next.note, record.routeChanges, true), next));
        }
      }
      return save(replaceAttempt({ ...record, error: 'UNIVERSAL_TRANSACTION_NOT_OBSERVED' }, attempt.state === 'SUBMITTING' ? { ...attempt, state: 'SUBMISSION_RESULT_UNKNOWN' } : attempt));
    }
    const s = isObject(value) ? value as Record<string, unknown> : fail('SOLANA_RPC_INVALID');
    const pending = attempt.state === 'PENDING' ? attempt : { ...attempt, state: 'PENDING' as const };
    if (s.confirmationStatus !== 'finalized') return save(replaceAttempt({ ...record, error: 'UNIVERSAL_AWAITING_SOURCE_FINALITY' }, pending));
    let landed: Awaited<ReturnType<typeof sol.verifySolanaDeposit>>;
    try { landed = await sol.verifySolanaDeposit(input.solanaRpc, record.review.route, attempt.transactionHash, attempt.transaction, programIdOf(record.review.tokens.input)); }
    catch (cause) {
      const code = cause instanceof Error && /^UNIVERSAL_[A-Z0-9_]+$/.test(cause.message) ? cause.message : null;
      if (!code) throw cause;
      return save(replaceAttempt(divergent(record, code), { ...pending, state: 'RECONCILIATION_REQUIRED', note: code }));
    }
    if (!landed) return save(replaceAttempt({ ...record, error: 'UNIVERSAL_AWAITING_SOURCE_FINALITY' }, pending));
    if (landed.status === 'REVERTED') return save(replaceAttempt({ ...transition(record, 'FAILED'), verdict: 'FAILED', authorization: null, error: 'UNIVERSAL_DEPOSIT_REVERTED',
      feeObligation: feeObligationFor(record.review.route, 'FAILED') },
      { ...pending, state: 'REVERTED', feeLamports: landed.fee.toString(), note: 'UNIVERSAL_DEPOSIT_REVERTED' }));
    const settled: SourceSettlement = { chainId: record.review.route.sourceChain, transactionHash: attempt.transactionHash, position: { kind: 'SLOT', height: landed.slot },
      blockHash: null, timestamp: landed.timestamp, orderId: record.review.route.order.orderId, ownerDebit: landed.ownerDebit.toString(), final: true, confirmedAt: now().toISOString() };
    return save(replaceAttempt({ ...transition(record, 'SOURCE_CONFIRMED'), authorization: null, source: settled, error: null },
      { ...pending, state: 'CONFIRMED', reconciled: true, feeLamports: landed.fee.toString() }));
  }

  // --- settlement -------------------------------------------------------------------------------------------------------
  async function hint(record: UniversalRecord): Promise<ProviderStatusHint | null> {
    try { return await relay.status(record.review.route); } catch { return null; } // a provider outage never blocks chain observation
  }
  const sameHint = (a: ProviderStatusHint | null, b: ProviderStatusHint | null) => canonical(a && { ...a, rawHash: null }) === canonical(b && { ...b, rawHash: null });
  type Credit = { ok: true; delivery: Omit<DestinationDelivery, 'discoveredBy' | 'final'>; final: boolean } | { ok: false; reason: string };
  async function verifyCredit(chain: string, hash: string, recipient: string, token: UniversalToken, minimum: bigint, orderId: string): Promise<Credit> {
    const network = universalNetworkOfChain(chain)!;
    if (network.ecosystem === 'EVM') {
      if (!/^0x[0-9a-f]{64}$/.test(hash)) return { ok: false, reason: 'INVALID_HASH' };
      const { rpc } = evmOf(chain), check = await evm.verifyEvmCredit(rpc, { hash, recipient, token: token.address, minimum, orderId });
      if (!check.ok) return { ok: false, reason: check.reason };
      const safe = await evm.evmSafeHead(rpc);
      return { ok: true, final: check.blockNumber <= safe, delivery: { chainId: chain, transactionHash: hash, position: { kind: 'BLOCK', height: check.blockNumber },
        blockHash: check.blockHash, timestamp: check.timestamp, recipient, token: token.address ?? 'native', amount: check.amount.toString(), orderBound: check.orderBound,
        contentHash: check.contentHash } };
    }
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(hash)) return { ok: false, reason: 'INVALID_HASH' };
    const check = await sol.verifySolanaCredit(input.solanaRpc, { signature: hash, recipient, mint: token.address, minimum, orderId });
    if (!check.ok) return { ok: false, reason: check.reason };
    return { ok: true, final: true, delivery: { chainId: chain, transactionHash: hash, position: { kind: 'SLOT', height: check.slot }, blockHash: null, timestamp: check.timestamp,
      recipient, token: token.address ?? 'native', amount: check.amount.toString(), orderBound: check.orderBound, contentHash: check.contentHash } };
  }
  async function findDelivery(record: UniversalRecord, h: ProviderStatusHint): Promise<{ delivery: DestinationDelivery } | { divergent: string } | { waiting: string }> {
    const route = record.review.route;
    let waiting = 'UNIVERSAL_DESTINATION_PENDING';
    for (const hash of h.destinationTxHashes) {
      const check = await verifyCredit(route.destinationChain, hash, route.recipient, route.outputToken, BigInt(route.minimumOutput), route.order.orderId);
      if (check.ok) {
        try { await claimSettlementTx('delivery', hash, record.id); } catch { return { divergent: 'UNIVERSAL_DELIVERY_CLAIMED_BY_ANOTHER_RUN' }; }
        return { delivery: { ...check.delivery, discoveredBy: 'PROVIDER_HINT', final: check.final } };
      }
      if (check.reason === 'BELOW_MINIMUM') return { divergent: 'UNIVERSAL_DELIVERY_BELOW_MINIMUM' };
      if (check.reason === 'NO_CREDIT' || check.reason === 'REVERTED') return { divergent: 'UNIVERSAL_DELIVERY_RECIPIENT_MISMATCH' };
      waiting = check.reason === 'UNVERIFIABLE_NATIVE' ? 'UNIVERSAL_DELIVERY_NOT_INDEPENDENTLY_VERIFIABLE' : 'UNIVERSAL_DELIVERY_AWAITING_FINALITY';
    }
    return { waiting };
  }
  /** A refund verified on chain: the order allows refunds to the owner on the source chain (input token) or to the recipient on the destination chain. */
  async function findRefund(record: UniversalRecord, h: ProviderStatusHint): Promise<UniversalRecord['refund']> {
    const route = record.review.route;
    for (const hash of h.refundTxHashes) {
      for (const [chain, recipient, token] of [[route.sourceChain, route.depositor, route.inputToken], [route.destinationChain, route.recipient, route.outputToken]] as const) {
        const network = universalNetworkOfChain(chain)!;
        if (network.ecosystem === 'EVM' ? !/^0x[0-9a-f]{64}$/.test(hash) : !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(hash)) continue;
        let check: Credit;
        try { check = await verifyCredit(chain, hash, recipient, token, 1n, route.order.orderId); } catch { continue; }
        if (check.ok && check.final) {
          await claimSettlementTx('refund', hash, record.id);
          return { chainId: chain, transactionHash: hash, recipient, token: token.address ?? 'native', amount: check.delivery.amount };
        }
      }
    }
    return null;
  }
  async function sourceFinal(record: UniversalRecord): Promise<boolean | 'REORGANIZED'> {
    const s = record.source!;
    if (s.final) return true;
    const { rpc } = evmOf(s.chainId), safe = await evm.evmSafeHead(rpc);
    if (s.position.height > safe) return false;
    const block = await rpc('eth_getBlockByNumber', [evm.tag(s.position.height), false]);
    return isObject(block) && evm.hex((block as Record<string, unknown>).hash) === s.blockHash ? true : 'REORGANIZED';
  }
  async function observeSettlement(record0: UniversalRecord): Promise<UniversalRecord> {
    let record = record0;
    const finality = await sourceFinal(record);
    if (finality === 'REORGANIZED') return save(divergent(record, 'UNIVERSAL_SOURCE_REORGANIZED'));
    if (finality && !record.source!.final) record = { ...record, source: { ...record.source!, final: true } };
    if (record.phase === 'SOURCE_CONFIRMED' && record.source!.final) record = transition(record, 'IN_FLIGHT');
    if (!record.destination) {
      const h = await hint(record);
      if (h && !sameHint(h, record.lastHint)) record = { ...record, lastHint: h };
      if (h?.status === 'FILLED') {
        const found = await findDelivery(record, h);
        if ('divergent' in found) return save(divergent(record, found.divergent));
        if ('delivery' in found) record = await save({ ...transition(record, 'DESTINATION_OBSERVED'), destination: found.delivery, received: found.delivery.amount, error: null });
        else return save({ ...record, error: found.waiting });
      } else if (h?.status === 'REFUNDED') {
        const refund = await findRefund(record, h);
        // Recovery is recorded before the refund, so the history shows the run left the normal settlement path first.
        if (record.phase !== 'RECOVERY_REQUIRED') record = await save({ ...transition(record, 'RECOVERY_REQUIRED'), error: 'UNIVERSAL_REFUND_NOT_OBSERVED' });
        if (refund) return save({ ...transition(record, 'REFUNDED'), verdict: 'REFUNDED', refund, error: null,
          feeObligation: feeObligationFor(record.review.route, 'REFUNDED') });
        return save({ ...record, error: 'UNIVERSAL_REFUND_NOT_OBSERVED' });
      } else {
        // No delivery yet: past the attention window (or a provider failure report) the run needs attention; it keeps observing and verifies a late fill or a refund.
        const late = now().getTime() - Date.parse(record.source!.confirmedAt) > D.deliveryAttentionSeconds * 1000;
        if ((late || h?.status === 'FAILED') && record.phase !== 'RECOVERY_REQUIRED')
          return save({ ...transition(record, 'RECOVERY_REQUIRED'), error: h?.status === 'FAILED' ? 'UNIVERSAL_PROVIDER_REPORTED_FAILURE_REFUND_EXPECTED' : 'UNIVERSAL_DELIVERY_DELAYED' });
        return save({ ...record, error: h?.status === 'DELAYED' ? 'UNIVERSAL_DELIVERY_DELAYED' : record.phase === 'RECOVERY_REQUIRED' ? record.error : 'UNIVERSAL_DESTINATION_PENDING' });
      }
    }
    if (record.destination && !record.destination.final) {
      const d = record.destination;
      if (d.position.kind === 'BLOCK') {
        const { rpc } = evmOf(d.chainId), safe = await evm.evmSafeHead(rpc);
        if (d.position.height <= safe) {
          const block = await rpc('eth_getBlockByNumber', [evm.tag(d.position.height), false]);
          if (!isObject(block) || evm.hex((block as Record<string, unknown>).hash) !== d.blockHash) return save(divergent(record, 'UNIVERSAL_DESTINATION_REORGANIZED'));
          record = { ...record, destination: { ...d, final: true } };
        }
      }
    }
    if (record.source!.final && record.destination?.final) {
      const feeObligation = feeObligationFor(record.review.route, 'RECONCILED');
      const evidence = buildEvidence(record, feeObligation);
      return save({ ...transition(record, 'RECONCILED'), evidence, verdict: 'RECONCILED', error: null, feeObligation });
    }
    return save({ ...record, error: record.destination ? 'UNIVERSAL_AWAITING_FINALITY' : record.error });
  }
  function buildEvidence(record: UniversalRecord, feeObligation: NonNullable<UniversalRecord['feeObligation']>): UniversalEvidence {
    const source = record.source!, destination = record.destination!, route = record.review.route, a = record.review.artifacts;
    const evidenceClass = universalEvidenceClass(provenance), network = universalNetworkOfChain(route.sourceChain)!;
    const asset = (t: UniversalToken) => t.kind === 'NATIVE' ? { chainId: t.chainId, nativeId: universalNetworkOfChain(t.chainId)!.native.nativeId, decimals: t.decimals }
      : { chainId: t.chainId, address: t.address!, decimals: t.decimals };
    const networkFee = record.attempts.reduce((sum, x) => sum + (x.ecosystem === 'EVM' ? BigInt(x.receipt?.gasCostWei ?? '0') : BigInt(x.feeLamports ?? '0')), 0n);
    const included = route.fees.filter(f => f.included && f.chainId === route.sourceChain && f.token === (route.inputToken.address ?? 'native')).reduce((s, f) => s + BigInt(f.amount), 0n);
    const transactions = [...record.attempts.filter(x => x.state === 'CONFIRMED' && x.transactionHash).map(x => ({ chain: route.sourceChain, step: x.step,
      transactionHash: x.transactionHash!, explorer: universalExplorerTx(route.sourceChain, x.transactionHash!, D) })),
      { chain: route.destinationChain, step: 'DELIVERY', transactionHash: destination.transactionHash, explorer: universalExplorerTx(route.destinationChain, destination.transactionHash, D) }];
    const bundle = validateArtifact('evidence-bundle', { schemaVersion: '1.0.0', evidenceBundleId: record.id + '.evidence', version: 1, supersedes: null,
      semanticWorkflowHash: a.hashes.workflow, artifactSetHash: a.hashes.artifactSet, simulationHash: a.hashes.simulation, policyHash: a.hashes.policy,
      manifestHash: a.hashes.manifest, executionPlanHash: a.hashes.plan, journalHeadHash: digest(record), observedAt: now().toISOString(),
      environment: evidenceClass, outcome: 'RECONCILED',
      receipts: [{ receiptId: source.transactionHash, contentHash: digest(source) }, { receiptId: destination.transactionHash, contentHash: destination.contentHash }],
      differences: [], reconciliation: {
        balances: [{ asset: asset(route.outputToken), amount: destination.amount }], allowances: [], debt: [], positions: [],
        fees: [{ asset: { chainId: route.sourceChain, nativeId: network.native.nativeId, decimals: network.native.decimals }, amount: networkFee.toString() },
          { asset: asset(route.inputToken), amount: included.toString() }],
        residualAssets: [], ownership: [{ chainId: route.sourceChain, address: record.owner }, { chainId: route.destinationChain, address: route.recipient }],
        limitations: [provenance === 'PUBLIC_MAINNET' ? 'PUBLIC_MAINNET_OWNER_EXECUTED' : 'MOCKED_CHAINS_ONLY',
          destination.orderBound ? 'DELIVERY_REFERENCES_ORDER_ON_CHAIN' : 'DELIVERY_REFERENCED_BY_PROVIDER_STATUS', 'SOURCE_AND_DESTINATION_FINAL',
          'FLOFI_FEE_OBLIGATION_RECORDED_NOT_COLLECTED'] },
      evidence: [{ evidenceId: 'route-commitment', kind: 'EXTERNAL_REFERENCE', contentHash: record.review.routeCommitment },
        { evidenceId: 'provider-order', kind: 'EXTERNAL_REFERENCE', contentHash: digest(route.order) },
        { evidenceId: 'source-deposit', kind: 'EXTERNAL_REFERENCE', contentHash: digest(source) },
        { evidenceId: 'destination-delivery', kind: 'EXTERNAL_REFERENCE', contentHash: digest(destination) },
        { evidenceId: 'flofi-fee-obligation', kind: 'EXTERNAL_REFERENCE', contentHash: digest(feeObligation) },
        { evidenceId: 'public-explorer', kind: 'EXTERNAL_REFERENCE', contentHash: digest(transactions.map(t => t.explorer).join('\n')) }] }) as EvidenceBundle;
    return { bundle, bundleHash: hashArtifactBytes('evidence-bundle', new TextEncoder().encode(JSON.stringify(bundle))), evidenceClass,
      route: { provider: route.provider, protocol: route.protocol, routeCommitment: record.review.routeCommitment, orderId: route.order.orderId, manifestHash: a.hashes.manifest },
      source, destination, recipient: route.recipient, minimumOutput: route.minimumOutput, received: destination.amount, feeObligation, transactions, reconciliation: 'RECONCILED',
      observedAt: now().toISOString() };
  }

  return {
    executionEnabled, deployment: D,
    /** Read-only: a new run with fresh quotes, a fresh simulation and a route-bound Manifest for this owner. */
    async simulate(workflowInput: unknown, ownerInput: string, destinationWallet?: string): Promise<UniversalRecord> {
      const workflow = workflowInput as SemanticWorkflow, review = await buildReview(workflow, ownerInput, destinationWallet);
      return save({ format: 'flofi.universal-bridge-run.v1', id: 'xuni-' + randomBytes(16).toString('hex'), provenance, workflow, owner: review.owner, review,
        authorization: null, phase: 'PREPARED', attempts: [], source: null, destination: null, refund: null, lastHint: null, routeChanges: [], requote: false, evidence: null,
        verdict: 'PENDING', error: null, received: null, feeObligation: null });
    },
    /** New quote, simulation and Review for the same run; only before any deposit can exist. */
    async refresh(id: string, destinationWallet?: string): Promise<UniversalRecord> { return locked(id, async () => {
      const record = await load(id);
      if (record.verdict !== 'PENDING' || active(record) || !['PREPARED', 'AUTHORIZED'].includes(record.phase) ||
          record.attempts.some(a => a.step === 'DEPOSIT' && !['CANCELLED', 'NOT_FOUND'].includes(a.state))) fail('UNIVERSAL_REFRESH_NOT_ALLOWED');
      const wallet = destinationWallet ?? (record.review.recipientKind === 'CONNECTED_DESTINATION_WALLET' ? record.review.recipient : undefined);
      const review = await buildReview(record.workflow, record.owner, wallet);
      if (review.owner !== record.owner) fail('UNIVERSAL_WRONG_OWNER');
      return save({ ...record, phase: 'PREPARED', review, authorization: null, error: null, requote: false, routeChanges: compareUniversalRoutes(record.review.route, review.route, 'REQUOTE') });
    }); },
    async review(id: string, commitment: string, workflow: SemanticWorkflow): Promise<UniversalRecord> { return locked(id, async () => {
      const record = await load(id);
      if (!sameWorkflow(workflow, record.workflow)) fail('UNIVERSAL_SEMANTIC_REVISION_CHANGED');
      if (record.verdict !== 'PENDING' || active(record) || record.phase !== 'PREPARED') fail('UNIVERSAL_REVIEW_NOT_ALLOWED');
      if (record.requote) fail('UNIVERSAL_REQUOTE_REQUIRED');
      if (commitment !== record.review.commitment) fail('UNIVERSAL_REVIEW_CHANGED');
      if (now().getTime() >= Date.parse(record.review.expiresAt)) fail('UNIVERSAL_REVIEW_EXPIRED');
      return save({ ...record, phase: 'AUTHORIZED', authorization: commitment, error: null });
    }); },
    /** Retires an unused authorization: a workflow edit or a wallet account change in the owner's browser after Review. */
    async invalidate(id: string, reason: 'SEMANTIC_EDIT' | 'WALLET_CHANGED' = 'SEMANTIC_EDIT'): Promise<UniversalRecord> { return locked(id, async () => {
      const record = await load(id);
      if (reason !== 'SEMANTIC_EDIT' && reason !== 'WALLET_CHANGED') fail('UNIVERSAL_INVALIDATION_REASON_INVALID');
      return record.authorization && record.phase === 'AUTHORIZED' && !active(record)
        ? save(deauthorized(record, reason === 'WALLET_CHANGED' ? 'UNIVERSAL_WALLET_CHANGED_REVIEW_REQUIRED' : 'UNIVERSAL_SEMANTIC_EDIT_REQUIRES_REVIEW')) : record;
    }); },
    /**
     * Re-verifies the Review against fresh chain state, re-quotes the SAME provider and compares (no fallback of any kind), re-simulates
     * the remaining reviewed calls (EVM), claims the attempt's identities and persists PREPARED with the exact wallet request.
     */
    async begin(id: string, ownerInput: string, workflow: SemanticWorkflow): Promise<UniversalBegin> { return locked(id, async () => {
      const record = await load(id);
      if (!executionEnabled) fail('UNIVERSAL_EXECUTION_NOT_ENABLED');
      const network = universalNetworkOfChain(record.review.route.sourceChain)!, owner = canonicalUniversalAddress(network, ownerInput, 'UNIVERSAL_OWNER_INVALID');
      if (owner !== record.owner) fail('UNIVERSAL_WRONG_OWNER');
      if (!sameWorkflow(workflow, record.workflow)) fail('UNIVERSAL_SEMANTIC_REVISION_CHANGED');
      if (record.verdict !== 'PENDING' || UNIVERSAL_SETTLING.includes(record.phase)) fail('UNIVERSAL_DEPOSIT_ALREADY_CONFIRMED');
      if (active(record)) fail('UNIVERSAL_ATTEMPT_ACTIVE_OBSERVE_EXISTING');
      if (record.phase !== 'AUTHORIZED' || record.authorization !== record.review.commitment) fail('UNIVERSAL_REVIEW_REQUIRED');
      if (now().getTime() >= Date.parse(record.review.expiresAt)) { await save(deauthorized(record, 'UNIVERSAL_REVIEW_EXPIRED', [], true)); fail('UNIVERSAL_REVIEW_EXPIRED'); }
      if (record.attempts.some(a => a.step === 'DEPOSIT' && !['CANCELLED', 'NOT_FOUND'].includes(a.state))) fail('UNIVERSAL_DEPOSIT_MAY_EXIST_OBSERVE');
      return network.ecosystem === 'EVM' ? beginEvm(record, owner) : beginSolana(record);
    }); },
    /** EVM: the handoff boundary; SUBMITTING is durable before the browser calls the wallet. */
    async handoff(id: string): Promise<UniversalRecord> { return locked(id, async () => {
      const record = await load(id), attempt = record.attempts.at(-1);
      if (!executionEnabled || attempt?.ecosystem !== 'EVM' || attempt.state !== 'PREPARED' || record.authorization !== attempt.reviewCommitment ||
          now().getTime() >= Date.parse(record.review.expiresAt)) fail('UNIVERSAL_WALLET_HANDOFF_NOT_AUTHORIZED');
      const a = attempt as UniversalEvmAttempt, { d, rpc } = evmOf(record.review.route.sourceChain);
      const [latest, pending] = await Promise.all([rpc('eth_getTransactionCount', [record.owner, 'latest']).then(evm.quantity),
        rpc('eth_getTransactionCount', [record.owner, 'pending']).then(evm.quantity)]);
      if (pending !== BigInt(a.nonce) || latest > pending) fail('UNIVERSAL_NONCE_CHANGED');
      await assertRequestFees(record.review, a.tx, rpc, d, 'latest', async code => {
        await save(replaceAttempt(deauthorized(record, code, [], true), { ...a, state: 'CANCELLED', note: code }));
        return fail(code);
      });
      const next = replaceAttempt(record, { ...a, state: 'SUBMITTING' });
      return save(a.step === 'DEPOSIT' ? transition(next, 'SOURCE_SUBMITTED') : next);
    }); },
    /** EVM wallet result. A hash is recorded once (a repeated identical report is a no-op); ambiguity is observed, never resent. */
    async report(id: string, result: { kind: 'HASH'; hash: string } | { kind: 'UNKNOWN' | 'REJECTED'; code?: string }): Promise<UniversalRecord> { return locked(id, async () => {
      const record = await load(id), attempt = record.attempts.at(-1);
      if (!attempt || attempt.ecosystem !== 'EVM') fail('UNIVERSAL_ATTEMPT_MISSING');
      const a = attempt as UniversalEvmAttempt;
      if (result.kind === 'HASH') {
        const hash = result.hash.toLowerCase();
        if (!/^0x[0-9a-f]{64}$/.test(hash)) fail('UNIVERSAL_HASH_INVALID');
        if (a.transactionHash) { if (a.transactionHash !== hash) fail('UNIVERSAL_HASH_DIVERGENT'); return record; }
        if (!['SUBMITTING', 'SUBMISSION_RESULT_UNKNOWN'].includes(a.state)) fail('UNIVERSAL_ATTEMPT_STATE_INVALID');
        return save(replaceAttempt({ ...record, error: null }, { ...a, state: 'PENDING', transactionHash: hash }));
      }
      if (a.state !== 'SUBMITTING') return record;
      return save(replaceAttempt({ ...record, error: 'UNIVERSAL_SUBMISSION_UNKNOWN' }, { ...a, state: 'SUBMISSION_RESULT_UNKNOWN',
        note: result.kind === 'REJECTED' ? 'UNIVERSAL_REPORTED_REJECTED_UNPROVEN' : 'UNIVERSAL_SUBMISSION_UNKNOWN' }));
    }); },
    /** Solana: verify the reviewed bytes (or a verified Lighthouse guard) and the owner signature, persist both, then broadcast exactly once. */
    async submit(id: string, signedTransaction: string): Promise<UniversalRecord> { return locked(id, async () => {
      const record = await load(id), attempt = record.attempts.at(-1);
      if (!executionEnabled || attempt?.ecosystem !== 'SOLANA' || attempt.state !== 'PREPARED' || record.authorization !== attempt.reviewCommitment)
        fail('UNIVERSAL_WALLET_HANDOFF_NOT_AUTHORIZED');
      const a = attempt as UniversalSolanaAttempt, src = record.review.source as SolanaReviewSource;
      let signed: SignedSolanaTransaction;
      try {
        signed = verifySignedSolanaSwap({ message: src.message, owner: record.owner }, signedTransaction, 'UNIVERSAL');
        if (now().getTime() >= Date.parse(record.review.expiresAt) || await blockHeight('confirmed') >= src.lastValidBlockHeight) fail('UNIVERSAL_QUOTE_STALE');
        await claimSolana('signature', signed.signature, id);
      } catch (cause) {
        const failure = cause instanceof Error && CODE.test(cause.message) ? cause.message : 'UNIVERSAL_TRANSACTION_CHANGED';
        let change: SolanaWalletChange | undefined;
        if (failure === 'UNIVERSAL_TRANSACTION_CHANGED') try { change = describeSolanaWalletChange(src.message, signedTransaction, {}); } catch { change = undefined; }
        return save(replaceAttempt(deauthorized(record, failure), { ...a, state: 'CANCELLED', note: failure, ...change ? { walletChange: change } : {} }));
      }
      const submitting = await save(replaceAttempt(transition({ ...record, error: null }, 'SOURCE_SUBMITTED'),
        { ...a, state: 'SUBMITTING', transactionHash: signed.signature, transaction: signed.transaction, walletGuard: signed.walletGuard ?? null }));
      const current = submitting.attempts.at(-1) as UniversalSolanaAttempt;
      try {
        const result = await input.solanaRpc('sendTransaction', [signed.transaction, { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 10 }]);
        if (result !== signed.signature) fail('UNIVERSAL_SUBMISSION_RESULT_MISMATCH');
        return save(replaceAttempt(submitting, { ...current, state: 'PENDING' }));
      } catch {
        // The signature is durable; observation by signature resolves this. There is never a second deposit.
        return save(replaceAttempt({ ...submitting, error: 'UNIVERSAL_SUBMISSION_UNKNOWN_OBSERVE_EXISTING' }, { ...current, state: 'SUBMISSION_RESULT_UNKNOWN' }));
      }
    }); },
    /** Records a proven pre-broadcast failure or refusal. Anything that may have reached the network stays observation-only. */
    async walletFailure(id: string, diagnostic: UniversalWalletDiagnostic): Promise<UniversalRecord> { return locked(id, async () => {
      const record = await load(id), attempt = record.attempts.at(-1);
      if (JSON.stringify(diagnostic).length > 65_536 || typeof diagnostic.invoked !== 'boolean' || !Array.isArray(diagnostic.calls) || !/^UNIVERSAL_[A-Z0-9_]{2,70}$/.test(diagnostic.code))
        fail('UNIVERSAL_DIAGNOSTIC_INVALID');
      if (!attempt || attempt.transactionHash) fail('UNIVERSAL_DIAGNOSTIC_NOT_PRE_SUBMISSION');
      if (attempt!.ecosystem === 'SOLANA') {
        // The wallet never returned signed bytes: FloFi holds nothing it could broadcast.
        if (attempt!.state !== 'PREPARED') fail('UNIVERSAL_DIAGNOSTIC_NOT_PRE_SUBMISSION');
        return save(replaceAttempt(deauthorized(record, diagnostic.code), { ...attempt!, state: 'CANCELLED', note: diagnostic.code }));
      }
      const send = diagnostic.calls.find(c => c.submission === true), error = send?.error as { code?: unknown } | undefined;
      const refused = diagnostic.invoked && send !== undefined && send.result === undefined && typeof error?.code === 'number' && error.code === diagnostic.rejectionCode &&
        REFUSALS.includes(error.code);
      if ((diagnostic.invoked || send) && !refused || !['PREPARED', 'SUBMITTING', 'SUBMISSION_RESULT_UNKNOWN'].includes(attempt!.state)) fail('UNIVERSAL_DIAGNOSTIC_NOT_PRE_SUBMISSION');
      return save(replaceAttempt(deauthorized(record, diagnostic.code), { ...attempt!, state: 'CANCELLED', note: diagnostic.code }));
    }); },
    /** Read-only observation and reconciliation (API and worker). There is no send path here. */
    async observe(id: string): Promise<UniversalRecord> { return locked(id, async () => {
      let record = await load(id);
      if (record.verdict !== 'PENDING') return record;
      const attempt = active(record);
      if (attempt) {
        record = attempt.ecosystem === 'EVM' ? await observeEvmAttempt(record, attempt) : await observeSolanaAttempt(record, attempt);
        if (record.verdict !== 'PENDING' || active(record)) return record;
      }
      return UNIVERSAL_SETTLING.includes(record.phase) ? observeSettlement(record) : record;
    }); },
    load,
  };
}
export type UniversalRouterService = ReturnType<typeof createUniversalRouterService>;
export { solanaAddress };
