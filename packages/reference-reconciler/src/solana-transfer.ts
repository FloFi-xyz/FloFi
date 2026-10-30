// SPDX-License-Identifier: AGPL-3.0-only
import { solanaTransferProfile } from '@defi-workflow-engine/action-registry';
import { solanaRpcU64, base58Encode, decompileMessageV0, fromBase64, parseMessageV0, parseTransaction, solanaSwapArtifactHash, solanaSwapHash, verifySolanaCluster,
  verifySignedSolanaTransfer, type SolanaRpc, type SolanaTransferReview, type SolanaWalletGuard } from '@defi-workflow-engine/reference-compiler';
import { walletGuardLimitation } from './jupiter.js';
import { hashJournalBytes, type EvidenceBundle, type ExecutionJournal } from '@defi-workflow-engine/workflow-contracts';

/**
 * BUILD-SOLANA-TRANSFER-UX-001: independent public-chain reconciliation of one Solana transfer. Success status alone never reconciles: the
 * finalized transaction must be byte-identical to the owner-signed reviewed transaction on the expected cluster and invoke the expected
 * program, and the actual balance movements must equal the intent exactly — the owner pays the amount (SOL) or the token amount plus the fee
 * and at most the reviewed account deposit, the recipient receives exactly the amount, and no other owner token account moves.
 */
export type SolanaTransferObservation = { verdict: 'RECONCILED' | 'DIVERGENT' | 'INCONCLUSIVE'; reason: string; found: boolean;
  /** True only after the expected cluster successfully returned an explicit null status with history search. RPC failure is never absence. */
  absenceVerified: boolean; signature: string | null;
  confirmation: string | null; slot: number | null; blockTime: number | null; feeLamports: string | null;
  owner: { lamportsBefore: string; lamportsAfter: string } | null; recipient: { lamportsBefore: string; lamportsAfter: string } | null;
  token: { sourceBefore: string; sourceAfter: string; destinationBefore: string; destinationAfter: string } | null;
  amountSent: string | null; amountReceived: string | null; accountCreationLamports: string | null; programs: string[]; explorer: string | null;
  /** The wallet guard re-verified against the Review for this exact signed transaction (only when the wallet appended one). */
  walletGuard?: SolanaWalletGuard };
export type SolanaTransferChainAttempt = { signature: string | null; transaction: string | null; walletGuard?: SolanaWalletGuard };
const X = 'SOLANA_TRANSFER';
const fail = (code: string): never => { throw new Error(code); };
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : fail('SOLANA_RPC_INVALID');
const lamportList = (v: unknown, n: number): bigint[] => Array.isArray(v) && v.length === n
  ? v.map(value => solanaRpcU64(value)) : fail('SOLANA_RPC_INVALID');
type TokenBalance = { index: number; mint: string; owner: string; amount: bigint; decimals: number; programId: string | null };
function tokenBalances(v: unknown): TokenBalance[] {
  if (!Array.isArray(v)) fail('SOLANA_RPC_INVALID');
  const balances = (v as unknown[]).map(item => {
    const b = record(item), ui = record(b.uiTokenAmount);
    if (!Number.isSafeInteger(b.accountIndex) || typeof b.mint !== 'string' || typeof b.owner !== 'string' || typeof ui.amount !== 'string' ||
        !/^(0|[1-9][0-9]{0,19})$/.test(ui.amount) || !Number.isSafeInteger(ui.decimals) || b.programId !== undefined && typeof b.programId !== 'string') fail('SOLANA_TOKEN_BALANCE_INVALID');
    return { index: b.accountIndex as number, mint: b.mint as string, owner: b.owner as string, amount: BigInt(ui.amount as string), decimals: ui.decimals as number,
      programId: typeof b.programId === 'string' ? b.programId : null };
  });
  if (new Set(balances.map(balance => balance.index)).size !== balances.length) fail('SOLANA_TOKEN_BALANCE_INVALID');
  return balances;
}

export async function reconcileSolanaTransferAttempt(review: SolanaTransferReview, attempt: SolanaTransferChainAttempt, rpc: SolanaRpc): Promise<SolanaTransferObservation> {
  const profile = solanaTransferProfile(review.chain) ?? fail(`${X}_NETWORK_UNSUPPORTED`);
  const base: SolanaTransferObservation = { verdict: 'INCONCLUSIVE', reason: 'TRANSACTION_NOT_OBSERVED', found: false, absenceVerified: false, signature: attempt.signature, confirmation: null,
    slot: null, blockTime: null, feeLamports: null, owner: null, recipient: null, token: null, amountSent: null, amountReceived: null, accountCreationLamports: null,
    programs: [], explorer: attempt.signature ? profile.explorerTx(attempt.signature) : null, ...attempt.walletGuard ? { walletGuard: attempt.walletGuard } : {} };
  if (!attempt.signature || !attempt.transaction) return base;
  try {
    await verifySolanaCluster(rpc, profile.genesisHash);
    const signed = fromBase64(attempt.transaction, 2048), parsedSigned = parseTransaction(signed);
    // The reviewed message, or the recorded wallet guard re-verified against it (HOTFIX-PHANTOM-LIGHTHOUSE-001), with a valid owner signature.
    if (JSON.stringify(verifySignedSolanaTransfer(review, attempt.transaction).walletGuard) !== JSON.stringify(attempt.walletGuard)) fail(`${X}_TRANSACTION_MISMATCH`);
    if (base58Encode(parsedSigned.signatures[0]!) !== attempt.signature) fail(`${X}_SIGNATURE_MISMATCH`);
    const finalizedSlot = await rpc('getSlot', [{ commitment: 'finalized' }]);
    if (!Number.isSafeInteger(finalizedSlot)) fail('SOLANA_RPC_INVALID');
    const statuses = record(await rpc('getSignatureStatuses', [[attempt.signature], { searchTransactionHistory: true }]));
    const context = record(statuses.context);
    if (!Number.isSafeInteger(context.slot) || (context.slot as number) < (finalizedSlot as number) || (context.slot as number) < review.simulationResult.slot) fail('SOLANA_RPC_STALE_STATUS');
    const status = Array.isArray(statuses.value) && statuses.value.length === 1 ? statuses.value[0] : fail('SOLANA_RPC_INVALID');
    if (status === null) {
      // A history lookup and a finalized transaction lookup must both establish absence. A lagging status index is not a retry grant.
      const transaction = await rpc('getTransaction', [attempt.signature, { encoding: 'base64', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]);
      return transaction === null ? { ...base, absenceVerified: true } : { ...base, found: true, reason: 'AWAITING_STATUS_INDEX' };
    }
    const s = record(status);
    base.found = true; base.confirmation = typeof s.confirmationStatus === 'string' ? s.confirmationStatus : null;
    if (s.confirmationStatus !== 'finalized') return { ...base, reason: 'AWAITING_FINALITY' };
    const value = await rpc('getTransaction', [attempt.signature, { encoding: 'base64', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]);
    if (!value) return { ...base, reason: 'AWAITING_FINALITY' };
    const tx = record(value), meta = record(tx.meta);
    if (!Array.isArray(tx.transaction) || tx.transaction[1] !== 'base64' || tx.version !== 0 || !Number.isSafeInteger(tx.slot)) fail('SOLANA_RPC_INVALID');
    base.slot = tx.slot as number; base.blockTime = Number.isSafeInteger(tx.blockTime) ? tx.blockTime as number : null;
    if (s.slot !== tx.slot || JSON.stringify(s.err) !== JSON.stringify(meta.err)) fail(`${X}_STATUS_METADATA_MISMATCH`);
    // Exact owner-signed bytes (verified above against the Review), not merely a similar transaction.
    if (Buffer.from(fromBase64((tx.transaction as unknown[])[0], 2048)).toString('base64') !== Buffer.from(signed).toString('base64')) fail(`${X}_TRANSACTION_MISMATCH`);
    if (base.slot < review.simulationResult.slot) fail(`${X}_SLOT_MISMATCH`);
    const message = parseMessageV0(parsedSigned.message);
    if (message.lookups.length) fail(`${X}_TRANSACTION_MISMATCH`);
    const loaded = meta.loadedAddresses === undefined || meta.loadedAddresses === null ? { writable: [], readonly: [] } : record(meta.loadedAddresses);
    if (JSON.stringify(loaded.writable ?? []) !== '[]' || JSON.stringify(loaded.readonly ?? []) !== '[]') fail(`${X}_LOOKUP_MISMATCH`);
    const keys = message.staticKeys;
    if (keys[0] !== review.owner) fail(`${X}_OWNER_MISMATCH`);
    base.programs = [...new Set(decompileMessageV0(message, {}).map(i => i.programId))];
    const program = review.token ? review.token.programId : profile.programs.system;
    if (!base.programs.includes(program)) fail(`${X}_PROGRAM_MISMATCH`);
    const fee = solanaRpcU64(meta.fee);
    base.feeLamports = fee.toString();
    if (meta.err !== null) return { ...base, verdict: 'DIVERGENT', reason: `${X}_TRANSFER_FAILED` };
    if (fee > BigInt(review.estimatedFeeLamports)) fail(`${X}_FEE_MISMATCH`);
    const pre = lamportList(meta.preBalances, keys.length), post = lamportList(meta.postBalances, keys.length);
    const at = (account: string) => keys.indexOf(account);
    const ownerPre = pre[0]!, ownerPost = post[0]!, amount = BigInt(review.amount);
    base.owner = { lamportsBefore: ownerPre.toString(), lamportsAfter: ownerPost.toString() };
    const recipientIndex = at(review.recipient);
    if (recipientIndex >= 0) base.recipient = { lamportsBefore: pre[recipientIndex]!.toString(), lamportsAfter: post[recipientIndex]!.toString() };
    if (!review.token) {
      if (recipientIndex < 0) fail(`${X}_RECIPIENT_MISMATCH`);
      const received = post[recipientIndex]! - pre[recipientIndex]!, sent = ownerPre - ownerPost - fee;
      base.amountSent = sent.toString(); base.amountReceived = received.toString(); base.accountCreationLamports = '0';
      if (received !== amount) fail(`${X}_RECIPIENT_DELTA_MISMATCH`);
      if (sent !== amount) fail(`${X}_OWNER_DELTA_MISMATCH`);
      return { ...base, verdict: 'RECONCILED', reason: `${X}_TRANSACTION_AND_BALANCES_VERIFIED` };
    }
    const token = review.token, preTokens = tokenBalances(meta.preTokenBalances), postTokens = tokenBalances(meta.postTokenBalances);
    const sourceIndex = at(token.sourceAccount), destinationIndex = at(token.destinationAccount);
    if (sourceIndex < 0 || destinationIndex < 0) fail(`${X}_TOKEN_ACCOUNT_MISMATCH`);
    const entry = (list: TokenBalance[], index: number, owner: string) => {
      const found = list.find(b => b.index === index);
      if (!found) return null;
      if (found.mint !== token.mint || found.owner !== owner || found.decimals !== token.decimals || found.programId !== null && found.programId !== token.programId)
        fail(`${X}_TOKEN_ACCOUNT_MISMATCH`);
      return found.amount;
    };
    const sourceBefore = entry(preTokens, sourceIndex, review.owner) ?? fail(`${X}_TOKEN_ACCOUNT_MISMATCH`), sourceAfter = entry(postTokens, sourceIndex, review.owner) ?? fail(`${X}_TOKEN_ACCOUNT_MISMATCH`);
    const destinationBefore = entry(preTokens, destinationIndex, review.recipient) ?? (pre[destinationIndex] === 0n ? 0n : fail(`${X}_TOKEN_ACCOUNT_MISMATCH`));
    const destinationAfter = entry(postTokens, destinationIndex, review.recipient) ?? fail(`${X}_TOKEN_ACCOUNT_MISMATCH`);
    // A recipient account created by this transaction holds the rent-exempt deposit the owner paid; never more than the reviewed deposit.
    const created = pre[destinationIndex] === 0n ? post[destinationIndex]! : 0n;
    base.token = { sourceBefore: sourceBefore.toString(), sourceAfter: sourceAfter.toString(), destinationBefore: destinationBefore.toString(), destinationAfter: destinationAfter.toString() };
    base.amountSent = (sourceBefore - sourceAfter).toString(); base.amountReceived = (destinationAfter - destinationBefore).toString(); base.accountCreationLamports = created.toString();
    if (sourceBefore - sourceAfter !== amount) fail(`${X}_OWNER_DELTA_MISMATCH`);
    if (destinationAfter - destinationBefore !== amount) fail(`${X}_RECIPIENT_DELTA_MISMATCH`);
    if (created > BigInt(review.maximumAccountCreationLamports)) fail(`${X}_ACCOUNT_DEPOSIT_MISMATCH`);
    if (ownerPre - ownerPost !== fee + created) fail(`${X}_UNRELATED_ASSET_MOVEMENT`);
    if (recipientIndex >= 0 && post[recipientIndex] !== pre[recipientIndex]) fail(`${X}_UNRELATED_ASSET_MOVEMENT`);
    // No other owner token account moves.
    for (const balance of [...preTokens, ...postTokens].filter(b => b.owner === review.owner && b.index !== sourceIndex)) {
      const before = preTokens.find(b => b.index === balance.index)?.amount ?? 0n, after = postTokens.find(b => b.index === balance.index)?.amount ?? 0n;
      if (before !== after) fail(`${X}_UNRELATED_ASSET_MOVEMENT`);
    }
    return { ...base, verdict: 'RECONCILED', reason: `${X}_TRANSACTION_AND_BALANCES_VERIFIED` };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : `${X}_OBSERVATION_FAILED`;
    // Provider failures stay ambiguous; any semantic mismatch fails closed.
    return { ...base, verdict: /MISMATCH|WRONG_CLUSTER|UNRELATED/.test(message) ? 'DIVERGENT' : 'INCONCLUSIVE', reason: message };
  }
}

export type SolanaTransferEvidenceClass = 'MOCKED' | 'PUBLIC_READ_ONLY' | 'PUBLIC_EXECUTED' | 'DEVNET_EXECUTED';
export type SolanaTransferEvidenceProvenance = 'PUBLIC_MAINNET' | 'PUBLIC_DEVNET' | 'MOCKED';
/** Honest classification: only an owner-initiated, independently reconciled public run is executed evidence; Devnet is never mainnet evidence. */
export function classifySolanaTransferEvidence(input: { provenance: SolanaTransferEvidenceProvenance; ownerInitiated: boolean; observation: Pick<SolanaTransferObservation, 'verdict'> | null }): SolanaTransferEvidenceClass {
  if (input.provenance === 'MOCKED') return 'MOCKED';
  if (!input.ownerInitiated || input.observation?.verdict !== 'RECONCILED') return 'PUBLIC_READ_ONLY';
  return input.provenance === 'PUBLIC_DEVNET' ? 'DEVNET_EXECUTED' : 'PUBLIC_EXECUTED';
}
export function buildSolanaTransferEvidence(input: { id: string; review: SolanaTransferReview; journal: ExecutionJournal; provenance: SolanaTransferEvidenceProvenance;
  ownerInitiated: boolean; observation: SolanaTransferObservation }): { bundle: EvidenceBundle; bundleHash: string; evidenceClass: SolanaTransferEvidenceClass; publicExecution: unknown; artifacts: unknown } {
  const o = input.observation, review = input.review, profile = solanaTransferProfile(review.chain) ?? fail(`${X}_NETWORK_UNSUPPORTED`);
  if (o.verdict !== 'RECONCILED' || !o.owner || !input.ownerInitiated) return fail(`${X}_EVIDENCE_NOT_RECONCILED`);
  if (input.provenance !== 'MOCKED' && input.provenance !== profile.provenance) return fail(`${X}_EVIDENCE_PROVENANCE_MISMATCH`);
  const evidenceClass = classifySolanaTransferEvidence(input);
  const asset = review.token ? { chainId: review.chain, address: review.token.mint, decimals: review.token.decimals } : { chainId: review.chain, nativeId: 'SOL', decimals: 9 };
  const publicExecution = { environment: evidenceClass, network: profile.network, cluster: review.cluster, chain: review.chain, genesisHash: profile.genesisHash,
    program: review.token ? review.token.programId : profile.programs.system, instruction: review.token ? 'TransferChecked' : 'System Transfer',
    officialSource: profile.officialSource, explorer: o.explorer, owner: review.owner, recipient: review.recipient, asset: review.asset,
    sourceAccount: review.token?.sourceAccount ?? null, destinationAccount: review.token?.destinationAccount ?? null, destinationCreated: o.accountCreationLamports !== null && o.accountCreationLamports !== '0',
    requestedAmount: review.amount, actualSent: o.amountSent, actualReceived: o.amountReceived, signature: o.signature, slot: o.slot, blockTime: o.blockTime,
    confirmation: o.confirmation, feeLamports: o.feeLamports, accountCreationLamports: o.accountCreationLamports, ownerBalances: o.owner, recipientBalances: o.recipient,
    tokenBalances: o.token, programs: o.programs, messageHash: review.messageHash,
    ...o.walletGuard ? { signedMessageHash: o.walletGuard.signedMessageHash, walletGuard: o.walletGuard } : {}, verdict: o.verdict, reason: o.reason, provenance: input.provenance, evidenceClass,
    ownerInitiated: input.ownerInitiated, realFunds: profile.realFunds && input.provenance !== 'MOCKED' };
  const head = hashJournalBytes(new TextEncoder().encode(JSON.stringify(input.journal))).at(-1) ?? fail(`${X}_JOURNAL_EMPTY`);
  // The frozen v1 environment enum has no Devnet member: Devnet maps to TESTNET_EXECUTED, never MAINNET_EXECUTED.
  const environment = input.provenance === 'MOCKED' ? 'MOCKED' as const : profile.bundleEnvironment;
  const limitations = [walletGuardLimitation(o.walletGuard) ?? 'Balances are finalized transaction metadata for the exact owner-signed reviewed bytes.',
    ...review.token ? ['Token amounts are the token program\'s own balances; native SOL changes are the network fee and any new recipient token-account deposit.'] : [],
    ...profile.realFunds ? [] : ['Solana Devnet with valueless test tokens (FloFi evidence class DEVNET_EXECUTED). Not mainnet execution and not real funds.']];
  const bundle: EvidenceBundle = { schemaVersion: '1.0.0', evidenceBundleId: input.id, version: 1, supersedes: null,
    semanticWorkflowHash: review.manifest.semanticWorkflowHash, artifactSetHash: review.manifest.artifactSetHash, simulationHash: review.manifest.simulationHash,
    policyHash: review.manifest.policyHash, manifestHash: solanaSwapArtifactHash('strategy-manifest', review.manifest), executionPlanHash: solanaSwapArtifactHash('execution-plan', review.plan),
    journalHeadHash: head, observedAt: new Date().toISOString(), environment, outcome: 'RECONCILED',
    receipts: [{ receiptId: `${profile.idPrefix}-transaction`, contentHash: solanaSwapHash(o) }], differences: [],
    reconciliation: { balances: [{ asset, amount: review.token ? o.token!.sourceAfter : o.owner.lamportsAfter }], allowances: [], debt: [], positions: [],
      fees: [{ asset: { chainId: review.chain, nativeId: 'SOL', decimals: 9 }, amount: o.feeLamports ?? '0' }], residualAssets: [],
      ownership: [{ chainId: review.chain, address: review.owner }], limitations },
    evidence: [{ evidenceId: `${profile.idPrefix}-public-observations`, kind: 'EXTERNAL_REFERENCE', contentHash: solanaSwapHash(publicExecution) }] };
  return { bundle, bundleHash: solanaSwapArtifactHash('evidence-bundle', bundle), evidenceClass, publicExecution,
    artifacts: { workflow: review.workflow, artifactSet: review.artifactSet, simulation: review.simulation, policy: review.policy, manifest: review.manifest, plan: review.plan, journal: input.journal, review } };
}
