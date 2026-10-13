// SPDX-License-Identifier: AGPL-3.0-only
'use server';
import { ORCA_WHIRLPOOLS_MAINNET_LIQUIDITY as profile } from '@defi-workflow-engine/action-registry';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { createOrcaLiquidityService, type OrcaLiquidityService, type OrcaLiquidityWalletDiagnostic } from '../server/orca-liquidity-service';
import { createSolanaRpc, solanaRpcOverride } from '../server/solana-rpc';
import { cloudFlow } from '../server/flow-runtime';

/**
 * BUILD-SOLANA-MAINNET-001: Orca Whirlpools liquidity on Solana mainnet-beta (SOL/USDC 0.30%, real funds) — the same service and engine as
 * Solana Devnet, on its own storage. Simulation, Review and Inspect are read-only. Owner execution is opt-in server configuration
 * (`GRYLOO_ORCA_MAINNET_OWNER_EXECUTION=MAINNET_OWNER_APPROVED`) and still needs the owner's Review, real-funds acknowledgement, Execute click
 * and wallet signature; FloFi never signs. The position-mint key for OPEN is generated in the browser and never sent here.
 */
let service: OrcaLiquidityService | null = null;
const HARNESS = 'http://127.0.0.1:8552/mainnet-rpc';
function current(): OrcaLiquidityService {
  const harness = process.env.GRYLOO_ORCA_MAINNET_HARNESS === 'MOCKED_LOOPBACK_ONLY';
  const journalDir = process.env.GRYLOO_ORCA_MAINNET_JOURNAL;
  if (!journalDir) throw new Error('ORCA_LIQUIDITY_STORAGE_NOT_CONFIGURED');
  if (service) return service;
  const override = solanaRpcOverride(process.env.GRYLOO_SOLANA_RPC_URL, 'ORCA_LIQUIDITY_RPC_CONFIGURATION_INVALID');
  service = createOrcaLiquidityService({ journalDir, profile, provenance: harness ? 'MOCKED' : 'PUBLIC_MAINNET',
    executionEnabled: harness || process.env.GRYLOO_ORCA_MAINNET_OWNER_EXECUTION === 'MAINNET_OWNER_APPROVED',
    rpc: createSolanaRpc(harness ? HARNESS : override ?? profile.rpc, harness) });
  return service;
}
async function run<T>(method: string, args: readonly unknown[], action: (service: OrcaLiquidityService) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; code: string }> {
  // Cloud deployment: the remote Flofi API (BUILD-CLOUD-001) or the embedded PostgreSQL runtime (BUILD-CLOUD-PARITY-001).
  const cloud = await cloudFlow<T>('orca-liquidity-mainnet', method, args);
  if (cloud) return cloud;
  try { return { ok: true, value: await action(current()) }; }
  catch (cause) { const code = cause instanceof Error ? cause.message : ''; return { ok: false, code: /^[A-Z][A-Z0-9_]{2,80}$/.test(code) ? code : 'ORCA_LIQUIDITY_SERVICE_UNAVAILABLE' }; }
}
type Request = { operation: 'OPEN' | 'DECREASE_PARTIAL' | 'EXIT'; positionMint: string; partBps?: number };
const request = (value: Request): Request => {
  if (!value || !['OPEN', 'DECREASE_PARTIAL', 'EXIT'].includes(value.operation) || typeof value.positionMint !== 'string' ||
      value.partBps !== undefined && !Number.isSafeInteger(value.partBps)) throw new Error('ORCA_LIQUIDITY_INPUT_INVALID');
  return { operation: value.operation, positionMint: value.positionMint, ...value.partBps === undefined ? {} : { partBps: value.partBps } };
};
export async function solanaMainnetLiquidityInfo() { return run('info', [], async service => ({ executionEnabled: service.executionEnabled })); }
export async function solanaMainnetLiquidityPrice() { return run('price', [], service => service.price()); }
export async function solanaMainnetLiquidityPositions(owner: string) { return run('positions', [owner], service => service.positions(owner)); }
export async function solanaMainnetLiquidityInspect(owner: string, positionMint: string) { return run('inspect', [owner, positionMint], service => service.inspect(owner, positionMint)); }
export async function solanaMainnetLiquiditySimulate(workflow: SemanticWorkflow, owner: string, value: Request) { return run('simulate', [workflow, owner, value], service => service.simulate(workflow, owner, request(value))); }
export async function solanaMainnetLiquidityReview(id: string, commitment: string, workflow: SemanticWorkflow) { return run('review', [id, commitment, workflow], service => service.review(id, commitment, workflow)); }
export async function solanaMainnetLiquidityInvalidate(id: string) { return run('invalidate', [id], service => service.invalidate(id)); }
export async function solanaMainnetLiquidityBegin(id: string, owner: string, workflow: SemanticWorkflow) { return run('begin', [id, owner, workflow], service => service.begin(id, owner, workflow)); }
export async function solanaMainnetLiquidityWalletFailure(id: string, diagnostic: OrcaLiquidityWalletDiagnostic) { return run('walletFailure', [id, diagnostic], service => service.walletFailure(id, diagnostic)); }
export async function solanaMainnetLiquiditySubmit(id: string, signedTransaction: string) { return run('submit', [id, signedTransaction], service => service.submit(id, signedTransaction)); }
export async function solanaMainnetLiquidityObserve(id: string) { return run('observe', [id], service => service.observe(id)); }
export async function solanaMainnetLiquidityStatus(id: string) { return run('status', [id], service => service.load(id)); }
