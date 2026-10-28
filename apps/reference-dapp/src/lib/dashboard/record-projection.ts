// SPDX-License-Identifier: AGPL-3.0-only
/** Adapt an owned backend status record to the existing UX-005 read-only projectors. */
import type { ReviewContext } from '@defi-workflow-engine/reference-linter';
import type { Workflow } from '../../domain/initial-workflow';
import { projectExecutionLifecycle, type ExecutionLifecycleSource } from '../../domain/execution-lifecycle';
import { projectExecutionEvidence } from '../../domain/execution-evidence';
import { projectExecutionStepEvidence } from '../../domain/execution-step-evidence';
import { object, sameOwner } from './run-mapping';
import type { DashboardRunDetail } from './types';

export function projectDashboardRecord(detail: DashboardRunDetail, context: ReviewContext) {
  const record = detail.record;
  if (!object(record)) return null;
  const kinds: Record<string, ExecutionLifecycleSource['kind']> = { 'aave-supply': 'supply', 'base-sepolia-swap': 'public',
    'crosschain-router': 'router', 'crosschain-universal': 'universal', 'lending-composition': 'lending', 'crosschain-router-testnet': 'router', 'robinhood-transfer': 'transfer',
    'solana-devnet-swap': 'solana-swap', 'jupiter-swap': 'solana-swap', 'orca-liquidity': 'solana-pool', 'orca-liquidity-mainnet': 'solana-pool', 'uniswap-liquidity': 'uniswap-pool',
    'solana-transfer': 'solana-transfer', 'solana-devnet-transfer': 'solana-transfer' };
  const kind = kinds[detail.run.flow] ?? (detail.run.flow.startsWith('crosschain-router-') ? 'router'
    : /^(base|arbitrum|ethereum|robinhood)-swap$/.test(detail.run.flow) ? 'public'
    : /^(base|arbitrum|ethereum|robinhood)-mainnet-transfer$/.test(detail.run.flow) ? 'transfer'
    : /^(base|arbitrum|ethereum|robinhood)-liquidity$/.test(detail.run.flow) ? 'uniswap-pool'
    : /^(base|arbitrum|ethereum)-aave$/.test(detail.run.flow) ? 'supply' : null);
  if (!kind) return null;
  const review = object(record.review) ? record.review : null;
  const latestReview = kind === 'lending' && Array.isArray(record.reviews) && object(record.reviews.at(-1)) ? record.reviews.at(-1) : review;
  const saved = kind === 'universal' || kind === 'router' || kind === 'uniswap-pool' || kind === 'public' ? record.workflow : latestReview?.workflow;
  if (!object(saved) || !Array.isArray(saved.nodes) || !Array.isArray(saved.resourceEdges) || typeof saved.workflowId !== 'string') return null;
  // The status endpoint loads validated durable records. Defaults describe the read operation only;
  // no attempts, workflow values, outcomes, receipts or reconciliation are supplied by this adapter.
  const source = { kind, state: { ...(kind === 'public' ? { run: record } : { record }),
    busy: false, signing: false, recovered: false, recoveryOnly: false, error: null } } as unknown as ExecutionLifecycleSource;
  try {
    const progress = projectExecutionLifecycle(saved as unknown as Workflow, context, source);
    const evidence = projectExecutionEvidence(source, progress);
    if (progress.runKey !== detail.run.runId || !sameOwner(evidence.wallet, detail.run.ownerAccount)) return null;
    return { ...progress, evidence, stepEvidence: projectExecutionStepEvidence(source, progress) };
  } catch { return null; }
}
