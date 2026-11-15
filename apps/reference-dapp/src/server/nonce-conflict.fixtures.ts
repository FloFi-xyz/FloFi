// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-RECONCILIATION-PRIVACY-UX-001: deterministic, in-memory EVM chains for the nonce-conflict investigation tests. They answer only the
 * read methods the investigator may call; any other method (and every send/sign method) throws. Real incident identifiers appear as forensic
 * references (hashes, run ids, nonces); every other value — senders, spenders, blocks — is a generated fixture value, never production data.
 */
export type FixtureLog = { readonly address: string; readonly topics: readonly string[]; readonly data: string };
export type FixtureTx = { readonly hash: string; readonly from: string; readonly nonce: number; readonly to: string | null; readonly input: string; readonly value?: bigint;
  readonly type?: string; readonly chainId?: number; readonly blockNumber: number; readonly status?: 0 | 1; readonly logs?: readonly FixtureLog[] };
export type FixtureChain = { readonly chainId: number; finalHead: number; readonly txs: FixtureTx[]; readonly code?: Record<string, string>;
  /** Method names that fail (an unavailable RPC); `hiddenTx` hashes the provider does not know yet. */ readonly failing?: Set<string>; readonly hiddenTx?: Set<string> };

export const APPROVAL_TOPIC = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
export const word = (address: string) => '0x' + address.slice(2).toLowerCase().padStart(64, '0');
export const hex = (n: number | bigint) => '0x' + n.toString(16);
export const approveData = (spender: string, amount: bigint) => '0x095ea7b3' + spender.slice(2).toLowerCase().padStart(64, '0') + amount.toString(16).padStart(64, '0');
export const approvalLog = (token: string, owner: string, spender: string, amount: bigint): FixtureLog =>
  ({ address: token, topics: [APPROVAL_TOPIC, word(owner), word(spender)], data: '0x' + amount.toString(16).padStart(64, '0') });
const blockHash = (chainId: number, n: number) => '0x' + (chainId.toString(16) + 'b' + n.toString(16)).padStart(64, '0');

export function fixtureRpc(chain: FixtureChain) {
  const calls: { method: string; params: readonly unknown[] }[] = [];
  const find = (hash: string) => chain.hiddenTx?.has(hash) ? undefined : chain.txs.find(t => t.hash === hash);
  const rpc = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    calls.push({ method, params });
    if (chain.failing?.has(method)) throw new Error('PUBLIC_RPC_UNAVAILABLE');
    switch (method) {
      case 'eth_chainId': return hex(chain.chainId);
      case 'eth_getBlockByNumber': {
        const tag = params[0];
        if (tag === 'finalized' || tag === 'safe') return { number: hex(chain.finalHead), hash: blockHash(chain.chainId, chain.finalHead) };
        const n = Number(BigInt(String(tag)));
        return { number: hex(n), hash: blockHash(chain.chainId, n), timestamp: hex(1_700_000_000 + n) };
      }
      case 'eth_getTransactionByHash': {
        const t = find(String(params[0]));
        return t ? { hash: t.hash, from: t.from, nonce: hex(t.nonce), to: t.to, input: t.input, value: hex(t.value ?? 0n), type: t.type ?? '0x2',
          ...t.chainId === 0 ? {} : { chainId: hex(t.chainId ?? chain.chainId) }, blockNumber: hex(t.blockNumber), blockHash: blockHash(chain.chainId, t.blockNumber) } : null;
      }
      case 'eth_getTransactionReceipt': {
        const t = find(String(params[0]));
        return t ? { transactionHash: t.hash, status: hex(t.status ?? 1), blockNumber: hex(t.blockNumber), blockHash: blockHash(chain.chainId, t.blockNumber),
          logs: (t.logs ?? []).map(l => ({ ...l, transactionHash: t.hash, blockNumber: hex(t.blockNumber) })) } : null;
      }
      case 'eth_getCode': return chain.code?.[String(params[0]).toLowerCase()] ?? '0x';
      case 'eth_getLogs': {
        const f = params[0] as { address: string; fromBlock: string; toBlock: string; topics: (string | null)[] };
        const from = Number(BigInt(f.fromBlock)), to = Number(BigInt(f.toBlock));
        if (to - from + 1 > 2_000) throw new Error('RANGE_TOO_LARGE');
        return chain.txs.filter(t => t.blockNumber >= from && t.blockNumber <= to && (t.status ?? 1) === 1).flatMap(t => (t.logs ?? [])
          .filter(l => l.address === f.address && f.topics.every((topic, i) => topic === null || l.topics[i] === topic))
          .map(l => ({ ...l, transactionHash: t.hash, blockNumber: hex(t.blockNumber) })));
      }
      default: throw new Error(`FIXTURE_METHOD_NOT_SERVED:${method}`);
    }
  };
  return { rpc, calls };
}

// --- Incident A (Base → Arbitrum, universal router): forensic references are real; other values are fixtures. --------------------------
export const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export const SENDER = '0x' + '5e'.repeat(20);
export const RELAY_DEPOSITORY = '0x' + '4e'.repeat(20); // the reviewed spender (fixture value)
export const OTHER_SPENDER = '0x' + '5a'.repeat(20);    // the conflicting workflow's spender (fixture value)
export const INCIDENT_A = {
  runId: 'xuni-379461c2e3f1807a0dc0455342a51d21', flow: 'crosschain-universal', chainId: 8453, nonce: 60, preparedAtBlock: 37_000_000,
  conflictHash: '0x236d2c4fcb9ac8e5c49c31bdf0a14d0a35ee9474cb9f4f0657b7e49e04b139d4', peerRunId: 'xroute-3e24d126e836528cecfb7dc445852c9b',
  peerDepositHash: '0xa2938caa574947d70fffe0949ae9e6f891d34c2cb7481c5bfac1bc4aeb096718', amount: 1_000_000n,
};
/** The universal router's durable record, reduced to the fields the investigation reads (shape of `UniversalRecord`). */
export const incidentARecord = (overrides: Record<string, unknown> = {}) => ({
  id: INCIDENT_A.runId, owner: SENDER, error: 'UNIVERSAL_NONCE_CONSUMED_BY_DIFFERENT_TRANSACTION',
  attempts: [{ ecosystem: 'EVM', attemptId: `${INCIDENT_A.runId}.approval.1`, step: 'APPROVAL', state: 'SUBMISSION_RESULT_UNKNOWN', nonce: String(INCIDENT_A.nonce),
    preparedAtBlock: INCIDENT_A.preparedAtBlock, transactionHash: null, replacementHash: null, conflictingTransactionHash: INCIDENT_A.conflictHash,
    note: 'UNIVERSAL_NONCE_CONSUMED_BY_DIFFERENT_TRANSACTION', reconciled: false,
    tx: { chainId: hex(INCIDENT_A.chainId), from: SENDER, to: BASE_USDC, data: approveData(RELAY_DEPOSITORY, INCIDENT_A.amount), value: '0x0', gas: '0x0',
      maxFeePerGas: '0x0', maxPriorityFeePerGas: '0x0' }, ...overrides }],
});
export function incidentAChain(): FixtureChain {
  return { chainId: INCIDENT_A.chainId, finalHead: 37_010_000, txs: [
    { hash: INCIDENT_A.conflictHash, from: SENDER, nonce: 60, to: BASE_USDC, input: approveData(OTHER_SPENDER, INCIDENT_A.amount), blockNumber: 37_000_400,
      logs: [approvalLog(BASE_USDC, SENDER, OTHER_SPENDER, INCIDENT_A.amount)] },
    { hash: INCIDENT_A.peerDepositHash, from: SENDER, nonce: 61, to: OTHER_SPENDER, input: '0xabcdef01', blockNumber: 37_000_410, logs: [] },
  ] };
}

// --- Incident B (Arbitrum → Base, cross-chain router) -----------------------------------------------------------------------------------
export const ARB_USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
export const SPOKE_POOL = '0x' + '5b'.repeat(20);       // the reviewed spender (fixture value)
export const SWAP_SPENDER = '0x' + '5c'.repeat(20);     // the conflicting swap's spender (fixture value)
export const INCIDENT_B = {
  runId: 'xroute-a09617c2bb8ac5469cab1fc955a3fd32', flow: 'crosschain-router-arbitrum-to-base', chainId: 42161, nonce: 29, preparedAtBlock: 395_000_000,
  conflictHash: '0xd7c93de487dd07550f119597b94f94e27c7303cbce547bb6939c829597fea223', peerRunId: 'ars-1963ff046993f0d2098032a7',
  earlierBridgeRunId: 'xroute-d24ac723c2c4307b384c26a1abcb3b64', amount: 5_000_000n,
};
export const incidentBRecord = () => ({
  id: INCIDENT_B.runId, owner: SENDER, error: 'ROUTER_NONCE_CONSUMED_BY_DIFFERENT_TRANSACTION',
  attempts: [{ attemptId: `${INCIDENT_B.runId}.approval.1`, step: 'APPROVAL', state: 'SUBMISSION_RESULT_UNKNOWN', reviewCommitment: '0x' + '0'.repeat(64),
    nonce: String(INCIDENT_B.nonce), preparedAtBlock: INCIDENT_B.preparedAtBlock, createdAt: '2026-10-28T12:00:00.000Z', transactionHash: null, replacementHash: null,
    conflictingTransactionHash: INCIDENT_B.conflictHash, receipt: null, reconciled: false, note: 'ROUTER_NONCE_CONSUMED_BY_DIFFERENT_TRANSACTION',
    tx: { nonce: hex(INCIDENT_B.nonce), chainId: hex(INCIDENT_B.chainId), from: SENDER, to: ARB_USDC, data: approveData(SPOKE_POOL, INCIDENT_B.amount), value: '0x0',
      gas: '0x0', maxFeePerGas: '0x0', maxPriorityFeePerGas: '0x0' } }],
});
export function incidentBChain(): FixtureChain {
  return { chainId: INCIDENT_B.chainId, finalHead: 395_030_000, txs: [
    // Recorded much later (November 5) than the uncertain bridge (October 28): consumption alone says nothing about when or why.
    { hash: INCIDENT_B.conflictHash, from: SENDER, nonce: 29, to: ARB_USDC, input: approveData(SWAP_SPENDER, 5_000_000n), blockNumber: 395_020_000,
      logs: [approvalLog(ARB_USDC, SENDER, SWAP_SPENDER, 5_000_000n)] },
  ] };
}
