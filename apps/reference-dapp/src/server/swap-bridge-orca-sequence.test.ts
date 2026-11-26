// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Post-#254 hotfix: the Orca counterpart of PR #254's Swap → Bridge → Pool fix. An Orca pool after a bridge to Solana (with or without a swap
 * before it) is a step-by-step composition whose Orca step runs ALONE, its USDC bound to what the bridge delivered; the whole workflow is refused
 * by the Orca compiler (SOLANA_LIQUIDITY_ISOLATED_ONLY) and by the service. A standalone Orca operation is unchanged. MOCKED loopback chain only;
 * never public execution evidence.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { baseAssetRegistry, referenceRegistry } from '@defi-workflow-engine/action-registry';
import { ORCA_WHIRLPOOLS_MAINNET_LIQUIDITY as mainnet, createMockedSolanaDevnetOrca, createMockedSolanaWallet, orcaLiquidityIntent } from '@defi-workflow-engine/reference-compiler';
import { createReviewContext, lintWorkflow, reviewContextForChain } from '@defi-workflow-engine/reference-linter';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { parseLocalCommand } from '../domain/commands';
import { editorReducer, initialEditor, type EditorState } from '../domain/editor';
import type { Workflow } from '../domain/initial-workflow';
import { stepNodeKey, stepRuntimeWorkflow, workflowSequence, type CompletedStep } from '../domain/workflow-sequence';
import { createPositionMintSigner } from '../wallet/position-mint-signer';
import { createOrcaLiquidityService } from './orca-liquidity-service';

const authoring = createReviewContext({ registryId: referenceRegistry.registryId, capabilityId: referenceRegistry.capabilities[0]!.id, actionId: referenceRegistry.actions[0]!.id,
  assets: baseAssetRegistry });
const contextOf = (workflow: Workflow) => reviewContextForChain(workflow.nodes[0]!.chainId, authoring);
const lint = (workflow: Workflow) => lintWorkflow(workflow, contextOf(workflow));
const SWAP = 'swap 0.0009 ETH to USDC on Base slippage 100 bps', BRIDGE = 'bridge 5 USDC from Base to Solana via best slippage 100 bps';
const POOL = 'add liquidity 0.01 SOL and 0.3 USDC ticks -39104 to -36992 on Solana slippage 100 bps';
const SOLANA = mainnet.chain;
function authored(...sentences: string[]): Workflow {
  let state: EditorState = initialEditor();
  for (const sentence of sentences) {
    state = editorReducer(state, parseLocalCommand(sentence, state.workflow, authoring), authoring);
    expect(state.error, sentence).toBeNull();
  }
  return state.workflow;
}
/** Every step before the pool completed; the bridge (the step right before it) delivered `bridged` USDC units on Solana. */
function completedBefore(workflow: Workflow, bridged: string | null): CompletedStep[] {
  return workflow.nodes.slice(0, -1).map((node, index, before) => ({ nodeId: node.nodeId, node: stepNodeKey(node),
    received: index === before.length - 1 ? bridged : '1527520', runKey: `step-${index}` }));
}
function poolStep(workflow: Workflow, bridged: string | null) {
  const sequence = workflowSequence(workflow, lint)!, step = sequence.steps.at(-1)!;
  return stepRuntimeWorkflow(step, completedBefore(workflow, bridged), contextOf(step.projection));
}
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function orcaService() {
  const env = createMockedSolanaDevnetOrca({ liquidityProfile: mainnet }), wallet = createMockedSolanaWallet();
  env.fund(wallet.owner, 3_000_000_000n, 50_000_000n);
  const dir = await mkdtemp(join(tmpdir(), 'flofi-orca-sequence-')); dirs.push(dir);
  const service = createOrcaLiquidityService({ rpc: env.rpc, journalDir: dir, profile: mainnet, provenance: 'MOCKED', executionEnabled: true,
    now: () => Date.parse('2026-10-13T12:00:00.000Z') });
  return { service, owner: wallet.owner, env };
}

describe('post-#254 hotfix: Orca pool steps of step-by-step compositions run alone, bound to the bridged amount', () => {
  it.each([['Swap → Bridge → Orca Pool', [SWAP, BRIDGE, POOL]], ['Bridge to Solana → Orca Pool', [BRIDGE, POOL]]] as const)('%s is one supported step-by-step composition', (_name, sentences) => {
    const workflow = authored(...sentences);
    expect(workflow.nodes.at(-1)).toMatchObject({ actionType: 'asset.liquidity.concentrated', chainId: SOLANA, adapterConstraints: { protocols: ['orca-whirlpools'] } });
    // As ONE workflow the Orca compiler refuses it: the step that executes on Solana executes alone.
    expect(() => orcaLiquidityIntent(workflow as unknown as SemanticWorkflow, createMockedSolanaWallet().owner)).toThrow('SOLANA_LIQUIDITY_ISOLATED_ONLY');
    const sequence = workflowSequence(workflow, lint)!;
    expect(sequence.steps.map(step => step.fundedBy)).toEqual(sentences.map((_s, index) => index === 0 ? null : index - 1));
    // The pool is funded by the bridge with Solana USDC only; its SOL is the owner's own (FloFi never inserts a swap, bridge or wrap for it).
    expect(sequence.steps.at(-1)!.funding).toEqual([{ input: expect.objectContaining({ chainId: SOLANA, address: mainnet.token1.mint, amount: '300000' }), fundedBy: sentences.length - 2 }]);
    for (const step of sequence.steps) expect(() => lint(step.projection)).not.toThrow();
  });

  it.each([[[SWAP, BRIDGE, POOL]], [[BRIDGE, POOL]]] as const)('the Orca step spends at most what the bridge delivered and never more than authored (%#)', sentences => {
    const workflow = authored(...sentences), owner = createMockedSolanaWallet().owner;
    const delivered = poolStep(workflow, '200000');
    expect([delivered.bound, delivered.workflow?.nodes]).toEqual([ '200000', [expect.objectContaining({ nodeId: workflow.nodes.at(-1)!.nodeId })]]);
    expect(orcaLiquidityIntent(delivered.workflow as unknown as SemanticWorkflow, owner)).toMatchObject({ amount0Max: '10000000', amount1Max: '200000' });
    // A larger delivery never raises the authored 0.3 USDC; an unproven delivery binds nothing (the step waits, nothing is simulated).
    expect(orcaLiquidityIntent(poolStep(workflow, '4000000').workflow as unknown as SemanticWorkflow, owner)).toMatchObject({ amount1Max: '300000' });
    expect(poolStep(workflow, null).workflow).toBeNull();
  });

  it('the Orca service simulates the step alone and refuses the whole workflow; a standalone Orca operation is simulated as authored', async () => {
    const { service, owner, env } = await orcaService();
    const workflow = authored(SWAP, BRIDGE, POOL), mint = async () => (await createPositionMintSigner()).address;
    await expect(service.simulate(workflow as unknown as SemanticWorkflow, owner, { operation: 'OPEN', positionMint: await mint() })).rejects.toThrow(/_ISOLATED_ONLY$/);
    const step = poolStep(workflow, '200000').workflow as unknown as SemanticWorkflow;
    const run = await service.simulate(step, owner, { operation: 'OPEN', positionMint: await mint() });
    expect(run.review).toMatchObject({ chain: SOLANA, intent: { amount0Max: '10000000', amount1Max: '200000' } });
    // Standalone: no sequence; the runtime workflow is the canonical workflow itself.
    const standalone = authored(POOL);
    expect(workflowSequence(standalone, lint)).toBeNull();
    const alone = await service.simulate(standalone as unknown as SemanticWorkflow, owner, { operation: 'OPEN', positionMint: await mint() });
    expect(alone.review).toMatchObject({ chain: SOLANA, intent: { amount0Max: '10000000', amount1Max: '300000' } });
    // Simulation is read-only: nothing was sent.
    expect(env.state.sent).toEqual([]);
  });
});
