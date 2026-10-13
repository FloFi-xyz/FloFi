// SPDX-License-Identifier: AGPL-3.0-only
'use server';
import { ORCA_WHIRLPOOLS_DEVNET as profile } from '@defi-workflow-engine/action-registry';
import { createFileExecutionStorage } from '@defi-workflow-engine/reference-executor';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { createSolanaDevnetService } from '../server/jupiter-service';
import { createOrcaLiquidityService } from '../server/orca-liquidity-service';
import { createSolanaCompositionService, type SolanaCompositionDiagnostic, type SolanaCompositionService } from '../server/solana-composition-service';
import { createSolanaRpc, solanaRpcOverride } from '../server/solana-rpc';
import { cloudFlow } from '../server/flow-runtime';

/**
 * Solana Devnet Swap → Orca liquidity (valueless test tokens). Simulation and Reviews are read-only. The swap and the position
 * are each the existing Solana Devnet transaction with its own Review, Execute click and wallet signature; FloFi never signs.
 * Locally both step services use the same Devnet journal directory as their isolated runs, so owner leases and the position
 * registry are shared.
 */
let service: SolanaCompositionService | null = null;
const HARNESS = 'http://127.0.0.1:8552';
function current(): SolanaCompositionService {
  const harness = process.env.GRYLOO_SOLANA_DEVNET_HARNESS === 'MOCKED_LOOPBACK_ONLY';
  const journalDir = process.env.GRYLOO_SOLANA_DEVNET_JOURNAL;
  if (!journalDir) throw new Error('SOLANA_COMPOSITION_STORAGE_NOT_CONFIGURED');
  if (service) return service;
  const override = solanaRpcOverride(process.env.GRYLOO_SOLANA_DEVNET_RPC_URL, 'SOLANA_COMPOSITION_RPC_CONFIGURATION_INVALID');
  const rpc = createSolanaRpc(harness ? HARNESS + '/rpc' : override ?? profile.rpc, harness);
  const provenance = harness ? 'MOCKED' as const : 'PUBLIC_DEVNET' as const, executionEnabled = process.env.GRYLOO_SOLANA_DEVNET_EXECUTION !== 'DISABLED';
  service = createSolanaCompositionService({ rpc, provenance, executionEnabled, storage: createFileExecutionStorage(journalDir, 'SOLANA_COMPOSITION_BUSY'),
    swap: createSolanaDevnetService({ journalDir, rpc, provenance, executionEnabled }), liquidity: createOrcaLiquidityService({ journalDir, rpc, provenance, executionEnabled }) });
  return service;
}
async function run<T>(method: string, args: readonly unknown[], action: (service: SolanaCompositionService) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; code: string }> {
  // Cloud deployment: the remote Flofi API (BUILD-CLOUD-001) or the embedded PostgreSQL runtime (BUILD-CLOUD-PARITY-001).
  const cloud = await cloudFlow<T>('solana-devnet-composition', method, args);
  if (cloud) return cloud;
  try { return { ok: true, value: await action(current()) }; }
  catch (cause) { const code = cause instanceof Error ? cause.message : ''; return { ok: false, code: /^[A-Z][A-Z0-9_]{2,80}$/.test(code) ? code : 'SOLANA_COMPOSITION_SERVICE_UNAVAILABLE' }; }
}
export async function solanaCompositionInfo() { return run('info', [], async service => ({ executionEnabled: service.executionEnabled })); }
export async function solanaCompositionSimulate(workflow: SemanticWorkflow, owner: string) { return run('simulate', [workflow, owner], service => service.simulate(workflow, owner)); }
export async function solanaCompositionReview(id: string, commitment: string, workflow: SemanticWorkflow) { return run('review', [id, commitment, workflow], service => service.review(id, commitment, workflow)); }
export async function solanaCompositionInvalidate(id: string) { return run('invalidate', [id], service => service.invalidate(id)); }
export async function solanaCompositionBeginSwap(id: string, owner: string, workflow: SemanticWorkflow) { return run('beginSwap', [id, owner, workflow], service => service.beginSwap(id, owner, workflow)); }
export async function solanaCompositionSubmitSwap(id: string, signedTransaction: string) { return run('submitSwap', [id, signedTransaction], service => service.submitSwap(id, signedTransaction)); }
export async function solanaCompositionPrepareLiquidity(id: string, owner: string, workflow: SemanticWorkflow, positionMint: string) {
  return run('prepareLiquidity', [id, owner, workflow, positionMint], service => service.prepareLiquidity(id, owner, workflow, positionMint));
}
export async function solanaCompositionReviewLiquidity(id: string, commitment: string, workflow: SemanticWorkflow) {
  return run('reviewLiquidity', [id, commitment, workflow], service => service.reviewLiquidity(id, commitment, workflow));
}
export async function solanaCompositionBeginLiquidity(id: string, owner: string, workflow: SemanticWorkflow) { return run('beginLiquidity', [id, owner, workflow], service => service.beginLiquidity(id, owner, workflow)); }
export async function solanaCompositionSubmitLiquidity(id: string, signedTransaction: string) { return run('submitLiquidity', [id, signedTransaction], service => service.submitLiquidity(id, signedTransaction)); }
export async function solanaCompositionWalletFailure(id: string, failure: SolanaCompositionDiagnostic) { return run('walletFailure', [id, failure], service => service.walletFailure(id, failure)); }
export async function solanaCompositionObserve(id: string) { return run('observe', [id], service => service.observe(id)); }
export async function solanaCompositionEnd(id: string) { return run('end', [id], service => service.end(id)); }
export async function solanaCompositionStatus(id: string) { return run('status', [id], service => service.status(id)); }
