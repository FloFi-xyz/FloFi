// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ORCA_WHIRLPOOLS_MAINNET_LIQUIDITY as mainnet, createMockedSolanaDevnetOrca, createMockedSolanaWallet, fromBase64, parseTransaction, serializeSignedTransaction,
  toBase64 } from '@defi-workflow-engine/reference-compiler';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { createSolanaLiquidityNode, type SolanaLiquidityInput } from '../domain/solana-liquidity-authoring';
import { createPositionMintSigner } from '../wallet/position-mint-signer';
import { createOrcaLiquidityService } from './orca-liquidity-service';

/**
 * BUILD-SOLANA-MAINNET-001: the Orca liquidity service bound to Solana mainnet-beta, on a MOCKED loopback of the verified SOL/USDC pool. It proves
 * that simulation, Review, the wallet handoff, submission and reconciliation all stay on the reviewed cluster. No public submission.
 */
const input = (network: SolanaLiquidityInput['network']): SolanaLiquidityInput => ({ network, maxSol: '0.01', maxDevUsdc: '0.3', rangeUnit: 'TICK',
  lower: '-39104', upper: '-36992', slippage: '100' });
const workflow = (network: SolanaLiquidityInput['network'] = 'Solana'): SemanticWorkflow => ({ schemaVersion: '1.0.0', workflowId: 'orca-mainnet', revision: 1,
  resourceEdges: [], nodes: [createSolanaLiquidityNode('node-002', input(network))] });
async function setup(service: { provenance?: 'PUBLIC_MAINNET' | 'MOCKED'; executionEnabled?: boolean } = {}) {
  const env = createMockedSolanaDevnetOrca({ liquidityProfile: mainnet }), wallet = createMockedSolanaWallet();
  env.fund(wallet.owner, 3_000_000_000n, 50_000_000n);
  const dir = await mkdtemp(join(tmpdir(), 'flofi-orca-mainnet-'));
  const clock = Date.parse('2026-10-13T12:00:00.000Z');
  return { env, wallet, service: createOrcaLiquidityService({ rpc: env.rpc, journalDir: dir, profile: mainnet, provenance: service.provenance ?? 'MOCKED',
    executionEnabled: service.executionEnabled ?? true, now: () => clock }) };
}

describe('Orca liquidity service on Solana mainnet-beta (MOCKED loopback, no public submission)', () => {
  it('simulates, reviews, hands off on solana:mainnet, submits once and reconciles on the mainnet cluster', async () => {
    const s = await setup({ provenance: 'PUBLIC_MAINNET' }), key = await createPositionMintSigner();
    const simulated = await s.service.simulate(workflow(), s.wallet.owner, { operation: 'OPEN', positionMint: key.address });
    expect(simulated.review).toMatchObject({ chain: mainnet.chain, cluster: 'mainnet-beta', genesisHash: mainnet.genesisHash, pool: { address: mainnet.pool.address },
      token1: { symbol: 'USDC', mint: mainnet.token1.mint } });
    expect([simulated.provenance, simulated.evidenceClass]).toEqual(['PUBLIC_MAINNET', 'PUBLIC_READ_ONLY']);
    const record = await s.service.review(simulated.id, simulated.review.commitment, workflow());
    const begin = await s.service.begin(record.id, s.wallet.owner, workflow());
    expect(begin.walletChain).toBe('solana:mainnet');
    const walletSigned = s.wallet.sign(begin.unsignedTransaction);
    const { signatures, message } = parseTransaction(fromBase64(walletSigned, 2048));
    await s.service.submit(record.id, toBase64(serializeSignedTransaction([signatures[0]!, await key.sign(message)], message)));
    expect(s.env.state.sent).toHaveLength(1);
    const observed = await s.service.observe(record.id);
    expect(observed).toMatchObject({ verdict: 'RECONCILED', evidenceClass: 'PUBLIC_EXECUTED' });
    expect(observed.evidence?.bundle.environment).toBe('MAINNET_EXECUTED');
    expect(observed.observations.at(-1)?.explorer).toMatch(/^https:\/\/solscan\.io\/tx\//);
  });
  it('refuses a Devnet workflow on the mainnet service, and keeps a MOCKED run MOCKED', async () => {
    const s = await setup();
    await expect(s.service.simulate(workflow('Solana Devnet'), s.wallet.owner, { operation: 'OPEN', positionMint: (await createPositionMintSigner()).address }))
      .rejects.toThrow('SOLANA_CLUSTER_UNSUPPORTED');
    const run = await s.service.simulate(workflow(), s.wallet.owner, { operation: 'OPEN', positionMint: (await createPositionMintSigner()).address });
    expect(run.evidenceClass).toBe('MOCKED');
  });
  it('keeps owner execution off unless the deployment opted in, with Simulate and Review still read-only', async () => {
    const s = await setup({ executionEnabled: false }), key = await createPositionMintSigner();
    const simulated = await s.service.simulate(workflow(), s.wallet.owner, { operation: 'OPEN', positionMint: key.address });
    const record = await s.service.review(simulated.id, simulated.review.commitment, workflow());
    await expect(s.service.begin(record.id, s.wallet.owner, workflow())).rejects.toThrow('ORCA_LIQUIDITY_EXECUTION_NOT_ENABLED');
    expect(s.env.state.sent).toEqual([]);
  });
  it('refuses a public provenance that is not this cluster’s', async () => {
    await expect(async () => createOrcaLiquidityService({ rpc: createMockedSolanaDevnetOrca().rpc, journalDir: '/tmp/never-used', profile: mainnet, provenance: 'PUBLIC_DEVNET',
      executionEnabled: false })).rejects.toThrow('ORCA_LIQUIDITY_STORAGE_INVALID');
  });
});
