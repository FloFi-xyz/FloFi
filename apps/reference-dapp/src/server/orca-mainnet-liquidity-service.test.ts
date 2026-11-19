// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ORCA_WHIRLPOOLS_MAINNET_LIQUIDITY as mainnet, associatedTokenAddress, createMockedSolanaDevnetOrca, createMockedSolanaWallet, fromBase64, orcaPositionAddress,
  orcaPositionTokenAccount, parseTransaction, serializeSignedTransaction, toBase64, type MockedOrcaOptions, type OrcaLiquidityOperation } from '@defi-workflow-engine/reference-compiler';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { createSolanaLiquidityNode, type SolanaLiquidityInput } from '../domain/solana-liquidity-authoring';
import { createPositionMintSigner, type PositionMintSigner } from '../wallet/position-mint-signer';
import { createOrcaLiquidityService, orcaPositionNotManageable } from './orca-liquidity-service';

/**
 * BUILD-SOLANA-MAINNET-001: the Orca liquidity service bound to Solana mainnet-beta, on a MOCKED loopback of the verified SOL/USDC pool. It proves
 * that simulation, Review, the wallet handoff, submission and reconciliation all stay on the reviewed cluster. No public submission.
 */
const input = (network: SolanaLiquidityInput['network']): SolanaLiquidityInput => ({ network, maxSol: '0.01', maxDevUsdc: '0.3', rangeUnit: 'TICK',
  lower: '-39104', upper: '-36992', slippage: '100' });
const workflow = (network: SolanaLiquidityInput['network'] = 'Solana'): SemanticWorkflow => ({ schemaVersion: '1.0.0', workflowId: 'orca-mainnet', revision: 1,
  resourceEdges: [], nodes: [createSolanaLiquidityNode('node-002', input(network))] });
async function setup(service: { provenance?: 'PUBLIC_MAINNET' | 'MOCKED'; executionEnabled?: boolean } = {}, mock: MockedOrcaOptions = {}) {
  const options: MockedOrcaOptions = { liquidityProfile: mainnet, ...mock };
  const env = createMockedSolanaDevnetOrca(options), wallet = createMockedSolanaWallet();
  env.fund(wallet.owner, 3_000_000_000n, 50_000_000n);
  const dir = await mkdtemp(join(tmpdir(), 'flofi-orca-mainnet-'));
  const clock = Date.parse('2026-10-13T12:00:00.000Z');
  const make = () => createOrcaLiquidityService({ rpc: env.rpc, journalDir: dir, profile: mainnet, provenance: service.provenance ?? 'MOCKED',
    executionEnabled: service.executionEnabled ?? true, now: () => clock });
  return { env, wallet, dir, options, make, service: make() };
}
type S = Awaited<ReturnType<typeof setup>>;
async function sign(s: S, begin: { unsignedTransaction: string; signers: string[] }, key: PositionMintSigner | null) {
  const walletSigned = s.wallet.sign(begin.unsignedTransaction);
  if (begin.signers.length === 1) return walletSigned;
  const { signatures, message } = parseTransaction(fromBase64(walletSigned, 2048));
  return toBase64(serializeSignedTransaction([signatures[0]!, await key!.sign(message)], message));
}
async function reviewed(s: S, operation: OrcaLiquidityOperation, mint: string, partBps?: number) {
  const simulated = await s.service.simulate(workflow(), s.wallet.owner, { operation, positionMint: mint, ...partBps ? { partBps } : {} });
  // The Review is always compiled for exactly the requested operation: a withdrawal or collect is never compiled as an OPEN.
  expect([simulated.operation, simulated.review.operation, simulated.review.operationPlan.operation]).toEqual([operation, operation, operation]);
  expect(simulated.review.plan.segments[0]!.steps[0]!.stepId).toBe(`orca-liquidity-${operation.toLowerCase().replaceAll('_', '-')}`);
  expect(simulated.review.signers).toEqual(operation === 'OPEN' ? [s.wallet.owner, mint] : [s.wallet.owner]);
  if (operation !== 'OPEN') expect(simulated.review.instructionSummary.map(i => i.name)).not.toContain('open_position_with_token_extensions');
  return s.service.review(simulated.id, simulated.review.commitment, workflow());
}
async function execute(s: S, id: string, key: PositionMintSigner | null) {
  const begin = await s.service.begin(id, s.wallet.owner, workflow());
  await s.service.submit(id, await sign(s, begin, key));
  return s.service.observe(id);
}
/** A position on the verified pool whose token the owner holds, written into the MOCKED chain state directly: never opened through this service. */
function externalPosition(s: S, options: { liquidity?: bigint; legacyToken?: boolean; delegate?: string; whirlpool?: string } = {}) {
  const mint = createMockedSolanaWallet().owner, position = orcaPositionAddress(mint), owner = s.wallet.owner;
  s.env.state.positions.set(position, { mint, liquidity: options.liquidity ?? 40_000_000n, lower: -39104, upper: -36992, feeOwedA: 0n, feeOwedB: 0n,
    ...options.whirlpool ? { whirlpool: options.whirlpool } : {} });
  s.env.state.lamportsOf.set(position, 2_885_440n); s.env.state.mints.add(mint); s.env.state.lamportsOf.set(mint, 1_676_400n);
  // A legacy (SPL Token) position token sits in the owner's SPL-Token associated account, not in the Token-2022 one.
  const tokenAccount = options.legacyToken ? associatedTokenAddress(owner, mint, mainnet.programs.token, mainnet.programs.associatedToken) : orcaPositionTokenAccount(owner, mint);
  (options.legacyToken ? s.env.state.tokens : s.env.state.tokens2022).set(tokenAccount, { mint, owner, amount: 1n, ...options.delegate ? { delegate: options.delegate } : {} });
  s.env.state.lamportsOf.set(tokenAccount, 1_513_840n);
  return mint;
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

/** BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: the whole position lifecycle and positions FloFi did not open, on the MOCKED mainnet loopback. No public submission. */
describe('Orca liquidity service lifecycle on Solana mainnet-beta (MOCKED loopback, no public submission)', () => {
  it('runs OPEN → DECREASE_PARTIAL (50%) → COLLECT → EXIT, one reviewed owner transaction each, every one reconciled as MOCKED evidence', async () => {
    const s = await setup({}, { accrueFees: { a: '1234', b: '56' } }), key = await createPositionMintSigner(), owner = s.wallet.owner;
    const opened = await execute(s, (await reviewed(s, 'OPEN', key.address)).id, key);
    expect(opened).toMatchObject({ verdict: 'RECONCILED', evidenceClass: 'MOCKED', attempt: { state: 'CONFIRMED' } });
    const liquidity = BigInt(opened.review.expected.liquidity);
    const partial = await execute(s, (await reviewed(s, 'DECREASE_PARTIAL', key.address, 5000)).id, null);
    expect(partial).toMatchObject({ verdict: 'RECONCILED', evidenceClass: 'MOCKED', review: { partBps: 5000, operationPlan: { liquidityDelta: (liquidity / 2n).toString() } } });
    expect(partial.observations.at(-1)!.effects).toMatchObject({ collectedFeesA: '1234', collectedFeesB: '56' });
    expect(BigInt(partial.observations.at(-1)!.effects!.withdrawnPrincipalB)).toBeGreaterThan(0n);
    // More trading since the partial removal; a collect-only transaction checkpoints and collects it without touching the liquidity.
    s.env.trade();
    const collect = await reviewed(s, 'COLLECT', key.address);
    expect(collect.review).toMatchObject({ partBps: null, operationPlan: { liquidityDelta: '0', decrease: false, close: false, refreshFees: true },
      expected: { positionLiquidityAfter: (liquidity - liquidity / 2n).toString() } });
    expect(collect.review.instructionSummary.map(i => i.name)).toEqual(['set_compute_unit_limit', 'create_idempotent', 'create_idempotent', 'update_fees_and_rewards',
      'collect_fees_v2', 'close_account']);
    const collected = await execute(s, collect.id, null);
    expect(collected).toMatchObject({ verdict: 'RECONCILED', evidenceClass: 'MOCKED', attempt: { state: 'CONFIRMED' },
      evidence: { bundle: { environment: 'MOCKED' }, publicExecution: { operation: 'COLLECT', realFunds: false, withdrawnPrincipal: { a: '0', b: '0' }, collectedFees: { a: '1234', b: '56' } } } });
    expect(collected.observations.at(-1)).toMatchObject({ events: [], positionAuthority: { owner, amount: '1' } });
    expect((await s.service.positions(owner))[0]).toMatchObject({ status: 'ACTIVE', liquidity: (liquidity - liquidity / 2n).toString(), feeOwedA: '0', feeOwedB: '0' });
    // Nothing left to collect: refused at simulation, nothing journaled, nothing sent.
    await expect(s.service.simulate(workflow(), owner, { operation: 'COLLECT', positionMint: key.address })).rejects.toThrow('ORCA_POSITION_NOTHING_TO_COLLECT');
    await expect(s.service.simulate(workflow(), owner, { operation: 'COLLECT', positionMint: key.address, partBps: 100 })).rejects.toThrow('ORCA_LIQUIDITY_PART_INVALID');
    const exit = await execute(s, (await reviewed(s, 'EXIT', key.address)).id, null);
    expect(exit).toMatchObject({ verdict: 'RECONCILED', evidence: { publicExecution: { operation: 'EXIT', lifecycle: { positionMint: key.address } } } });
    expect(exit.observations.at(-1)!.effects!.rentRefundedLamports).toBe(opened.observations.at(-1)!.effects!.rentPaidLamports);
    expect((await s.service.positions(owner))[0]).toMatchObject({ status: 'CLOSED', liquidity: null, runs: [{ operation: 'OPEN', verdict: 'RECONCILED' },
      { operation: 'DECREASE_PARTIAL', verdict: 'RECONCILED' }, { operation: 'COLLECT', verdict: 'RECONCILED' }, { operation: 'EXIT', verdict: 'RECONCILED' }] });
    expect(s.env.state.sent).toHaveLength(4);
    // A restarted service reads the same registry, COLLECT lines included.
    expect((await s.make().positions(owner))[0]!.runs.map(r => r.operation)).toEqual(['OPEN', 'DECREASE_PARTIAL', 'COLLECT', 'EXIT']);
  });
  it('manages a position FloFi did not open once the chain verifies it, and enters it in the owner registry', async () => {
    const s = await setup(), owner = s.wallet.owner, mint = externalPosition(s);
    expect(await s.service.positions(owner)).toEqual([]);
    const partial = await reviewed(s, 'DECREASE_PARTIAL', mint, 5000);
    expect(partial.review.operationPlan.liquidityDelta).toBe('20000000');
    // Simulation and Review alone register nothing; the first prepared operation does, before any signature exists.
    expect(await s.service.positions(owner)).toEqual([]);
    const begin = await s.service.begin(partial.id, owner, workflow());
    expect((await s.service.positions(owner))[0]).toMatchObject({ positionMint: mint, status: 'ACTIVE', runs: [{ operation: 'DECREASE_PARTIAL', state: 'PREPARED' }] });
    await s.service.submit(partial.id, await sign(s, begin, null));
    expect(await s.service.observe(partial.id)).toMatchObject({ verdict: 'RECONCILED', evidenceClass: 'MOCKED' });
    expect((await s.make().positions(owner))[0]).toMatchObject({ positionMint: mint, status: 'ACTIVE', liquidity: '20000000',
      runs: [{ operation: 'DECREASE_PARTIAL', verdict: 'RECONCILED' }] });
    // Now a registry position, it follows the registry's gates: exit, then the closed position is refused.
    expect(await execute(s, (await reviewed(s, 'EXIT', mint)).id, null)).toMatchObject({ verdict: 'RECONCILED' });
    expect((await s.service.positions(owner))[0]).toMatchObject({ status: 'CLOSED' });
    await expect(s.service.simulate(workflow(), owner, { operation: 'COLLECT', positionMint: mint })).rejects.toThrow('ORCA_POSITION_NOT_FOUND');
    expect(s.env.state.sent).toHaveLength(2);
  });
  it('refuses a discovered position it cannot manage with the engine’s own reason, and journals nothing', async () => {
    const s = await setup(), owner = s.wallet.owner;
    const refusals: [string, string][] = [
      [externalPosition(s, { legacyToken: true }), 'ORCA_POSITION_AUTHORITY_MISMATCH'],
      [externalPosition(s, { delegate: createMockedSolanaWallet().owner }), 'ORCA_POSITION_AUTHORITY_MISMATCH'],
      [externalPosition(s, { whirlpool: createMockedSolanaWallet().owner }), 'ORCA_POSITION_POOL_MISMATCH'],
      [createMockedSolanaWallet().owner, 'ORCA_POSITION_UNKNOWN']];
    for (const [mint, reason] of refusals) for (const operation of ['DECREASE_PARTIAL', 'EXIT', 'COLLECT'] as const) {
      const refused = await s.service.simulate(workflow(), owner, { operation, positionMint: mint, ...operation === 'DECREASE_PARTIAL' ? { partBps: 5000 } : {} })
        .then(() => null, (cause: unknown) => cause);
      expect([operation, (refused as Error).message, orcaPositionNotManageable(refused)]).toEqual([operation, reason, reason]);
    }
    // A position token held by someone else is the owner's to manage only in that holder's wallet.
    const stranger = createMockedSolanaWallet(), held = externalPosition(s);
    await expect(s.service.simulate(workflow(), stranger.owner, { operation: 'EXIT', positionMint: held })).rejects.toThrow('ORCA_POSITION_AUTHORITY_MISMATCH');
    expect(orcaPositionNotManageable(new Error('SOLANA_RPC_INVALID'))).toBeNull();
    expect(await s.service.positions(owner)).toEqual([]);
    expect((await readdir(s.dir)).filter(n => n.endsWith('.jsonl'))).toEqual([]);
    expect(s.env.state.sent).toEqual([]);
  });
  it('ambiguous submission is observed, never resubmitted (OPEN and COLLECT); duplicate Execute is refused', async () => {
    const s = await setup({}, { send: 'RPC_ERROR_AFTER_LANDING', accrueFees: { a: '1234', b: '56' } }), key = await createPositionMintSigner();
    for (const operation of ['OPEN', 'COLLECT'] as const) {
      const record = await reviewed(s, operation, key.address);
      const begin = await s.service.begin(record.id, s.wallet.owner, workflow());
      await expect(s.service.begin(record.id, s.wallet.owner, workflow())).rejects.toThrow('ORCA_LIQUIDITY_EXISTING_ATTEMPT_OBSERVE_ONLY');
      const signed = await sign(s, begin, operation === 'OPEN' ? key : null);
      const unknown = await s.service.submit(record.id, signed);
      expect(unknown).toMatchObject({ error: 'ORCA_LIQUIDITY_SUBMISSION_UNKNOWN_OBSERVE_EXISTING', attempt: { state: 'SUBMISSION_RESULT_UNKNOWN', signature: expect.any(String) } });
      await expect(s.service.submit(record.id, signed)).rejects.toThrow('ORCA_LIQUIDITY_WALLET_HANDOFF_NOT_AUTHORIZED');
      // Restart after submission: a fresh service observes the durable signature and reconciles the landed transaction; nothing is sent again.
      expect(await s.make().observe(record.id)).toMatchObject({ verdict: 'RECONCILED', attempt: { state: 'CONFIRMED' } });
    }
    expect(s.env.state.sent).toHaveLength(2);
    expect((await s.service.positions(s.wallet.owner))[0]).toMatchObject({ status: 'ACTIVE', runs: [{ operation: 'OPEN', verdict: 'RECONCILED' }, { operation: 'COLLECT', verdict: 'RECONCILED' }] });
  });
});
