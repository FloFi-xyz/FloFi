// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createMockedSolanaDevnetOrca, createMockedSolanaWallet, fromBase64, parseTransaction, serializeSignedTransaction, toBase64 } from '@defi-workflow-engine/reference-compiler';
import { createFileExecutionStorage } from '@defi-workflow-engine/reference-executor';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { createSolanaDevnetService } from '../server/jupiter-service';
import { createOrcaLiquidityService } from '../server/orca-liquidity-service';
import { createSolanaCompositionService } from '../server/solana-composition-service';
import { createPositionMintSigner } from '../wallet/position-mint-signer';
import { act, CopilotSession, intent } from './copilot-session.test-harness';
import { reconciledRemaining } from './copilot-reconciled-context';
it('executes Copilot-authored composition, recovers only its position, then removes half and closes via fresh reviews (MOCKED)', async () => {
  const env = createMockedSolanaDevnetOrca(), wallet = createMockedSolanaWallet();
  env.fund(wallet.owner, 3_000_000_000n, 50_000_000n);
  const journalDir = await mkdtemp(join(tmpdir(), 'flofi-copilot-execution-'));
  const swap = createSolanaDevnetService({ rpc: env.rpc, journalDir, provenance: 'MOCKED', executionEnabled: true });
  const liquidity = createOrcaLiquidityService({ rpc: env.rpc, journalDir, provenance: 'MOCKED', executionEnabled: true });
  const service = createSolanaCompositionService({ rpc: env.rpc, storage: createFileExecutionStorage(journalDir, 'SOLANA_COMPOSITION_BUSY'),
    swap, liquidity, provenance: 'MOCKED', executionEnabled: true });
  const session = new CopilotSession();
  const price = await liquidity.price();
  session.verified = { orcaPrice: price, solanaOwner: wallet.owner, orcaPositions: [], remaining: [] };
  expect(session.say('Swap 0.1 SOL to devUSDC on Solana Devnet and add liquidity with these tokens and 0.05 SOL in a 10% range', intent.composition([
    act.swap({ network: 'SOLANA_DEVNET', inputAsset: 'SOL', outputAsset: 'devUSDC', amount: '0.1' }),
    act.liquidity({ funding: 'SWAP_OUTPUT', deposits: [{ asset: 'SOL', maxAmount: '0.05' }], rangeUnit: 'PERCENT', lower: null, upper: '10' })
  ]))).toMatchObject({ kind: 'PROPOSAL', command: { type: 'ADD_SOLANA_COMPOSITION' } });
  expect(env.state.sent).toHaveLength(0);
  session.apply();
  const workflow = session.workflow as unknown as SemanticWorkflow;
  const simulated = await service.simulate(workflow, wallet.owner), id = simulated.record.id;
  await expect(service.beginSwap(id, wallet.owner, workflow)).rejects.toThrow('REVIEW_REQUIRED');
  await service.review(id, simulated.record.review.commitment, workflow);
  const begin = await service.beginSwap(id, wallet.owner, workflow);
  await service.submitSwap(id, wallet.sign(begin.unsignedTransaction));
  const bound = await service.observe(id);
  expect(bound.phase).toBe('BOUND');
  expect(env.state.sent).toHaveLength(1);
  const declinedKey = await createPositionMintSigner();
  const prepared = await service.prepareLiquidity(id, wallet.owner, workflow, declinedKey.address);
  await service.reviewLiquidity(id, prepared.liquidity!.review.commitment, workflow);
  await service.beginLiquidity(id, wallet.owner, workflow);
  await service.walletFailure(id, { step: 'LIQUIDITY', diagnostic: { stage: 'SIGN', code: 'ORCA_LIQUIDITY_WALLET_REJECTED', error: {} } });
  await expect(service.beginSwap(id, wallet.owner, workflow)).rejects.toThrow('EXISTING_ATTEMPT_OBSERVE_ONLY');
  const key = await createPositionMintSigner();
  const retry = await service.prepareLiquidity(id, wallet.owner, workflow, key.address);
  await service.reviewLiquidity(id, retry.liquidity!.review.commitment, workflow);
  const lb = await service.beginLiquidity(id, wallet.owner, workflow);
  const parsed = parseTransaction(fromBase64(wallet.sign(lb.unsignedTransaction), 2048));
  await service.submitLiquidity(id, toBase64(serializeSignedTransaction([parsed.signatures[0]!, await key.sign(parsed.message)], parsed.message)));
  const done = await service.observe(id);
  expect(done.phase).toBe('COMPLETED');
  expect(env.state.sent).toHaveLength(2);
  expect(BigInt(done.liquidity!.observations.at(-1)!.effects!.depositedB)).toBeLessThanOrEqual(BigInt(bound.record.binding!.received));
  expect(reconciledRemaining('another-wallet', null, done)).toEqual([]);
  for (const operation of ['DECREASE', 'EXIT'] as const) {
    session.verified = { orcaPrice: await liquidity.price(), solanaOwner: wallet.owner, orcaPositions: await liquidity.positions(wallet.owner), remaining: [] };
    expect(session.say(operation === 'DECREASE' ? 'Remove 50% of my liquidity' : 'Close my position', intent.position(operation, operation === 'DECREASE' ? '50' : null)))
      .toMatchObject({ kind: 'PROPOSAL', command: { type: 'MANAGE_SOLANA_POSITION', positionMint: key.address } });
    const command = session.pending!.command;
    if (command.type !== 'MANAGE_SOLANA_POSITION') throw new Error('POSITION_COMMAND_REQUIRED');
    session.apply();
    const wf = session.workflow as unknown as SemanticWorkflow;
    expect(wf.nodes.filter(node => !node.actionType.startsWith('mock-'))).toHaveLength(1);
    const removal = await liquidity.simulate(wf, wallet.owner, { operation: command.operation, positionMint: command.positionMint, ...command.partBps !== null ? { partBps: command.partBps } : {} });
    await expect(liquidity.begin(removal.id, wallet.owner, wf)).rejects.toThrow('REVIEW_REQUIRED');
    await liquidity.review(removal.id, removal.review.commitment, wf);
    const rb = await liquidity.begin(removal.id, wallet.owner, wf);
    await liquidity.submit(removal.id, wallet.sign(rb.unsignedTransaction));
    expect((await liquidity.observe(removal.id)).verdict).toBe('RECONCILED');
  }
  expect(env.state.sent).toHaveLength(4);
  expect((await liquidity.positions(wallet.owner)).find(position => position.positionMint === key.address)!.status).toBe('CLOSED');
});
