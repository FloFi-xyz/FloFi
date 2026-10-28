// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { projectCanvasAction } from '../domain/canvas-lifecycle';
import type { ExecutionControls, ExecutionControlsState } from '../state/execution-controls';
import { useLocale } from '../i18n/locale';
import { WalletPendingNotice } from './wallet-pending-notice';

export function CanvasLifecycleAction(props: ExecutionControlsState & {
  controls: ExecutionControls; simulate?: () => void | Promise<void>; simulationDisabled?: boolean;
  simulationReason?: string | null;
  onExecute?: () => void; workflowName?: string;
}) {
  const { t } = useLocale();
  const c = props.controls, action = projectCanvasAction(c.current, c);
  const disabled = action.disabled || action.kind === 'simulate' && (!props.simulate || props.simulationDisabled) || action.kind === 'execute' && !c.view.canExecute;
  function act() {
    // Re-project at the click boundary; background tabs cannot preserve expired authority.
    const next = projectCanvasAction(c.current, c);
    if (next.disabled || next.kind !== action.kind) return;
    if (next.kind === 'simulate' && !props.simulationDisabled) void props.simulate?.();
    // BUILD-SOLANA-TRANSFER-UX-001: Authorize in wallet = accept this Review, then the first wallet request (one owner action).
    if (next.kind === 'approve' || next.kind === 'execute') c.authorize(props.onExecute);
    if (next.kind === 'continue') { c.request(true); props.onExecute?.(); }
    if (next.kind === 'recover') c.checkStatus();
  }
  return <div className="canvas-lifecycle-control">
    {/* UX-003: simulating / waiting for the wallet keep the CTA position as a locked, active button; a duplicate request cannot start. */}
    {action.processing ? <button data-lifecycle-action="processing" type="button" className="primary canvas-cta-processing" disabled aria-busy="true"><span className="canvas-cta-spinner" aria-hidden="true"/>{t(action.label)}</button>
      : action.kind === 'status' ? <span role="status" data-lifecycle-action="status">{t(action.label)}</span> : <button data-lifecycle-action={action.kind} type="button" className="primary" disabled={disabled}
        title={action.kind === 'simulate' && disabled && props.simulationReason ? t(props.simulationReason) : undefined}
        aria-description={action.kind === 'simulate' && disabled && props.simulationReason ? t(props.simulationReason) : undefined} onClick={act}>{t(action.label)}</button>}
    {c.live?.steps.some(step => step.operations.some(operation => operation.state === 'wallet')) && <WalletPendingNotice/>}
  </div>;
}
