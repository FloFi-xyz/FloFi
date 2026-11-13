// SPDX-License-Identifier: AGPL-3.0-only
// ADR-0010 §4: FloFi Wallet's confirmation summary names the token fee the owner repays to Pimlico's Kora fee payer, never a SOL fee it does not pay.
import { describe, expect, it } from 'vitest';
import { JUPITER_SOLANA_MAINNET, SOLANA_MAINNET_TRANSFER } from '@defi-workflow-engine/action-registry';
import { resolveManagedSigning, type ManagedSigningDeps } from './managed-signing';

const NOW = Date.parse('2026-11-13T12:00:00.000Z'), LATER = '2026-11-13T12:01:00.000Z';
const SOL_OWNER = '7'.repeat(32) + 'abcd', SOL_RECIPIENT = '8'.repeat(32) + 'efgh';
const MESSAGE = Uint8Array.from([0x80, 2, 1, 0, 2, ...new Array(64).fill(9)]);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const gas = { mechanism: 'PIMLICO_KORA_SPL_FEE', amount: '3100', token: { symbol: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 } };
const deps = (record: unknown): ManagedSigningDeps => ({ load: async () => structuredClone(record), managed: (ecosystem, address) => ecosystem === 'solana' && address === SOL_OWNER,
  pendingNonce: async () => 0n, fees: async () => ({ maxFeePerGas: 0n, maxPriorityFeePerGas: 0n }), now: () => NOW } as ManagedSigningDeps);
const attempt = { state: 'PREPARED', messageHash: '0xh', signature: null, transaction: null };

describe('FloFi Wallet summary of a Kora transaction', () => {
  it('shows the swap\'s network fee in USDC, paid to Pimlico', async () => {
    const id = 'jupiter-' + 'c'.repeat(32);
    const record = { id, verdict: 'PENDING', authorization: '0xr', attempt, review: { format: 'gryloo.jupiter-review.v1', chain: JUPITER_SOLANA_MAINNET.chain, cluster: 'mainnet-beta',
      owner: SOL_OWNER, message: b64(MESSAGE), messageHash: '0xh', amount: '1500000', input: { symbol: 'USDC', decimals: 6 }, output: { symbol: 'SOL', decimals: 9 },
      quote: { outAmount: '10000000', otherAmountThreshold: '9950000' }, slippageBps: 50, estimatedFeeLamports: '10000', expiresAt: LATER, commitment: '0xr', gas } };
    const result = await resolveManagedSigning({ flow: 'jupiter-swap', runId: id }, { ecosystem: 'solana', chain: 'solana:mainnet', address: SOL_OWNER, message: MESSAGE }, deps(record));
    const lines = result.ok ? result.value.summary.lines : [];
    expect(lines).toContainEqual({ label: 'Network fee', value: '0.0031 USDC (paid to Pimlico)' });
    expect(lines.some(line => /SOL$/.test(line.value) && /fee|cost/i.test(line.label))).toBe(false);
  });
  it('shows the transfer\'s network fee in USDC instead of a SOL network cost', async () => {
    const id = 'soltx-' + 'd'.repeat(32);
    const record = { id, verdict: 'PENDING', authorization: '0xs', attempt, review: { format: 'gryloo.solana-transfer-review.v1', chain: SOLANA_MAINNET_TRANSFER.chain,
      cluster: SOLANA_MAINNET_TRANSFER.cluster, owner: SOL_OWNER, recipient: SOL_RECIPIENT, amount: '12000000', asset: { symbol: 'USDC', mint: gas.token.mint, decimals: 6 },
      maximumNetworkCostLamports: '0', message: b64(MESSAGE), messageHash: '0xh', expiresAt: LATER, commitment: '0xs', gas } };
    const result = await resolveManagedSigning({ flow: 'solana-transfer', runId: id }, { ecosystem: 'solana', chain: 'solana:mainnet', message: MESSAGE }, deps(record));
    expect(result.ok && result.value.summary.lines).toEqual([{ label: 'You send', value: '12 USDC' }, { label: 'Recipient', value: SOL_RECIPIENT },
      { label: 'Token mint', value: gas.token.mint }, { label: 'Network fee', value: '0.0031 USDC (paid to Pimlico)' }]);
  });
});
