// SPDX-License-Identifier: AGPL-3.0-only
/** Presentation only: a timeout or a provider hint cannot complete a financial stage. */
import type { ExecutionLifecycleSource, LifecycleOperation } from './execution-lifecycle';
export type BridgeStage = { id: string; label: string; status: 'Pending' | 'In progress' | 'Confirmed' | 'Awaiting observation' | 'Failed with evidence' | 'Outcome undetermined' | 'Not submitted' | 'Submitted'; chain?: string; hash?: string; note?: string };
export function projectBridgeProgress(source: ExecutionLifecycleSource, operations: LifecycleOperation[]): BridgeStage[] | undefined {
  if (source.kind !== 'router' && source.kind !== 'universal') return;
  const record = source.state.record;
  if (!record) return;
  const approval = operations.find(op => op.approval), deposit = operations.find(op => op.id === 'DEPOSIT');
  const state = (operation: LifecycleOperation | undefined): BridgeStage['status'] => !operation || operation.state === 'waiting' ? 'Pending'
    : operation.state === 'confirmed' ? 'Confirmed' : operation.state === 'uncertain' ? 'Outcome undetermined'
    : operation.state === 'failed' && operation.hash ? record.attempts?.some(attempt => attempt.step === operation.id && attempt.state === 'REVERTED') ? 'Failed with evidence' : 'Outcome undetermined'
    : ['failed', 'not-submitted', 'cancelled', 'expired'].includes(operation.state) ? 'Not submitted' : 'In progress';
  const sourceFinal = source.kind === 'router' ? source.state.record?.source?.safe : source.state.record?.source?.final;
  const destinationFinal = source.kind === 'router' ? source.state.record?.destination?.safe : source.state.record?.destination?.final;
  const reconciled = record.verdict === 'RECONCILED' && record.evidence?.bundle?.outcome === 'RECONCILED' && Boolean(sourceFinal && destinationFinal);
  const observationUnavailable = record.observation?.outcome === 'TEMPORARY_FAILURE';
  const sourceHash = record.source?.transactionHash ?? deposit?.hash ?? undefined;
  const sourceChain = deposit?.chain, destinationChain = operations.find(op => op.id === 'destination')?.chain;
  const stages: BridgeStage[] = [];
  if (approval) stages.push({ id: 'authorization', label: 'Token authorization', status: state(approval), chain: approval.chain, ...(approval.hash ? { hash: approval.hash } : {}), note: 'Approval does not transfer your tokens.' });
  stages.push(
    { id: 'submission', label: 'Source transaction', status: sourceHash ? sourceFinal ? 'Confirmed' : 'Submitted' : state(deposit), ...(sourceChain ? { chain: sourceChain } : {}), ...(sourceHash ? { hash: sourceHash } : {}), note: 'A transaction hash establishes submission, not delivery.' },
    { id: 'source', label: 'Source confirmation', status: sourceFinal ? 'Confirmed' : deposit?.state === 'failed' && deposit.hash ? state(deposit) : deposit?.state === 'uncertain' ? 'Outcome undetermined' : sourceHash ? 'Awaiting observation' : 'Pending', ...(sourceChain ? { chain: sourceChain } : {}) },
    { id: 'transfer', label: 'Cross-network transfer', status: destinationFinal ? 'Confirmed' : sourceFinal ? 'In progress' : 'Pending' },
    { id: 'delivery', label: 'Destination delivery', status: destinationFinal ? 'Confirmed' : record.destination || sourceFinal ? 'Awaiting observation' : 'Pending', ...(destinationChain ? { chain: destinationChain } : {}), ...(record.destination?.transactionHash ? { hash: record.destination.transactionHash } : {}) },
    { id: 'reconciliation', label: 'Final reconciliation', status: reconciled ? 'Confirmed' : record.verdict === 'DIVERGENT' ? 'Outcome undetermined' : destinationFinal ? 'Awaiting observation' : 'Pending' },
  );
  if (observationUnavailable) {
    const stage = stages.find(item => item.status === 'Awaiting observation' || item.status === 'In progress');
    if (stage) { stage.status = 'Awaiting observation'; stage.note = 'The network could not be checked right now. The previous financial state is preserved. Try checking again.'; }
  }
  return stages;
}
