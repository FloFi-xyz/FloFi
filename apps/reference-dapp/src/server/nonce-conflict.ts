// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-RECONCILIATION-PRIVACY-UX-001 (P0): read-only forensic investigation of an EVM nonce conflict.
 *
 * A flow records `<FLOW>_NONCE_CONSUMED_BY_DIFFERENT_TRANSACTION` when the account nonce reserved for a reviewed transaction was consumed by a
 * transaction that is not a direct send of the reviewed call. That establishes only one fact: the transaction AT that nonce is not the reviewed
 * call as a direct send. It does not establish whether the reviewed call executed (through a delegated account, inside a batch, or with another
 * nonce) or did not. This module gathers the evidence an operator needs and classifies it conservatively:
 *
 *   MATCHING_TRANSACTION_CONFIRMED      the transaction at the nonce IS the reviewed call (the flow's own reconciliation settles it, not this module)
 *   CONFLICTING_TRANSACTION_IDENTIFIED  a different, direct transaction consumed the nonce (with, for approvals, the reviewed effect absent from it)
 *   DELEGATED_EXECUTION_UNDETERMINED    the consuming transaction is delegated / batched (EIP-7702, self-call) or carries the reviewed effect
 *                                       inside a different outer call — the reviewed call may have executed inside it
 *   POSSIBLE_ALTERNATE_NONCE            the reviewed effect appears in another of the sender's transactions (another nonce)
 *   INSUFFICIENT_CHAIN_EVIDENCE         the chain data could not be read, is not canonical, or is inconsistent (retry later)
 *
 * There is deliberately no "proven not executed" class: proof of non-execution remains the flow's own protocol-specific verdict
 * (`*_SUBMISSION_EXPIRED_NOT_EXECUTED`, a complete deposit scan past a protocol deadline). Every report carries `financialOutcome: 'UNKNOWN'`:
 * this module never decides, changes or clears a financial outcome, and the caller never feeds its result into a run's state machine.
 *
 * Read-only by construction: it calls only `eth_chainId`, `eth_getBlockByNumber`, `eth_getTransactionByHash`, `eth_getTransactionReceipt`, `eth_getCode` and
 * `eth_getLogs` through the flow's existing read RPC (whose method allowlist has no send method). It signs, submits and replays nothing.
 */
import { createHash } from 'node:crypto';

export type Rpc = (method: string, params: readonly unknown[]) => Promise<unknown>;
/** Methods this module may call. A unit test proves no other method is ever requested. */
export const INVESTIGATION_RPC_METHODS = Object.freeze(['eth_chainId', 'eth_getBlockByNumber', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getCode', 'eth_getLogs']);
export const NONCE_CONFLICT_CODE = /^[A-Z][A-Z0-9]*_NONCE_CONSUMED_BY_DIFFERENT_TRANSACTION$/;
export const NONCE_CONFLICT_CLASSIFICATIONS = ['MATCHING_TRANSACTION_CONFIRMED', 'CONFLICTING_TRANSACTION_IDENTIFIED', 'DELEGATED_EXECUTION_UNDETERMINED',
  'POSSIBLE_ALTERNATE_NONCE', 'INSUFFICIENT_CHAIN_EVIDENCE'] as const;
export type NonceConflictClassification = (typeof NONCE_CONFLICT_CLASSIFICATIONS)[number];

const APPROVE_SELECTOR = '0x095ea7b3';
const APPROVAL_TOPIC = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
const ADDRESS = /^0x[0-9a-f]{40}$/, HASH = /^0x[0-9a-f]{64}$/, HEX = /^0x[0-9a-f]*$/, QUANTITY = /^0x[0-9a-f]+$/;
/** Blocks per `eth_getLogs` window (the same bound the flows' own deposit scans use for public RPCs) and windows per investigation. */
export const SCAN_BLOCKS = 2_000, SCAN_WINDOWS = 50, PEER_LIMIT = 20, CANDIDATE_LIMIT = 40;

/** The attempt whose nonce was consumed, as the flow recorded it. Built from the run's durable record only (`nonceConflictSubject`). */
export type NonceConflictSubject = {
  readonly flow: string; readonly runId: string; readonly attemptId: string; readonly step: string;
  /** Decimal EVM chain id. */ readonly chainId: string;
  readonly sender: string; readonly nonce: string; readonly preparedAtBlock: number;
  readonly reviewed: { readonly to: string; readonly data: string; readonly value: string };
  readonly conflictingTransactionHash: string | null;
  /** Attempts the run recorded AFTER the conflicted one (step, state, whether a hash is recorded): what FloFi asked the wallet to do next. */
  readonly laterAttempts: readonly { readonly step: string; readonly state: string; readonly hashRecorded: boolean }[];
};
/** Another FloFi attempt of the same tenant and sender with the same nonce (any chain: the database does not record one per attempt). */
export type PeerAttempt = { readonly runId: string; readonly flow: string; readonly step: string; readonly state: string; readonly transactionHash: string | null };

export type Comparison = 'SAME' | 'DIFFERENT' | 'UNKNOWN' | 'NOT_APPLICABLE';
export type ExecutionStructure = 'DIRECT' | 'EIP7702_SET_CODE' | 'DELEGATED_SELF_CALL' | 'DELEGATED_ACCOUNT' | 'CONTRACT_CREATION' | 'UNKNOWN';
export type EffectPresence = 'OBSERVED' | 'ABSENT' | 'NOT_DETERMINABLE';
export type AlternateNonceStatus = 'CANDIDATE_FOUND' | 'NONE_IN_SCANNED_RANGE' | 'INCOMPLETE' | 'NOT_EVALUATED';
export type SafeNextAction = 'WAIT_FOR_RPC' | 'WAIT_FOR_FINALITY' | 'LET_FLOW_SETTLE' | 'CONTINUE_SCAN' | 'OPERATOR_REVIEW_DELEGATED' | 'OPERATOR_REVIEW_ALTERNATE'
  | 'OPERATOR_REVIEW_CONFLICT' | 'OPERATOR_REVIEW_PROTOCOL_WINDOW';

export type NonceConflictReport = {
  readonly version: 1;
  readonly classification: NonceConflictClassification;
  /** Constant: this module never establishes a financial outcome. */
  readonly financialOutcome: 'UNKNOWN';
  /** True when every check this module can run for the step ran to completion on final data (not a proof of the outcome). */
  readonly proofComplete: boolean;
  /** Whether a later identical check could change this report (an RPC failure, data not final yet, an unfinished scan). */
  readonly retryable: boolean;
  readonly chainId: string; readonly nonce: string; readonly step: string;
  readonly conflictingTransactionHash: string | null;
  readonly conflict: null | { readonly blockNumber: number; readonly blockHash: string; readonly final: boolean; readonly status: 0 | 1 | null; readonly type: string | null;
    readonly to: string | null; readonly selector: string | null; readonly valueWei: string };
  readonly comparison: { readonly sender: Comparison; readonly chain: Comparison; readonly target: Comparison; readonly selector: Comparison; readonly calldata: Comparison;
    readonly value: Comparison; readonly approvalSpender: Comparison; readonly approvalAmount: Comparison };
  readonly executionStructure: ExecutionStructure;
  /** The reviewed call's observable effect (for an ERC-20 approval: its Approval event) inside the consuming transaction. */
  readonly reviewedEffectInConflict: EffectPresence;
  readonly alternateNonce: { readonly status: AlternateNonceStatus; readonly complete: boolean;
    /** More same-spender approvals than are kept (non-matching ones beyond CANDIDATE_LIMIT were not recorded): the report is then never complete. */
    readonly truncated?: boolean; readonly scannedFrom: number | null; readonly scannedThrough: number | null; readonly finalHead: number | null;
    readonly candidates: readonly { readonly transactionHash: string; readonly nonce: string | null; readonly blockNumber: number; readonly amountMatches: boolean }[] };
  /** FloFi runs linked by an exact transaction hash, never by similarity of intent. */
  readonly relatedWorkflows: readonly { readonly runId: string; readonly flow: string; readonly step: string; readonly state: string;
    readonly linkage: 'SAME_TRANSACTION_HASH' | 'ALTERNATE_NONCE_CANDIDATE' | 'SAME_NONCE_OTHER_HASH' }[];
  readonly laterAttempts: NonceConflictSubject['laterAttempts'];
  /** Closed codes: why the outcome remains unknown. */
  readonly reasons: readonly string[];
  readonly safeNextAction: SafeNextAction;
  /** SHA-256 of the evidence that decides the classification (not the time or the scan cursor): equal fingerprints mean nothing new was learned. */
  readonly evidenceFingerprint: string;
  readonly checkedAt: string;
};

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const lower = (v: unknown): string | null => typeof v === 'string' ? v.toLowerCase() : null;
const quantity = (v: unknown): bigint | null => typeof v === 'string' && QUANTITY.test(v.toLowerCase()) ? BigInt(v) : null;
const blockTag = (n: number) => '0x' + n.toString(16);
const word = (address: string) => '0x' + address.slice(2).padStart(64, '0');
const decimal = (v: string): string | null => { try { const n = BigInt(v); return n >= 0n ? n.toString() : null; } catch { return null; } };

/** `approve(address,uint256)` calldata, decoded; null for any other call. */
export function decodeApprove(data: string): { spender: string; amount: bigint } | null {
  const d = data.toLowerCase();
  if (!d.startsWith(APPROVE_SELECTOR) || d.length !== 10 + 128 || !HEX.test(d) || !/^0{24}$/.test(d.slice(10, 34))) return null;
  return { spender: '0x' + d.slice(34, 74), amount: BigInt('0x' + d.slice(74, 138)) };
}

/**
 * The conflicted attempt of a flow record (router and universal EVM records share this shape), or null when the record has none. Pure: reads
 * the record only. The newest attempt in SUBMISSION_RESULT_UNKNOWN whose note is a nonce-conflict code is the subject.
 */
export function nonceConflictSubject(flow: string, record: unknown): NonceConflictSubject | null {
  if (!isObject(record) || typeof record.id !== 'string' || !Array.isArray(record.attempts)) return null;
  const attempts = record.attempts as unknown[];
  for (let index = attempts.length - 1; index >= 0; index--) {
    const a = attempts[index];
    if (!isObject(a) || a.state !== 'SUBMISSION_RESULT_UNKNOWN' || typeof a.note !== 'string' || !NONCE_CONFLICT_CODE.test(a.note)) continue;
    if (a.ecosystem !== undefined && a.ecosystem !== 'EVM') return null;
    const tx = a.tx;
    if (!isObject(tx) || typeof a.attemptId !== 'string' || typeof a.step !== 'string' || typeof a.nonce !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(a.nonce)
      || !Number.isSafeInteger(a.preparedAtBlock) || (a.preparedAtBlock as number) < 0) return null;
    const from = lower(tx.from), to = lower(tx.to), data = lower(tx.data), value = typeof tx.value === 'string' ? decimal(tx.value) : null;
    const chainId = typeof tx.chainId === 'string' ? decimal(tx.chainId) : null, hash = lower(a.conflictingTransactionHash);
    if (!from || !ADDRESS.test(from) || !to || !ADDRESS.test(to) || !data || !HEX.test(data) || data.length % 2 || value === null || !chainId || chainId === '0') return null;
    return { flow, runId: record.id, attemptId: a.attemptId, step: a.step, chainId, sender: from, nonce: a.nonce, preparedAtBlock: a.preparedAtBlock as number,
      reviewed: { to, data, value }, conflictingTransactionHash: hash && HASH.test(hash) ? hash : null,
      laterAttempts: attempts.slice(index + 1).filter(isObject).map(later => ({ step: String(later.step).slice(0, 32), state: String(later.state).slice(0, 40),
        hashRecorded: typeof later.transactionHash === 'string' })) };
  }
  return null;
}

class Unavailable extends Error {}
const read = async (rpc: Rpc, method: string, params: readonly unknown[]): Promise<unknown> => {
  if (!INVESTIGATION_RPC_METHODS.includes(method)) throw new Error('NONCE_INVESTIGATION_METHOD_NOT_ALLOWED');
  try { return await rpc(method, params); } catch { throw new Unavailable(method); }
};

export type AlternateCandidate = NonceConflictReport['alternateNonce']['candidates'][number];
type Options = { readonly rpc: Rpc; readonly subject: NonceConflictSubject; readonly peers: readonly PeerAttempt[];
  /**
   * The previous investigation's scan of the same attempt: where it stopped (the next block to scan) and what it found. Final blocks never
   * change, so the scan resumes there and keeps those candidates instead of reading the same range again.
   */
  readonly previousScan?: { readonly nextBlock: number; readonly candidates: readonly AlternateCandidate[]; readonly truncated?: boolean } | null;
  /** FloFi attempts that recorded one of the alternate-nonce candidates (any nonce): attributes a candidate to another workflow by exact hash. */
  readonly candidatePeers?: (hashes: readonly string[]) => Promise<readonly PeerAttempt[]>;
  readonly finality?: 'safe' | 'finalized'; readonly scanBlocks?: number; readonly scanWindows?: number; readonly now?: () => Date };

/** Investigates one nonce conflict. Never throws for chain conditions: an unreadable chain is the INSUFFICIENT_CHAIN_EVIDENCE classification. */
export async function investigateNonceConflict(options: Options): Promise<NonceConflictReport> {
  const { rpc, subject } = options, now = options.now ?? (() => new Date()), finality = options.finality ?? 'finalized';
  const scanBlocks = options.scanBlocks ?? SCAN_BLOCKS, scanWindows = options.scanWindows ?? SCAN_WINDOWS;
  const approve = decodeApprove(subject.reviewed.data), hash = subject.conflictingTransactionHash;
  let peers = options.peers.slice(0, PEER_LIMIT);
  const unknownComparison = { sender: 'UNKNOWN', chain: 'UNKNOWN', target: 'UNKNOWN', selector: 'UNKNOWN', calldata: 'UNKNOWN', value: 'UNKNOWN',
    approvalSpender: approve ? 'UNKNOWN' : 'NOT_APPLICABLE', approvalAmount: approve ? 'UNKNOWN' : 'NOT_APPLICABLE' } as const;
  const base = { version: 1 as const, financialOutcome: 'UNKNOWN' as const, chainId: subject.chainId, nonce: subject.nonce, step: subject.step,
    conflictingTransactionHash: hash, laterAttempts: subject.laterAttempts, checkedAt: now().toISOString() };
  const related = (conflictHash: string | null, candidates: readonly string[]) => peers.flatMap(peer => {
    const h = lower(peer.transactionHash);
    const linkage = h && h === conflictHash ? 'SAME_TRANSACTION_HASH' as const : h && candidates.includes(h) ? 'ALTERNATE_NONCE_CANDIDATE' as const : h ? 'SAME_NONCE_OTHER_HASH' as const : null;
    return linkage ? [{ runId: peer.runId, flow: peer.flow, step: peer.step, state: peer.state, linkage }] : [];
  });
  const insufficient = (reason: string, conflict: NonceConflictReport['conflict'] = null): NonceConflictReport => {
    const report = { ...base, classification: 'INSUFFICIENT_CHAIN_EVIDENCE' as const, proofComplete: false, retryable: true, conflict, comparison: unknownComparison,
      executionStructure: 'UNKNOWN' as const, reviewedEffectInConflict: 'NOT_DETERMINABLE' as const,
      alternateNonce: { status: 'NOT_EVALUATED' as const, complete: false, scannedFrom: null, scannedThrough: null, finalHead: null, candidates: [] },
      relatedWorkflows: related(null, []), reasons: [reason, 'OUTCOME_UNKNOWN_CHAIN_EVIDENCE_INCOMPLETE'],
      safeNextAction: reason === 'CONFLICT_NOT_FINAL' ? 'WAIT_FOR_FINALITY' as const : 'WAIT_FOR_RPC' as const };
    return { ...report, evidenceFingerprint: fingerprintOf(report) };
  };
  if (!hash) return insufficient('CONFLICT_HASH_NOT_RECORDED');
  try {
    // The client must serve the attempt's own chain: a hash or nonce read on another chain proves nothing about this one.
    const chain = quantity(await read(rpc, 'eth_chainId', []));
    if (chain === null || chain.toString() !== subject.chainId) return insufficient('RPC_CHAIN_MISMATCH');
    const head = await read(rpc, 'eth_getBlockByNumber', [finality, false]);
    const finalHead = isObject(head) ? quantity(head.number) : null;
    if (finalHead === null || finalHead > BigInt(Number.MAX_SAFE_INTEGER)) return insufficient('RPC_RESPONSE_INVALID');
    const [tx, receipt] = await Promise.all([read(rpc, 'eth_getTransactionByHash', [hash]), read(rpc, 'eth_getTransactionReceipt', [hash])]);
    if (tx === null || receipt === null) return insufficient('CONFLICT_TRANSACTION_NOT_FOUND');
    if (!isObject(tx) || !isObject(receipt)) return insufficient('RPC_RESPONSE_INVALID');
    const blockNumber = quantity(tx.blockNumber), blockHash = lower(tx.blockHash);
    if (lower(tx.hash) !== hash || lower(receipt.transactionHash) !== hash) return insufficient('CONFLICT_IDENTITY_MISMATCH');
    if (lower(tx.from) !== subject.sender || quantity(tx.nonce) !== BigInt(subject.nonce)) return insufficient('CONFLICT_IDENTITY_MISMATCH');
    if (blockNumber === null || !blockHash || !HASH.test(blockHash) || lower(receipt.blockHash) !== blockHash) return insufficient('CONFLICT_NOT_MINED');
    const canonical = await read(rpc, 'eth_getBlockByNumber', [blockTag(Number(blockNumber)), false]);
    if (!isObject(canonical) || lower(canonical.hash) !== blockHash) return insufficient('CONFLICT_NOT_CANONICAL');
    const status = quantity(receipt.status), to = lower(tx.to), input = lower(tx.input) ?? '', valueWei = quantity(tx.value);
    const conflict = { blockNumber: Number(blockNumber), blockHash, final: blockNumber <= finalHead, status: status === 1n ? 1 as const : status === 0n ? 0 as const : null,
      type: lower(tx.type), to, selector: HEX.test(input) && input.length >= 10 ? input.slice(0, 10) : null, valueWei: (valueWei ?? 0n).toString() };
    if (!conflict.final) return insufficient('CONFLICT_NOT_FINAL', conflict);

    // 1. Field-by-field comparison with the reviewed call.
    const same = (a: unknown, b: unknown): Comparison => a === null || a === undefined ? 'UNKNOWN' : a === b ? 'SAME' : 'DIFFERENT';
    const txChain = quantity(tx.chainId);
    const actualApprove = to === subject.reviewed.to && HEX.test(input) ? decodeApprove(input) : null;
    const logs = Array.isArray(receipt.logs) ? receipt.logs.filter(isObject) : null;
    const approvalLogs = approve && logs ? logs.filter(l => lower(l.address) === subject.reviewed.to && Array.isArray(l.topics) && lower(l.topics[0]) === APPROVAL_TOPIC
      && lower(l.topics[1]) === word(subject.sender)) : [];
    const spenderOf = (l: Record<string, unknown>) => Array.isArray(l.topics) ? lower(l.topics[2]) : null;
    const amountOf = (l: Record<string, unknown>) => quantity(l.data);
    const comparison = {
      sender: 'SAME' as const, chain: txChain === null ? 'UNKNOWN' as const : same(txChain.toString(), subject.chainId),
      target: to === null ? 'DIFFERENT' as const : same(to, subject.reviewed.to), selector: same(conflict.selector, subject.reviewed.data.slice(0, 10)),
      calldata: same(input, subject.reviewed.data), value: same(valueWei?.toString(), subject.reviewed.value),
      approvalSpender: !approve ? 'NOT_APPLICABLE' as const : actualApprove ? same(actualApprove.spender, approve.spender)
        : logs === null ? 'UNKNOWN' as const : approvalLogs.some(l => spenderOf(l) === word(approve.spender)) ? 'SAME' as const : approvalLogs.length ? 'DIFFERENT' as const : 'UNKNOWN' as const,
      approvalAmount: !approve ? 'NOT_APPLICABLE' as const : actualApprove ? same(actualApprove.amount, approve.amount)
        : logs === null ? 'UNKNOWN' as const : approvalLogs.some(l => amountOf(l) === approve.amount) ? 'SAME' as const : approvalLogs.length ? 'DIFFERENT' as const : 'UNKNOWN' as const,
    };
    // Exactly what the flows' own `sameEvmIntent` accepts (chain id included): only then can the flow settle it.
    const exact = comparison.chain === 'SAME' && comparison.target === 'SAME' && comparison.calldata === 'SAME' && comparison.value === 'SAME';

    // 2. Direct or delegated structure. A different outer transaction never proves the reviewed inner call absent.
    // The sender's code at the consuming block: an EIP-7702 delegation designator (0xef0100…) means calls to the sender run delegated code. A
    // plain self-send from an account without code (a wallet "cancel") executes nothing and stays DIRECT.
    let executionStructure: ExecutionStructure = to === null ? 'CONTRACT_CREATION' : conflict.type === '0x4' ? 'EIP7702_SET_CODE' : 'DIRECT';
    if (executionStructure === 'DIRECT') {
      const code = await read(rpc, 'eth_getCode', [subject.sender, blockTag(conflict.blockNumber)]);
      const delegatedCode = typeof code === 'string' && code.toLowerCase().startsWith('0xef0100');
      executionStructure = typeof code !== 'string' || !HEX.test(code.toLowerCase()) ? 'UNKNOWN' : to === subject.sender ? (delegatedCode || code.length > 2 ? 'DELEGATED_SELF_CALL' : 'DIRECT')
        : delegatedCode ? 'DELEGATED_ACCOUNT' : 'DIRECT';
    }
    // 3. The reviewed effect inside the consuming transaction. Only an approval has an effect this module can recognise without the protocol.
    const effectLog = (l: Record<string, unknown>) => !!approve && spenderOf(l) === word(approve.spender) && amountOf(l) === approve.amount;
    const reviewedEffectInConflict: EffectPresence = !approve || logs === null ? 'NOT_DETERMINABLE' : conflict.status === 0 ? 'ABSENT'
      : approvalLogs.some(effectLog) ? 'OBSERVED' : 'ABSENT';

    // 4. The reviewed effect elsewhere: the sender's Approval events for the reviewed spender, from the prepared block to the final head.
    let alternate: NonceConflictReport['alternateNonce'] = { status: 'NOT_EVALUATED', complete: false, scannedFrom: null, scannedThrough: null, finalHead: Number(finalHead), candidates: [] };
    if (approve) {
      const previous = options.previousScan && options.previousScan.nextBlock >= subject.preparedAtBlock ? options.previousScan : null;
      const candidates: AlternateCandidate[] = previous ? previous.candidates.filter(c => HASH.test(c.transactionHash) && c.transactionHash !== hash) : [];
      let from = previous?.nextBlock ?? subject.preparedAtBlock, truncated = previous?.truncated === true;
      for (let i = 0; i < scanWindows && from <= Number(finalHead); i++) {
        const through = Math.min(from + scanBlocks - 1, Number(finalHead));
        const found = await read(rpc, 'eth_getLogs', [{ address: subject.reviewed.to, fromBlock: blockTag(from), toBlock: blockTag(through),
          topics: [APPROVAL_TOPIC, word(subject.sender), word(approve.spender)] }]);
        if (!Array.isArray(found)) return insufficient('RPC_RESPONSE_INVALID', conflict);
        for (const entry of found.filter(isObject)) {
          const txHash = lower(entry.transactionHash), at = quantity(entry.blockNumber);
          if (!txHash || !HASH.test(txHash) || at === null || txHash === hash || candidates.some(c => c.transactionHash === txHash)) continue;
          // A candidate with the reviewed amount is always kept; others only up to the limit (beyond it the scan is marked truncated).
          if (amountOf(entry) !== approve.amount && candidates.length >= CANDIDATE_LIMIT) { truncated = true; continue; }
          const other = await read(rpc, 'eth_getTransactionByHash', [txHash]);
          candidates.push({ transactionHash: txHash, nonce: isObject(other) ? quantity(other.nonce)?.toString() ?? null : null, blockNumber: Number(at),
            amountMatches: amountOf(entry) === approve.amount });
        }
        from = through + 1;
      }
      // Any candidate already decides the class (the reviewed effect exists elsewhere); an unfinished scan without one stays INCOMPLETE.
      alternate = { status: candidates.length ? 'CANDIDATE_FOUND' : from > Number(finalHead) ? 'NONE_IN_SCANNED_RANGE' : 'INCOMPLETE',
        complete: from > Number(finalHead), ...truncated ? { truncated: true } : {}, scannedFrom: subject.preparedAtBlock,
        scannedThrough: from - 1, finalHead: Number(finalHead), candidates };
    }
    if (alternate.candidates.length && options.candidatePeers) {
      const extra = await options.candidatePeers(alternate.candidates.map(c => c.transactionHash)).catch(() => []);
      peers = [...peers, ...extra.filter(p => !peers.some(q => q.runId === p.runId && q.transactionHash === p.transactionHash))].slice(0, PEER_LIMIT * 2);
    }
    const relatedWorkflows = related(hash, alternate.candidates.map(c => c.transactionHash));

    // 5. Classification (conservative precedence) and why the outcome stays unknown.
    const reasons: string[] = [];
    let classification: NonceConflictClassification, safeNextAction: SafeNextAction;
    const delegated = executionStructure === 'EIP7702_SET_CODE' || executionStructure === 'DELEGATED_SELF_CALL' || executionStructure === 'UNKNOWN'
      || executionStructure === 'DELEGATED_ACCOUNT' && reviewedEffectInConflict !== 'ABSENT';
    if (exact) {
      classification = 'MATCHING_TRANSACTION_CONFIRMED'; safeNextAction = 'LET_FLOW_SETTLE';
      reasons.push('MATCH_SETTLED_ONLY_BY_FLOW_RECONCILIATION');
    } else if (reviewedEffectInConflict === 'OBSERVED' || delegated) {
      classification = 'DELEGATED_EXECUTION_UNDETERMINED'; safeNextAction = 'OPERATOR_REVIEW_DELEGATED';
      reasons.push(reviewedEffectInConflict === 'OBSERVED' ? 'REVIEWED_EFFECT_INSIDE_DIFFERENT_OUTER_TRANSACTION' : 'DELEGATED_OR_BATCHED_EXECUTION_NOT_DECODED');
    } else if (alternate.candidates.some(c => c.amountMatches)) {
      classification = 'POSSIBLE_ALTERNATE_NONCE'; safeNextAction = 'OPERATOR_REVIEW_ALTERNATE';
      reasons.push('REVIEWED_EFFECT_FOUND_IN_ANOTHER_TRANSACTION_NOT_ATTRIBUTED');
    } else {
      classification = 'CONFLICTING_TRANSACTION_IDENTIFIED';
      safeNextAction = approve && !alternate.complete ? 'CONTINUE_SCAN' : approve ? 'OPERATOR_REVIEW_CONFLICT' : 'OPERATOR_REVIEW_PROTOCOL_WINDOW';
      reasons.push(approve ? 'REVIEWED_EFFECT_ABSENT_FROM_CONFLICT' : 'REVIEWED_EFFECT_NOT_RECOGNISABLE_WITHOUT_PROTOCOL');
      if (alternate.candidates.length) reasons.push('SAME_SPENDER_APPROVAL_WITH_DIFFERENT_AMOUNT');
    }
    if (classification !== 'MATCHING_TRANSACTION_CONFIRMED') {
      if (approve && !alternate.complete) reasons.push('ALTERNATE_NONCE_SCAN_INCOMPLETE');
      if (alternate.truncated) reasons.push('ALTERNATE_NONCE_CANDIDATES_TRUNCATED');
      if (alternate.status === 'NONE_IN_SCANNED_RANGE') reasons.push('LATER_BROADCAST_NOT_EXCLUDED');
      if (alternate.status === 'NOT_EVALUATED') reasons.push('ALTERNATE_NONCE_PROTOCOL_SPECIFIC');
      reasons.push('NONCE_CONSUMPTION_IS_NOT_PROOF_OF_OUTCOME');
    }
    if (relatedWorkflows.some(r => r.linkage === 'SAME_TRANSACTION_HASH')) reasons.push('CONFLICT_RECORDED_BY_ANOTHER_FLOFI_WORKFLOW');
    if (relatedWorkflows.some(r => r.linkage === 'ALTERNATE_NONCE_CANDIDATE')) reasons.push('CANDIDATE_RECORDED_BY_ANOTHER_FLOFI_WORKFLOW');
    const scanOpen = !!approve && !alternate.complete && !exact;
    const proofComplete = exact || !scanOpen && !alternate.truncated && executionStructure !== 'UNKNOWN' && reviewedEffectInConflict !== 'NOT_DETERMINABLE';
    const report = { ...base, classification, proofComplete, retryable: scanOpen, conflict, comparison, executionStructure, reviewedEffectInConflict,
      alternateNonce: alternate, relatedWorkflows, reasons, safeNextAction };
    return { ...report, evidenceFingerprint: fingerprintOf(report) };
  } catch (error) {
    if (error instanceof Unavailable) return insufficient('RPC_UNAVAILABLE');
    throw error;
  }
}

/** The fingerprint of what decides a report: never its time, never how far a still-running scan has reached. */
function fingerprintOf(report: Omit<NonceConflictReport, 'evidenceFingerprint'>): string {
  // Scan progress is not evidence: a later head the next check has not reached yet (`complete` false again, its reason) changes nothing that
  // was found, so it never resets stability. While a scan is open the report is retryable and never escalates anyway.
  const decisive = [report.classification, report.conflictingTransactionHash, report.conflict && [report.conflict.blockHash, report.conflict.final,
    report.conflict.status], report.comparison, report.executionStructure, report.reviewedEffectInConflict,
  report.alternateNonce.status === 'INCOMPLETE' ? 'NONE_IN_SCANNED_RANGE' : report.alternateNonce.status,
  report.alternateNonce.candidates.map(c => c.transactionHash), report.alternateNonce.truncated === true,
  // Same-nonce runs with another hash are context only (possibly another chain): they never change the evidence.
  report.relatedWorkflows.filter(r => r.linkage !== 'SAME_NONCE_OTHER_HASH').map(r => [r.runId, r.linkage]),
  report.reasons.filter(r => r !== 'ALTERNATE_NONCE_SCAN_INCOMPLETE' && r !== 'LATER_BROADCAST_NOT_EXCLUDED')];
  return createHash('sha256').update(JSON.stringify(decisive)).digest('hex');
}

/**
 * How the worker paces a run whose observation still ends in a nonce conflict, from the latest report and the durable tracking row.
 *
 *   - a check that a later identical check could change (RPC failure, data not final, unfinished scan) keeps the normal cadence
 *     (`delayMs: null` → the worker's exponential backoff), or 30 s while a scan is making progress;
 *   - an unchanged, complete report backs off 15 min → 30 min → 1 h → … ≤ 12 h instead of the 10 min the worker caps at;
 *   - once it has stayed unchanged for STABLE_ESCALATION_OBSERVATIONS checks and at least STABLE_ESCALATION_MIN_AGE_MS since the conflict was
 *     first investigated, and the report is complete for its step, the check stops for operator review (`escalate`). The run is flagged for
 *     attention with NONCE_CONFLICT_STABLE_OPERATOR_REVIEW and keeps outcome UNKNOWN; an operator can resume the read-only check (bounded by the
 *     recovery registry's retry limit) when there is new evidence.
 *
 * A report that is not complete for its step (any non-approval step: its alternate-nonce evidence is protocol-specific and stays with the
 * flow's own scans and deadlines) never escalates early: it only backs off, and stops when the worker's existing budget does.
 */
export const STABLE_ESCALATION_OBSERVATIONS = 4, STABLE_ESCALATION_MIN_AGE_MS = 24 * 3600_000, STABLE_BACKOFF_BASE_MS = 15 * 60_000, STABLE_BACKOFF_MAX_MS = 12 * 3600_000;
export const SCAN_PROGRESS_DELAY_MS = 30_000;
export const STABLE_ESCALATION_CODE = 'NONCE_CONFLICT_STABLE_OPERATOR_REVIEW';
export type NonceConflictPacing = { readonly delayMs: number | null; readonly escalate: boolean; readonly reason: string };
export function nonceConflictPacing(report: Pick<NonceConflictReport, 'classification' | 'retryable' | 'proofComplete'> & { readonly laterAttempts?: NonceConflictReport['laterAttempts'] },
  tracked: { readonly stableObservations: number; readonly firstObservedAt: Date }, now: Date): NonceConflictPacing {
  if (report.classification === 'INSUFFICIENT_CHAIN_EVIDENCE') return { delayMs: null, escalate: false, reason: 'NONCE_CONFLICT_EVIDENCE_UNAVAILABLE' };
  if (report.classification === 'MATCHING_TRANSACTION_CONFIRMED') return { delayMs: null, escalate: false, reason: 'NONCE_CONFLICT_MATCH_AWAITING_FLOW' };
  if (report.retryable) return { delayMs: SCAN_PROGRESS_DELAY_MS, escalate: false, reason: 'NONCE_CONFLICT_SCAN_IN_PROGRESS' };
  // Incomplete for its step (a deposit: its evidence is the flow's own protocol-bound scan, which advances per observation): the worker's
  // normal cadence is kept, exactly as before this build, so a deposit under another nonce is never noticed later than it was.
  if (!report.proofComplete) return { delayMs: null, escalate: false, reason: 'NONCE_CONFLICT_PROTOCOL_EVIDENCE_PENDING' };
  const stable = Math.max(0, tracked.stableObservations);
  // A stop ends automatic observation of the whole run: never while a later step of it may still be on the network.
  const laterOpen = (report.laterAttempts ?? []).some(a => a.hashRecorded || a.state !== 'CANCELLED');
  if (laterOpen) return { delayMs: null, escalate: false, reason: 'NONCE_CONFLICT_LATER_STEP_OPEN' };
  const escalate = stable >= STABLE_ESCALATION_OBSERVATIONS && now.getTime() - tracked.firstObservedAt.getTime() >= STABLE_ESCALATION_MIN_AGE_MS;
  return { delayMs: Math.min(STABLE_BACKOFF_MAX_MS, STABLE_BACKOFF_BASE_MS * 2 ** Math.min(stable, 10)), escalate,
    reason: escalate ? STABLE_ESCALATION_CODE : 'NONCE_CONFLICT_UNCHANGED' };
}
