// SPDX-License-Identifier: AGPL-3.0-only
import { solanaRpcU64, ORCA_WHIRLPOOLS_DEVNET, assertKoraRelayedAttempt, assertRecordedSolanaWalletGuard, decompileMessageV0, fromBase64, koraCreatedAccounts, parseMessageV0,
  parseOrcaTradedEvents, parseTransaction, requireSolanaSwapRuntime, solanaSwapArtifactHash, solanaSwapHash, verifySolanaCluster, base58Encode, type KoraGasTerms, type OrcaTradedEvent,
  type SolanaSwapReview, type SolanaRpc, type SolanaWalletGuard } from '@defi-workflow-engine/reference-compiler';
import { hashJournalBytes, type EvidenceBundle, type ExecutionJournal } from '@defi-workflow-engine/workflow-contracts';

/**
 * `walletGuard`: the verified Lighthouse assertions the owner's wallet appended (HOTFIX-PHANTOM-LIGHTHOUSE-001); absent for the reviewed bytes.
 * `kora` (ADR-0010 §4): the owner's signature and the fully signed bytes Kora returned; `transaction` is then the owner-signed bytes.
 */
export type JupiterChainAttempt = { signature: string | null; transaction: string | null; walletGuard?: SolanaWalletGuard;
  kora?: { ownerSignature: string; signedTransaction: string | null } };
/**
 * ADR-0010: what the owner paid for the network fee in a token, proven from the transaction's own balances: Kora's fee payer (`feePayer`) fronted
 * `feeLamports` (the network fee plus any rent it advanced is its own outflow), and the owner's repayment of `amount` reached `payee`'s account.
 */
export type KoraFeeObservation = { mechanism: KoraGasTerms['mechanism']; feePayer: string; feeLamports: string; token: KoraGasTerms['token']; amount: string;
  payee: string; paymentAccount: string };
/** The bytes a chain attempt broadcast: the owner-signed bytes (native), or Kora's fully signed bytes after verifying they complete them (Kora). */
export function relayedChainBytes(gas: KoraGasTerms | undefined, attempt: JupiterChainAttempt, mismatch: string): string | null {
  if (!gas) return attempt.transaction;
  const relayed = attempt.kora?.signedTransaction ?? null;
  if (!relayed || !attempt.signature || !attempt.transaction) return null;
  try { assertKoraRelayedAttempt(attempt.transaction, attempt.kora!.ownerSignature, relayed, attempt.signature, gas.feePayer); } catch { return fail(mismatch); }
  return relayed;
}
/**
 * ADR-0010: Kora's share of a finalized transaction's lamport movements. The fee payer (key 0) pays the fee and the rent of the ATAs it creates;
 * a created ATA that is closed again in the same transaction (the temporary wrapped-SOL account) returns that rent to the owner: `refund`.
 */
export function koraLamportRefund(keys: readonly string[], pre: readonly bigint[], post: readonly bigint[], fee: bigint, created: readonly string[], code: string): bigint {
  const outflow = pre[0]! - post[0]! - fee;
  const kept = created.reduce((sum, account) => { const i = keys.indexOf(account); return i >= 0 && pre[i] === 0n ? sum + post[i]! : sum; }, 0n);
  const refund = outflow - kept;
  return refund < 0n ? fail(code) : refund;
}
export type SolanaSwapChainAttempt = JupiterChainAttempt;
export type JupiterObservation = { verdict: 'RECONCILED' | 'DIVERGENT' | 'INCONCLUSIVE'; reason: string; found: boolean; signature: string | null;
  confirmation: string | null; slot: number | null; blockTime: number | null; feeLamports: string | null;
  owner: { lamportsBefore: string; lamportsAfter: string; inputBefore: string; inputAfter: string; outputBefore: string; outputAfter: string } | null;
  inputSpent: string | null; outputReceived: string | null; accountCreationLamports: string | null; minimumOutput: string;
  programs: string[]; innerPrograms: string[]; explorer: string | null;
  /** Devnet runtime only: Orca's own on-chain Traded event for the swap. */
  trade?: OrcaTradedEvent | null;
  /** The wallet guard re-verified against the Review for this exact signed transaction (only when the wallet appended one). */
  walletGuard?: SolanaWalletGuard;
  /** ADR-0010: the network fee was fronted by Kora and repaid by the owner in a token (only for a Kora Review, once balances were verified). */
  tokenFee?: KoraFeeObservation };
export type SolanaSwapObservation = JupiterObservation;
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const fail = (code: string): never => { throw new Error(code); };
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : fail('SOLANA_RPC_INVALID');
const lamportList = (v: unknown, n: number): bigint[] => Array.isArray(v) && v.length === n
  ? v.map(value => solanaRpcU64(value)) : fail('SOLANA_RPC_INVALID');
type TokenBalance = { index: number; mint: string; owner: string; amount: bigint; decimals: number };
function tokenBalances(v: unknown): TokenBalance[] {
  if (!Array.isArray(v)) fail('SOLANA_RPC_INVALID');
  return (v as unknown[]).map(item => {
    const b = record(item), ui = record(b.uiTokenAmount);
    if (!Number.isSafeInteger(b.accountIndex) || typeof b.mint !== 'string' || typeof b.owner !== 'string' || typeof ui.amount !== 'string' ||
        !/^(0|[1-9][0-9]{0,19})$/.test(ui.amount) || !Number.isSafeInteger(ui.decimals) || b.programId !== undefined && b.programId !== TOKEN_PROGRAM) fail('SOLANA_TOKEN_BALANCE_INVALID');
    return { index: b.accountIndex as number, mint: b.mint as string, owner: b.owner as string, amount: BigInt(ui.amount as string), decimals: ui.decimals as number };
  });
}

/**
 * Independent public-chain reconciliation for every runtime of the canonical swap. Success status alone never reconciles:
 * the finalized transaction must be byte-identical to the owner-signed reviewed transaction on the expected cluster, invoke
 * the expected provider program, and the owner's balance deltas must match the semantic intent.
 */
export async function reconcileSolanaSwapAttempt(review: SolanaSwapReview, attempt: JupiterChainAttempt, rpc: SolanaRpc): Promise<JupiterObservation> {
  const runtime = requireSolanaSwapRuntime(review.chain), X = runtime.codePrefix;
  const base: JupiterObservation = { verdict: 'INCONCLUSIVE', reason: 'TRANSACTION_NOT_OBSERVED', found: false, signature: attempt.signature, confirmation: null,
    slot: null, blockTime: null, feeLamports: null, owner: null, inputSpent: null, outputReceived: null, accountCreationLamports: null,
    minimumOutput: review.quote.otherAmountThreshold, programs: [], innerPrograms: [], explorer: attempt.signature ? runtime.explorerTx(attempt.signature) : null,
    ...review.format === 'gryloo.orca-devnet-review.v1' ? { trade: null } : {}, ...attempt.walletGuard ? { walletGuard: attempt.walletGuard } : {} };
  if (!attempt.signature || !attempt.transaction) return base;
  const gas = review.gas;
  try {
    await verifySolanaCluster(rpc, runtime.genesisHash);
    // Kora: the fully signed bytes Kora returned, proven to be the owner-signed bytes plus the pinned signer's slot-0 signature.
    const relayed = relayedChainBytes(gas, attempt, `${X}_TRANSACTION_MISMATCH`);
    if (!relayed) return base;
    const signed = fromBase64(relayed, 2048), parsedSigned = parseTransaction(signed);
    if (base58Encode(parsedSigned.signatures[0]!) !== attempt.signature) fail(`${X}_SIGNATURE_MISMATCH`);
    const statuses = record(await rpc('getSignatureStatuses', [[attempt.signature], { searchTransactionHistory: true }]));
    const status = Array.isArray(statuses.value) ? statuses.value[0] : fail('SOLANA_RPC_INVALID');
    if (!status) return base;
    const s = record(status);
    base.found = true; base.confirmation = typeof s.confirmationStatus === 'string' ? s.confirmationStatus : null;
    if (s.confirmationStatus !== 'finalized') return { ...base, reason: 'AWAITING_FINALITY' };
    const value = await rpc('getTransaction', [attempt.signature, { encoding: 'base64', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]);
    if (!value) return { ...base, reason: 'AWAITING_FINALITY' };
    const tx = record(value), meta = record(tx.meta);
    if (!Array.isArray(tx.transaction) || tx.transaction[1] !== 'base64' || tx.version !== 0 || !Number.isSafeInteger(tx.slot)) fail('SOLANA_RPC_INVALID');
    base.slot = tx.slot as number; base.blockTime = Number.isSafeInteger(tx.blockTime) ? tx.blockTime as number : null;
    // Exact owner-signed bytes, not merely a similar transaction: the reviewed message, or the recorded wallet guard re-verified against it.
    if (Buffer.from(fromBase64((tx.transaction as unknown[])[0], 2048)).toString('base64') !== Buffer.from(signed).toString('base64')) fail(`${X}_TRANSACTION_MISMATCH`);
    try { assertRecordedSolanaWalletGuard(fromBase64(review.message), parsedSigned.message, attempt.walletGuard, review.lookupTables); } catch { fail(`${X}_TRANSACTION_MISMATCH`); }
    if (base.slot < review.simulationResult.slot) fail(`${X}_SLOT_MISMATCH`);
    const message = parseMessageV0(parsedSigned.message);
    const loaded = record(meta.loadedAddresses);
    const instructions = decompileMessageV0(message, review.lookupTables);
    const keys = [...message.staticKeys, ...message.lookups.flatMap(l => l.writable.map(i => review.lookupTables[l.table]![i]!)),
      ...message.lookups.flatMap(l => l.readonly.map(i => review.lookupTables[l.table]![i]!))];
    // On-chain lookup resolution must equal the reviewed resolution.
    if (JSON.stringify(loaded.writable) !== JSON.stringify(keys.slice(message.staticKeys.length, message.staticKeys.length + message.lookups.reduce((n, l) => n + l.writable.length, 0))) ||
        JSON.stringify(loaded.readonly) !== JSON.stringify(keys.slice(message.staticKeys.length + message.lookups.reduce((n, l) => n + l.writable.length, 0)))) fail(`${X}_LOOKUP_MISMATCH`);
    // Native: the owner is the fee payer (key 0). Kora: the pinned signer is key 0 and the owner is found by key, at index 1.
    if (gas ? keys[0] !== gas.feePayer || keys[1] !== review.owner : keys[0] !== review.owner) fail(`${X}_OWNER_MISMATCH`);
    const o = gas ? 1 : 0;
    base.programs = [...new Set(instructions.map(i => i.programId))];
    base.innerPrograms = Array.isArray(meta.innerInstructions) ? [...new Set((meta.innerInstructions as unknown[]).flatMap(group =>
      Array.isArray(record(group).instructions) ? (record(group).instructions as unknown[]).map(i => keys[record(i).programIdIndex as number] ?? fail('SOLANA_RPC_INVALID')) : []))] : [];
    if (!base.programs.includes(runtime.providerProgram)) fail(`${X}_PROGRAM_MISMATCH`);
    const fee = solanaRpcU64(meta.fee);
    base.feeLamports = fee.toString();
    if (meta.err !== null) return { ...base, verdict: 'DIVERGENT', reason: `${X}_SWAP_FAILED` };
    if (fee > BigInt(review.estimatedFeeLamports)) fail(`${X}_FEE_MISMATCH`);
    const pre = lamportList(meta.preBalances, keys.length), post = lamportList(meta.postBalances, keys.length);
    const preTokens = tokenBalances(meta.preTokenBalances), postTokens = tokenBalances(meta.postTokenBalances);
    const { ownerInputAccount, ownerOutputAccount, wrappedSolAccount } = review.inspection;
    const at = (account: string) => keys.indexOf(account);
    const amountOf = (list: TokenBalance[], account: string, mint: string, decimals: number) => {
      const entry = list.find(b => b.index === at(account));
      if (!entry) return 0n;
      if (entry.mint !== mint || entry.owner !== review.owner || entry.decimals !== decimals) fail(`${X}_TOKEN_ACCOUNT_MISMATCH`);
      return entry.amount;
    };
    // ADR-0010: the owner's repayment of the reviewed fee is an expected debit of its fee-token account and an exact credit of the pinned
    // payment account; every other owner movement is still checked exactly.
    const feeLeg = gas ? BigInt(gas.amount) : 0n, feeAccount = gas?.feeAccount ?? null;
    // No unrelated owner asset movement: every other owner token account is unchanged (a separate fee account moves by exactly the repayment).
    for (const entry of [...preTokens, ...postTokens].filter(b => b.owner === review.owner)) {
      const account = keys[entry.index];
      if (account === ownerInputAccount || account === ownerOutputAccount || account === wrappedSolAccount) continue;
      const before = preTokens.find(b => b.index === entry.index)?.amount ?? 0n, after = postTokens.find(b => b.index === entry.index)?.amount ?? 0n;
      if (before - after !== (account === feeAccount ? feeLeg : 0n)) fail(`${X}_UNRELATED_ASSET_MOVEMENT`);
    }
    if (wrappedSolAccount && (at(wrappedSolAccount) < 0 || post[at(wrappedSolAccount)] !== 0n || pre[at(wrappedSolAccount)] !== 0n)) fail(`${X}_WRAPPED_SOL_NOT_CLOSED`);
    const native = (mint: string) => mint === 'So11111111111111111111111111111111111111112';
    const outputIndex = at(ownerOutputAccount);
    // A newly created owner output token account holds a refundable rent deposit paid from owner SOL. Kora: Kora paid every deposit and the
    // fee; the rent of a Kora-funded account closed to the owner (the temporary wrapped-SOL account) is a refund, not swap output.
    const created = !gas && !native(review.output.mint) && outputIndex >= 0 && pre[outputIndex] === 0n ? post[outputIndex]! : 0n;
    const refund = gas ? koraLamportRefund(keys, pre, post, fee, koraCreatedAccounts(instructions, gas.feePayer), `${X}_UNRELATED_ASSET_MOVEMENT`) : 0n;
    const lamports = gas ? post[o]! - pre[o]! - refund : post[0]! - pre[0]! + fee + created;
    const inputBefore = native(review.input.mint) ? pre[o]! : amountOf(preTokens, ownerInputAccount, review.input.mint, review.input.decimals);
    const inputAfter = native(review.input.mint) ? post[o]! : amountOf(postTokens, ownerInputAccount, review.input.mint, review.input.decimals);
    const outputBefore = native(review.output.mint) ? pre[o]! : amountOf(preTokens, ownerOutputAccount, review.output.mint, review.output.decimals);
    const outputAfter = native(review.output.mint) ? post[o]! : amountOf(postTokens, ownerOutputAccount, review.output.mint, review.output.decimals);
    const inputSpent = native(review.input.mint) ? -lamports : inputBefore - inputAfter - (feeAccount === ownerInputAccount ? feeLeg : 0n);
    const outputReceived = native(review.output.mint) ? lamports : outputAfter - outputBefore + (feeAccount === ownerOutputAccount ? feeLeg : 0n);
    // With no native leg, the owner's SOL may change only by the fee and a new token-account deposit (Kora: not at all).
    if (!native(review.input.mint) && !native(review.output.mint) && lamports !== 0n) fail(`${X}_UNRELATED_ASSET_MOVEMENT`);
    if (gas) {
      // The repayment reached the pinned payment account, exactly the reviewed amount, owned by the pinned payment address.
      const payment = at(gas.paymentAccount), credited = (list: TokenBalance[]) => {
        const entry = list.find(b => b.index === payment);
        if (!entry) return 0n;
        if (entry.mint !== gas.token.mint || entry.owner !== gas.paymentAddress || entry.decimals !== gas.token.decimals) fail(`${X}_KORA_PAYMENT_MISMATCH`);
        return entry.amount;
      };
      if (payment < 0 || credited(postTokens) - credited(preTokens) !== feeLeg) fail(`${X}_KORA_PAYMENT_MISMATCH`);
      base.tokenFee = { mechanism: gas.mechanism, feePayer: gas.feePayer, feeLamports: fee.toString(), token: gas.token, amount: gas.amount,
        payee: gas.paymentAddress, paymentAccount: gas.paymentAccount };
    }
    base.owner = { lamportsBefore: pre[o]!.toString(), lamportsAfter: post[o]!.toString(), inputBefore: inputBefore.toString(), inputAfter: inputAfter.toString(),
      outputBefore: outputBefore.toString(), outputAfter: outputAfter.toString() };
    base.inputSpent = inputSpent.toString(); base.outputReceived = outputReceived.toString(); base.accountCreationLamports = created.toString();
    if (inputSpent !== BigInt(review.amount)) fail(`${X}_INPUT_DELTA_MISMATCH`);
    if (outputReceived <= 0n) fail(`${X}_DIRECTION_MISMATCH`);
    if (outputReceived < BigInt(review.quote.otherAmountThreshold)) fail(`${X}_MINIMUM_OUTPUT_VIOLATED`);
    if (review.format === 'gryloo.orca-devnet-review.v1') {
      // Program evidence: exactly one Traded event from the verified pool, for the reviewed direction, exact input and measured output.
      const logs = Array.isArray(meta.logMessages) ? (meta.logMessages as unknown[]).filter((l): l is string => typeof l === 'string') : fail('SOLANA_RPC_INVALID');
      const events = parseOrcaTradedEvents(logs);
      const trade = events.length === 1 ? events[0]! : fail('ORCA_TRADE_EVENT_MISMATCH');
      base.trade = trade;
      if (trade.whirlpool !== ORCA_WHIRLPOOLS_DEVNET.pool.address || trade.aToB !== review.inspection.swap.aToB || trade.inputAmount !== review.amount ||
          BigInt(trade.outputAmount) !== outputReceived) fail('ORCA_TRADE_EVENT_MISMATCH');
    }
    return { ...base, verdict: 'RECONCILED', reason: `${X}_TRANSACTION_AND_BALANCES_VERIFIED` };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : `${X}_OBSERVATION_FAILED`;
    // Provider failures stay ambiguous; any semantic mismatch fails closed.
    return { ...base, verdict: /MISMATCH|WRONG_CLUSTER|VIOLATED|UNRELATED|NOT_CLOSED/.test(message) ? 'DIVERGENT' : 'INCONCLUSIVE', reason: message };
  }
}

/** The evidence's honest statement of what was signed when the owner's wallet appended a verified guard; null for the reviewed bytes. */
export function walletGuardLimitation(guard: SolanaWalletGuard | undefined): string | null {
  return guard ? `Balances are finalized transaction metadata for the owner-signed transaction: every reviewed instruction byte for byte, plus ${guard.instructions.length} ` +
    `Lighthouse assertion instruction(s) the owner's wallet appended before signing (verified read-only post-state checks; signed message ${guard.signedMessageHash}).` : null;
}
/** ADR-0010: the evidence's statement of who fronted the network fee and what the owner paid back for it. */
export function koraFeeLimitation(fee: KoraFeeObservation): string {
  return `The network fee (${fee.feeLamports} lamports) was paid by Pimlico's Kora fee payer ${fee.feePayer}; the owner repaid it in the same transaction: ` +
    `${fee.amount} base units of ${fee.token.symbol} (${fee.token.mint}) to ${fee.payee}.`;
}
export type SolanaSwapEvidenceClass = 'MOCKED' | 'PUBLIC_READ_ONLY' | 'PUBLIC_EXECUTED' | 'DEVNET_EXECUTED';
export type JupiterEvidenceClass = SolanaSwapEvidenceClass;
export type SolanaSwapEvidenceProvenance = 'PUBLIC_MAINNET' | 'PUBLIC_DEVNET' | 'MOCKED';
/**
 * Honest classification. Only an owner-initiated, independently reconciled public run is executed evidence:
 * PUBLIC_EXECUTED on mainnet-beta, DEVNET_EXECUTED on Devnet. Devnet evidence is never mainnet evidence.
 */
export function classifySolanaSwapEvidence(input: { provenance: SolanaSwapEvidenceProvenance; ownerInitiated: boolean; observation: JupiterObservation | null }): SolanaSwapEvidenceClass {
  if (input.provenance === 'MOCKED') return 'MOCKED';
  if (!input.ownerInitiated || input.observation?.verdict !== 'RECONCILED') return 'PUBLIC_READ_ONLY';
  return input.provenance === 'PUBLIC_DEVNET' ? 'DEVNET_EXECUTED' : 'PUBLIC_EXECUTED';
}
export const classifyJupiterEvidence = classifySolanaSwapEvidence;
export function buildSolanaSwapEvidence(input: { id: string; review: SolanaSwapReview; journal: ExecutionJournal; provenance: SolanaSwapEvidenceProvenance;
  ownerInitiated: boolean; observation: JupiterObservation }): { bundle: EvidenceBundle; bundleHash: string; evidenceClass: SolanaSwapEvidenceClass; publicExecution: unknown; artifacts: unknown } {
  const o = input.observation, review = input.review, runtime = requireSolanaSwapRuntime(review.chain), X = runtime.codePrefix, prefix = runtime.idPrefix;
  const balances = o.owner;
  if (o.verdict !== 'RECONCILED' || !balances || !input.ownerInitiated) return fail(`${X}_EVIDENCE_NOT_RECONCILED`);
  if (input.provenance !== 'MOCKED' && input.provenance !== runtime.provenance) return fail(`${X}_EVIDENCE_PROVENANCE_MISMATCH`);
  const evidenceClass = classifySolanaSwapEvidence(input);
  const asset = (side: SolanaSwapReview['input']) => ({ chainId: review.chain, address: side.mint, decimals: side.decimals });
  const orca = review.format === 'gryloo.orca-devnet-review.v1' ? review : null;
  const publicExecution = { environment: evidenceClass === 'MOCKED' ? 'MOCKED' : evidenceClass, network: runtime.network, cluster: review.cluster, chain: review.chain,
    genesisHash: runtime.genesisHash, provider: orca ? 'Orca Whirlpools swap_v2 (Solana Devnet)' : 'Jupiter Swap API V2 /build (Metis)', providerProgram: runtime.providerProgram,
    officialSource: runtime.officialSource, explorer: o.explorer, owner: review.owner, inputMint: review.input.mint, outputMint: review.output.mint,
    inputTokenAccount: review.inspection.ownerInputAccount, outputTokenAccount: review.inspection.ownerOutputAccount, ...orca ? { pool: orca.pool.address, trade: o.trade ?? null } : {},
    requestedInput: review.amount, quotedOutput: review.quote.outAmount, expectedOutput: review.quote.outAmount, minimumOutput: review.quote.otherAmountThreshold, slippageBps: review.slippageBps,
    actualInputDelta: o.inputSpent, actualOutputDelta: o.outputReceived, signature: o.signature, slot: o.slot, blockTime: o.blockTime, confirmation: o.confirmation,
    feeLamports: o.feeLamports, accountCreationLamports: o.accountCreationLamports, balances: o.owner, route: review.quote.routePlan, routeCommitment: review.routeCommitment,
    swapInstruction: review.inspection.swap, programs: o.programs, innerPrograms: o.innerPrograms, messageHash: review.messageHash,
    ...o.walletGuard ? { signedMessageHash: o.walletGuard.signedMessageHash, walletGuard: o.walletGuard } : {},
    verdict: o.verdict, reason: o.reason, provenance: input.provenance, evidenceClass, ownerInitiated: input.ownerInitiated, realFunds: runtime.realFunds && input.provenance !== 'MOCKED' };
  const head = hashJournalBytes(new TextEncoder().encode(JSON.stringify(input.journal))).at(-1) ?? fail(`${X}_JOURNAL_EMPTY`);
  // The frozen v1 environment enum has no Devnet member: Devnet maps to TESTNET_EXECUTED, never MAINNET_EXECUTED.
  const environment = input.provenance === 'MOCKED' ? 'MOCKED' as const : runtime.bundleEnvironment;
  const limitations = [walletGuardLimitation(o.walletGuard) ?? 'Balances are finalized transaction metadata for the exact owner-signed reviewed bytes.',
    'Native SOL deltas exclude the network fee and any new token-account deposit.',
    ...o.tokenFee ? [koraFeeLimitation(o.tokenFee)] : [],
    ...orca ? ['Solana Devnet with valueless test tokens (Gryloo evidence class DEVNET_EXECUTED). Not mainnet execution and not real funds.'] : []];
  const bundle: EvidenceBundle = { schemaVersion: '1.0.0', evidenceBundleId: input.id, version: 1, supersedes: null,
    semanticWorkflowHash: review.manifest.semanticWorkflowHash, artifactSetHash: review.manifest.artifactSetHash, simulationHash: review.manifest.simulationHash,
    policyHash: review.manifest.policyHash, manifestHash: solanaSwapArtifactHash('strategy-manifest', review.manifest), executionPlanHash: solanaSwapArtifactHash('execution-plan', review.plan),
    journalHeadHash: head, observedAt: new Date().toISOString(), environment, outcome: 'RECONCILED',
    receipts: [{ receiptId: `${prefix}-transaction`, contentHash: solanaSwapHash(o) }], differences: [],
    reconciliation: { balances: [{ asset: asset(review.input), amount: balances.inputAfter }, { asset: asset(review.output), amount: balances.outputAfter }],
      allowances: [], debt: [], positions: [], fees: [{ asset: { chainId: review.chain, nativeId: 'SOL', decimals: 9 }, amount: o.feeLamports ?? '0' },
        ...o.tokenFee ? [{ asset: { chainId: review.chain, address: o.tokenFee.token.mint, decimals: o.tokenFee.token.decimals }, amount: o.tokenFee.amount }] : []], residualAssets: [],
      ownership: [{ chainId: review.chain, address: review.owner }], limitations },
    evidence: [{ evidenceId: `${prefix}-public-observations`, kind: 'EXTERNAL_REFERENCE', contentHash: solanaSwapHash(publicExecution) }] };
  return { bundle, bundleHash: solanaSwapArtifactHash('evidence-bundle', bundle), evidenceClass, publicExecution,
    artifacts: { workflow: review.workflow, artifactSet: review.artifactSet, simulation: review.simulation, policy: review.policy, manifest: review.manifest, plan: review.plan, journal: input.journal, review } };
}
// BUILD-014 names for the shared reconciliation and evidence.
export const reconcileJupiterAttempt = reconcileSolanaSwapAttempt;
export const buildJupiterEvidence = buildSolanaSwapEvidence;
