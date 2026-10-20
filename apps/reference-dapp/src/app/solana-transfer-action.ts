// SPDX-License-Identifier: AGPL-3.0-only
'use server';
import { SOLANA_DEVNET_TRANSFER, SOLANA_MAINNET_TRANSFER } from '@defi-workflow-engine/action-registry';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { createSolanaTransferService, type SolanaTransferService, type SolanaTransferWalletDiagnostic } from '../server/solana-transfer-service';
import { createSolanaRpc, solanaRpcOverride } from '../server/solana-rpc';
import { cloudFlow } from '../server/flow-runtime';

/**
 * BUILD-SOLANA-TRANSFER-UX-001: direct transfers to another wallet on Solana mainnet-beta (`solana-transfer`, real funds) and Devnet
 * (`solana-devnet-transfer`). Simulation and Review are read-only. Mainnet owner execution is a separate explicit deployment opt-in
 * (GRYLOO_SOLANA_TRANSFER_OWNER_EXECUTION=MAINNET_OWNER_APPROVED); Devnet follows the existing Devnet execution switch. FloFi never signs.
 */
export type SolanaTransferCluster = 'mainnet' | 'devnet';
const services: Partial<Record<SolanaTransferCluster, SolanaTransferService>> = {};
const HARNESS = 'http://127.0.0.1:8552';
function current(cluster: SolanaTransferCluster): SolanaTransferService {
  const mainnet = cluster === 'mainnet', profile = mainnet ? SOLANA_MAINNET_TRANSFER : SOLANA_DEVNET_TRANSFER;
  const harness = process.env.GRYLOO_SOLANA_TRANSFER_HARNESS === 'MOCKED_LOOPBACK_ONLY';
  const journalDir = process.env.GRYLOO_SOLANA_TRANSFER_JOURNAL;
  if (!journalDir) throw new Error('SOLANA_TRANSFER_STORAGE_NOT_CONFIGURED');
  const existing = services[cluster];
  if (existing) return existing;
  const override = mainnet ? solanaRpcOverride(process.env.GRYLOO_SOLANA_RPC_URL, 'SOLANA_TRANSFER_RPC_CONFIGURATION_INVALID')
    : solanaRpcOverride(process.env.GRYLOO_SOLANA_DEVNET_RPC_URL, 'SOLANA_TRANSFER_RPC_CONFIGURATION_INVALID');
  const service = createSolanaTransferService({ profile, journalDir, provenance: harness ? 'MOCKED' : profile.provenance,
    // Real-funds owner execution is opt-in server configuration; Simulate and Review stay read-only without it.
    executionEnabled: mainnet ? harness || process.env.GRYLOO_SOLANA_TRANSFER_OWNER_EXECUTION === 'MAINNET_OWNER_APPROVED' : process.env.GRYLOO_SOLANA_DEVNET_EXECUTION !== 'DISABLED',
    rpc: createSolanaRpc(harness ? `${HARNESS}/${mainnet ? 'transfer-rpc' : 'transfer-devnet-rpc'}` : override ?? profile.rpc, harness) });
  services[cluster] = service;
  return service;
}
async function run<T>(cluster: SolanaTransferCluster, method: string, args: readonly unknown[], action: (service: SolanaTransferService) => Promise<T>):
  Promise<{ ok: true; value: T } | { ok: false; code: string }> {
  if (cluster !== 'mainnet' && cluster !== 'devnet') return { ok: false, code: 'SOLANA_TRANSFER_NETWORK_UNSUPPORTED' };
  // Cloud deployment: the remote FloFi API (BUILD-CLOUD-001) or the embedded PostgreSQL runtime (BUILD-CLOUD-PARITY-001).
  const cloud = await cloudFlow<T>(cluster === 'mainnet' ? 'solana-transfer' : 'solana-devnet-transfer', method, args);
  if (cloud) return cloud;
  try { return { ok: true, value: await action(current(cluster)) }; }
  catch (cause) { const code = cause instanceof Error ? cause.message : ''; return { ok: false, code: /^[A-Z][A-Z0-9_]{2,80}$/.test(code) ? code : 'SOLANA_TRANSFER_SERVICE_UNAVAILABLE' }; }
}
export async function solanaTransferInfo(cluster: SolanaTransferCluster) { return run(cluster, 'info', [], async service => ({ executionEnabled: service.executionEnabled })); }
export async function solanaTransferSimulate(cluster: SolanaTransferCluster, workflow: SemanticWorkflow, owner: string) {
  return run(cluster, 'simulate', [workflow, owner], service => service.simulate(workflow, owner));
}
export async function solanaTransferReview(cluster: SolanaTransferCluster, id: string, commitment: string, workflow: SemanticWorkflow) {
  return run(cluster, 'review', [id, commitment, workflow], service => service.review(id, commitment, workflow));
}
export async function solanaTransferInvalidate(cluster: SolanaTransferCluster, id: string) { return run(cluster, 'invalidate', [id], service => service.invalidate(id)); }
export async function solanaTransferBegin(cluster: SolanaTransferCluster, id: string, owner: string, workflow: SemanticWorkflow) {
  return run(cluster, 'begin', [id, owner, workflow], service => service.begin(id, owner, workflow));
}
export async function solanaTransferWalletFailure(cluster: SolanaTransferCluster, id: string, diagnostic: SolanaTransferWalletDiagnostic) {
  return run(cluster, 'walletFailure', [id, diagnostic], service => service.walletFailure(id, diagnostic));
}
export async function solanaTransferSubmit(cluster: SolanaTransferCluster, id: string, signedTransaction: string) {
  return run(cluster, 'submit', [id, signedTransaction], service => service.submit(id, signedTransaction));
}
export async function solanaTransferObserve(cluster: SolanaTransferCluster, id: string) { return run(cluster, 'observe', [id], service => service.observe(id)); }
export async function solanaTransferStatus(cluster: SolanaTransferCluster, id: string) { return run(cluster, 'status', [id], service => service.load(id)); }
