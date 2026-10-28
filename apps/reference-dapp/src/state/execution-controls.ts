// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useEffect, useRef, useState } from 'react';
import { canContinueExecution, projectExecution, startReviewedExecution, type ExecutionWorkspaceState } from '../domain/execution-presentation';
import type { ExecutionLifecycle } from '../domain/execution-lifecycle';
import type { ExecutionRecovery } from '../domain/execution-recovery';
import { currentExecution, projectExecutionResult } from '../domain/execution-result';
import { projectReview } from '../domain/review-presentation';

export type ExecutionControlsState = ExecutionWorkspaceState & { progress?: ExecutionLifecycle; recovery?: ExecutionRecovery };
/** Shared explicit request controls. Mounted across stages so navigation cannot clear a submission lock. */
export function useExecutionControls(props: ExecutionControlsState) {
  const { execution } = props;
  const requestLock = useRef<{ fingerprint: string; error: string | null; sawBusy: boolean } | null>(null);
  const checkLock = useRef<{ sawBusy: boolean } | null>(null);
  const [checking, setChecking] = useState(false), [checkFailed, setCheckFailed] = useState(false);
  const [requesting, setRequesting] = useState(false), [requestFailed, setRequestFailed] = useState(false);
  // UX-004: a new workflow identity does not inherit the previous workflow's failed-request or failed-check notice (presentation only).
  const workflowId = props.workflow.workflowId;
  useEffect(() => { setRequestFailed(false); setCheckFailed(false); }, [workflowId]);
  // BUILD-FIX-UX-001: a final run of another (new or edited) workflow is not this workflow's execution state.
  const progress = props.progress, live = currentExecution(progress);
  const [lastCheck, setLastCheck] = useState<{ runKey: string | null; checkedAt: string } | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const current = props;
  const view = projectExecution(current, Math.max(clock, Date.now())), expiresAt = view.expiresAt;
  useEffect(() => {
    const lock = requestLock.current;
    if (!lock) return;
    if (props.source.state.busy) { lock.sawBusy = true; return; }
    if (lock.sawBusy || props.progress?.fingerprint !== lock.fingerprint && Boolean(props.progress) || props.source.state.error !== lock.error) { requestLock.current = null; setRequesting(false); }
  }, [props.source.state.busy, props.source.state.error, props.progress?.fingerprint]);
  const providers = live ? [...new Set(live.steps.map(step => step.provider).filter((provider): provider is string => Boolean(provider)))] : view.providers;
  const recovery = props.recovery;
  const verifying = checking || Boolean(recovery?.checking);
  const result = verifying ? null : projectExecutionResult(live);
  const reconciledCount = Object.values(live?.stepEvidence ?? {}).filter(step => step.reconciled).length;
  const recoveredCount = Object.values(live?.stepEvidence ?? {}).filter(step => step.recovered).length;
  const resultUnit = live?.planUnavailable ? 'recorded action' : 'step';
  const canContinue = Boolean(live && live.state === 'active' && canContinueExecution(current) && !requesting && !verifying && !recovery?.contextIssue);
  const check = recovery ? recovery.check : execution.check;
  const canCheck = Boolean(live && check && !requesting && !verifying && !props.source.state.busy && (recovery?.action || !recovery && live.steps.some(step => step.operations.some(op => ['submitted', 'pending', 'posted', 'settling', 'partial'].includes(op.state)))));
  useEffect(() => {
    const lock = checkLock.current; if (!lock) return;
    if (props.source.state.busy) lock.sawBusy = true;
    else if (lock.sawBusy) { checkLock.current = null; setChecking(false); }
  }, [props.source.state.busy]);
  function checkStatus() {
    if (checkLock.current || requestLock.current || !canCheck || !check) return;
    const lock = { sawBusy: false };
    checkLock.current = lock; setChecking(true); setCheckFailed(false);
    const finish = () => { if (checkLock.current === lock) { checkLock.current = null; setChecking(false); } };
    // Observation is read-only. A missing HTTP response must not keep the workspace in Checking status forever.
    const timeout = setTimeout(() => { if (checkLock.current === lock) { setCheckFailed(true); finish(); } }, 30_000);
    try {
      void Promise.resolve(check()).then(() => { if (checkLock.current === lock) setLastCheck({ runKey: live?.runKey ?? null, checkedAt: new Date().toISOString() }); })
        .catch(() => { if (checkLock.current === lock) setCheckFailed(true); }).finally(() => { clearTimeout(timeout); finish(); });
    } catch { clearTimeout(timeout); setCheckFailed(true); finish(); }
  }
  function request(continuation: boolean) {
    if (requestLock.current || checkLock.current || verifying || recovery?.contextIssue || !(continuation ? canContinueExecution(current) && live?.state === 'active' : projectExecution(current).canExecute)) return;
    requestLock.current = { fingerprint: props.progress?.fingerprint ?? '', error: props.source.state.error, sawBusy: false };
    setRequesting(true); setRequestFailed(false);
    const lock = requestLock.current;
    const failed = () => {
      if (requestLock.current !== lock) return;
      requestLock.current = null; setRequesting(false); setRequestFailed(true);
    };
    try { void Promise.resolve(continuation ? execution.next?.() : startReviewedExecution(current)).catch(failed); } catch { failed(); }
  }
  /**
   * BUILD-SOLANA-TRANSFER-UX-001: "Authorize in wallet" — one explicit owner action accepts the current Review and then makes the first wallet
   * request under that just-accepted authority (Review → wallet, without a second FloFi button). Each half keeps its own gate at its own
   * boundary: the Review must be approvable at the click (fresh clock), and the reviewed execution must be ready when the accepted authority
   * lands. A refused Review, replaced authority (a new simulation), expiry or failure ends the chain with no wallet request. The wallet's own
   * confirmation stays mandatory; FloFi never signs.
   */
  const authorizeLock = useRef<{ key: string; settled: boolean; after?: (() => void) | undefined } | null>(null);
  const [authorizing, setAuthorizing] = useState(false), [, setSettled] = useState(0);
  function authorize(after?: () => void) {
    if (authorizeLock.current || requestLock.current || checkLock.current || verifying || recovery?.contextIssue) return;
    const now = Date.now(), review = projectReview(current.workflow, current.context, current.source, current.authorization, current.wallet, now, current.invalidWorkflow);
    if (review.status === 'approved') {
      if (live?.state === 'active' && canContinueExecution(current, now)) { request(true); after?.(); }
      else if (projectExecution(current, now).canExecute) { request(false); after?.(); }
      return;
    }
    const key = current.authorization.key, approve = current.authorization.approve;
    if (!review.canApprove || !key || !approve) return;
    const lock = { key, settled: false, after };
    authorizeLock.current = lock; setAuthorizing(true); setRequestFailed(false);
    const settle = (failed: boolean) => {
      if (authorizeLock.current !== lock) return;
      if (failed) { authorizeLock.current = null; setAuthorizing(false); setRequestFailed(true); return; }
      lock.settled = true; setSettled(n => n + 1);
    };
    try { void Promise.resolve(approve()).then(() => settle(false), () => settle(true)); } catch { settle(true); }
  }
  useEffect(() => {
    const lock = authorizeLock.current;
    if (!lock?.settled || props.source.state.busy) return;
    const stop = (failed = false) => { authorizeLock.current = null; setAuthorizing(false); if (failed) setRequestFailed(true); };
    // A new simulation replaced the authority the owner clicked for: the click never carries over to it.
    if (props.authorization.key !== lock.key) { stop(); return; }
    const now = Date.now();
    if (live?.state === 'active' && canContinueExecution(current, now)) { stop(); request(true); lock.after?.(); return; }
    if (projectExecution(current, now).canExecute) { stop(); request(false); lock.after?.(); return; }
    // The Review was refused, or the accepted authority cannot start (the projected status names why): nothing is requested.
    stop(!props.authorization.accepted && Boolean(props.source.state.error));
  });
  useEffect(() => {
    if (expiresAt === null || expiresAt <= Date.now()) return;
    const update = () => setClock(Date.now());
    const timer = window.setTimeout(update, Math.min(expiresAt - Date.now() + 1, 2_147_483_647));
    window.addEventListener('focus', update); document.addEventListener('visibilitychange', update);
    return () => { window.clearTimeout(timer); window.removeEventListener('focus', update); document.removeEventListener('visibilitychange', update); };
  }, [expiresAt]);
  return { live, view, current, providers, recovery, verifying, result, reconciledCount, recoveredCount, resultUnit,
    lastCheckedAt: lastCheck?.runKey === live?.runKey ? lastCheck?.checkedAt ?? null : null,
    canContinue, canCheck, checkStatus, request, requesting, requestFailed, checkFailed, authorize, authorizing };
}
export type ExecutionControls = ReturnType<typeof useExecutionControls>;
