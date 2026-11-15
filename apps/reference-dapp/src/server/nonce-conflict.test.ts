// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-FLOFI-RECONCILIATION-PRIVACY-UX-001 (P0): the read-only nonce-conflict investigation, on the two incident shapes and the edge cases. */
import { describe, expect, it } from 'vitest';
import { decodeApprove, INVESTIGATION_RPC_METHODS, investigateNonceConflict, nonceConflictPacing, nonceConflictSubject, STABLE_ESCALATION_CODE,
  type NonceConflictReport, type PeerAttempt } from './nonce-conflict';
import { approvalLog, approveData, BASE_USDC, fixtureRpc, INCIDENT_A, INCIDENT_B, incidentAChain, incidentARecord, incidentBChain, incidentBRecord, OTHER_SPENDER,
  RELAY_DEPOSITORY, SENDER, type FixtureChain } from './nonce-conflict.fixtures';

const subjectA = () => nonceConflictSubject(INCIDENT_A.flow, incidentARecord())!;
const peersA: PeerAttempt[] = [{ runId: INCIDENT_A.peerRunId, flow: 'crosschain-router-base', step: 'APPROVAL', state: 'CONFIRMED', transactionHash: INCIDENT_A.conflictHash }];
const run = (chain: FixtureChain, options: { subject?: ReturnType<typeof subjectA>; peers?: PeerAttempt[]; previousScan?: { nextBlock: number; candidates: [] } | null;
  scanWindows?: number } = {}) => {
  const { rpc, calls } = fixtureRpc(chain);
  return investigateNonceConflict({ rpc, subject: options.subject ?? subjectA(), peers: options.peers ?? peersA, previousScan: options.previousScan ?? null,
    now: () => new Date('2026-11-14T12:00:00Z'), ...options.scanWindows ? { scanWindows: options.scanWindows } : {} }).then(report => ({ report, calls }));
};
const NOT_A_VERDICT = ['SUCCESS', 'FAILED', 'CANCELLED', 'NOT_EXECUTED', 'PROVEN_NOT_EXECUTED', 'RECONCILED'];
const assertNeverAVerdict = (report: NonceConflictReport) => {
  expect(report.financialOutcome).toBe('UNKNOWN');
  expect(NOT_A_VERDICT).not.toContain(report.classification);
};

describe('subject extraction (pure, from the durable record only)', () => {
  it('reads the conflicted approval of a universal record (Incident A) and of a router record (Incident B)', () => {
    expect(subjectA()).toMatchObject({ runId: INCIDENT_A.runId, step: 'APPROVAL', chainId: '8453', nonce: '60', sender: SENDER, conflictingTransactionHash: INCIDENT_A.conflictHash,
      reviewed: { to: BASE_USDC, value: '0' }, laterAttempts: [] });
    expect(nonceConflictSubject(INCIDENT_B.flow, incidentBRecord())).toMatchObject({ runId: INCIDENT_B.runId, chainId: '42161', nonce: '29' });
  });
  it('returns null for anything that is not an EVM nonce conflict', () => {
    expect(nonceConflictSubject('x', incidentARecord({ note: 'UNIVERSAL_TRANSACTION_NOT_OBSERVED' }))).toBeNull();
    expect(nonceConflictSubject('x', incidentARecord({ state: 'CONFIRMED' }))).toBeNull();
    expect(nonceConflictSubject('x', incidentARecord({ ecosystem: 'SOLANA' }))).toBeNull();
    expect(nonceConflictSubject('x', incidentARecord({ tx: { from: 'nope' } }))).toBeNull();
    expect(nonceConflictSubject('x', null)).toBeNull();
  });
  it('decodes only a canonical approve(address,uint256)', () => {
    expect(decodeApprove(approveData(RELAY_DEPOSITORY, 7n))).toEqual({ spender: RELAY_DEPOSITORY, amount: 7n });
    expect(decodeApprove('0x095ea7b3')).toBeNull();
    expect(decodeApprove('0xa9059cbb' + approveData(RELAY_DEPOSITORY, 7n).slice(10))).toBeNull();
  });
});

describe('Incident A — Base, nonce 60, approval consumed by another FloFi workflow (cases 1, 2, 8, 17)', () => {
  it('identifies the different direct transaction, the different spender and the related workflow by exact hash — outcome stays UNKNOWN', async () => {
    const { report } = await run(incidentAChain());
    expect(report).toMatchObject({ classification: 'CONFLICTING_TRANSACTION_IDENTIFIED', financialOutcome: 'UNKNOWN', executionStructure: 'DIRECT',
      reviewedEffectInConflict: 'ABSENT', proofComplete: true, retryable: false, safeNextAction: 'OPERATOR_REVIEW_CONFLICT',
      conflict: { blockNumber: 37_000_400, final: true, status: 1, to: BASE_USDC, selector: '0x095ea7b3' },
      comparison: { sender: 'SAME', chain: 'SAME', target: 'SAME', selector: 'SAME', calldata: 'DIFFERENT', value: 'SAME', approvalSpender: 'DIFFERENT', approvalAmount: 'SAME' },
      alternateNonce: { status: 'NONE_IN_SCANNED_RANGE', complete: true, scannedFrom: INCIDENT_A.preparedAtBlock, scannedThrough: 37_010_000, candidates: [] },
      relatedWorkflows: [{ runId: INCIDENT_A.peerRunId, linkage: 'SAME_TRANSACTION_HASH' }] });
    expect(report.reasons).toEqual(expect.arrayContaining(['REVIEWED_EFFECT_ABSENT_FROM_CONFLICT', 'LATER_BROADCAST_NOT_EXCLUDED', 'NONCE_CONSUMPTION_IS_NOT_PROOF_OF_OUTCOME',
      'CONFLICT_RECORDED_BY_ANOTHER_FLOFI_WORKFLOW']));
    assertNeverAVerdict(report);
  });
  it('never attributes the other workflow’s confirmed bridge deposit (nonce 61) to this execution (case 8)', async () => {
    const peers = [...peersA, { runId: INCIDENT_A.peerRunId, flow: 'crosschain-router-base', step: 'DEPOSIT', state: 'CONFIRMED', transactionHash: INCIDENT_A.peerDepositHash }];
    const { report } = await run(incidentAChain(), { peers });
    expect(report.relatedWorkflows.filter(r => r.linkage === 'SAME_TRANSACTION_HASH')).toHaveLength(1);
    expect(report.relatedWorkflows.find(r => r.step === 'DEPOSIT')).toMatchObject({ linkage: 'SAME_NONCE_OTHER_HASH' });
    expect(report.classification).toBe('CONFLICTING_TRANSACTION_IDENTIFIED');
    assertNeverAVerdict(report);
  });
  it('stays unknown even when no FloFi workflow recorded the consuming transaction (an external wallet transaction)', async () => {
    const { report } = await run(incidentAChain(), { peers: [] });
    expect(report).toMatchObject({ classification: 'CONFLICTING_TRANSACTION_IDENTIFIED', relatedWorkflows: [] });
    expect(report.reasons).not.toContain('CONFLICT_RECORDED_BY_ANOTHER_FLOFI_WORKFLOW');
  });
});

describe('Incident B — Arbitrum One, nonce 29, approval consumed by a later swap approval (case 1, 2)', () => {
  it('classifies the conflict without inferring a replacement from the later date, and keeps the outcome unknown', async () => {
    const subject = nonceConflictSubject(INCIDENT_B.flow, incidentBRecord())!;
    const peers = [{ runId: INCIDENT_B.peerRunId, flow: 'arbitrum-swap', step: 'APPROVAL', state: 'CONFIRMED', transactionHash: INCIDENT_B.conflictHash }];
    const { report } = await run(incidentBChain(), { subject, peers });
    expect(report).toMatchObject({ classification: 'CONFLICTING_TRANSACTION_IDENTIFIED', chainId: '42161', nonce: '29', reviewedEffectInConflict: 'ABSENT',
      comparison: { approvalSpender: 'DIFFERENT' }, relatedWorkflows: [{ runId: INCIDENT_B.peerRunId, linkage: 'SAME_TRANSACTION_HASH' }],
      alternateNonce: { status: 'NONE_IN_SCANNED_RANGE', complete: true } });
    expect(report.relatedWorkflows.map(r => r.runId)).not.toContain(INCIDENT_B.earlierBridgeRunId); // similar intent is never a link
    assertNeverAVerdict(report);
  });
});

describe('edge cases', () => {
  it('case 3: a genuinely matching transaction is reported as a match for the flow to settle — not settled here', async () => {
    const chain = incidentAChain();
    chain.txs[0] = { ...chain.txs[0]!, input: approveData(RELAY_DEPOSITORY, INCIDENT_A.amount), logs: [approvalLog(BASE_USDC, SENDER, RELAY_DEPOSITORY, INCIDENT_A.amount)] };
    const { report } = await run(chain);
    expect(report).toMatchObject({ classification: 'MATCHING_TRANSACTION_CONFIRMED', safeNextAction: 'LET_FLOW_SETTLE', financialOutcome: 'UNKNOWN' });
  });
  it('case 4 / 11: unreadable or unavailable data is INSUFFICIENT_CHAIN_EVIDENCE (retryable), never a verdict and never a throw', async () => {
    for (const failing of ['eth_chainId', 'eth_getBlockByNumber', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getCode', 'eth_getLogs']) {
      const { report } = await run({ ...incidentAChain(), failing: new Set([failing]) });
      expect([failing, report.classification, report.retryable]).toEqual([failing, 'INSUFFICIENT_CHAIN_EVIDENCE', true]);
      assertNeverAVerdict(report);
    }
    const missing = await run(incidentARecord() && { ...incidentAChain(), hiddenTx: new Set([INCIDENT_A.conflictHash]) });
    expect(missing.report.reasons[0]).toBe('CONFLICT_TRANSACTION_NOT_FOUND');
    const noHash = await run(incidentAChain(), { subject: nonceConflictSubject('crosschain-universal', incidentARecord({ conflictingTransactionHash: undefined }))! });
    expect(noHash.report.reasons[0]).toBe('CONFLICT_HASH_NOT_RECORDED');
  });
  it('refuses a client that serves another chain', async () => {
    const { report } = await run({ ...incidentAChain(), chainId: 42161 });
    expect(report.reasons[0]).toBe('RPC_CHAIN_MISMATCH');
  });
  it('refuses data that contradicts the record (sender or nonce)', async () => {
    const chain = incidentAChain();
    chain.txs[0] = { ...chain.txs[0]!, nonce: 59 };
    expect((await run(chain)).report.reasons[0]).toBe('CONFLICT_IDENTITY_MISMATCH');
  });
  it('case 5: a different outer transaction (self-call through delegated code) carrying the reviewed approval is DELEGATED_EXECUTION_UNDETERMINED', async () => {
    const chain = { ...incidentAChain(), code: { [SENDER]: '0xef0100' + '77'.repeat(20) } };
    chain.txs[0] = { ...chain.txs[0]!, to: SENDER, input: '0x34fcd5be' + '00'.repeat(64), logs: [approvalLog(BASE_USDC, SENDER, RELAY_DEPOSITORY, INCIDENT_A.amount)] };
    const { report } = await run(chain);
    expect(report).toMatchObject({ classification: 'DELEGATED_EXECUTION_UNDETERMINED', executionStructure: 'DELEGATED_SELF_CALL', reviewedEffectInConflict: 'OBSERVED',
      safeNextAction: 'OPERATOR_REVIEW_DELEGATED' });
    assertNeverAVerdict(report);
  });
  it('a plain self-send from an account without code (a wallet cancel) is a DIRECT conflicting transaction, not delegation', async () => {
    const chain = incidentAChain();
    chain.txs[0] = { ...chain.txs[0]!, to: SENDER, input: '0x', logs: [] };
    expect((await run(chain)).report).toMatchObject({ classification: 'CONFLICTING_TRANSACTION_IDENTIFIED', executionStructure: 'DIRECT', reviewedEffectInConflict: 'ABSENT',
      comparison: { target: 'DIFFERENT', approvalSpender: 'UNKNOWN' } });
  });
  it('case 6: an EIP-7702 set-code transaction is undetermined even without a recognisable effect', async () => {
    const chain = incidentAChain();
    chain.txs[0] = { ...chain.txs[0]!, type: '0x4', to: SENDER, input: '0x', logs: [] };
    expect((await run(chain)).report).toMatchObject({ classification: 'DELEGATED_EXECUTION_UNDETERMINED', executionStructure: 'EIP7702_SET_CODE' });
  });
  it('case 6b: a delegated account (0xef0100 code) is undetermined unless the reviewed effect is provably absent', async () => {
    const code = { [SENDER]: '0xef0100' + '77'.repeat(20) };
    expect((await run({ ...incidentAChain(), code })).report).toMatchObject({ classification: 'CONFLICTING_TRANSACTION_IDENTIFIED', executionStructure: 'DELEGATED_ACCOUNT',
      reviewedEffectInConflict: 'ABSENT' });
    const chain = { ...incidentAChain(), code };
    chain.txs[0] = { ...chain.txs[0]!, to: OTHER_SPENDER, input: '0xdeadbeef', logs: [approvalLog(BASE_USDC, SENDER, RELAY_DEPOSITORY, INCIDENT_A.amount)] };
    expect((await run(chain)).report.classification).toBe('DELEGATED_EXECUTION_UNDETERMINED');
  });
  it('case 7 / 9: the reviewed approval sent with another nonce is a POSSIBLE_ALTERNATE_NONCE candidate, never attributed', async () => {
    const chain = incidentAChain();
    chain.txs.push({ hash: '0x' + 'c7'.repeat(32), from: SENDER, nonce: 62, to: BASE_USDC, input: approveData(RELAY_DEPOSITORY, INCIDENT_A.amount), blockNumber: 37_005_000,
      logs: [approvalLog(BASE_USDC, SENDER, RELAY_DEPOSITORY, INCIDENT_A.amount)] });
    const { report } = await run(chain);
    expect(report).toMatchObject({ classification: 'POSSIBLE_ALTERNATE_NONCE', safeNextAction: 'OPERATOR_REVIEW_ALTERNATE',
      alternateNonce: { status: 'CANDIDATE_FOUND', complete: true, candidates: [{ transactionHash: '0x' + 'c7'.repeat(32), nonce: '62', amountMatches: true }] } });
    // Case 9: an approval without any later deposit request from FloFi: the record says so, the outcome is still unknown.
    expect(report.laterAttempts).toEqual([]);
    assertNeverAVerdict(report);
  });
  it('an approval to the reviewed spender with another amount is reported, not treated as the reviewed call', async () => {
    const chain = incidentAChain();
    chain.txs.push({ hash: '0x' + 'c8'.repeat(32), from: SENDER, nonce: 63, to: BASE_USDC, input: approveData(RELAY_DEPOSITORY, 5n), blockNumber: 37_006_000,
      logs: [approvalLog(BASE_USDC, SENDER, RELAY_DEPOSITORY, 5n)] });
    const { report } = await run(chain);
    expect(report.classification).toBe('CONFLICTING_TRANSACTION_IDENTIFIED');
    expect(report.reasons).toContain('SAME_SPENDER_APPROVAL_WITH_DIFFERENT_AMOUNT');
  });
  it('case 10: a peer workflow’s deposit and destination fill never become evidence for this execution', async () => {
    const peers = [...peersA, { runId: INCIDENT_A.peerRunId, flow: 'crosschain-router-base', step: 'FILL', state: 'CONFIRMED', transactionHash: '0x' + 'f1'.repeat(32) }];
    const { report } = await run(incidentAChain(), { peers });
    expect(report.classification).toBe('CONFLICTING_TRANSACTION_IDENTIFIED');
    assertNeverAVerdict(report);
  });
  it('case 12: a consuming transaction above the final head is not final evidence', async () => {
    const { report } = await run({ ...incidentAChain(), finalHead: 37_000_300 });
    expect(report).toMatchObject({ classification: 'INSUFFICIENT_CHAIN_EVIDENCE', safeNextAction: 'WAIT_FOR_FINALITY', reasons: ['CONFLICT_NOT_FINAL', expect.any(String)] });
  });
  it('case 12: a bounded scan stops, resumes from its cursor without re-reading, and its fingerprint is stable once complete', async () => {
    const first = await run(incidentAChain(), { scanWindows: 2 });
    expect(first.report).toMatchObject({ retryable: true, proofComplete: false, safeNextAction: 'CONTINUE_SCAN', alternateNonce: { status: 'INCOMPLETE', complete: false,
      scannedThrough: 37_003_999 } });
    const second = await run(incidentAChain(), { previousScan: { nextBlock: 37_004_000, candidates: [] } });
    expect(second.report).toMatchObject({ retryable: false, proofComplete: true, alternateNonce: { complete: true, scannedFrom: INCIDENT_A.preparedAtBlock } });
    expect(second.calls.filter(c => c.method === 'eth_getLogs').map(c => (c.params[0] as { fromBlock: string }).fromBlock)[0]).toBe('0x' + (37_004_000).toString(16));
    const third = await run({ ...incidentAChain(), finalHead: 37_012_000 }, { previousScan: { nextBlock: 37_010_001, candidates: [] } });
    expect(third.report.evidenceFingerprint).toBe(second.report.evidenceFingerprint); // a later final head with nothing new is the same evidence
    expect(third.calls.filter(c => c.method === 'eth_getLogs')).toHaveLength(1);
  });
  it('case 13: a historic transaction the provider finds only on a later try changes the report', async () => {
    const hidden = await run({ ...incidentAChain(), hiddenTx: new Set([INCIDENT_A.conflictHash]) });
    const found = await run(incidentAChain());
    expect(hidden.report.classification).toBe('INSUFFICIENT_CHAIN_EVIDENCE');
    expect(found.report.classification).toBe('CONFLICTING_TRANSACTION_IDENTIFIED');
    expect(found.report.evidenceFingerprint).not.toBe(hidden.report.evidenceFingerprint);
  });
  it('case 18: only allow-listed read methods are ever called — no send, sign or replay', async () => {
    for (const chain of [incidentAChain(), { ...incidentAChain(), finalHead: 37_000_300 }]) {
      const { calls } = await run(chain);
      expect(calls.every(c => INVESTIGATION_RPC_METHODS.includes(c.method))).toBe(true);
      expect(calls.some(c => /send|sign|raw/i.test(c.method))).toBe(false);
    }
  });
});

describe('review fixes', () => {
  it('a matching transaction without a chain id is not called a match (the flows require the chain id)', async () => {
    const chain = incidentAChain();
    chain.txs[0] = { ...chain.txs[0]!, chainId: 0, input: approveData(RELAY_DEPOSITORY, INCIDENT_A.amount), logs: [approvalLog(BASE_USDC, SENDER, RELAY_DEPOSITORY, INCIDENT_A.amount)] };
    const { report } = await run(chain);
    expect(report.comparison.chain).toBe('UNKNOWN');
    expect(report.classification).not.toBe('MATCHING_TRANSACTION_CONFIRMED');
  });
  it('never drops an amount-matching candidate behind many other same-spender approvals; truncation makes the report incomplete', async () => {
    const chain = incidentAChain();
    for (let i = 0; i < 45; i++) chain.txs.push({ hash: '0x' + (0x1000 + i).toString(16).padStart(64, '0'), from: SENDER, nonce: 100 + i, to: BASE_USDC,
      input: approveData(RELAY_DEPOSITORY, 1n), blockNumber: 37_001_000 + i, logs: [approvalLog(BASE_USDC, SENDER, RELAY_DEPOSITORY, 1n)] });
    const truncatedOnly = await run(chain);
    expect(truncatedOnly.report).toMatchObject({ classification: 'CONFLICTING_TRANSACTION_IDENTIFIED', proofComplete: false, alternateNonce: { truncated: true } });
    expect(truncatedOnly.report.reasons).toContain('ALTERNATE_NONCE_CANDIDATES_TRUNCATED');
    chain.txs.push({ hash: '0x' + 'c9'.repeat(32), from: SENDER, nonce: 200, to: BASE_USDC, input: approveData(RELAY_DEPOSITORY, INCIDENT_A.amount), blockNumber: 37_002_000,
      logs: [approvalLog(BASE_USDC, SENDER, RELAY_DEPOSITORY, INCIDENT_A.amount)] });
    const { report } = await run(chain);
    expect(report.classification).toBe('POSSIBLE_ALTERNATE_NONCE');
    expect(report.alternateNonce.candidates.some(c => c.transactionHash === '0x' + 'c9'.repeat(32) && c.amountMatches)).toBe(true);
  });
  it('a candidate that another FloFi run recorded is attributed to it by exact hash', async () => {
    const chain = incidentAChain(), other = '0x' + 'ca'.repeat(32);
    chain.txs.push({ hash: other, from: SENDER, nonce: 70, to: BASE_USDC, input: approveData(RELAY_DEPOSITORY, INCIDENT_A.amount), blockNumber: 37_003_000,
      logs: [approvalLog(BASE_USDC, SENDER, RELAY_DEPOSITORY, INCIDENT_A.amount)] });
    const { rpc } = fixtureRpc(chain);
    const report = await investigateNonceConflict({ rpc, subject: subjectA(), peers: peersA, now: () => new Date('2026-11-14T12:00:00Z'),
      candidatePeers: async hashes => hashes.includes(other) ? [{ runId: 'xuni-another-bridge', flow: 'crosschain-universal', step: 'APPROVAL', state: 'CONFIRMED', transactionHash: other }] : [] });
    expect(report).toMatchObject({ classification: 'POSSIBLE_ALTERNATE_NONCE', financialOutcome: 'UNKNOWN' });
    expect(report.relatedWorkflows).toContainEqual(expect.objectContaining({ runId: 'xuni-another-bridge', linkage: 'ALTERNATE_NONCE_CANDIDATE' }));
    expect(report.reasons).toContain('CANDIDATE_RECORDED_BY_ANOTHER_FLOFI_WORKFLOW');
  });
  it('same-nonce runs with another hash (possibly another chain) are context only: they never change the evidence fingerprint', async () => {
    const base = await run(incidentAChain());
    const other = await run(incidentAChain(), { peers: [...peersA, { runId: 'other-chain-run', flow: 'ethereum-swap', step: 'SWAP', state: 'CONFIRMED', transactionHash: '0x' + 'ab'.repeat(32) }] });
    expect(other.report.relatedWorkflows.find(r => r.runId === 'other-chain-run')?.linkage).toBe('SAME_NONCE_OTHER_HASH');
    expect(other.report.evidenceFingerprint).toBe(base.report.evidenceFingerprint);
  });
});

describe('pacing of a stable conflict (case 14)', () => {
  const complete = { classification: 'CONFLICTING_TRANSACTION_IDENTIFIED' as const, retryable: false, proofComplete: true };
  const first = new Date('2026-11-10T00:00:00Z');
  it('backs off exponentially (15 min … ≤ 12 h) and escalates only after 4 unchanged checks and 24 h', () => {
    expect(nonceConflictPacing(complete, { stableObservations: 0, firstObservedAt: first }, new Date('2026-11-10T01:00:00Z'))).toEqual({ delayMs: 900_000, escalate: false,
      reason: 'NONCE_CONFLICT_UNCHANGED' });
    expect(nonceConflictPacing(complete, { stableObservations: 9, firstObservedAt: first }, new Date('2026-11-10T02:00:00Z'))).toMatchObject({ delayMs: 12 * 3600_000, escalate: false });
    expect(nonceConflictPacing(complete, { stableObservations: 4, firstObservedAt: first }, new Date('2026-11-11T00:00:00Z'))).toMatchObject({ escalate: true, reason: STABLE_ESCALATION_CODE });
  });
  it('never escalates an incomplete report, a scan in progress, a match, or missing evidence', () => {
    const late = new Date('2026-11-20T00:00:00Z'), tracked = { stableObservations: 50, firstObservedAt: first };
    expect(nonceConflictPacing({ ...complete, proofComplete: false }, tracked, late).escalate).toBe(false);
    expect(nonceConflictPacing({ ...complete, retryable: true }, tracked, late)).toEqual({ delayMs: 30_000, escalate: false, reason: 'NONCE_CONFLICT_SCAN_IN_PROGRESS' });
    expect(nonceConflictPacing({ ...complete, classification: 'MATCHING_TRANSACTION_CONFIRMED' }, tracked, late)).toMatchObject({ delayMs: null, escalate: false });
    expect(nonceConflictPacing({ classification: 'INSUFFICIENT_CHAIN_EVIDENCE', retryable: true, proofComplete: false }, tracked, late)).toMatchObject({ delayMs: null, escalate: false });
  });
  it('non-approval steps stay incomplete (protocol-specific evidence), so they only back off and never escalate early', async () => {
    const record = incidentARecord({ step: 'DEPOSIT', tx: { ...incidentARecord().attempts[0]!.tx, data: '0xabcdef01' } });
    const { report } = await run(incidentAChain(), { subject: nonceConflictSubject('crosschain-universal', record)! });
    expect(report).toMatchObject({ classification: 'CONFLICTING_TRANSACTION_IDENTIFIED', proofComplete: false, retryable: false, reviewedEffectInConflict: 'NOT_DETERMINABLE',
      alternateNonce: { status: 'NOT_EVALUATED' }, safeNextAction: 'OPERATOR_REVIEW_PROTOCOL_WINDOW' });
    // Review fix: a deposit keeps the worker's normal cadence (its own protocol-bound scan advances per observation), as before this build.
    expect(nonceConflictPacing(report, { stableObservations: 99, firstObservedAt: first }, new Date('2026-12-01T00:00:00Z'))).toEqual({ delayMs: null, escalate: false,
      reason: 'NONCE_CONFLICT_PROTOCOL_EVIDENCE_PENDING' });
  });
  it('never stops the run while a later step of it may still be on the network', () => {
    const tracked = { stableObservations: 9, firstObservedAt: first }, late = new Date('2026-11-20T00:00:00Z');
    // Review fix: while a later step may be on the network, the whole run keeps the worker's normal cadence (no stable back-off either).
    expect(nonceConflictPacing({ ...complete, laterAttempts: [{ step: 'DEPOSIT', state: 'PENDING', hashRecorded: true }] }, tracked, late))
      .toEqual({ delayMs: null, escalate: false, reason: 'NONCE_CONFLICT_LATER_STEP_OPEN' });
    expect(nonceConflictPacing({ ...complete, laterAttempts: [{ step: 'DEPOSIT', state: 'SUBMISSION_RESULT_UNKNOWN', hashRecorded: false }] }, tracked, late).escalate).toBe(false);
    expect(nonceConflictPacing({ ...complete, laterAttempts: [{ step: 'DEPOSIT', state: 'CANCELLED', hashRecorded: false }] }, tracked, late).escalate).toBe(true);
  });
});
