// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001 browser fixtures for managing Orca Whirlpools positions on the MOCKED Solana mainnet-beta loopback harness
 * (e2e/solana-devnet-harness.mjs `/mainnet-rpc` and `/mainnet-control`, 127.0.0.1:8552). Positions are seeded as if opened in another interface;
 * the browser discovers them on the Dashboard and prepares, simulates and recovers their runs through the real server actions (the app's
 * in-process MOCKED Orca mainnet runtime, src/app/solana-mainnet-liquidity-action.ts).
 *
 * The product never authorizes or executes a MOCKED result (release-financial-provenance.spec.ts), so the owner's Review authorization and the one
 * signed transaction are made here, through a runtime built exactly as the app's MOCKED harness action builds it (same journal, same loopback RPC,
 * same Solana mainnet profile, execution enabled only because it is the harness) — the pattern of e2e/liquidity-position-fixtures.ts. The owner's
 * disposable key lives only in this test process's memory (createMockedSolanaWallet); its one signature goes to the loopback harness only.
 * Nothing reaches a public network, nothing is signed with a real key, and none of this is mainnet evidence.
 */
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ORCA_WHIRLPOOLS_MAINNET_LIQUIDITY as ORCA } from '@defi-workflow-engine/action-registry';
import { createMockedSolanaWallet } from '@defi-workflow-engine/reference-compiler';
import { createOrcaLiquidityService, type OrcaLiquidityService } from '../src/server/orca-liquidity-service';
import { ORCA_MAINNET_HARNESS_RPC } from '../src/server/orca-mainnet-harness';
import { createSolanaRpc } from '../src/server/solana-rpc';

export type OrcaOwnerWallet = ReturnType<typeof createMockedSolanaWallet>;
/** The Orca run pointer the browser keeps (src/state/solana-liquidity-store.tsx). */
export const ORCA_RUN_KEY = 'gryloo:build015:orca-liquidity';

/** The journal of the app's in-process MOCKED Orca mainnet runtime (`$GRYLOO_ORCA_MAINNET_JOURNAL`), refused unless it is this run's own. */
function journal(): string {
  const dir = process.env.GRYLOO_ORCA_MAINNET_JOURNAL;
  if (process.env.FLOFI_ORCA_POSITIONS_E2E !== 'MOCKED_LOOPBACK_ONLY' || process.env.GRYLOO_SOLANA_DEVNET_E2E !== 'MOCKED_LOOPBACK_ONLY'
    || !dir?.startsWith(join(tmpdir(), 'gryloo-orca-mainnet-'))) throw new Error('MOCK_JOURNAL_DENIED');
  return dir;
}
export async function orcaControl<T>(body: Record<string, unknown>): Promise<T> {
  const response = await fetch('http://127.0.0.1:8552/mainnet-control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const value = await response.json() as { result?: T; error?: string };
  if (!response.ok || value.error) throw new Error(`MOCK_HARNESS_ERROR ${value.error ?? response.status}`);
  return value.result as T;
}
/** A position opened outside FloFi: amounts as decimal strings; `delegate` names an approved delegate on its position token. */
export type SeededOrcaPosition = { liquidity: string; tickLower: number; tickUpper: number; feeOwedA?: string; feeOwedB?: string; delegate?: string };
/**
 * A fresh journal and a fresh MOCKED mainnet loopback whose positions belong to a new disposable owner (3 SOL and 50 USDC; positions opened outside
 * FloFi). `accrueFees`: fees earned since each position's last checkpoint, credited at its next one (decrease, collect).
 */
export async function resetOrcaPositions(positions: readonly SeededOrcaPosition[], accrueFees?: { a: string; b: string }): Promise<{ wallet: OrcaOwnerWallet; mints: string[] }> {
  await rm(journal(), { recursive: true, force: true });
  const wallet = createMockedSolanaWallet();
  await orcaControl({ action: 'reset', owner: wallet.owner, options: accrueFees ? { accrueFees } : {} });
  return { wallet, mints: await orcaControl<string[]>({ action: 'seed', owner: wallet.owner, positions }) };
}
/** Transactions the loopback harness received (`sendTransaction`); only the test's owner wallet ever sends one. */
export const orcaSent = () => orcaControl<number>({ action: 'sent' });
export type OrcaHarnessPosition = { liquidity: string; feeOwedA: string; feeOwedB: string; tokenOwner: string | null; tokenAmount: string | null; delegate: string | null } | null;
export const orcaPosition = (mint: string) => orcaControl<OrcaHarnessPosition>({ action: 'position', mint });
export const orcaBalances = (owner: string) => orcaControl<{ lamports: string; usdc: string }>({ action: 'balances', owner });
/** More pool trading since every position's last checkpoint: each position with liquidity is credited `fees` at its next checkpoint only. */
export const orcaTrade = (fees: { a: string; b: string }) => orcaControl<boolean>({ action: 'trade', fees });

/** The runtime the app's server actions run in MOCKED harness mode (src/app/solana-mainnet-liquidity-action.ts `current`). */
export function orcaOwnerRuntime(): OrcaLiquidityService {
  return createOrcaLiquidityService({ journalDir: journal(), profile: ORCA, provenance: 'MOCKED', executionEnabled: true, rpc: createSolanaRpc(ORCA_MAINNET_HARNESS_RPC, true) });
}
/**
 * The owner's explicit authorization of the run's current Review, then its ONE signed transaction (prepared durably → signed by the owner's
 * disposable key in this process → verified and submitted once by the runtime → observed until reconciled).
 */
export async function ownerManagesOrca(service: OrcaLiquidityService, id: string, wallet: OrcaOwnerWallet) {
  const run = await service.load(id);
  await service.review(id, run.review.commitment, run.review.workflow);
  const begun = await service.begin(id, wallet.owner, run.review.workflow);
  const submitted = await service.submit(id, wallet.sign(begun.unsignedTransaction));
  return { begun, submitted, record: await service.observe(id) };
}
