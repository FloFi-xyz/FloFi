// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bindCompositionConsumer } from '@defi-workflow-engine/action-registry';
import { createBaseSepoliaReviewContext } from '@defi-workflow-engine/reference-linter';
import { appendMockedWalletGuards, createMockedSolanaDevnetOrca, createMockedSolanaWallet, fromBase64, LIGHTHOUSE_PROGRAM, parseTransaction, serializeSignedTransaction,
  toBase64 } from '@defi-workflow-engine/reference-compiler';
import { createFileExecutionStorage } from '@defi-workflow-engine/reference-executor';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { createSolanaDevnetService } from '../server/jupiter-service';
import { createOrcaLiquidityService } from '../server/orca-liquidity-service';
import { createSolanaCompositionService, type SolanaCompositionView } from '../server/solana-composition-service';
import { createPositionMintSigner, signOrcaLiquidityTransaction } from '../wallet/position-mint-signer';
import type { SolanaSession } from '../wallet/solana-wallet';
import type { ExecutionControlsState } from '../state/execution-controls';
import { createSolanaSwapNode } from './jupiter-authoring';
import { createSolanaLiquidityNode } from './solana-liquidity-authoring';
import { projectExecutionLifecycle, type ExecutionLifecycleSource } from './execution-lifecycle';
import { projectExecutionEvidence } from './execution-evidence';
import { nothingSubmitted, projectExecutionResult } from './execution-result';
import { projectCanvasAction } from './canvas-lifecycle';
import type { Workflow } from './initial-workflow';
import { translate } from '../i18n/locale';

/**
 * P0 reproduction (MOCKED Solana Devnet loopback): Phantom appends Lighthouse guard instructions to the reviewed swap before signing.
 * FloFi must refuse those bytes (exact-byte invariant), broadcast nothing, say why, and recover only through a fresh
 * Simulate → Review → Execute that runs the swap once and then the Orca position.
 */
const context = createBaseSepoliaReviewContext();
const swap = createSolanaSwapNode('node-002', { network: 'Solana Devnet', from: 'SOL', to: 'devUSDC', amount: '0.1', slippage: '50' });
const position = bindCompositionConsumer(createSolanaLiquidityNode('node-003', { network: 'Solana Devnet', maxSol: '0.05', maxDevUsdc: '1000', rangeUnit: 'TICK',
  lower: '-39104', upper: '-36992', slippage: '100' }), swap);
const workflow: SemanticWorkflow = { schemaVersion: '1.0.0', workflowId: 'p0-wallet-refusal', revision: 2, nodes: [swap, position],
  resourceEdges: [{ fromNodeId: 'node-002', outputId: 'amount-out', toNodeId: 'node-003', inputName: 'amount1-source' }] };
async function run() {
  const env = createMockedSolanaDevnetOrca(), wallet = createMockedSolanaWallet();
  env.fund(wallet.owner, 3_000_000_000n, 0n);
  const dir = await mkdtemp(join(tmpdir(), 'gryloo-solcomp-refusal-'));
  const clock = { now: Date.parse('2026-10-01T12:00:00.000Z') }, now = () => clock.now;
  const swaps = createSolanaDevnetService({ rpc: env.rpc, journalDir: dir, provenance: 'MOCKED', executionEnabled: true, now });
  const liquidity = createOrcaLiquidityService({ rpc: env.rpc, journalDir: dir, provenance: 'MOCKED', executionEnabled: true, now });
  const service = createSolanaCompositionService({ rpc: env.rpc, storage: createFileExecutionStorage(dir, 'SOLANA_COMPOSITION_BUSY'), swap: swaps, liquidity, provenance: 'MOCKED',
    executionEnabled: true, now });
  return { env, wallet, service, clock };
}
const source = (record: SolanaCompositionView | null): ExecutionLifecycleSource => ({ kind: 'solana-composition',
  state: { record, busy: false, error: null, retired: false, recovered: false, executionEnabled: true, signing: false, owner: null, authorized: false } });
function presented(view: SolanaCompositionView) {
  const lifecycle = projectExecutionLifecycle(workflow as unknown as Workflow, context, source(view));
  const progress = { ...lifecycle, evidence: projectExecutionEvidence(source(view), lifecycle) };
  // The Canvas primary action of a final run (a run in progress also needs the Review state, not projected here).
  const action = () => projectCanvasAction({ progress, source: source(view), invalidWorkflow: false, recovery: null } as unknown as ExecutionControlsState,
    { requesting: false, verifying: false, canContinue: false, canCheck: false });
  return { progress, result: projectExecutionResult(progress), action, steps: progress.steps.map(step => [step.id, step.state, step.operations[0]?.label]) };
}
/** A Wallet Standard session whose wallet behaves like Phantom: it appends guard instructions, then signs. */
const guardingSession = (wallet: ReturnType<typeof createMockedSolanaWallet>): SolanaSession => ({ chain: 'solana:devnet',
  account: { address: wallet.owner, chains: ['solana:devnet'], features: ['solana:signTransaction'] },
  wallet: { name: 'Guarding wallet', chains: ['solana:devnet'], accounts: [], features: { 'solana:signTransaction': { signTransaction: async (input: { transaction: Uint8Array }) =>
    [{ signedTransaction: fromBase64(wallet.sign(appendMockedWalletGuards(toBase64(input.transaction), 2)), 2048) }] } } } });

describe('P0: a wallet that changes the reviewed Solana Devnet swap (MOCKED loopback)', () => {
  it('refuses the changed swap, sends nothing, explains why, and recovers through a fresh Simulate → Review → Execute that runs the swap once and the position', async () => {
    const { env, wallet, service } = await run();
    const first = await service.simulate(workflow, wallet.owner), id = first.record.id;
    await service.review(id, first.record.review.commitment, workflow);
    const begin = await service.beginSwap(id, wallet.owner, workflow);
    // The owner confirms in the wallet; the wallet returns the reviewed swap plus two Lighthouse assertions, signed.
    const changed = wallet.sign(appendMockedWalletGuards(begin.unsignedTransaction, 2));
    const refused = await service.submitSwap(id, changed);
    expect(env.state.sent).toHaveLength(0);
    expect(refused.phase).toBe('NOT_EXECUTED');
    expect(refused.record.error).toBe('DEVNET_SWAP_TRANSACTION_CHANGED');
    expect(refused.swap).toMatchObject({ notSubmitted: true, error: 'DEVNET_SWAP_TRANSACTION_CHANGED', attempt: { state: 'CANCELLED', signature: null } });
    expect(refused.swap.walletDiagnostic?.change).toMatchObject({ reviewedInstructionsPreserved: true, feePayerChanged: false, blockhashChanged: false, addedPrograms: [LIGHTHOUSE_PROGRAM] });
    // The refused signed bytes (a valid owner signature until the blockhash expires) are not kept anywhere in the run.
    expect(JSON.stringify(refused)).not.toContain(changed);
    expect(JSON.stringify(refused)).not.toContain(toBase64(parseTransaction(fromBase64(changed, 2048)).signatures[0]!));
    // Execute shows a concrete outcome and a way forward, not a terminal "Cancelled".
    const shown = presented(refused);
    expect(shown.steps).toEqual([['node-002', 'not-submitted', 'Not submitted'], ['node-003', 'waiting', 'Waiting']]);
    const note = shown.progress.evidence.operations.swap!;
    expect(translate('EN', note.note!, ...note.noteArgs!)).toBe('Your wallet added 2 instruction(s) from Lighthouse to the transaction you reviewed before signing it. FloFi sends only the exact transaction you reviewed, so it did not send this one and nothing reached Solana. Simulate again for a fresh Review.');
    expect(translate('PT', note.note!, ...note.noteArgs!)).toBe('A sua carteira acrescentou 2 instrução(ões) de Lighthouse à transação que reviu antes de a assinar. O FloFi envia apenas a transação exata que reviu, por isso não enviou esta e nada chegou à Solana. Simule novamente para obter uma nova Revisão.');
    expect(shown.progress.evidence.details).toContainEqual({ label: 'Wallet result', value: 'DEVNET_SWAP_TRANSACTION_CHANGED', copy: false });
    expect(shown.result).toMatchObject({ label: 'Transaction not submitted', completed: 0, total: 2 });
    expect(nothingSubmitted(shown.progress)).toBe(true);
    expect(shown.action()).toEqual({ kind: 'simulate', label: 'Simulate again', disabled: false });
    // The refused attempt can never be submitted later.
    await expect(service.submitSwap(id, wallet.sign(begin.unsignedTransaction))).rejects.toThrow('SOLANA_COMPOSITION_WALLET_HANDOFF_NOT_AUTHORIZED');
    expect(env.state.sent).toHaveLength(0);

    // Recovery: a new run with a fresh Review. The exact reviewed swap is sent once, reconciled and bound; then the position.
    const second = await service.simulate(workflow, wallet.owner), next = second.record.id;
    expect(next).not.toBe(id);
    await service.review(next, second.record.review.commitment, workflow);
    const retry = await service.beginSwap(next, wallet.owner, workflow);
    await service.submitSwap(next, wallet.sign(retry.unsignedTransaction));
    const bound = await service.observe(next);
    expect(bound.phase).toBe('BOUND');
    expect(env.state.sent).toHaveLength(1);
    expect(BigInt(bound.record.binding!.received)).toBeGreaterThan(0n);
    expect(presented(bound).steps).toEqual([['node-002', 'confirmed', 'Confirmed'], ['node-003', 'waiting', 'Waiting']]);
    const key = await createPositionMintSigner();
    const prepared = await service.prepareLiquidity(next, wallet.owner, workflow, key.address);
    await service.reviewLiquidity(next, prepared.liquidity!.review.commitment, workflow);
    const lp = await service.beginLiquidity(next, wallet.owner, workflow);
    const { signatures, message } = parseTransaction(fromBase64(wallet.sign(lp.unsignedTransaction), 2048));
    await service.submitLiquidity(next, toBase64(serializeSignedTransaction([signatures[0]!, await key.sign(message)], message)));
    const done = await service.observe(next);
    expect(done.phase).toBe('COMPLETED');
    expect(env.state.sent).toHaveLength(2);
    expect(presented(done).steps.map(([id, state]) => [id, state])).toEqual([['node-002', 'confirmed'], ['node-003', 'confirmed']]);
    // The refused run is unchanged: never retried, never resubmitted.
    expect((await service.status(id)).swap.attempt).toMatchObject({ state: 'CANCELLED', signature: null });
  });

  it('refuses a changed position transaction before the position key signs, keeps the reconciled swap, and never repeats it', async () => {
    const { env, wallet, service } = await run();
    const simulated = await service.simulate(workflow, wallet.owner), id = simulated.record.id;
    await service.review(id, simulated.record.review.commitment, workflow);
    const begin = await service.beginSwap(id, wallet.owner, workflow);
    await service.submitSwap(id, wallet.sign(begin.unsignedTransaction));
    await service.observe(id);
    const key = await createPositionMintSigner();
    const prepared = await service.prepareLiquidity(id, wallet.owner, workflow, key.address);
    await service.reviewLiquidity(id, prepared.liquidity!.review.commitment, workflow);
    const lp = await service.beginLiquidity(id, wallet.owner, workflow);
    const failure = await signOrcaLiquidityTransaction(guardingSession(wallet), lp.unsignedTransaction, lp.view.liquidity!.review.message, lp.signers, key).catch((cause: unknown) => cause);
    expect(failure).toMatchObject({ message: 'ORCA_LIQUIDITY_TRANSACTION_CHANGED', change: { reviewedInstructionsPreserved: true, addedPrograms: [LIGHTHOUSE_PROGRAM] } });
    await expect(key.sign(new Uint8Array(1))).resolves.toHaveLength(64); // the position key never signed the changed message
    const recorded = await service.walletFailure(id, { step: 'LIQUIDITY', diagnostic: { stage: 'SIGN', code: 'ORCA_LIQUIDITY_TRANSACTION_CHANGED', error: { message: 'changed' },
      change: (failure as { change: never }).change } });
    expect(env.state.sent).toHaveLength(1);
    expect(recorded.phase).toBe('BOUND');
    expect(recorded.record.error).toBe('ORCA_LIQUIDITY_TRANSACTION_CHANGED');
    expect(presented(recorded).steps).toEqual([['node-002', 'confirmed', 'Confirmed'], ['node-003', 'waiting', 'Waiting']]);
    // The swap is never offered again: only a freshly prepared position (or ending the run, keeping the tokens) can follow.
    await expect(service.beginSwap(id, wallet.owner, workflow)).rejects.toThrow('SOLANA_COMPOSITION_EXISTING_ATTEMPT_OBSERVE_ONLY');
    await expect(service.simulate(workflow, wallet.owner)).rejects.toThrow('SOLANA_COMPOSITION_CONTINUE_EXISTING_RUN');
  });

  it('a quote that expires while the wallet is open is refused before broadcast with that reason, and recovers the same way', async () => {
    const { env, wallet, service, clock } = await run();
    const simulated = await service.simulate(workflow, wallet.owner), id = simulated.record.id;
    await service.review(id, simulated.record.review.commitment, workflow);
    const begin = await service.beginSwap(id, wallet.owner, workflow);
    clock.now = Date.parse(begin.view.swap.review.expiresAt) + 1;
    const stale = await service.submitSwap(id, wallet.sign(begin.unsignedTransaction));
    expect(env.state.sent).toHaveLength(0);
    expect(stale.swap).toMatchObject({ notSubmitted: true, error: 'DEVNET_SWAP_QUOTE_STALE', attempt: { state: 'CANCELLED', signature: null } });
    expect(stale.swap.walletDiagnostic?.change).toBeUndefined();
    const shown = presented(stale);
    expect(shown.progress.evidence.operations.swap).toMatchObject({ note: 'The reviewed quote expired before your wallet returned the signature. FloFi did not send the transaction, and nothing reached Solana. Simulate again for a fresh quote and Review.', noteArgs: [] });
    expect(translate('PT', shown.progress.evidence.operations.swap!.note!)).toMatch(/^A cotação revista expirou/);
    expect(shown.action()).toMatchObject({ kind: 'simulate', label: 'Simulate again' });
  });

  it('the standalone Devnet swap shows the same reason and the same fresh-simulation recovery', async () => {
    const { env, wallet } = await run();
    const dir = await mkdtemp(join(tmpdir(), 'gryloo-devnet-refusal-'));
    const swaps = createSolanaDevnetService({ rpc: env.rpc, journalDir: dir, provenance: 'MOCKED', executionEnabled: true, now: () => Date.parse('2026-10-01T12:00:00.000Z') });
    const single = { ...workflow, nodes: [swap], resourceEdges: [] };
    const simulated = await swaps.simulate(single, wallet.owner);
    await swaps.review(simulated.id, simulated.review.commitment, single);
    const begin = await swaps.begin(simulated.id, wallet.owner, single);
    const refused = await swaps.submit(simulated.id, wallet.sign(appendMockedWalletGuards(begin.unsignedTransaction, 3)));
    expect(env.state.sent).toHaveLength(0);
    const swapSource = { kind: 'solana-swap', state: { record: refused, busy: false, error: null, retired: false, recovered: false } } as unknown as ExecutionLifecycleSource;
    const lifecycle = projectExecutionLifecycle(single as unknown as Workflow, context, swapSource);
    const progress = { ...lifecycle, evidence: projectExecutionEvidence(swapSource, lifecycle) };
    expect(progress.steps.map(step => step.state)).toEqual(['not-submitted']);
    expect(progress.evidence.operations.transaction).toMatchObject({ noteArgs: ['3', 'Lighthouse'] });
    expect(projectExecutionResult(progress)).toMatchObject({ label: 'Transaction not submitted' });
    expect(projectCanvasAction({ progress, source: swapSource, invalidWorkflow: false, recovery: null } as unknown as ExecutionControlsState,
      { requesting: false, verifying: false, canContinue: false, canCheck: false })).toEqual({ kind: 'simulate', label: 'Simulate again', disabled: false });
    // A fresh run sends the exact reviewed swap once.
    const fresh = await swaps.simulate(single, wallet.owner);
    await swaps.review(fresh.id, fresh.review.commitment, single);
    const again = await swaps.begin(fresh.id, wallet.owner, single);
    expect((await swaps.submit(fresh.id, wallet.sign(again.unsignedTransaction))).attempt?.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
    expect(env.state.sent).toHaveLength(1);
  });
});

