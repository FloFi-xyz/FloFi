// SPDX-License-Identifier: AGPL-3.0-only
// Deterministic test seams only. The in-memory RPC models public response shapes; this is never evidence of public execution.
import { createMockedSolanaTransferChain, createMockedSolanaWallet, simulateSolanaTransfer } from '@defi-workflow-engine/reference-compiler';
import { SOLANA_MAINNET_TRANSFER, type SolanaTransferProfile } from '@defi-workflow-engine/action-registry';
import { createSolanaTransferNode, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { createSolanaTransferRun } from '@defi-workflow-engine/reference-executor';
import { reviewFixture, reviewNow } from './review-fixture';
import type { ExecutionControlsState } from '../state/execution-controls';

export async function solanaTransferReviewFixture(profile: SolanaTransferProfile = SOLANA_MAINNET_TRANSFER, existingDestination = false): Promise<ExecutionControlsState> {
  const chain = createMockedSolanaTransferChain({ profile }), owner = createMockedSolanaWallet(), recipient = createMockedSolanaWallet().owner;
  chain.fundWallet(owner.owner, 3_000_000_000n);
  const asset = profile.assets.find(asset => asset.mint)!;
  chain.createMint(asset.mint!, { decimals: asset.decimals }); chain.fundToken(owner.owner, asset.mint!, 50_000_000n);
  if (existingDestination) chain.fundToken(recipient, asset.mint!, 0n);
  const workflow: SemanticWorkflow = { schemaVersion: '1.0.0', workflowId: 'signing-transfer-fixture', revision: 1, resourceEdges: [], nodes: [createSolanaTransferNode('send', {
    chain: profile.chain, amount: '1500000', recipient, token: { mint: asset.mint!, decimals: asset.decimals, program: 'spl-token' },
  })] };
  const review = await simulateSolanaTransfer(workflow, owner.owner, chain.rpc, reviewNow);
  const record = { ...createSolanaTransferRun(`${profile.idPrefix}-${'a'.repeat(32)}`, review, profile.provenance), observations: [], evidence: null, error: null, evidenceClass: 'PUBLIC_READ_ONLY' };
  return { workflow: workflow as ExecutionControlsState['workflow'], context: reviewFixture().context,
    source: { kind: 'solana-transfer', state: { record, owner: owner.owner, network: profile.network, walletChain: profile.walletChain,
      busy: false, error: null, retired: false, recovered: false, executionEnabled: true, signing: false } } as ExecutionControlsState['source'],
    authorization: { key: review.commitment, manifest: review.manifest, policy: review.policy, owner: owner.owner, chain: profile.chain, ready: true, accepted: false,
      approve: null, approvals: [], tokens: [{ address: asset.mint!, chain: profile.chain, symbol: asset.symbol, decimals: asset.decimals }], limits: [], technical: null },
    wallet: { account: owner.owner, chain: profile.chain, environment: profile.realFunds ? 'mainnet' : 'testnet', changed: false },
    execution: { ready: true, started: false, start: null, prompt: null, expiresAt: null } };
}
